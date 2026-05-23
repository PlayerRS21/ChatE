"""Backend security regression tests for ChatE.

Run from the project root after installing backend requirements:

    PYTHONPATH=backend pytest -q tests

These tests use a temporary SQLite database selected before importing the app.
"""
from __future__ import annotations

import os
import tempfile

TEST_DB = os.path.join(tempfile.gettempdir(), "chate_test_security_v73.db")
try:
    os.unlink(TEST_DB)
except FileNotFoundError:
    pass

os.environ["CHATE_DATABASE_URL"] = f"sqlite:///{TEST_DB}"
os.environ["CHATE_SECRET_KEY"] = "test-secret-not-for-production"
os.environ["CHATE_ENV"] = "test"
os.environ["CHATE_PUBLIC_BASE_URL"] = "http://testserver"
os.environ["CHATE_MAIL_MODE"] = "dev"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import Message, User  # noqa: E402
from app.timeutils import utcnow  # noqa: E402
from datetime import timedelta  # noqa: E402

client = TestClient(app)


def jwk(seed: str) -> dict:
    # The app validates shape/length only; browser crypto owns real key generation.
    return {"kty": "RSA", "alg": "RSA-OAEP-256", "n": seed * 360, "e": "AQAB", "ext": True}


def register(username: str, email: str) -> tuple[str, dict]:
    r = client.post("/api/auth/register", json={
        "username": username,
        "email": email,
        "password": "StrongPass123!",
        "display_name": username.title(),
        "public_key_jwk": jwk(username[0]),
    })
    assert r.status_code == 200, r.text
    data = r.json()
    return data["access_token"], data["user"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_block_stops_message_delivery_and_reports_are_explicit():
    alice_token, alice = register("alice_v46", "alice_v46@example.com")
    bob_token, bob = register("bob_v46", "bob_v46@example.com")

    blocked = client.post(f"/api/blocks/{alice['id']}", headers=auth(bob_token), json={})
    assert blocked.status_code == 200, blocked.text

    blocked_send = client.post("/api/messages", headers=auth(alice_token), json={
        "receiver_id": bob["id"],
        "message_type": "text",
        "ciphertext": "abc",
        "iv": "iviviv",
        "encrypted_key_for_receiver": "receiver-key",
        "encrypted_key_for_sender": "sender-key",
    })
    assert blocked_send.status_code == 403

    report = client.post("/api/reports", headers=auth(alice_token), json={
        "reported_user_id": bob["id"],
        "reason": "spam",
        "details": "test report",
        "evidence": [{"message_id": 1, "direction": "received", "text": "user-selected plaintext evidence"}],
    })
    assert report.status_code == 200, report.text
    assert report.json()["reported_id"] == bob["id"]


def test_password_reset_does_not_touch_e2ee_public_key():
    token, user = register("carol_v46", "carol_v46@example.com")
    before = client.get("/api/users/me", headers=auth(token)).json()["public_key_jwk"]

    start = client.post("/api/auth/password-reset/start", json={"login": "carol_v46"})
    assert start.status_code == 200
    # In dev/test without SMTP, token is written to backend/storage/mailbox/dev_mailbox.log.
    mailbox = os.path.join(os.getcwd(), "backend", "storage", "mailbox", "dev_mailbox.log")
    with open(mailbox, "r", encoding="utf-8") as f:
      text = f.read()
    reset_code = text.split("Code: ")[-1].split()[0]

    done = client.post("/api/auth/password-reset/complete", json={
        "token": reset_code,
        "new_password": "NewStrongPass123!",
    })
    assert done.status_code == 200, done.text

    login = client.post("/api/auth/login", json={"login": "carol_v46", "password": "NewStrongPass123!"})
    assert login.status_code == 200, login.text
    after_token = login.json()["access_token"]
    after = client.get("/api/users/me", headers=auth(after_token)).json()["public_key_jwk"]
    assert after == before


def test_disappearing_setting_is_saved_for_new_messages():
    alice_token, alice = register("dana_v46", "dana_v46@example.com")
    bob_token, bob = register("erin_v46", "erin_v46@example.com")
    settings = client.put("/api/settings", headers=auth(alice_token), json={
        "auto_delete_after_days": None,
        "default_disappearing_seconds": 3600,
    })
    assert settings.status_code == 200, settings.text
    assert settings.json()["default_disappearing_seconds"] == 3600

    msg = client.post("/api/messages", headers=auth(alice_token), json={
        "receiver_id": bob["id"],
        "message_type": "text",
        "ciphertext": "abc",
        "iv": "iviviv",
        "encrypted_key_for_receiver": "receiver-key",
        "encrypted_key_for_sender": "sender-key",
    })
    assert msg.status_code == 200, msg.text
    assert msg.json()["expires_at"] is not None



def test_conversation_disappearing_setting_overrides_account_default():
    alice_token, alice = register("frank_v46", "frank_v46@example.com")
    bob_token, bob = register("grace_v46", "grace_v46@example.com")

    off = client.put(f"/api/conversations/{bob['id']}/settings", headers=auth(alice_token), json={"disappearing_seconds": 30})
    assert off.status_code == 200, off.text
    assert off.json()["disappearing_seconds"] == 30

    msg = client.post("/api/messages", headers=auth(alice_token), json={
        "receiver_id": bob["id"],
        "message_type": "text",
        "ciphertext": "abc",
        "iv": "iviviv",
        "encrypted_key_for_receiver": "receiver-key",
        "encrypted_key_for_sender": "sender-key",
    })
    assert msg.status_code == 200, msg.text
    assert msg.json()["expires_at"] is not None


def test_device_link_session_relays_only_encrypted_key_package():
    token, user = register("henry_v46", "henry_v46@example.com")
    dev = client.post("/api/devices/current", headers=auth(token), json={
        "device_id": "a" * 48,
        "name": "test laptop",
        "public_key_jwk": jwk("h"),
    })
    assert dev.status_code == 200, dev.text

    start = client.post("/api/devices/link/start", headers=auth(token), json={
        "device_id": "b" * 48,
        "device_name": "new phone",
        "public_key_jwk": jwk("i"),
    })
    assert start.status_code == 200, start.text
    session_id = start.json()["id"]
    assert "qr_payload" in start.json()

    encrypted_pkg = '{"app":"ChatE","ciphertext":"cipher-only","publicKeyJwk":{"kty":"RSA","n":"x","e":"AQAB"}}'
    approve = client.post(f"/api/devices/link/{session_id}/approve", headers=auth(token), json={
        "encrypted_key_package_json": encrypted_pkg,
    })
    assert approve.status_code == 200, approve.text
    assert approve.json()["status"] == "approved"

    complete = client.post(f"/api/devices/link/{session_id}/complete", headers=auth(token), json={})
    assert complete.status_code == 200, complete.text
    assert complete.json()["encrypted_key_package_json"] == encrypted_pkg


def test_conversation_list_does_not_drop_old_threads_behind_busy_chat():
    alice_token, alice = register("ivy_v46", "ivy_v46@example.com")
    bob_token, bob = register("john_v46", "john_v46@example.com")
    carl_token, carl = register("kira_v46", "kira_v46@example.com")

    first = client.post("/api/messages", headers=auth(alice_token), json={
        "receiver_id": carl["id"],
        "message_type": "text",
        "ciphertext": "old-thread",
        "iv": "iviviv",
        "encrypted_key_for_receiver": "receiver-key",
        "encrypted_key_for_sender": "sender-key",
    })
    assert first.status_code == 200, first.text

    for i in range(75):
        msg = client.post("/api/messages", headers=auth(alice_token), json={
            "receiver_id": bob["id"],
            "message_type": "text",
            "client_message_id": f"busy-{i}",
            "ciphertext": f"busy-{i}",
            "iv": "iviviv",
            "encrypted_key_for_receiver": "receiver-key",
            "encrypted_key_for_sender": "sender-key",
        })
        assert msg.status_code == 200, msg.text

    conversations = client.get("/api/conversations?limit=10", headers=auth(alice_token))
    assert conversations.status_code == 200, conversations.text
    peer_ids = {row["other_user"]["id"] for row in conversations.json()}
    assert bob["id"] in peer_ids
    assert carl["id"] in peer_ids


def test_profile_routes_include_or_gracefully_repair_public_keys():
    alice_token, alice = register("pubkey_alice_v73", "pubkey_alice_v73@example.com")
    bob_token, bob = register("pubkey_bob_v73", "pubkey_bob_v73@example.com")

    profile = client.get(f"/api/users/{bob['id']}/profile", headers=auth(alice_token))
    assert profile.status_code == 200, profile.text
    assert profile.json()["public_key_jwk"] == bob["public_key_jwk"]

    direct_key = client.get(f"/api/users/{bob['id']}/public-key", headers=auth(alice_token))
    assert direct_key.status_code == 200, direct_key.text
    assert direct_key.json()["public_key_jwk"] == bob["public_key_jwk"]

    db = SessionLocal()
    try:
        row = db.get(User, bob["id"])
        row.public_key_jwk = ""
        db.commit()
    finally:
        db.close()

    profile_missing = client.get(f"/api/users/{bob['id']}/profile", headers=auth(alice_token))
    assert profile_missing.status_code == 200, profile_missing.text
    assert profile_missing.json()["public_key_jwk"] is None

    direct_missing = client.get(f"/api/users/{bob['id']}/public-key", headers=auth(alice_token))
    assert direct_missing.status_code == 409, direct_missing.text
    assert "public key" in direct_missing.json()["detail"].lower()

    repaired = client.put("/api/users/me/public-key", headers=auth(bob_token), json={"public_key_jwk": jwk("z")})
    assert repaired.status_code == 200, repaired.text
    assert repaired.json()["public_key_jwk"] == jwk("z")


def test_runtime_smoke_login_websocket_static_and_chat_flow():
    alice_token, alice = register("runtime_alice_v73", "runtime_alice_v73@example.com")
    bob_token, bob = register("runtime_bob_v73", "runtime_bob_v73@example.com")

    assert client.get("/api/health").status_code == 200
    for path in ["/", "/settings", "/offline.html", "/sw.js", "/manifest.webmanifest", "/js/app.js?v=73", "/js/settings.js?v=73", "/css/styles.css?v=73"]:
        response = client.get(path)
        assert response.status_code == 200, path

    login_by_username = client.post("/api/auth/login", json={"login": "runtime_alice_v73", "password": "StrongPass123!"})
    assert login_by_username.status_code == 200, login_by_username.text
    login_by_email = client.post("/api/auth/login", json={"login": "runtime_alice_v73@example.com", "password": "StrongPass123!"})
    assert login_by_email.status_code == 200, login_by_email.text

    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "auth:error"

    with client.websocket_connect("/ws", subprotocols=["chate.v1", f"token.{alice_token}"]) as ws:
        assert ws.accepted_subprotocol == "chate.v1"
        assert ws.receive_json()["type"] == "highway:ready"
        assert ws.receive_json()["type"] == "presence:update"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"

    msg = client.post("/api/messages", headers=auth(alice_token), json={
        "receiver_id": bob["id"],
        "message_type": "text",
        "client_message_id": "runtime-smoke-1",
        "ciphertext": "cipher",
        "iv": "iviviv",
        "encrypted_key_for_receiver": "receiver-key",
        "encrypted_key_for_sender": "sender-key",
    })
    assert msg.status_code == 200, msg.text
    message_id = msg.json()["id"]

    assert client.get("/api/conversations", headers=auth(alice_token)).status_code == 200
    assert client.get(f"/api/messages/{alice['id']}", headers=auth(bob_token)).status_code == 200
    assert client.get(f"/api/messages/{alice['id']}/after/0", headers=auth(bob_token)).status_code == 200

    reaction = client.post(f"/api/messages/{message_id}/reactions", headers=auth(bob_token), json={"emoji": "👍"})
    assert reaction.status_code == 200, reaction.text



def test_lookup_routes_return_public_keys_and_cache_headers_are_fast():
    alice_token, alice = register("lookup_alice_v73", "lookup_alice_v73@example.com")
    bob_token, bob = register("lookup_bob_v73", "lookup_bob_v73@example.com")

    search = client.get("/api/users/search?q=lookup_bob_v73", headers=auth(alice_token))
    assert search.status_code == 200, search.text
    row = next(item for item in search.json() if item["id"] == bob["id"])
    assert row["public_key_jwk"] == bob["public_key_jwk"]

    by_username = client.get("/api/users/by-username/lookup_bob_v73", headers=auth(alice_token))
    assert by_username.status_code == 200, by_username.text
    assert by_username.json()["public_key_jwk"] == bob["public_key_jwk"]

    asset = client.get("/assets/message-circle-lock.svg")
    assert asset.status_code == 200
    assert "immutable" in asset.headers.get("cache-control", "")
    js = client.get("/js/app.js?v=73")
    assert js.status_code == 200
    assert "stale-while-revalidate" in js.headers.get("cache-control", "")


def test_expired_disappearing_messages_are_hidden_from_hot_paths():
    alice_token, alice = register("expire_alice_v73", "expire_alice_v73@example.com")
    bob_token, bob = register("expire_bob_v73", "expire_bob_v73@example.com")

    sent = client.post("/api/messages", headers=auth(alice_token), json={
        "receiver_id": bob["id"],
        "message_type": "text",
        "client_message_id": "expire-smoke-1",
        "ciphertext": "soon-gone",
        "iv": "iviviv",
        "encrypted_key_for_receiver": "receiver-key",
        "encrypted_key_for_sender": "sender-key",
    })
    assert sent.status_code == 200, sent.text
    message_id = sent.json()["id"]

    db = SessionLocal()
    try:
        row = db.get(Message, message_id)
        row.expires_at = utcnow() - timedelta(seconds=5)
        db.commit()
    finally:
        db.close()

    messages = client.get(f"/api/messages/{alice['id']}", headers=auth(bob_token))
    assert messages.status_code == 200, messages.text
    assert all(msg["id"] != message_id for msg in messages.json())

    after = client.get(f"/api/messages/{alice['id']}/after/0", headers=auth(bob_token))
    assert after.status_code == 200, after.text
    assert all(msg["id"] != message_id for msg in after.json())

    conversations = client.get("/api/conversations", headers=auth(bob_token))
    assert conversations.status_code == 200, conversations.text
    assert all(conv["latest_message"]["id"] != message_id for conv in conversations.json())
