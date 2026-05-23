from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from functools import lru_cache
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import settings

PREFIX = "chate-meta-v1:"
PROFILE_AAD = b"chate:user-profile:v1"
MESSAGE_AAD = b"chate:message-field:v1"
SESSION_AAD = b"chate:key-session-field:v1"
REPORT_AAD = b"chate:report-evidence:v1"


def _truthy(value: str | None, default: bool = True) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def metadata_crypto_enabled() -> bool:
    return _truthy(os.getenv("CHATE_METADATA_ENCRYPTION"), True)


def protect_plaintext_columns() -> bool:
    return _truthy(os.getenv("CHATE_PROTECT_USER_PLAINTEXT"), True)


def _root_secret() -> str:
    # Prefer a dedicated metadata key. Fall back to the app secret for local MVP installs.
    return (
        os.getenv("CHATE_SERVER_ENCRYPTION_KEY")
        or os.getenv("CHATE_DB_ENCRYPTION_KEY")
        or settings.secret_key
        or "CHANGE_ME_FOR_PRODUCTION"
    )


def metadata_key_is_default() -> bool:
    return _root_secret() in {"", "CHANGE_ME_FOR_PRODUCTION"}


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


@lru_cache(maxsize=16)
def _derive_key_cached(label: bytes, secret: str) -> bytes:
    # This was the main performance bug in v42-v52. PBKDF2 was being run for
    # every protected message/session field on every send/load. On weak laptops
    # that turns a short message into seconds of CPU work. Cache derived keys per
    # process; changing CHATE_SERVER_ENCRYPTION_KEY requires a server restart.
    return hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), b"ChatE field encryption " + label, 240_000, dklen=32)


def _derive_key(label: bytes) -> bytes:
    return _derive_key_cached(label, _root_secret())


@lru_cache(maxsize=4)
def _aes_key() -> bytes:
    return _derive_key(b"aes-gcm-v1")


@lru_cache(maxsize=4)
def _hmac_key() -> bytes:
    return _derive_key(b"blind-index-v1")


@lru_cache(maxsize=4)
def _aesgcm() -> AESGCM:
    return AESGCM(_aes_key())


def normalize_lookup(value: str | None) -> str:
    return (value or "").strip().casefold()


def blind_index(kind: str, value: str | None) -> str | None:
    normalized = normalize_lookup(value)
    if not normalized:
        return None
    msg = f"{kind}\0{normalized}".encode("utf-8")
    return hmac.new(_hmac_key(), msg, hashlib.sha256).hexdigest()


def protect_text(value: str | None, aad: bytes = b"") -> str | None:
    if value is None:
        return None
    if not metadata_crypto_enabled():
        return value
    if isinstance(value, str) and value.startswith(PREFIX):
        return value
    nonce = os.urandom(12)
    ciphertext = _aesgcm().encrypt(nonce, value.encode("utf-8"), aad)
    return f"{PREFIX}{_b64(nonce)}.{_b64(ciphertext)}"


def unprotect_text(value: str | None, aad: bytes = b"") -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.startswith(PREFIX):
        return value
    try:
        rest = value[len(PREFIX):]
        nonce_raw, ciphertext_raw = rest.split(".", 1)
        plaintext = _aesgcm().decrypt(_unb64(nonce_raw), _unb64(ciphertext_raw), aad)
        return plaintext.decode("utf-8")
    except Exception:
        # Failing closed would make old accounts unusable after a key typo. Return a clear marker
        # so UI/API stays stable while making the bad key obvious in diagnostics.
        return "[metadata-decryption-failed]"


def protect_json(data: dict[str, Any], aad: bytes = b"") -> str:
    clean = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return protect_text(clean, aad) or ""


def unprotect_json(value: str | None, aad: bytes = b"") -> dict[str, Any]:
    if not value:
        return {}
    text = unprotect_text(value, aad)
    if not text or text == "[metadata-decryption-failed]":
        return {"_error": text or "empty"}
    try:
        loaded = json.loads(text)
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def opaque_username(user_id: int) -> str:
    return f"u_{user_id:012x}"


def opaque_email(user_id: int) -> str:
    return f"u_{user_id:012x}@chate.local"
