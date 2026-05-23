import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from collections import deque
import base64
import hashlib
import ipaddress
import json
import logging
import mimetypes
import re
import socket
import secrets
import uuid
from urllib.parse import urlparse
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request as UrlRequest, build_opener
from datetime import datetime, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect, status
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import Response
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordBearer
from fastapi.staticfiles import StaticFiles
from sqlalchemy import update, delete, and_, case, func, or_, select, text
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, SessionLocal, engine, get_db
from .models import AuthRecoveryToken, BlockedUser, ConversationSetting, Device, DeviceLinkSession, EncryptedBlob, Message, MessageKeySession, MessageReaction, PushSubscription, User, UserKeyEvent, UserReport
from .schemas import (
    AccountSettingsOut,
    AccountSettingsUpdate,
    AuthFlowResponse,
    AvatarUpload,
    BlobOut,
    ConversationOut,
    DeletionRequestOut,
    KeySessionCreate,
    KeySessionOut,
    LoginRequest,
    MessageCreate,
    MessageEditRequest,
    MessageOut,
    MessageReactionRequest,
    PasswordChangeRequest,
    PresenceOut,
    PresenceUpdate,
    PushSubscriptionIn,
    PushSubscriptionOut,
    ProfileUpdate,
    BlockedUserOut,
    DeviceOut,
    DeviceRegisterRequest,
    DeviceTrustRequest,
    DeviceTrustOut,
    DeviceLostStartOut,
    DeviceLostConfirmRequest,
    DeviceLinkApproveRequest,
    DeviceLinkCompleteOut,
    DeviceLinkSessionOut,
    DeviceLinkStartRequest,
    ConversationSettingsOut,
    ConversationSettingsUpdate,
    EmailVerificationCompleteRequest,
    ForgotUsernameRequest,
    PublicKeyUpdate,
    PublicUser,
    PasswordResetCompleteRequest,
    PasswordResetStartRequest,
    RegisterRequest,
    TokenResponse,
    UrlImportRequest,
    UrlImportOut,
    BlobUploadStart,
    BlobUploadStartOut,
    BlobUploadComplete,
    KeyHistoryOut,
    UserReportCreate,
    UserReportOut,
)
from .security import create_access_token, decode_access_token, hash_password, verify_password
from .timeutils import utc_from_timestamp, utc_iso_z, utcnow
from .services.email_service import send_account_email

try:
    from pywebpush import WebPushException, webpush
except Exception:  # optional dependency; endpoints stay safe when not installed
    WebPushException = Exception
    webpush = None

from .services.metadata_crypto import (
    MESSAGE_AAD,
    PROFILE_AAD,
    REPORT_AAD,
    SESSION_AAD,
    blind_index,
    metadata_crypto_enabled,
    metadata_key_is_default,
    opaque_email,
    opaque_username,
    protect_json,
    protect_plaintext_columns,
    protect_text,
    unprotect_json,
    unprotect_text,
)

Base.metadata.create_all(bind=engine)


def migrate_database() -> None:
    """Tiny SQLite-safe migration for the MVP.

    create_all() does not add columns to an existing SQLite database. This keeps old
    local chate.db files working when upgrading from v5 to v6.
    """
    with engine.begin() as conn:
        columns = {row[1] for row in conn.execute(text("PRAGMA table_info(users)")).all()}
        if "last_login_at" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN last_login_at DATETIME"))
        if "last_seen_at" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN last_seen_at DATETIME"))
        if "auto_delete_after_days" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN auto_delete_after_days INTEGER"))
        if "bio" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN bio VARCHAR(280)"))
        if "public_show_email" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN public_show_email BOOLEAN NOT NULL DEFAULT 0"))
        if "public_show_display_name" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN public_show_display_name BOOLEAN NOT NULL DEFAULT 1"))
        if "public_show_avatar" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN public_show_avatar BOOLEAN NOT NULL DEFAULT 1"))
        if "public_show_bio" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN public_show_bio BOOLEAN NOT NULL DEFAULT 1"))
        if "public_show_last_seen" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN public_show_last_seen BOOLEAN NOT NULL DEFAULT 0"))
        if "email_verified_at" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN email_verified_at DATETIME"))
        if "token_revoked_after" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN token_revoked_after DATETIME"))
        if "default_disappearing_seconds" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN default_disappearing_seconds INTEGER"))
        if "username_lookup_hash" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN username_lookup_hash VARCHAR(128)"))
        if "email_lookup_hash" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN email_lookup_hash VARCHAR(128)"))
        if "encrypted_profile_json" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN encrypted_profile_json TEXT"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username_lookup_hash ON users (username_lookup_hash)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email_lookup_hash ON users (email_lookup_hash)"))

        message_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(messages)")).all()}
        if "key_session_id" not in message_columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN key_session_id VARCHAR(64)"))
        if "client_message_id" not in message_columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN client_message_id VARCHAR(96)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_client_message_id ON messages (client_message_id)"))
        if "blob_id" not in message_columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN blob_id VARCHAR(64)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_blob_id ON messages (blob_id)"))
        if "edited_at" not in message_columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN edited_at DATETIME"))
        if "reply_to_id" not in message_columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_reply_to_id ON messages (reply_to_id)"))
        if "expires_at" not in message_columns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN expires_at DATETIME"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_expires_at ON messages (expires_at)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS message_reactions (
                id INTEGER PRIMARY KEY,
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                emoji VARCHAR(16) NOT NULL,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_message_reactions_message_id ON message_reactions (message_id)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_message_reaction_user_emoji ON message_reactions (message_id, user_id, emoji)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS encrypted_blobs (
                id VARCHAR(64) PRIMARY KEY,
                owner_id INTEGER NOT NULL,
                receiver_id INTEGER NOT NULL,
                original_name VARCHAR(255),
                mime_type VARCHAR(120),
                size_bytes INTEGER NOT NULL DEFAULT 0,
                storage_path TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                is_deleted BOOLEAN NOT NULL DEFAULT 0,
                FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(receiver_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_encrypted_blobs_owner_id ON encrypted_blobs (owner_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_encrypted_blobs_receiver_id ON encrypted_blobs (receiver_id)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS blocked_users (
                id INTEGER PRIMARY KEY,
                blocker_id INTEGER NOT NULL,
                blocked_id INTEGER NOT NULL,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(blocker_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(blocked_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_blocked_users_blocker_id ON blocked_users (blocker_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_blocked_users_blocked_id ON blocked_users (blocked_id)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_blocked_users_pair ON blocked_users (blocker_id, blocked_id)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS user_key_events (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                fingerprint VARCHAR(96) NOT NULL,
                event_type VARCHAR(32) NOT NULL,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_key_events_user_id ON user_key_events (user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_key_events_fingerprint ON user_key_events (fingerprint)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS auth_recovery_tokens (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                purpose VARCHAR(32) NOT NULL,
                token_hash VARCHAR(128) NOT NULL UNIQUE,
                created_at DATETIME NOT NULL,
                expires_at DATETIME NOT NULL,
                used_at DATETIME,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_auth_recovery_tokens_user_id ON auth_recovery_tokens (user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_auth_recovery_tokens_purpose ON auth_recovery_tokens (purpose)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_auth_recovery_tokens_token_hash ON auth_recovery_tokens (token_hash)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS user_reports (
                id INTEGER PRIMARY KEY,
                reporter_id INTEGER NOT NULL,
                reported_id INTEGER NOT NULL,
                reason VARCHAR(120) NOT NULL,
                details TEXT,
                evidence_json TEXT,
                status VARCHAR(32) NOT NULL DEFAULT 'open',
                created_at DATETIME NOT NULL,
                FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(reported_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_reports_reporter_id ON user_reports (reporter_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_reports_reported_id ON user_reports (reported_id)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS devices (
                id VARCHAR(64) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                name VARCHAR(120) NOT NULL,
                public_key_jwk TEXT,
                status VARCHAR(32) NOT NULL DEFAULT 'trusted',
                created_at DATETIME NOT NULL,
                approved_at DATETIME,
                last_seen_at DATETIME,
                revoked_at DATETIME,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_devices_user_id ON devices (user_id)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS device_link_sessions (
                id VARCHAR(64) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                new_device_id VARCHAR(64) NOT NULL,
                new_device_name VARCHAR(120) NOT NULL,
                new_device_public_key_jwk TEXT NOT NULL,
                encrypted_key_package_json TEXT,
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                created_at DATETIME NOT NULL,
                approved_at DATETIME,
                rejected_at DATETIME,
                email_requested_at DATETIME,
                email_approved_at DATETIME,
                email_token_hash VARCHAR(128),
                expires_at DATETIME NOT NULL,
                consumed_at DATETIME,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_link_sessions_user_id ON device_link_sessions (user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_link_sessions_new_device_id ON device_link_sessions (new_device_id)"))

        device_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(devices)")).all()}
        if "status" not in device_columns:
            conn.execute(text("ALTER TABLE devices ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'trusted'"))
        if "approved_at" not in device_columns:
            conn.execute(text("ALTER TABLE devices ADD COLUMN approved_at DATETIME"))

        device_link_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(device_link_sessions)")).all()}
        if "rejected_at" not in device_link_columns:
            conn.execute(text("ALTER TABLE device_link_sessions ADD COLUMN rejected_at DATETIME"))
        if "email_requested_at" not in device_link_columns:
            conn.execute(text("ALTER TABLE device_link_sessions ADD COLUMN email_requested_at DATETIME"))
        if "email_approved_at" not in device_link_columns:
            conn.execute(text("ALTER TABLE device_link_sessions ADD COLUMN email_approved_at DATETIME"))
        if "email_token_hash" not in device_link_columns:
            conn.execute(text("ALTER TABLE device_link_sessions ADD COLUMN email_token_hash VARCHAR(128)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_link_sessions_email_token_hash ON device_link_sessions (email_token_hash)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS conversation_settings (
                id INTEGER PRIMARY KEY,
                user_low_id INTEGER NOT NULL,
                user_high_id INTEGER NOT NULL,
                disappearing_seconds INTEGER,
                updated_by_id INTEGER,
                updated_at DATETIME NOT NULL,
                FOREIGN KEY(updated_by_id) REFERENCES users(id) ON DELETE SET NULL
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_conversation_settings_pair ON conversation_settings (user_low_id, user_high_id)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_settings_pair ON conversation_settings (user_low_id, user_high_id)"))

        # Performance indexes for the hot chat paths. SQLite can use these for
        # conversation scans, unread counts, pagination, idempotency, and block checks.
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_sender_receiver_id ON messages (sender_id, receiver_id, id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_receiver_sender_id ON messages (receiver_id, sender_id, id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_receiver_sender_read ON messages (receiver_id, sender_id, read_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_sender_client ON messages (sender_id, client_message_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_key_sessions_pair_expires ON message_key_sessions (sender_id, receiver_id, expires_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_devices_user_status ON devices (user_id, status)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_links_user_status ON device_link_sessions (user_id, status, expires_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_expires_id ON messages (expires_at, id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_receiver_read_id ON messages (receiver_id, read_at, id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_message_reactions_msg_user ON message_reactions (message_id, user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_blobs_owner_receiver_deleted ON encrypted_blobs (owner_id, receiver_id, is_deleted)"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME NOT NULL
            )
        """))


migrate_database()

PROJECT_DIR = Path(__file__).resolve().parents[2]
FRONTEND_DIR = PROJECT_DIR / "frontend"
UPLOAD_DIR = settings.upload_dir
AVATAR_DIR = settings.avatar_dir
BLOB_DIR = settings.blob_dir
BLOB_UPLOAD_TMP_DIR = settings.blob_upload_tmp_dir
MAX_BLOB_BYTES = settings.max_blob_bytes
MAX_IMPORT_MEDIA_BYTES = settings.max_import_media_bytes
CHUNK_SIZE_LIMIT = settings.chunk_size_limit
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
BLOB_DIR.mkdir(parents=True, exist_ok=True)
BLOB_UPLOAD_TMP_DIR.mkdir(parents=True, exist_ok=True)

HEX_ID_RE = re.compile(r"^[a-f0-9]{32,64}$")
USERNAME_LOOKUP_RE = re.compile(r"^[a-z0-9_.@-]{3,40}$")
SAFE_TEXT_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
EMAIL_REQUEST_COOLDOWN_SECONDS = 30
DEVICE_REVOKED_VISIBLE_DAYS = 7
DEVICE_REVOKED_PURGE_DAYS = 30
DEVICE_LINK_PURGE_DAYS = 7
APP_BUILD = "v73_share_reachability_verified"
PUSH_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="chate-push")


def reject_control_chars(value: str, field: str) -> str:
    if SAFE_TEXT_RE.search(value):
        raise HTTPException(status_code=400, detail=f"{field} contains invalid control characters")
    return value


def require_hex_id(value: str, field: str = "id") -> str:
    candidate = (value or "").strip().lower()
    if not HEX_ID_RE.fullmatch(candidate):
        raise HTTPException(status_code=400, detail=f"Invalid {field}")
    return candidate


def resolve_under(root: Path, candidate: Path) -> Path:
    root_resolved = root.resolve()
    candidate_resolved = candidate.resolve()
    if root_resolved != candidate_resolved and root_resolved not in candidate_resolved.parents:
        raise HTTPException(status_code=403, detail="Invalid storage path")
    return candidate_resolved


def escape_like_term(value: str) -> str:
    # SQLAlchemy still parameterizes LIKE values, but escaping wildcards prevents
    # attackers from turning a tiny search into a full-table wildcard scan.
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def clean_short_text(value: str | None, *, max_len: int, field: str) -> str | None:
    if value is None:
        return None
    cleaned = reject_control_chars(value.strip(), field)
    if len(cleaned) > max_len:
        raise HTTPException(status_code=400, detail=f"{field} is too long")
    return cleaned or None



def _fallback_user_profile(user: User) -> dict:
    return {
        "username": user.username,
        "email": user.email,
        "display_name": user.display_name or user.username,
        "avatar_url": user.avatar_url,
        "bio": user.bio,
    }


def get_user_profile(user: User) -> dict:
    encrypted = getattr(user, "encrypted_profile_json", None)
    if encrypted:
        profile = unprotect_json(encrypted, PROFILE_AAD)
        if profile and "_error" not in profile:
            return {
                "username": str(profile.get("username") or user.username),
                "email": str(profile.get("email") or user.email),
                "display_name": profile.get("display_name") or profile.get("username") or user.display_name,
                "avatar_url": profile.get("avatar_url") or None,
                "bio": profile.get("bio") or None,
            }
    return _fallback_user_profile(user)


def get_user_username(user: User) -> str:
    return str(get_user_profile(user).get("username") or user.username)


def get_user_email(user: User) -> str:
    return str(get_user_profile(user).get("email") or user.email).lower()


def set_user_profile_encrypted(
    user: User,
    *,
    username: str | None = None,
    email: str | None = None,
    display_name: str | None = None,
    avatar_url: str | None = None,
    bio: str | None = None,
) -> None:
    current = get_user_profile(user)
    username = (username or current.get("username") or user.username).strip().lower()
    email = (email or current.get("email") or user.email).strip().lower()
    data = {
        "username": username,
        "email": email,
        "display_name": display_name if display_name is not None else current.get("display_name"),
        "avatar_url": avatar_url if avatar_url is not None else current.get("avatar_url"),
        "bio": bio if bio is not None else current.get("bio"),
    }
    user.username_lookup_hash = blind_index("username", username)
    user.email_lookup_hash = blind_index("email", email)
    user.encrypted_profile_json = protect_json(data, PROFILE_AAD)
    if protect_plaintext_columns() and user.id:
        user.username = opaque_username(user.id)
        user.email = opaque_email(user.id)
        user.display_name = None
        user.avatar_url = None
        user.bio = None
    else:
        user.username = username
        user.email = email
        user.display_name = data.get("display_name") or username
        user.avatar_url = data.get("avatar_url")
        user.bio = data.get("bio")


def find_user_by_login(db: Session, login_value: str) -> User | None:
    value = login_value.strip().lower()
    username_hash = blind_index("username", value)
    email_hash = blind_index("email", value)
    user = db.scalar(select(User).where(or_(User.username_lookup_hash == username_hash, User.email_lookup_hash == email_hash)))
    if user:
        return user
    # Backward compatibility for old/unmigrated local databases.
    return db.scalar(select(User).where(or_(User.username == value, User.email == value)))


def find_user_by_email(db: Session, email: str) -> User | None:
    value = email.strip().lower()
    email_hash = blind_index("email", value)
    user = db.scalar(select(User).where(User.email_lookup_hash == email_hash))
    if user:
        return user
    return db.scalar(select(User).where(User.email == value))


def find_user_by_username(db: Session, username: str) -> User | None:
    value = username.strip().lower()
    username_hash = blind_index("username", value)
    user = db.scalar(select(User).where(User.username_lookup_hash == username_hash))
    if user:
        return user
    return db.scalar(select(User).where(User.username == value))


def app_state_get(db: Session, key: str) -> str | None:
    try:
        return db.execute(text("SELECT value FROM app_state WHERE key = :key"), {"key": key}).scalar_one_or_none()
    except Exception:
        return None


def app_state_set(db: Session, key: str, value: str) -> None:
    db.execute(
        text("""
            INSERT INTO app_state(key, value, updated_at) VALUES (:key, :value, :updated_at)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """),
        {"key": key, "value": value, "updated_at": utcnow()},
    )


def harden_existing_user_metadata() -> None:
    """Backfill encrypted profile blobs and blind indexes for existing SQLite installs.

    This intentionally keeps routing IDs because the MVP server still needs them for
    auth, delivery, blocks, and device approval. What it hides from a raw DB dump is
    usernames, emails, display names, bios, avatar paths, and client ciphertext fields.
    """
    if not metadata_crypto_enabled():
        return
    db = SessionLocal()
    try:
        already_marked_done = app_state_get(db, "metadata_profile_harden_v1_done") == "1"
        if already_marked_done:
            missing = db.scalar(
                select(func.count()).select_from(User).where(or_(
                    User.username_lookup_hash.is_(None),
                    User.email_lookup_hash.is_(None),
                    User.encrypted_profile_json.is_(None),
                ))
            ) or 0
            if not missing:
                return
        changed = False
        for user in db.scalars(select(User)).all():
            if not getattr(user, "encrypted_profile_json", None):
                set_user_profile_encrypted(
                    user,
                    username=user.username,
                    email=user.email,
                    display_name=user.display_name or user.username,
                    avatar_url=user.avatar_url,
                    bio=user.bio,
                )
                changed = True
            elif not getattr(user, "username_lookup_hash", None) or not getattr(user, "email_lookup_hash", None):
                profile = get_user_profile(user)
                set_user_profile_encrypted(
                    user,
                    username=str(profile.get("username") or user.username),
                    email=str(profile.get("email") or user.email),
                    display_name=profile.get("display_name"),
                    avatar_url=profile.get("avatar_url"),
                    bio=profile.get("bio"),
                )
                changed = True
        app_state_set(db, "metadata_profile_harden_v1_done", "1")
        db.commit()
    finally:
        db.close()



def harden_existing_message_storage() -> None:
    """Wrap already-client-encrypted message fields with server-side field encryption.

    This is the requested second encryption layer. The backend unwraps before returning
    to the browser, so the browser E2EE protocol remains unchanged.
    """
    if not metadata_crypto_enabled():
        return
    db = SessionLocal()
    try:
        if app_state_get(db, "metadata_message_harden_v1_done") == "1":
            return
        changed = False
        for row in db.scalars(select(Message).limit(20000)).all():
            if row.ciphertext and not str(row.ciphertext).startswith("chate-meta-v1:"):
                row.ciphertext = protect_message_field(row.ciphertext) or ""
                changed = True
            if row.iv and not str(row.iv).startswith("chate-meta-v1:"):
                row.iv = protect_message_field(row.iv) or ""
                changed = True
            if row.encrypted_key_for_receiver and not str(row.encrypted_key_for_receiver).startswith("chate-meta-v1:"):
                row.encrypted_key_for_receiver = protect_message_field(row.encrypted_key_for_receiver) or ""
                changed = True
            if row.encrypted_key_for_sender and not str(row.encrypted_key_for_sender).startswith("chate-meta-v1:"):
                row.encrypted_key_for_sender = protect_message_field(row.encrypted_key_for_sender) or ""
                changed = True
        for session in db.scalars(select(MessageKeySession).limit(20000)).all():
            if session.encrypted_key_for_receiver and not str(session.encrypted_key_for_receiver).startswith("chate-meta-v1:"):
                session.encrypted_key_for_receiver = protect_session_field(session.encrypted_key_for_receiver) or ""
                changed = True
            if session.encrypted_key_for_sender and not str(session.encrypted_key_for_sender).startswith("chate-meta-v1:"):
                session.encrypted_key_for_sender = protect_session_field(session.encrypted_key_for_sender) or ""
                changed = True
        for report in db.scalars(select(UserReport).limit(20000)).all():
            if report.details and not str(report.details).startswith("chate-meta-v1:"):
                report.details = protect_text(report.details, REPORT_AAD)
                changed = True
            if report.evidence_json and not str(report.evidence_json).startswith("chate-meta-v1:"):
                report.evidence_json = protect_text(report.evidence_json, REPORT_AAD)
                changed = True
        app_state_set(db, "metadata_message_harden_v1_done", "1")
        db.commit()
    finally:
        db.close()

def protect_message_field(value: str | None) -> str | None:
    return protect_text(value, MESSAGE_AAD)


def unprotect_message_field(value: str | None) -> str | None:
    return unprotect_text(value, MESSAGE_AAD)


def protect_session_field(value: str | None) -> str | None:
    return protect_text(value, SESSION_AAD)


def unprotect_session_field(value: str | None) -> str | None:
    return unprotect_text(value, SESSION_AAD)


def key_session_to_dict(session: MessageKeySession) -> dict:
    return {
        "id": session.id,
        "sender_id": session.sender_id,
        "receiver_id": session.receiver_id,
        "encrypted_key_for_receiver": unprotect_session_field(session.encrypted_key_for_receiver) or "",
        "encrypted_key_for_sender": unprotect_session_field(session.encrypted_key_for_sender) or "",
        "created_at": session.created_at,
        "expires_at": session.expires_at,
    }

def validate_local_avatar_url(value: str | None) -> str | None:
    if not value:
        return None
    url = reject_control_chars(value.strip(), "avatar_url")
    if not url.startswith("/uploads/avatars/"):
        raise HTTPException(status_code=400, detail="Avatar URL must be a ChatE uploaded avatar")
    # Prevent browser-path tricks. The actual avatar upload route generates safe names.
    if ".." in url or "\\" in url or "%2f" in url.lower():
        raise HTTPException(status_code=400, detail="Invalid avatar URL")
    return url[:500]


harden_existing_user_metadata()
harden_existing_message_storage()

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

app = FastAPI(title=settings.app_name, version="0.73.0")
PUSH_LOG = logging.getLogger("chate.push")

if settings.environment == "production" and settings.secret_key in {"CHANGE_ME_FOR_PRODUCTION", "dev-secret", "secret"}:
    raise RuntimeError("Set CHATE_SECRET_KEY to a strong random value before running in production.")

# In-memory MVP presence store. This is fine for local/dev and Cloudflare quick-tunnel testing.
# Production needs Redis or database-backed presence across workers.
PRESENCE: dict[int, dict] = {}
PRESENCE_TTL_SECONDS = 30
TRANSIENT_STATUS_TTL_SECONDS = 8


def push_endpoint_hash(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


_VAPID_PRIVATE_KEY_CACHE: str | None = None
_VAPID_PRIVATE_KEY_STATUS_CACHE: tuple[bool, str] | None = None


def _b64url_no_pad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _raw_vapid_private_key() -> str:
    raw = (settings.vapid_private_key or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        raw = raw[1:-1].strip()
    return raw.replace("\\n", "\n").strip()


def normalized_vapid_private_key() -> str:
    """Return the VAPID private key in the format pywebpush expects.

    pywebpush/py-vapid expects CHATE_VAPID_PRIVATE_KEY as base64url DER.
    Older ChatE builds printed a one-line PEM key instead. Accept both so existing
    .env files keep working, but normalize PEM -> base64url DER before calling
    pywebpush. This fixes: "Could not deserialize key data / ASN.1 invalid length".
    """
    global _VAPID_PRIVATE_KEY_CACHE
    if _VAPID_PRIVATE_KEY_CACHE is not None:
        return _VAPID_PRIVATE_KEY_CACHE

    raw = _raw_vapid_private_key()
    if not raw:
        _VAPID_PRIVATE_KEY_CACHE = ""
        return ""

    if "-----BEGIN" in raw and "PRIVATE KEY-----" in raw:
        try:
            from cryptography.hazmat.primitives import serialization

            key = serialization.load_pem_private_key(raw.encode("utf-8"), password=None)
            der = key.private_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
            _VAPID_PRIVATE_KEY_CACHE = _b64url_no_pad(der)
            return _VAPID_PRIVATE_KEY_CACHE
        except Exception as exc:
            PUSH_LOG.warning("Could not normalize PEM VAPID private key: %s", exc)
            _VAPID_PRIVATE_KEY_CACHE = raw
            return raw

    # Already pywebpush-native base64url DER.
    _VAPID_PRIVATE_KEY_CACHE = raw
    return raw


def vapid_private_key_status() -> tuple[bool, str]:
    """Return (usable, detail) for the configured VAPID private key."""
    global _VAPID_PRIVATE_KEY_STATUS_CACHE
    if _VAPID_PRIVATE_KEY_STATUS_CACHE is not None:
        return _VAPID_PRIVATE_KEY_STATUS_CACHE
    key = normalized_vapid_private_key()
    if not key:
        _VAPID_PRIVATE_KEY_STATUS_CACHE = (False, "missing CHATE_VAPID_PRIVATE_KEY")
        return _VAPID_PRIVATE_KEY_STATUS_CACHE
    try:
        from py_vapid import Vapid

        Vapid.from_string(private_key=key)
        _VAPID_PRIVATE_KEY_STATUS_CACHE = (True, "valid")
    except Exception as exc:
        _VAPID_PRIVATE_KEY_STATUS_CACHE = (False, f"invalid VAPID private key: {exc}")
    return _VAPID_PRIVATE_KEY_STATUS_CACHE


def push_available() -> bool:
    private_ok, _ = vapid_private_key_status()
    return bool(settings.vapid_public_key and private_ok and webpush is not None)


def push_unavailable_reason() -> str:
    missing = []
    if webpush is None:
        missing.append("pywebpush")
    if not settings.vapid_public_key:
        missing.append("CHATE_VAPID_PUBLIC_KEY")
    private_ok, private_detail = vapid_private_key_status()
    if not private_ok:
        missing.append(private_detail)
    return ", ".join(missing) or "unknown"

def _safe_push_endpoint_label(endpoint: str) -> str:
    try:
        parsed = urlparse(endpoint)
        return f"{parsed.netloc}{parsed.path[:16]}…"
    except Exception:
        return "unknown-endpoint"


def send_web_push(subscription: dict, payload: dict) -> str:
    """Best-effort Web Push send. Never call this on the request hot path.

    Return values: sent | stale | failed | unavailable. Only stale subscriptions
    should be revoked. Misconfigured VAPID should not delete good browser rows.
    """
    if not push_available():
        PUSH_LOG.warning("Web Push unavailable: %s", push_unavailable_reason())
        return "unavailable"
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload, separators=(",", ":")),
            vapid_private_key=normalized_vapid_private_key(),
            vapid_claims={"sub": settings.vapid_subject},
        )
        PUSH_LOG.info("Web Push sent to %s", _safe_push_endpoint_label(subscription.get("endpoint", "")))
        return "sent"
    except WebPushException as exc:
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        PUSH_LOG.warning("Web Push failed status=%s endpoint=%s", status_code, _safe_push_endpoint_label(subscription.get("endpoint", "")))
        return "stale" if status_code in {404, 410} else "failed"
    except Exception as exc:
        PUSH_LOG.exception("Web Push failed before provider response: %s", exc)
        return "failed"


def send_background_pushes(user_id: int, payload: dict) -> None:
    """Runs in a worker thread so message sending does not wait for push providers."""
    db = SessionLocal()
    try:
        rows = db.scalars(
            select(PushSubscription).where(
                PushSubscription.user_id == user_id,
                PushSubscription.revoked_at.is_(None),
            )
        ).all()
        if not rows:
            PUSH_LOG.info("No active push subscriptions for user_id=%s; background notification skipped", user_id)
            return
        stale: list[PushSubscription] = []
        counts = {"sent": 0, "failed": 0, "stale": 0, "unavailable": 0}
        for row in rows:
            info = {"endpoint": row.endpoint, "keys": {"p256dh": row.p256dh, "auth": row.auth}}
            result = send_web_push(info, payload)
            counts[result] = counts.get(result, 0) + 1
            if result == "stale":
                row.revoked_at = utcnow()
                stale.append(row)
        if stale:
            db.commit()
        PUSH_LOG.info("Push delivery summary user_id=%s sent=%s failed=%s stale=%s unavailable=%s",
                      user_id, counts.get("sent", 0), counts.get("failed", 0),
                      counts.get("stale", 0), counts.get("unavailable", 0))
    finally:
        db.close()


def queue_push_thread(receiver_id: int, payload: dict) -> None:
    # Keep push delivery off the send hot path without spawning unbounded threads.
    # A small pool is enough because Web Push is best-effort and stale endpoints are
    # cleaned asynchronously. Under bursty chat traffic this avoids CPU/context-switch
    # spikes on weak machines.
    try:
        PUSH_EXECUTOR.submit(send_background_pushes, receiver_id, payload)
    except Exception:
        worker = threading.Thread(target=send_background_pushes, args=(receiver_id, payload), daemon=True)
        worker.start()


def queue_message_push(receiver_id: int, sender: User, message_id: int, message_type: str) -> None:
    """Queue a privacy-preserving Web Push notification only for closed/offline clients.

    If the recipient currently has an active WebSocket connection, the foreground
    app already receives the message:new event and can show exactly one in-app
    toast/local notification. Sending Web Push as well creates the duplicate
    notification the user reported. Closed browsers/PWAs have no socket, so they
    still receive server-side Web Push.

    MVP caveat: HUB is in-memory, so this active-client check is per-process. A
    multi-worker production deployment should move HUB/presence to Redis/pubsub.
    """
    if HUB.connections.get(receiver_id):
        PUSH_LOG.info("Push skipped for user_id=%s message_id=%s because active realtime client is connected", receiver_id, message_id)
        return
    sender_name = get_user_profile(sender).get("display_name") or get_user_username(sender)
    body_by_type = {
        "text": "New encrypted message",
        "image": "Sent an encrypted image",
        "video": "Sent an encrypted video",
        "voice": "Sent an encrypted voice note",
        "file": "Sent an encrypted file",
        "gif": "Sent an encrypted GIF",
        "sticker": "Sent an encrypted sticker",
    }
    payload = {
        "type": "message",
        "title": f"{sender_name} on ChatE",
        "body": body_by_type.get(message_type, "New encrypted message"),
        "sender_id": sender.id,
        "message_id": message_id,
        "url": f"/?chat={sender.id}&focus=reply&message_id={message_id}",
    }
    queue_push_thread(receiver_id, payload)

# Keep high-frequency chat requests cheap on low-end laptops. The old path ran
# cleanup queries and wrote last_seen on nearly every authenticated API call.
# That made SQLite serialize too many writes and caused message send/load lag.
CLEANUP_LAST_RUN_MONO = 0.0
LAST_SEEN_DB_WRITE_MONO: dict[int, float] = {}


class RealtimeHub:
    """In-memory WebSocket event highway for the MVP.

    This replaces aggressive client polling for active sessions. It is intentionally
    in-memory for local/dev and Cloudflare Quick Tunnel testing. Production should
    move this to Redis pub/sub so multiple Uvicorn workers and servers can share
    events.
    """

    def __init__(self) -> None:
        self.connections: dict[int, set[WebSocket]] = {}

    async def connect(self, user_id: int, websocket: WebSocket, subprotocol: str | None = None) -> None:
        await websocket.accept(subprotocol=subprotocol)
        self.connections.setdefault(user_id, set()).add(websocket)

    def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        sockets = self.connections.get(user_id)
        if not sockets:
            return
        sockets.discard(websocket)
        if not sockets:
            self.connections.pop(user_id, None)

    def has_connections(self, user_id: int) -> bool:
        return bool(self.connections.get(user_id))

    async def _send_one(self, user_id: int, websocket: WebSocket, event: dict) -> bool:
        try:
            await websocket.send_json(event)
            return True
        except Exception:
            self.disconnect(user_id, websocket)
            return False

    async def send_to_user(self, user_id: int, event: dict) -> int:
        sockets = list(self.connections.get(user_id, set()))
        if not sockets:
            return 0
        results = await asyncio.gather(*(self._send_one(user_id, ws, event) for ws in sockets), return_exceptions=True)
        return sum(1 for item in results if item is True)

    async def fanout(self, user_ids: set[int], event: dict) -> None:
        targets = [int(uid) for uid in user_ids if uid is not None]
        if not targets:
            return
        await asyncio.gather(*(self.send_to_user(uid, event) for uid in targets), return_exceptions=True)


HUB = RealtimeHub()


def public_key_fingerprint(public_key_jwk: dict) -> str:
    identity = {
        "kty": public_key_jwk.get("kty") or "RSA",
        "n": public_key_jwk.get("n"),
        "e": public_key_jwk.get("e"),
    }
    raw = json.dumps(identity, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode("ascii").rstrip("=")


def assert_public_key_jwk(public_key_jwk: dict) -> None:
    if not isinstance(public_key_jwk, dict):
        raise HTTPException(status_code=400, detail="Invalid public key")
    if public_key_jwk.get("kty") != "RSA" or public_key_jwk.get("alg") not in {None, "RSA-OAEP-256"}:
        raise HTTPException(status_code=400, detail="Only RSA-OAEP public keys are accepted")
    if not isinstance(public_key_jwk.get("n"), str) or not isinstance(public_key_jwk.get("e"), str):
        raise HTTPException(status_code=400, detail="Public key is missing RSA modulus/exponent")
    if len(public_key_jwk["n"]) < 300 or len(public_key_jwk["e"]) < 2:
        raise HTTPException(status_code=400, detail="Public key is too weak or malformed")


def parse_public_key_jwk(raw: str | None) -> dict | None:
    """Return a valid RSA-OAEP public JWK or None for old/corrupt local rows.

    Older MVP databases and interrupted key resets can leave public_key_jwk blank,
    null-ish, or malformed. Never let that produce a 500 or a vague frontend
    "Missing public key" crash; expose a repairable state instead.
    """
    if not raw:
        return None
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None
    try:
        assert_public_key_jwk(parsed)
    except HTTPException:
        return None
    return parsed


def require_user_public_key(user: User, detail: str = "User encryption public key is missing. Ask them to log in once so ChatE can repair the key.") -> dict:
    public_key = parse_public_key_jwk(getattr(user, "public_key_jwk", None))
    if not public_key:
        raise HTTPException(status_code=409, detail=detail)
    return public_key


def add_key_event(db: Session, user_id: int, public_key_jwk: dict, event_type: str) -> None:
    db.add(UserKeyEvent(user_id=user_id, fingerprint=public_key_fingerprint(public_key_jwk), event_type=event_type, created_at=utcnow()))


# Login/register brute-force throttling. In-memory for MVP; production should move to Redis.
AUTH_FAILURES: dict[str, list[float]] = {}
AUTH_LOCK_SECONDS = 10 * 60
AUTH_FAIL_WINDOW_SECONDS = 10 * 60
AUTH_MAX_FAILURES = 10


def auth_bucket_key(request: Request, login_hint: str = "") -> str:
    client = request.client.host if request.client else "unknown"
    return f"{client}:{login_hint.strip().lower()[:80]}"


def auth_failures_for(key: str, now: float) -> list[float]:
    return [ts for ts in AUTH_FAILURES.get(key, []) if ts >= now - AUTH_FAIL_WINDOW_SECONDS]


def reject_if_auth_locked(request: Request, login_hint: str = "") -> None:
    import time
    key = auth_bucket_key(request, login_hint)
    failures = auth_failures_for(key, time.time())
    AUTH_FAILURES[key] = failures
    if len(failures) >= AUTH_MAX_FAILURES:
        raise HTTPException(status_code=429, detail="Too many failed login attempts. Wait 10 minutes and try again.")


def record_auth_failure(request: Request, login_hint: str = "") -> None:
    import time
    key = auth_bucket_key(request, login_hint)
    failures = auth_failures_for(key, time.time())
    failures.append(time.time())
    AUTH_FAILURES[key] = failures


def clear_auth_failures(request: Request, login_hint: str = "") -> None:
    AUTH_FAILURES.pop(auth_bucket_key(request, login_hint), None)


def current_presence_for(user: User, viewer_id: int | None = None) -> PresenceOut:
    now = utcnow()
    record = PRESENCE.get(user.id)
    status_value = "offline"
    peer_id = None
    last_seen = user.last_seen_at
    if record:
        peer_id = record.get("peer_id")
        expires_at = record.get("expires_at", now)
        record_status = record.get("status", "offline")
        updated_at = record.get("updated_at")
        if updated_at:
            last_seen = updated_at
        if record_status in {"typing", "recording"}:
            if expires_at > now and (viewer_id is None or peer_id == viewer_id):
                status_value = record_status
            elif last_seen and last_seen + timedelta(seconds=PRESENCE_TTL_SECONDS) > now:
                status_value = "online"
        elif record_status == "offline":
            status_value = "offline"
        elif expires_at > now:
            status_value = record_status
        elif last_seen and last_seen + timedelta(seconds=PRESENCE_TTL_SECONDS) > now:
            status_value = "online"
    elif last_seen and last_seen + timedelta(seconds=PRESENCE_TTL_SECONDS) > now:
        status_value = "online"
    return PresenceOut(user_id=user.id, status=status_value, last_seen_at=last_seen, peer_id=peer_id)


def apply_presence(user: User, db: Session, status_value: str = "online", peer_id: int | None = None) -> PresenceOut:
    import time

    now = utcnow()
    ttl = TRANSIENT_STATUS_TTL_SECONDS if status_value in {"typing", "recording"} else PRESENCE_TTL_SECONDS
    if status_value == "offline":
        PRESENCE[user.id] = {"status": "offline", "peer_id": peer_id, "updated_at": now, "expires_at": now}
    else:
        PRESENCE[user.id] = {"status": status_value, "peer_id": peer_id, "updated_at": now, "expires_at": now + timedelta(seconds=ttl)}

    # Persist last_seen sparingly. Presence is served from memory while the app is
    # open; the DB only needs periodic durability. This removes a write+commit from
    # every heartbeat and from most API requests.
    now_mono = time.monotonic()
    write_interval = max(10, int(getattr(settings, "last_seen_write_seconds", 45)))
    last_write = LAST_SEEN_DB_WRITE_MONO.get(user.id, 0.0)
    should_write = status_value == "offline" or now_mono - last_write >= write_interval
    if should_write:
        user.last_seen_at = now
        db.commit()
        LAST_SEEN_DB_WRITE_MONO[user.id] = now_mono
    return PresenceOut(user_id=user.id, status=status_value, last_seen_at=now, peer_id=peer_id)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_hosts)
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Low-cost production guardrails. This is not a replacement for a real edge proxy,
# but it blocks accidental request floods and adds baseline browser security headers.
RATE_BUCKETS: dict[str, deque[float]] = {}
RATE_BUCKET_LAST_PRUNE = 0.0


@app.middleware("http")
async def production_guardrails(request: Request, call_next):
    import time
    global RATE_BUCKET_LAST_PRUNE

    path = request.url.path
    client = request.client.host if request.client else "unknown"
    now = time.time()
    window_start = now - 60
    bucket = RATE_BUCKETS.setdefault(client, deque())
    while bucket and bucket[0] < window_start:
        bucket.popleft()
    if len(RATE_BUCKETS) > 5000 and now - RATE_BUCKET_LAST_PRUNE > 30:
        RATE_BUCKET_LAST_PRUNE = now
        stale_clients = [ip for ip, hits in RATE_BUCKETS.items() if not hits or hits[-1] < window_start]
        for ip in stale_clients[:2500]:
            RATE_BUCKETS.pop(ip, None)
    if len(bucket) >= settings.rate_limit_per_minute and not path.startswith(("/css", "/js", "/assets")):
        return Response("Rate limit exceeded", status_code=429)
    bucket.append(now)

    response = await call_next(request)
    response.headers.setdefault("X-ChatE-Build", APP_BUILD)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=()")
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "media-src 'self' data: blob:; "
        "connect-src 'self' ws: wss:; "
        "font-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self'"
    )
    if path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    elif path.startswith("/assets/"):
        response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    elif path.startswith(("/js/", "/css/")) and "v=" in request.url.query:
        response.headers.setdefault("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800")
    elif path in {"/", "/settings", "/sw.js", "/offline.html", "/manifest.webmanifest"} or path.startswith(("/js/", "/css/")):
        # HTML/service-worker shells must revalidate; versioned assets above are cacheable.
        response.headers.setdefault("Cache-Control", "no-cache, must-revalidate")
    if settings.environment == "production":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response

app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")
app.mount("/uploads/avatars", StaticFiles(directory=AVATAR_DIR), name="avatars")


def user_to_public(user: User, include_email: bool = False, include_public_key: bool = False) -> PublicUser:
    """Return user data with display/privacy controls applied.

    The database may store profile data in encrypted_profile_json while username/email
    columns are opaque compatibility values. This function decrypts only for API output.
    """
    profile = get_user_profile(user)
    real_username = str(profile.get("username") or user.username)
    real_email = str(profile.get("email") or user.email)
    display_name = profile.get("display_name")
    avatar_url = profile.get("avatar_url")
    bio = profile.get("bio")

    is_owner_view = include_email
    show_display_name = bool(getattr(user, "public_show_display_name", True)) or is_owner_view
    show_avatar = bool(getattr(user, "public_show_avatar", True)) or is_owner_view
    show_bio = bool(getattr(user, "public_show_bio", True)) or is_owner_view
    show_last_seen = bool(getattr(user, "public_show_last_seen", False)) or is_owner_view
    show_email = bool(getattr(user, "public_show_email", False)) or is_owner_view
    return PublicUser(
        id=user.id,
        username=real_username,
        email=real_email if show_email else None,
        display_name=display_name if show_display_name else None,
        avatar_url=avatar_url if show_avatar else None,
        bio=bio if show_bio else None,
        public_key_jwk=parse_public_key_jwk(user.public_key_jwk) if include_public_key else None,
        created_at=user.created_at,
        deletion_requested_at=user.deletion_requested_at if is_owner_view else None,
        deletion_scheduled_at=user.deletion_scheduled_at if is_owner_view else None,
        last_login_at=user.last_login_at if is_owner_view else None,
        last_seen_at=user.last_seen_at if show_last_seen else None,
        auto_delete_after_days=user.auto_delete_after_days if is_owner_view else None,
        email_verified_at=user.email_verified_at if is_owner_view else None,
        default_disappearing_seconds=user.default_disappearing_seconds if is_owner_view else None,
        public_show_email=bool(getattr(user, "public_show_email", False)),
        public_show_display_name=bool(getattr(user, "public_show_display_name", True)),
        public_show_avatar=bool(getattr(user, "public_show_avatar", True)),
        public_show_bio=bool(getattr(user, "public_show_bio", True)),
        public_show_last_seen=bool(getattr(user, "public_show_last_seen", False)),
    )


def message_to_dict(msg: Message, db: Session | None = None) -> dict:
    data = {
        "id": msg.id,
        "sender_id": msg.sender_id,
        "receiver_id": msg.receiver_id,
        "message_type": msg.message_type,
        "client_message_id": msg.client_message_id,
        "ciphertext": unprotect_message_field(msg.ciphertext) or "",
        "iv": unprotect_message_field(msg.iv) or "",
        "encrypted_key_for_receiver": unprotect_message_field(msg.encrypted_key_for_receiver),
        "encrypted_key_for_sender": unprotect_message_field(msg.encrypted_key_for_sender),
        "key_session_id": msg.key_session_id,
        "blob_id": msg.blob_id,
        "blob_url": f"/api/blobs/{msg.blob_id}" if msg.blob_id else None,
        "session_encrypted_key_for_receiver": None,
        "session_encrypted_key_for_sender": None,
        "session_expires_at": None,
        "created_at": msg.created_at,
        "expires_at": getattr(msg, "expires_at", None),
        "edited_at": getattr(msg, "edited_at", None),
        "reply_to_id": getattr(msg, "reply_to_id", None),
        "reactions": [],
        "delivered_at": msg.delivered_at,
        "read_at": msg.read_at,
    }
    if db is not None:
        reactions = db.scalars(select(MessageReaction).where(MessageReaction.message_id == msg.id).order_by(MessageReaction.created_at.asc())).all()
        reaction_out = []
        for reaction in reactions:
            reactor = db.get(User, reaction.user_id)
            reaction_out.append({
                "emoji": reaction.emoji,
                "user_id": reaction.user_id,
                "username": get_user_username(reactor) if reactor else None,
                "created_at": reaction.created_at,
            })
        data["reactions"] = reaction_out
    if db is not None and msg.key_session_id:
        session = db.get(MessageKeySession, msg.key_session_id)
        if session:
            data["session_encrypted_key_for_receiver"] = unprotect_session_field(session.encrypted_key_for_receiver)
            data["session_encrypted_key_for_sender"] = unprotect_session_field(session.encrypted_key_for_sender)
            data["session_expires_at"] = session.expires_at
    return data


def messages_to_dicts(db: Session, rows: list[Message], *, include_reactions: bool = True) -> list[dict]:
    """Serialize message pages without N+1 queries.

    The old MVP called db.get()/reaction queries for every message. On SQLite,
    that becomes visible lag on weak laptops. This batches key-session lookup,
    reactions, and reactor usernames for the whole page.
    """
    if not rows:
        return []
    out_by_id = {row.id: message_to_dict(row, None) for row in rows}

    session_ids = sorted({row.key_session_id for row in rows if row.key_session_id})
    if session_ids:
        sessions = db.scalars(select(MessageKeySession).where(MessageKeySession.id.in_(session_ids))).all()
        session_map = {session.id: session for session in sessions}
        for row in rows:
            if row.key_session_id and row.key_session_id in session_map:
                session = session_map[row.key_session_id]
                item = out_by_id[row.id]
                item["session_encrypted_key_for_receiver"] = unprotect_session_field(session.encrypted_key_for_receiver)
                item["session_encrypted_key_for_sender"] = unprotect_session_field(session.encrypted_key_for_sender)
                item["session_expires_at"] = session.expires_at

    if include_reactions:
        message_ids = [row.id for row in rows]
        reactions = db.scalars(
            select(MessageReaction)
            .where(MessageReaction.message_id.in_(message_ids))
            .order_by(MessageReaction.created_at.asc())
        ).all()
        reactor_ids = sorted({reaction.user_id for reaction in reactions})
        reactors = db.scalars(select(User).where(User.id.in_(reactor_ids))).all() if reactor_ids else []
        username_by_id = {user.id: get_user_username(user) for user in reactors}
        for reaction in reactions:
            out_by_id[reaction.message_id]["reactions"].append({
                "emoji": reaction.emoji,
                "user_id": reaction.user_id,
                "username": username_by_id.get(reaction.user_id),
                "created_at": reaction.created_at,
            })

    return [out_by_id[row.id] for row in rows]


def settings_to_out(user: User) -> AccountSettingsOut:
    profile = get_user_profile(user)
    return AccountSettingsOut(
        username=str(profile.get("username") or user.username),
        email=str(profile.get("email") or user.email),
        display_name=profile.get("display_name"),
        avatar_url=profile.get("avatar_url"),
        bio=profile.get("bio"),
        last_login_at=user.last_login_at,
        last_seen_at=user.last_seen_at,
        auto_delete_after_days=user.auto_delete_after_days,
        default_disappearing_seconds=user.default_disappearing_seconds,
        email_verified_at=user.email_verified_at,
        deletion_requested_at=user.deletion_requested_at,
        deletion_scheduled_at=user.deletion_scheduled_at,
        public_show_email=bool(getattr(user, "public_show_email", False)),
        public_show_display_name=bool(getattr(user, "public_show_display_name", True)),
        public_show_avatar=bool(getattr(user, "public_show_avatar", True)),
        public_show_bio=bool(getattr(user, "public_show_bio", True)),
        public_show_last_seen=bool(getattr(user, "public_show_last_seen", False)),
    )



def blob_to_out(blob: EncryptedBlob) -> BlobOut:
    return BlobOut(
        id=blob.id,
        owner_id=blob.owner_id,
        receiver_id=blob.receiver_id,
        original_name=None,
        mime_type=None,
        size_bytes=blob.size_bytes,
        download_url=f"/api/blobs/{blob.id}",
        created_at=blob.created_at,
    )


def safe_delete_blob_file(blob: EncryptedBlob | None) -> None:
    if not blob:
        return
    try:
        path = Path(blob.storage_path)
        if path.exists() and path.is_file():
            path.unlink()
    except Exception:
        # Best-effort cleanup; do not fail user-facing deletion on local FS race/permissions.
        pass

def cleanup_expired_messages(db: Session) -> None:
    """Remove expired disappearing messages with bulk DB work.

    The old loop loaded ORM Message rows, then db.get()'d every blob. On an old
    laptop with SQLite that becomes a visible pause. This path fetches only the
    ids we need, deletes files best-effort, then uses bulk DELETE statements.
    """
    now = utcnow()
    rows = db.execute(
        select(Message.id, Message.blob_id)
        .where(Message.expires_at.is_not(None), Message.expires_at <= now)
        .order_by(Message.expires_at.asc())
        .limit(500)
    ).all()
    if not rows:
        return

    message_ids = [int(row[0]) for row in rows]
    blob_ids = [row[1] for row in rows if row[1]]
    if blob_ids:
        blobs = db.scalars(select(EncryptedBlob).where(EncryptedBlob.id.in_(blob_ids))).all()
        for blob in blobs:
            safe_delete_blob_file(blob)
        db.execute(delete(EncryptedBlob).where(EncryptedBlob.id.in_(blob_ids)))

    db.execute(delete(MessageReaction).where(MessageReaction.message_id.in_(message_ids)))
    db.execute(delete(Message).where(Message.id.in_(message_ids)))
    db.commit()


def cleanup_due_deleted_accounts(db: Session, *, force: bool = False) -> None:
    global CLEANUP_LAST_RUN_MONO
    import time

    now_mono = time.monotonic()
    interval = max(15, int(getattr(settings, "cleanup_interval_seconds", 60)))
    if not force and now_mono - CLEANUP_LAST_RUN_MONO < interval:
        return
    CLEANUP_LAST_RUN_MONO = now_mono

    cleanup_expired_messages(db)
    cleanup_old_device_rows(db)
    now = utcnow()
    manual_due_users = db.scalars(
        select(User).where(
            User.deletion_scheduled_at.is_not(None),
            User.deletion_scheduled_at <= now,
        )
    ).all()

    inactive_due_users: list[User] = []
    candidates = db.scalars(
        select(User).where(
            User.auto_delete_after_days.is_not(None),
            User.is_deleted == False,  # noqa: E712 - SQLAlchemy comparison
        )
    ).all()
    for user in candidates:
        if not user.auto_delete_after_days or user.auto_delete_after_days <= 0:
            continue
        last_activity = user.last_seen_at or user.last_login_at or user.created_at
        if last_activity + timedelta(days=user.auto_delete_after_days) <= now:
            inactive_due_users.append(user)

    due_by_id = {user.id: user for user in [*manual_due_users, *inactive_due_users]}
    for user in due_by_id.values():
        db.delete(user)
    if due_by_id:
        db.commit()


def touch_seen(user: User, db: Session) -> None:
    user.last_seen_at = utcnow()
    PRESENCE[user.id] = {"status": "online", "peer_id": None, "updated_at": user.last_seen_at, "expires_at": user.last_seen_at + timedelta(seconds=PRESENCE_TTL_SECONDS)}
    db.commit()


def is_blocked_between(db: Session, user_a_id: int, user_b_id: int) -> bool:
    return bool(db.scalar(
        select(BlockedUser.id).where(
            or_(
                and_(BlockedUser.blocker_id == user_a_id, BlockedUser.blocked_id == user_b_id),
                and_(BlockedUser.blocker_id == user_b_id, BlockedUser.blocked_id == user_a_id),
            )
        )
    ))


def blocked_user_to_out(block: BlockedUser, db: Session) -> dict:
    blocked = db.get(User, block.blocked_id)
    return {
        "id": block.id,
        "blocked_user": user_to_public(blocked).model_dump() if blocked else {"id": block.blocked_id, "username": "deleted", "display_name": "Deleted user"},
        "created_at": block.created_at,
    }


def conversation_pair(user_a_id: int, user_b_id: int) -> tuple[int, int]:
    return (user_a_id, user_b_id) if user_a_id < user_b_id else (user_b_id, user_a_id)


def live_message_clause(now: datetime | None = None):
    now = now or utcnow()
    return or_(Message.expires_at.is_(None), Message.expires_at > now)


def get_conversation_setting(db: Session, user_a_id: int, user_b_id: int) -> ConversationSetting | None:
    low, high = conversation_pair(user_a_id, user_b_id)
    return db.scalar(select(ConversationSetting).where(ConversationSetting.user_low_id == low, ConversationSetting.user_high_id == high))


def get_disappearing_seconds_for_send(db: Session, sender: User, receiver_id: int) -> int | None:
    setting = get_conversation_setting(db, sender.id, receiver_id)
    if setting and setting.disappearing_seconds and setting.disappearing_seconds > 0:
        return int(setting.disappearing_seconds)
    if sender.default_disappearing_seconds and sender.default_disappearing_seconds > 0:
        return int(sender.default_disappearing_seconds)
    return None


def link_session_to_out(session: DeviceLinkSession, include_secret: bool = False) -> dict:
    payload = {
        "type": "chate-device-link-v1",
        "session_id": session.id,
        "user_id": session.user_id,
        "new_device_id": session.new_device_id,
        "new_device_name": session.new_device_name,
        "expires_at": session.expires_at.isoformat() + "Z",
    }
    out = {
        "id": session.id,
        "user_id": session.user_id,
        "new_device_id": session.new_device_id,
        "new_device_name": session.new_device_name,
        "status": session.status,
        "created_at": session.created_at,
        "expires_at": session.expires_at,
        "approved_at": session.approved_at,
        "rejected_at": getattr(session, "rejected_at", None),
        "email_requested_at": getattr(session, "email_requested_at", None),
        "email_approved_at": getattr(session, "email_approved_at", None),
        "consumed_at": session.consumed_at,
        "qr_payload": json.dumps(payload, separators=(",", ":")),
    }
    if include_secret:
        try:
            out["new_device_public_key_jwk"] = json.loads(session.new_device_public_key_jwk)
        except Exception:
            out["new_device_public_key_jwk"] = None
    return out


async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    cleanup_due_deleted_accounts(db)

    payload = decode_access_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user = db.get(User, int(payload["sub"]))
    if not user or user.is_deleted:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if token_was_revoked(user, payload):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired. Login again.")
    if user.deletion_requested_at is not None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account deletion is pending. Login again to cancel it.")

    # Inactive deletion should mean actual inactivity, not just failure to type the
    # password again while a valid session token still exists. Keep live presence
    # in memory and only write last_seen to SQLite periodically; otherwise every
    # API request becomes a serialized DB write.
    import time
    now = utcnow()
    record = PRESENCE.get(user.id)
    if not record or record.get("status") not in {"typing", "recording"} or record.get("expires_at", now) <= now:
        PRESENCE[user.id] = {"status": "online", "peer_id": None, "updated_at": now, "expires_at": now + timedelta(seconds=PRESENCE_TTL_SECONDS)}

    now_mono = time.monotonic()
    write_interval = max(10, int(getattr(settings, "last_seen_write_seconds", 45)))
    if now_mono - LAST_SEEN_DB_WRITE_MONO.get(user.id, 0.0) >= write_interval:
        user.last_seen_at = now
        db.commit()
        LAST_SEEN_DB_WRITE_MONO[user.id] = now_mono
    return user



def token_was_revoked(user: User, payload: dict) -> bool:
    if not user.token_revoked_after:
        return False
    try:
        iat = utc_from_timestamp(int(payload.get("iat") or 0))
    except Exception:
        return True
    # JWT iat is second-precision while SQLite DateTime keeps microseconds. Without
    # a small leeway, a fresh login in the same second as a password reset can be
    # falsely treated as revoked. Old sessions remain invalid; this only avoids
    # same-second self-lockout.
    return (iat + timedelta(seconds=2)) < user.token_revoked_after


def recovery_token_hash(token: str) -> str:
    return hashlib.sha256(f"{settings.secret_key}:{token}".encode("utf-8")).hexdigest()


def _cooldown_state_key(scope: str, identity: str) -> str:
    material = f"{scope}:{identity.strip().lower()}"
    digest = hashlib.sha256(f"{settings.secret_key}:{material}".encode("utf-8")).hexdigest()
    return f"email_cooldown:{scope}:{digest}"


EMAIL_REQUEST_INFLIGHT_SECONDS = 20


def app_state_delete(db: Session, key: str) -> None:
    db.execute(text("DELETE FROM app_state WHERE key = :key"), {"key": key})


def begin_email_request(db: Session, scope: str, identity: str, seconds: int = EMAIL_REQUEST_COOLDOWN_SECONDS) -> tuple[str, str]:
    """Reserve an email request without starting the 30s sent cooldown.

    Flow is intentionally: check sent cooldown -> claim short in-flight lock ->
    send email -> mark sent cooldown. v48 incorrectly marked the 30s cooldown
    before SMTP delivery, so the first request could be blocked after a stale or
    failed attempt. This version only starts the 30s timer after successful mail
    delivery while still blocking double-click/direct-API duplicate sends.
    """
    now = utcnow()
    sent_key = _cooldown_state_key(scope, identity)
    inflight_key = f"{sent_key}:inflight"

    raw = app_state_get(db, sent_key)
    if raw:
        try:
            last = datetime.fromisoformat(raw)
            remaining = seconds - int((now - last).total_seconds())
            if remaining > 0:
                raise HTTPException(
                    status_code=429,
                    detail=f"Please wait {remaining} seconds before requesting another email.",
                    headers={"Retry-After": str(remaining)},
                )
        except HTTPException:
            raise
        except Exception:
            pass

    inflight_raw = app_state_get(db, inflight_key)
    if inflight_raw:
        try:
            started = datetime.fromisoformat(inflight_raw)
            remaining = EMAIL_REQUEST_INFLIGHT_SECONDS - int((now - started).total_seconds())
            if remaining > 0:
                raise HTTPException(
                    status_code=429,
                    detail="Email request is already being sent. Please wait a few seconds.",
                    headers={"Retry-After": str(max(1, remaining))},
                )
        except HTTPException:
            raise
        except Exception:
            pass

    app_state_set(db, inflight_key, now.isoformat())
    db.commit()
    return sent_key, inflight_key


def finish_email_request_success(db: Session, sent_key: str, inflight_key: str) -> None:
    app_state_set(db, sent_key, utcnow().isoformat())
    app_state_delete(db, inflight_key)
    db.commit()


def finish_email_request_failure(db: Session, inflight_key: str) -> None:
    app_state_delete(db, inflight_key)
    db.commit()


def cleanup_old_device_rows(db: Session) -> None:
    """Keep the device manager bounded.

    Recently revoked devices stay visible for a short audit window; stale revoked
    devices and obsolete link sessions are purged so the list does not grow forever.
    """
    now = utcnow()
    device_cutoff = now - timedelta(days=DEVICE_REVOKED_PURGE_DAYS)
    link_cutoff = now - timedelta(days=DEVICE_LINK_PURGE_DAYS)
    db.execute(delete(Device).where(Device.revoked_at.is_not(None), Device.revoked_at < device_cutoff))
    db.execute(delete(DeviceLinkSession).where(
        or_(
            DeviceLinkSession.expires_at < link_cutoff,
            and_(DeviceLinkSession.consumed_at.is_not(None), DeviceLinkSession.consumed_at < link_cutoff),
            and_(DeviceLinkSession.rejected_at.is_not(None), DeviceLinkSession.rejected_at < link_cutoff),
        )
    ))



def create_auth_token(db: Session, user: User, purpose: str, minutes: int | None = None) -> str:
    token = secrets.token_urlsafe(32)
    now = utcnow()
    db.add(AuthRecoveryToken(
        user_id=user.id,
        purpose=purpose,
        token_hash=recovery_token_hash(token),
        created_at=now,
        expires_at=now + timedelta(minutes=minutes or settings.recovery_token_minutes),
    ))
    db.commit()
    return token


def consume_auth_token(db: Session, token: str, purpose: str) -> User:
    token_hash = recovery_token_hash(token)
    row = db.scalar(select(AuthRecoveryToken).where(AuthRecoveryToken.token_hash == token_hash, AuthRecoveryToken.purpose == purpose))
    if not row or row.used_at is not None or row.expires_at < utcnow():
        raise HTTPException(status_code=400, detail="Invalid or expired recovery token")
    user = db.get(User, row.user_id)
    if not user or user.is_deleted:
        raise HTTPException(status_code=400, detail="Invalid or expired recovery token")
    row.used_at = utcnow()
    db.commit()
    return user


def deliver_account_email(to_email: str, subject: str, body: str) -> None:
    # Centralized mailer: dev mode writes links/codes to backend/storage/mailbox/dev_mailbox.log;
    # production mode sends through SMTP using CHATE_MAIL_MODE=smtp.
    send_account_email(to_email, subject, body)


def generic_recovery_response() -> AuthFlowResponse:
    return AuthFlowResponse(detail="If that account exists, ChatE sent recovery instructions by email. In development, check backend/storage/mailbox/dev_mailbox.log.")


async def close_unauthorized_websocket(websocket: WebSocket, accept_protocol: str | None, detail: str = "Authentication required") -> None:
    """Close an unauthenticated realtime socket without producing Uvicorn 403 noise.

    Starlette/FastAPI turns close-before-accept into an HTTP 403. That is correct
    at protocol level, but terrible in local ChatE logs because stale browser tabs
    and service-worker restores can create a burst of scary 403 lines. Accept the
    socket, send a tiny auth event, then close with the app auth code instead.
    No user data is exposed before authentication.
    """
    try:
        await websocket.accept(subprotocol=accept_protocol)
        await websocket.send_json({"type": "auth:error", "detail": detail})
    except Exception:
        pass
    finally:
        try:
            await websocket.close(code=4401)
        except Exception:
            pass


@app.websocket("/ws")
async def websocket_highway(websocket: WebSocket, token: str | None = None) -> None:
    """Encrypted-event highway.

    The websocket carries only service events (new-message, presence, read state).
    Message bodies are still encrypted payloads stored by /api/messages.

    v54 accepts the JWT through the websocket subprotocol as ``token.<jwt>`` so
    normal uvicorn access logs no longer print the full bearer token in the URL.
    The query parameter remains as a backward-compatible fallback for stale clients.
    """
    offered_protocols = [p.strip() for p in (websocket.headers.get("sec-websocket-protocol") or "").split(",") if p.strip()]
    if not token:
        for protocol in offered_protocols:
            if protocol.startswith("token."):
                token = protocol[6:]
                break
    accept_protocol = "chate.v1" if "chate.v1" in offered_protocols else None
    if not token:
        await close_unauthorized_websocket(websocket, accept_protocol, "Missing realtime token")
        return

    payload = decode_access_token(token)
    if not payload or "sub" not in payload:
        await close_unauthorized_websocket(websocket, accept_protocol, "Invalid or expired realtime token")
        return

    db = SessionLocal()
    user: User | None = None
    try:
        cleanup_due_deleted_accounts(db)
        user = db.get(User, int(payload["sub"]))
        if not user or user.is_deleted or user.deletion_requested_at is not None or token_was_revoked(user, payload):
            await close_unauthorized_websocket(websocket, accept_protocol, "Realtime session expired")
            return

        await HUB.connect(user.id, websocket, accept_protocol)
        presence = apply_presence(user, db, "online", None)
        await websocket.send_json({"type": "highway:ready", "user_id": user.id})
        await HUB.send_to_user(user.id, {"type": "presence:update", "presence": presence.model_dump(mode="json")})

        while True:
            try:
                event = await websocket.receive_json()
            except ValueError:
                await websocket.send_json({"type": "error", "detail": "Invalid websocket JSON"})
                continue

            event_type = event.get("type")
            if event_type == "ping":
                await websocket.send_json({"type": "pong", "ts": utcnow().isoformat()})
                continue

            if event_type == "presence":
                raw_status = event.get("status") or "online"
                if raw_status not in {"online", "idle", "typing", "recording", "offline"}:
                    raw_status = "online"
                raw_peer_id = event.get("peer_id")
                try:
                    peer_id = int(raw_peer_id) if raw_peer_id is not None else None
                except (TypeError, ValueError):
                    peer_id = None
                presence = apply_presence(user, db, raw_status, peer_id)
                payload_out = {"type": "presence:update", "presence": presence.model_dump(mode="json")}
                targets = {user.id}
                if peer_id and not is_blocked_between(db, user.id, peer_id):
                    targets.add(peer_id)
                await HUB.fanout(targets, payload_out)
                continue

            await websocket.send_json({"type": "error", "detail": "Unknown websocket event"})
    except WebSocketDisconnect:
        pass
    finally:
        if user is not None:
            previous_peer_id = None
            record = PRESENCE.get(user.id) or {}
            try:
                previous_peer_id = record.get("peer_id")
            except Exception:
                previous_peer_id = None
            HUB.disconnect(user.id, websocket)
            # Do not mark the user offline while another tab/device websocket is still open.
            if not HUB.connections.get(user.id):
                try:
                    presence = apply_presence(user, db, "offline", previous_peer_id)
                    targets = {user.id}
                    if previous_peer_id:
                        targets.add(int(previous_peer_id))
                    await HUB.fanout(targets, {"type": "presence:update", "presence": presence.model_dump(mode="json")})
                except Exception:
                    pass
        db.close()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/settings")
def settings_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "settings.html")


@app.get("/sw.js")
def service_worker() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "sw.js", media_type="application/javascript")


@app.get("/manifest.webmanifest")
def web_manifest() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/offline.html")
def offline_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "offline.html")


@app.get("/api/health")
def health(db: Annotated[Session, Depends(get_db)]) -> dict[str, str]:
    cleanup_due_deleted_accounts(db)
    return {"status": "ok", "version": "v73", "storage": "encrypted-blob-private-metadata-plus-field-protected-db", "environment": settings.environment, "mail_mode": settings.mail_mode}


@app.post("/api/auth/register", response_model=TokenResponse)
def register(payload: RegisterRequest, request: Request, db: Annotated[Session, Depends(get_db)]) -> TokenResponse:
    cleanup_due_deleted_accounts(db)
    reject_if_auth_locked(request, payload.email)
    assert_public_key_jwk(payload.public_key_jwk)
    if not settings.allow_public_registration:
        raise HTTPException(status_code=403, detail="Public registration is disabled")

    existing = db.scalar(
        select(User).where(or_(
            User.username_lookup_hash == blind_index("username", payload.username),
            User.email_lookup_hash == blind_index("email", payload.email.lower()),
            User.username == payload.username,
            User.email == payload.email.lower(),
        ))
    )
    if existing:
        record_auth_failure(request, payload.email)
        raise HTTPException(status_code=409, detail="Username or email already exists")

    now = utcnow()
    user = User(
        username=payload.username,
        email=payload.email.lower(),
        password_hash=hash_password(payload.password),
        display_name=payload.display_name or payload.username,
        public_key_jwk=json.dumps(payload.public_key_jwk),
        last_login_at=now,
        last_seen_at=now,
    )
    db.add(user)
    db.flush()
    set_user_profile_encrypted(
        user,
        username=payload.username,
        email=payload.email.lower(),
        display_name=payload.display_name or payload.username,
        avatar_url=None,
        bio=None,
    )
    add_key_event(db, user.id, payload.public_key_jwk, "registered")
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id)
    return TokenResponse(access_token=token, user=user_to_public(user, include_email=True, include_public_key=True))


@app.post("/api/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Annotated[Session, Depends(get_db)]) -> TokenResponse:
    cleanup_due_deleted_accounts(db)

    login_value = payload.login.strip().lower()
    reject_if_auth_locked(request, login_value)
    user = find_user_by_login(db, login_value)
    if not user or not verify_password(payload.password, user.password_hash):
        record_auth_failure(request, login_value)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    clear_auth_failures(request, login_value)

    deletion_was_cancelled = False
    now = utcnow()
    if user.deletion_requested_at is not None:
        # Requirement: logging back in before the scheduled deletion cancels deletion.
        user.deletion_requested_at = None
        user.deletion_scheduled_at = None
        deletion_was_cancelled = True

    user.last_login_at = now
    user.last_seen_at = now
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id)
    return TokenResponse(
        access_token=token,
        user=user_to_public(user, include_email=True, include_public_key=True),
        deletion_was_cancelled=deletion_was_cancelled,
    )




@app.post("/api/auth/forgot-username", response_model=AuthFlowResponse)
def forgot_username(
    payload: ForgotUsernameRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> AuthFlowResponse:
    # Do not reveal whether an email exists.
    reject_if_auth_locked(request, payload.email)
    user = find_user_by_email(db, payload.email.lower())
    if user and not user.is_deleted:
        sent_key, inflight_key = begin_email_request(db, "forgot_username", payload.email)
        try:
            body = (
                "Your ChatE username reminder:\n\n"
                f"Username: @{get_user_username(user)}\n\n"
                "If you did not request this, ignore this email."
            )
            deliver_account_email(get_user_email(user), "Your ChatE username", body)
            finish_email_request_success(db, sent_key, inflight_key)
        except Exception:
            finish_email_request_failure(db, inflight_key)
            raise
    return generic_recovery_response()


@app.post("/api/auth/password-reset/start", response_model=AuthFlowResponse)
def start_password_reset(
    payload: PasswordResetStartRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> AuthFlowResponse:
    login_value = payload.login.strip().lower()
    reject_if_auth_locked(request, login_value)
    user = find_user_by_login(db, login_value)
    if user and not user.is_deleted:
        sent_key, inflight_key = begin_email_request(db, "password_reset", login_value)
        try:
            token = create_auth_token(db, user, "password_reset")
            link = f"{settings.public_base_url.rstrip('/')}/?reset_token={token}"
            body = (
                "Reset your ChatE login password with this one-time link/code.\n\n"
                f"Link: {link}\n"
                f"Code: {token}\n\n"
                "This only resets account login. It does NOT recover encrypted chat history. "
                "Old chats still need your exported ChatE key package and key passphrase, or another trusted device."
            )
            deliver_account_email(get_user_email(user), "Reset your ChatE password", body)
            finish_email_request_success(db, sent_key, inflight_key)
        except Exception:
            finish_email_request_failure(db, inflight_key)
            raise
    return generic_recovery_response()


@app.post("/api/auth/password-reset/complete", response_model=AuthFlowResponse)
def complete_password_reset(
    payload: PasswordResetCompleteRequest,
    db: Annotated[Session, Depends(get_db)],
) -> AuthFlowResponse:
    user = consume_auth_token(db, payload.token, "password_reset")
    user.password_hash = hash_password(payload.new_password)
    # Revoke old JWTs. This does not touch E2EE keys or decrypt old messages.
    user.token_revoked_after = utcnow()
    db.commit()
    return AuthFlowResponse(detail="Password reset complete. Login again. Old encrypted chats still require the matching exported key package or another trusted device.")


@app.post("/api/auth/email-verification/start", response_model=AuthFlowResponse)
def start_email_verification(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> AuthFlowResponse:
    if current_user.email_verified_at:
        return AuthFlowResponse(detail="Email is already verified.")
    sent_key, inflight_key = begin_email_request(db, "email_verify", str(current_user.id))
    try:
        token = create_auth_token(db, current_user, "email_verify")
        link = f"{settings.public_base_url.rstrip('/')}/?verify_email_token={token}"
        body = f"Verify your ChatE email address with this one-time link/code.\n\nLink: {link}\nCode: {token}\n"
        deliver_account_email(get_user_email(current_user), "Verify your ChatE email", body)
        finish_email_request_success(db, sent_key, inflight_key)
    except Exception:
        finish_email_request_failure(db, inflight_key)
        raise
    return generic_recovery_response()


@app.post("/api/auth/email-verification/complete", response_model=AuthFlowResponse)
def complete_email_verification(
    payload: EmailVerificationCompleteRequest,
    db: Annotated[Session, Depends(get_db)],
) -> AuthFlowResponse:
    user = consume_auth_token(db, payload.token, "email_verify")
    user.email_verified_at = utcnow()
    db.commit()
    return AuthFlowResponse(detail="Email verified.")

@app.get("/api/users/me", response_model=PublicUser)
def me(current_user: Annotated[User, Depends(get_current_user)]) -> PublicUser:
    return user_to_public(current_user, include_email=True, include_public_key=True)


@app.put("/api/users/me/public-key", response_model=PublicUser)
def update_my_public_key(
    payload: PublicKeyUpdate,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PublicUser:
    # This rotates the user encryption identity for future messages only.
    # Old messages remain encrypted to older keys and require imported old key packages.
    assert_public_key_jwk(payload.public_key_jwk)
    old_key = parse_public_key_jwk(current_user.public_key_jwk)
    old_fingerprint = public_key_fingerprint(old_key) if old_key else None
    new_fingerprint = public_key_fingerprint(payload.public_key_jwk)
    current_user.public_key_jwk = json.dumps(payload.public_key_jwk)
    if new_fingerprint != old_fingerprint:
        add_key_event(db, current_user.id, payload.public_key_jwk, "rotated" if old_fingerprint else "repaired")
    db.commit()
    db.refresh(current_user)
    return user_to_public(current_user, include_email=True, include_public_key=True)


@app.put("/api/users/me/profile", response_model=PublicUser)
def update_my_profile(
    payload: ProfileUpdate,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PublicUser:
    display_name = clean_short_text(payload.display_name, max_len=80, field="display_name")
    avatar_url = validate_local_avatar_url(payload.avatar_url)
    bio = clean_short_text(payload.bio, max_len=280, field="bio")
    profile = get_user_profile(current_user)
    set_user_profile_encrypted(
        current_user,
        username=str(profile.get("username") or current_user.username),
        email=str(profile.get("email") or current_user.email),
        display_name=display_name or str(profile.get("username") or current_user.username),
        avatar_url=avatar_url,
        bio=bio,
    )
    current_user.public_show_email = bool(payload.public_show_email)
    current_user.public_show_display_name = bool(payload.public_show_display_name)
    current_user.public_show_avatar = bool(payload.public_show_avatar)
    current_user.public_show_bio = bool(payload.public_show_bio)
    current_user.public_show_last_seen = bool(payload.public_show_last_seen)
    db.commit()
    db.refresh(current_user)
    return user_to_public(current_user, include_email=True, include_public_key=True)


@app.post("/api/users/me/avatar", response_model=PublicUser)
def upload_my_avatar(
    payload: AvatarUpload,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PublicUser:
    match = re.fullmatch(r"data:image/(png|jpeg|jpg|webp);base64,(.+)", payload.image_data_url, re.DOTALL)
    if not match:
        raise HTTPException(status_code=400, detail="Avatar must be a PNG, JPEG, or WebP data URL")

    ext = "jpg" if match.group(1) == "jpeg" else match.group(1)
    raw_b64 = match.group(2)
    try:
        image_bytes = base64.b64decode(raw_b64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid avatar image data") from exc

    if len(image_bytes) > 2_500_000:
        raise HTTPException(status_code=413, detail="Avatar image is too large after cropping")
    if ext == "png" and not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(status_code=400, detail="Avatar bytes are not a valid PNG")
    if ext == "jpg" and not image_bytes.startswith(b"\xff\xd8"):
        raise HTTPException(status_code=400, detail="Avatar bytes are not a valid JPEG")
    if ext == "webp" and not (image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP"):
        raise HTTPException(status_code=400, detail="Avatar bytes are not a valid WebP")

    filename = f"avatar_user_{current_user.id}_{int(utcnow().timestamp())}.{ext}"
    path = AVATAR_DIR / filename
    path.write_bytes(image_bytes)

    profile = get_user_profile(current_user)
    set_user_profile_encrypted(
        current_user,
        username=str(profile.get("username") or current_user.username),
        email=str(profile.get("email") or current_user.email),
        display_name=profile.get("display_name"),
        avatar_url=f"/uploads/avatars/{filename}",
        bio=profile.get("bio"),
    )
    db.commit()
    db.refresh(current_user)
    return user_to_public(current_user, include_email=True, include_public_key=True)


@app.put("/api/account/password")
def change_password(
    payload: PasswordChangeRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict[str, str]:
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if payload.current_password == payload.new_password:
        raise HTTPException(status_code=400, detail="New password must be different from current password")
    current_user.password_hash = hash_password(payload.new_password)
    current_user.token_revoked_after = utcnow()
    db.commit()
    return {"status": "password_updated", "sessions_revoked": "true"}


@app.get("/api/users/search", response_model=list[PublicUser])
def search_users(
    q: str,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: int = 12,
) -> list[PublicUser]:
    query = reject_control_chars(q.strip().lower(), "search query")[:40]
    if len(query) < 2:
        return []
    limit = max(1, min(limit, 25))
    blocked_ids = set(db.scalars(select(BlockedUser.blocked_id).where(BlockedUser.blocker_id == current_user.id)).all())
    blocked_by_ids = set(db.scalars(select(BlockedUser.blocker_id).where(BlockedUser.blocked_id == current_user.id)).all())
    excluded = blocked_ids | blocked_by_ids | {current_user.id}

    # Exact lookup still works through blind indexes even when usernames/emails are encrypted at rest.
    exact_ids: list[int] = []
    exact_user = db.scalar(select(User).where(or_(
        User.username_lookup_hash == blind_index("username", query),
        User.email_lookup_hash == blind_index("email", query),
    )))
    if exact_user:
        exact_ids.append(exact_user.id)

    # Substring search over encrypted profile data requires decrypting a small candidate set in app memory.
    # This is acceptable for the local MVP; production should use private contact discovery or a client-side address book.
    rows = db.scalars(select(User).where(User.is_deleted == False).order_by(User.id.desc()).limit(250)).all()  # noqa: E712
    ranked: list[User] = []
    for user in rows:
        if user.id in excluded:
            continue
        profile = get_user_profile(user)
        username = str(profile.get("username") or "").lower()
        display_name = str(profile.get("display_name") or "").lower()
        email = str(profile.get("email") or "").lower()
        public_email = bool(getattr(user, "public_show_email", False))
        public_display = bool(getattr(user, "public_show_display_name", True))
        if user.id in exact_ids or query in username or (public_display and query in display_name) or (public_email and query in email):
            ranked.append(user)
        if len(ranked) >= limit:
            break
    return [user_to_public(user, include_public_key=True) for user in ranked]


@app.get("/api/users/by-username/{username}", response_model=PublicUser)
def find_user(username: str, db: Annotated[Session, Depends(get_db)], _: Annotated[User, Depends(get_current_user)]) -> PublicUser:
    lookup = username.strip().lower()
    if not USERNAME_LOOKUP_RE.fullmatch(lookup):
        raise HTTPException(status_code=404, detail="User not found")
    user = find_user_by_username(db, lookup)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user_to_public(user, include_public_key=True)


@app.get("/api/users/{user_id}/profile", response_model=PublicUser)
def public_profile(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PublicUser:
    user = db.get(User, user_id)
    if not user or user.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    # The encryption public key is intentionally public and required to start a
    # chat from profile/notification routes. Privacy toggles still apply to email,
    # bio, avatar, display name, and last-seen only.
    if user.id == current_user.id:
        return user_to_public(user, include_email=True, include_public_key=True)
    return user_to_public(user, include_public_key=True)


@app.get("/api/users/{user_id}/public-key")
def public_key(user_id: int, db: Annotated[Session, Depends(get_db)], _: Annotated[User, Depends(get_current_user)]):
    user = db.get(User, user_id)
    if not user or user.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    return {"user_id": user.id, "username": get_user_username(user), "public_key_jwk": require_user_public_key(user, "This contact is missing an encryption public key. They need to log in once or reset their encryption key.")}



@app.get("/api/security/key-history/{user_id}", response_model=list[KeyHistoryOut])
def key_history(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[UserKeyEvent]:
    # Any authenticated user may inspect the public key history for a peer they talk to.
    user = db.get(User, user_id)
    if not user or user.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    rows = db.scalars(
        select(UserKeyEvent).where(UserKeyEvent.user_id == user_id).order_by(UserKeyEvent.created_at.desc()).limit(20)
    ).all()
    if rows:
        return rows
    # Existing local databases created before v29 have no audit row yet. Return a
    # synthetic current-key entry so Security Center still has something useful.
    public_key = parse_public_key_jwk(user.public_key_jwk)
    if not public_key:
        return []
    return [{
        "id": 0,
        "user_id": user.id,
        "fingerprint": public_key_fingerprint(public_key),
        "event_type": "current",
        "created_at": user.created_at,
    }]



@app.get("/api/push/vapid-public-key", response_model=PushSubscriptionOut)
def get_push_public_key(_: Annotated[User, Depends(get_current_user)]) -> PushSubscriptionOut:
    if not settings.vapid_public_key:
        return PushSubscriptionOut(enabled=False, detail="Web Push is not configured. Set CHATE_VAPID_PUBLIC_KEY and CHATE_VAPID_PRIVATE_KEY.", public_key=None)
    if webpush is None:
        return PushSubscriptionOut(enabled=False, detail="Server is missing pywebpush. Install backend requirements again.", public_key=settings.vapid_public_key)
    return PushSubscriptionOut(enabled=True, detail="Web Push is available.", public_key=settings.vapid_public_key)




@app.get("/api/push/diagnostics")
def get_push_diagnostics(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    active_subscriptions = db.scalar(
        select(func.count(PushSubscription.id)).where(
            PushSubscription.user_id == current_user.id,
            PushSubscription.revoked_at.is_(None),
        )
    ) or 0
    private_ok, private_detail = vapid_private_key_status()
    raw_private = _raw_vapid_private_key()
    private_format = "pem" if "-----BEGIN" in raw_private else ("base64url-der" if raw_private else "missing")
    return {
        "enabled": push_available(),
        "pywebpush_installed": webpush is not None,
        "has_public_key": bool(settings.vapid_public_key),
        "has_private_key": bool(normalized_vapid_private_key()),
        "private_key_format": private_format,
        "private_key_valid": private_ok,
        "private_key_detail": private_detail,
        "vapid_subject": settings.vapid_subject,
        "active_subscriptions": int(active_subscriptions),
        "detail": "Web Push ready" if push_available() else push_unavailable_reason(),
    }

@app.post("/api/push/subscribe", response_model=PushSubscriptionOut)
def subscribe_push(
    payload: PushSubscriptionIn,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PushSubscriptionOut:
    if not settings.vapid_public_key:
        raise HTTPException(status_code=503, detail="Web Push is not configured on this server")
    if webpush is None:
        raise HTTPException(status_code=503, detail="pywebpush is not installed on this server")
    endpoint = payload.endpoint.strip()
    h = push_endpoint_hash(endpoint)
    row = db.scalar(select(PushSubscription).where(PushSubscription.endpoint_hash == h))
    now = utcnow()
    ua = (request.headers.get("user-agent") or "")[:300]
    if not row:
        row = PushSubscription(
            user_id=current_user.id,
            device_id=payload.device_id,
            endpoint=endpoint,
            endpoint_hash=h,
            p256dh=payload.keys.p256dh,
            auth=payload.keys.auth,
            user_agent=ua,
            created_at=now,
            last_seen_at=now,
            revoked_at=None,
        )
        db.add(row)
    else:
        row.user_id = current_user.id
        row.device_id = payload.device_id
        row.endpoint = endpoint
        row.p256dh = payload.keys.p256dh
        row.auth = payload.keys.auth
        row.user_agent = ua
        row.last_seen_at = now
        row.revoked_at = None
    db.commit()
    return PushSubscriptionOut(enabled=True, detail="Push notifications enabled for this browser.", public_key=settings.vapid_public_key)


@app.post("/api/push/unsubscribe", response_model=PushSubscriptionOut)
def unsubscribe_push(
    payload: PushSubscriptionIn,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PushSubscriptionOut:
    row = db.scalar(select(PushSubscription).where(PushSubscription.endpoint_hash == push_endpoint_hash(payload.endpoint)))
    if row and row.user_id == current_user.id:
        row.revoked_at = utcnow()
        db.commit()
    return PushSubscriptionOut(enabled=False, detail="Push notifications disabled for this browser.", public_key=settings.vapid_public_key or None)


@app.post("/api/push/test", response_model=PushSubscriptionOut)
def test_push(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PushSubscriptionOut:
    if not push_available():
        raise HTTPException(status_code=503, detail="Web Push is not fully configured. Check pywebpush and VAPID keys.")
    active_subscriptions = db.scalar(
        select(func.count(PushSubscription.id)).where(
            PushSubscription.user_id == current_user.id,
            PushSubscription.revoked_at.is_(None),
        )
    ) or 0
    if active_subscriptions <= 0:
        raise HTTPException(status_code=400, detail="No active push subscription for this browser. Enable background notifications first.")
    queue_message_push(current_user.id, current_user, 0, "text")
    return PushSubscriptionOut(enabled=True, detail=f"Test push queued to {active_subscriptions} active subscription(s).", public_key=settings.vapid_public_key)

@app.get("/api/settings", response_model=AccountSettingsOut)
def get_settings(current_user: Annotated[User, Depends(get_current_user)]) -> AccountSettingsOut:
    return settings_to_out(current_user)


@app.put("/api/settings", response_model=AccountSettingsOut)
def update_settings(
    payload: AccountSettingsUpdate,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> AccountSettingsOut:
    current_user.auto_delete_after_days = payload.auto_delete_after_days
    seconds = payload.default_disappearing_seconds
    current_user.default_disappearing_seconds = int(seconds) if seconds and seconds > 0 else None
    db.commit()
    db.refresh(current_user)
    return settings_to_out(current_user)



class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib hook
        return None


def _safe_external_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Only http(s) URLs are allowed")
    host = parsed.hostname or ""
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
                raise HTTPException(status_code=400, detail="Private network URLs are blocked")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Could not verify URL host")
    return url.strip()


@app.post("/api/media/import-url", response_model=UrlImportOut)
def import_media_url(
    payload: UrlImportRequest,
    current_user: Annotated[User, Depends(get_current_user)],
) -> UrlImportOut:
    url = _safe_external_url(payload.url)
    req = UrlRequest(url, headers={"User-Agent": "ChatE-MVP/1.0"})
    try:
        with build_opener(_NoRedirectHandler).open(req, timeout=12) as resp:
            content_type = (resp.headers.get("content-type") or mimetypes.guess_type(url)[0] or "application/octet-stream").split(";")[0].strip()
            if not (content_type.startswith("image/") or content_type.startswith("video/") or content_type in {"application/json", "application/x-lottie+json"}):
                raise HTTPException(status_code=400, detail="Only image/video/GIF/sticker/JSON pack URLs are allowed")
            data = bytearray()
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_IMPORT_MEDIA_BYTES:
                    raise HTTPException(status_code=413, detail=f"Imported media is over {MAX_IMPORT_MEDIA_BYTES // (1024 * 1024)} MB")
    except HTTPException:
        raise
    except HTTPError as exc:
        if 300 <= exc.code < 400:
            raise HTTPException(status_code=400, detail="Redirecting media URLs are blocked for SSRF safety") from exc
        raise HTTPException(status_code=400, detail=f"Could not import URL: HTTP {exc.code}") from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not import URL: {exc}")
    label = Path(urlparse(url).path).name or "imported-media"
    encoded = base64.b64encode(bytes(data)).decode("ascii")
    return UrlImportOut(label=label[:80], mime_type=content_type, size_bytes=len(data), data_url=f"data:{content_type};base64,{encoded}")



RISKY_ATTACHMENT_EXTENSIONS = {
    ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".psm1", ".vbs",
    ".js", ".jse", ".jar", ".apk", ".ipa", ".deb", ".rpm", ".appimage", ".desktop",
    ".sh", ".bash", ".zsh", ".fish", ".run", ".bin"
}


def validate_attachment_name(original_name: str | None) -> str:
    raw_name = reject_control_chars((original_name or "encrypted-file").strip(), "attachment name") or "encrypted-file"
    name = Path(raw_name.replace("\\", "/")).name or "encrypted-file"
    suffix = Path(name).suffix.lower()
    if suffix in RISKY_ATTACHMENT_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Blocked risky executable attachment type: {suffix}")
    return name[:255]

def _upload_meta_path(upload_id: str) -> Path:
    safe = require_hex_id(upload_id, "upload id")
    return resolve_under(BLOB_UPLOAD_TMP_DIR, BLOB_UPLOAD_TMP_DIR / f"{safe}.json")


def _upload_part_path(upload_id: str, index: int) -> Path:
    safe = require_hex_id(upload_id, "upload id")
    return resolve_under(BLOB_UPLOAD_TMP_DIR, BLOB_UPLOAD_TMP_DIR / safe / f"{index:06d}.part")


@app.post("/api/blob-uploads/start", response_model=BlobUploadStartOut)
def start_blob_upload(
    payload: BlobUploadStart,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> BlobUploadStartOut:
    receiver = db.get(User, payload.receiver_id)
    if not receiver or receiver.is_deleted:
        raise HTTPException(status_code=404, detail="Receiver not found")
    if is_blocked_between(db, current_user.id, payload.receiver_id):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")
    upload_id = uuid.uuid4().hex
    folder = BLOB_UPLOAD_TMP_DIR / upload_id
    folder.mkdir(parents=True, exist_ok=True)
    meta = {
        "upload_id": upload_id,
        "owner_id": current_user.id,
        "receiver_id": payload.receiver_id,
        # Filename and MIME type belong in the encrypted message payload, not server metadata.
        "original_name": None,
        "mime_type": None,
        "total_size": payload.total_size,
        "total_chunks": payload.total_chunks,
        "created_at": utcnow().isoformat(),
    }
    _upload_meta_path(upload_id).write_text(json.dumps(meta), encoding="utf-8")
    return BlobUploadStartOut(upload_id=upload_id, chunk_size_limit=CHUNK_SIZE_LIMIT)


@app.put("/api/blob-uploads/{upload_id}/chunks/{chunk_index}")
async def upload_blob_chunk(
    upload_id: str,
    chunk_index: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...),
) -> dict[str, int | str]:
    meta_path = _upload_meta_path(upload_id)
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Upload session not found")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Upload session metadata is corrupt") from exc
    if meta.get("owner_id") != current_user.id:
        raise HTTPException(status_code=403, detail="Upload session belongs to another user")
    if is_blocked_between(db, current_user.id, int(meta.get("receiver_id") or 0)):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")
    total_chunks = int(meta.get("total_chunks") or 0)
    if chunk_index < 0 or chunk_index >= total_chunks:
        raise HTTPException(status_code=400, detail="Invalid chunk index")
    part_path = _upload_part_path(upload_id, chunk_index)
    part_path.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    try:
        with part_path.open("wb") as out:
            while True:
                chunk = await file.read(512 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > CHUNK_SIZE_LIMIT + 64 * 1024:
                    out.close()
                    part_path.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="Encrypted chunk too large")
                out.write(chunk)
    finally:
        await file.close()
    return {"status": "ok", "chunk_index": chunk_index, "size": total}


@app.post("/api/blob-uploads/{upload_id}/complete", response_model=BlobOut)
def complete_blob_upload(
    upload_id: str,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> BlobOut:
    meta_path = _upload_meta_path(upload_id)
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Upload session not found")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Upload session metadata is corrupt") from exc
    if meta.get("owner_id") != current_user.id:
        raise HTTPException(status_code=403, detail="Upload session belongs to another user")
    if is_blocked_between(db, current_user.id, int(meta.get("receiver_id") or 0)):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")
    total_chunks = int(meta.get("total_chunks") or 0)
    part_paths = [_upload_part_path(upload_id, i) for i in range(total_chunks)]
    if any(not path.exists() for path in part_paths):
        raise HTTPException(status_code=400, detail="Upload is missing chunks")
    now = utcnow()
    blob_id = uuid.uuid4().hex
    subdir = BLOB_DIR / now.strftime("%Y") / now.strftime("%m")
    subdir.mkdir(parents=True, exist_ok=True)
    final_path = subdir / f"{blob_id}.enc"
    total = 0
    with final_path.open("wb") as out:
        for part in part_paths:
            data = part.read_bytes()
            total += len(data)
            if total > MAX_BLOB_BYTES + (total_chunks * 32):
                out.close()
                final_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Encrypted file is over 100 MB")
            out.write(data)
    blob = EncryptedBlob(
        id=blob_id,
        owner_id=current_user.id,
        receiver_id=int(meta["receiver_id"]),
        original_name=None,
        mime_type=None,
        size_bytes=total,
        storage_path=str(final_path),
        created_at=now,
        is_deleted=False,
    )
    db.add(blob)
    db.commit()
    db.refresh(blob)
    for part in part_paths:
        part.unlink(missing_ok=True)
    try:
        part_paths[0].parent.rmdir()
    except Exception:
        pass
    meta_path.unlink(missing_ok=True)
    return blob_to_out(blob)


@app.post("/api/blobs", response_model=BlobOut)
async def upload_encrypted_blob(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    receiver_id: int = Form(...),
    original_name: str | None = Form(default=None),
    mime_type: str | None = Form(default=None),
    file: UploadFile = File(...),
) -> BlobOut:
    receiver = db.get(User, receiver_id)
    if not receiver or receiver.is_deleted:
        raise HTTPException(status_code=404, detail="Receiver not found")
    if is_blocked_between(db, current_user.id, receiver_id):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")
    # The received file is already ciphertext. Keep plaintext filename/MIME out of server metadata.
    now = utcnow()
    blob_id = uuid.uuid4().hex
    subdir = BLOB_DIR / now.strftime("%Y") / now.strftime("%m")
    subdir.mkdir(parents=True, exist_ok=True)
    path = subdir / f"{blob_id}.enc"

    total = 0
    try:
        with path.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BLOB_BYTES:
                    out.close()
                    path.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="Encrypted file is over 100 MB")
                out.write(chunk)
    finally:
        await file.close()

    blob = EncryptedBlob(
        id=blob_id,
        owner_id=current_user.id,
        receiver_id=receiver_id,
        original_name=None,
        mime_type=None,
        size_bytes=total,
        storage_path=str(path),
        created_at=now,
        is_deleted=False,
    )
    db.add(blob)
    db.commit()
    db.refresh(blob)
    return blob_to_out(blob)


@app.get("/api/blobs/{blob_id}")
def download_encrypted_blob(
    blob_id: str,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> FileResponse:
    blob_id = require_hex_id(blob_id, "blob id")
    blob = db.get(EncryptedBlob, blob_id)
    if not blob or blob.is_deleted:
        raise HTTPException(status_code=404, detail="Encrypted blob not found")
    if current_user.id not in {blob.owner_id, blob.receiver_id}:
        raise HTTPException(status_code=403, detail="You cannot access this encrypted blob")
    path = resolve_under(BLOB_DIR, Path(blob.storage_path))
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Encrypted blob file is missing")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=f"{blob.id}.enc",
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.get("/api/conversations", response_model=list[ConversationOut])
def get_conversations(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: int = 50,
) -> list[dict]:
    """Return chat threads without scanning arbitrary recent messages.

    Previous builds scanned the latest N messages and deduplicated in Python. That
    was fast for tiny databases but both laggy and logically wrong when one busy
    chat pushed older conversations outside the scan window. This grouped query
    asks SQLite for one latest message id per other user, then batches everything
    else. Same features, fewer loops, correct conversation coverage.
    """
    limit = max(1, min(limit, 100))
    now = utcnow()
    other_id = case(
        (Message.sender_id == current_user.id, Message.receiver_id),
        else_=Message.sender_id,
    ).label("other_id")
    latest_subq = (
        select(other_id, func.max(Message.id).label("latest_id"))
        .where(or_(Message.sender_id == current_user.id, Message.receiver_id == current_user.id), live_message_clause(now))
        .group_by(other_id)
        .order_by(func.max(Message.id).desc())
        .limit(limit)
        .subquery()
    )

    latest_rows = db.scalars(
        select(Message)
        .join(latest_subq, Message.id == latest_subq.c.latest_id)
        .order_by(Message.id.desc())
    ).all()
    if not latest_rows:
        return []

    other_ids = [msg.receiver_id if msg.sender_id == current_user.id else msg.sender_id for msg in latest_rows]
    users = db.scalars(select(User).where(User.id.in_(other_ids))).all()
    users_by_id = {user.id: user for user in users if not user.is_deleted}

    blocks = db.execute(
        select(BlockedUser.blocker_id, BlockedUser.blocked_id).where(
            or_(
                and_(BlockedUser.blocker_id == current_user.id, BlockedUser.blocked_id.in_(other_ids)),
                and_(BlockedUser.blocked_id == current_user.id, BlockedUser.blocker_id.in_(other_ids)),
            )
        )
    ).all()
    blocked_ids = {b if a == current_user.id else a for a, b in blocks}

    unread_rows = db.execute(
        select(Message.sender_id, func.count(Message.id))
        .where(
            Message.sender_id.in_(other_ids),
            Message.receiver_id == current_user.id,
            Message.read_at.is_(None),
            live_message_clause(now),
        )
        .group_by(Message.sender_id)
    ).all()
    unread_by_sender = {int(sender_id): int(count) for sender_id, count in unread_rows}

    latest_dicts = messages_to_dicts(db, latest_rows, include_reactions=False)

    conversations: list[dict] = []
    for msg, latest in zip(latest_rows, latest_dicts):
        peer_id = msg.receiver_id if msg.sender_id == current_user.id else msg.sender_id
        other = users_by_id.get(peer_id)
        if not other or peer_id in blocked_ids:
            continue
        conversations.append({
            "other_user": user_to_public(other, include_public_key=True).model_dump(),
            "latest_message": latest,
            "unread_count": unread_by_sender.get(peer_id, 0),
        })
    return conversations

@app.post("/api/key-sessions", response_model=KeySessionOut)
def create_key_session(
    payload: KeySessionCreate,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> MessageKeySession:
    receiver = db.get(User, payload.receiver_id)
    if not receiver or receiver.is_deleted:
        raise HTTPException(status_code=404, detail="Receiver not found")
    if is_blocked_between(db, current_user.id, payload.receiver_id):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")

    existing = db.get(MessageKeySession, payload.id)
    if existing:
        if existing.sender_id != current_user.id or existing.receiver_id != payload.receiver_id:
            raise HTTPException(status_code=409, detail="Key session id collision")
        return key_session_to_dict(existing)

    now = utcnow()
    session = MessageKeySession(
        id=payload.id,
        sender_id=current_user.id,
        receiver_id=payload.receiver_id,
        encrypted_key_for_receiver=protect_session_field(payload.encrypted_key_for_receiver or "") or "",
        encrypted_key_for_sender=protect_session_field(payload.encrypted_key_for_sender or "") or "",
        created_at=now,
        expires_at=now + timedelta(minutes=10),
    )
    db.add(session)
    db.flush()
    out = key_session_to_dict(session)
    db.commit()
    return out


@app.post("/api/messages", response_model=MessageOut)
async def send_message(
    payload: MessageCreate,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    receiver = db.get(User, payload.receiver_id)
    if not receiver or receiver.is_deleted:
        raise HTTPException(status_code=404, detail="Receiver not found")
    if is_blocked_between(db, current_user.id, payload.receiver_id):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")

    if payload.client_message_id:
        existing = db.scalar(
            select(Message).where(
                Message.sender_id == current_user.id,
                Message.client_message_id == payload.client_message_id,
            )
        )
        if existing:
            return message_to_dict(existing, db)

    message_blob_id = None
    if payload.blob_id:
        message_blob_id = require_hex_id(payload.blob_id, "blob id")
        blob = db.get(EncryptedBlob, message_blob_id)
        if not blob or blob.is_deleted:
            raise HTTPException(status_code=400, detail="Encrypted blob not found")
        if blob.owner_id != current_user.id or blob.receiver_id != payload.receiver_id:
            raise HTTPException(status_code=403, detail="Encrypted blob does not belong to this message")

    session = None
    session_out_receiver_key = None
    session_out_sender_key = None
    if payload.key_session_id:
        session = db.get(MessageKeySession, payload.key_session_id)
        if not session:
            # Fast messenger path: the browser creates the temporary E2EE session
            # locally and registers the wrapped session key inline with the first
            # message. This removes the extra /api/key-sessions round-trip from
            # the send path, matching how mature messengers avoid blocking UI on
            # unnecessary setup calls. The server still receives only wrapped keys.
            if not payload.encrypted_key_for_receiver or not payload.encrypted_key_for_sender:
                raise HTTPException(status_code=400, detail="Temporary key session not found")
            now_for_session = utcnow()
            session = MessageKeySession(
                id=payload.key_session_id,
                sender_id=current_user.id,
                receiver_id=payload.receiver_id,
                encrypted_key_for_receiver=protect_session_field(payload.encrypted_key_for_receiver or "") or "",
                encrypted_key_for_sender=protect_session_field(payload.encrypted_key_for_sender or "") or "",
                created_at=now_for_session,
                expires_at=now_for_session + timedelta(minutes=10),
            )
            db.add(session)
            session_out_receiver_key = payload.encrypted_key_for_receiver
            session_out_sender_key = payload.encrypted_key_for_sender
        if session.sender_id != current_user.id or session.receiver_id != payload.receiver_id:
            raise HTTPException(status_code=403, detail="Temporary key session does not belong to this message")
        if session.expires_at < utcnow():
            raise HTTPException(status_code=400, detail="Temporary key session expired. Rotate and resend.")
    elif not payload.encrypted_key_for_receiver or not payload.encrypted_key_for_sender:
        raise HTTPException(status_code=400, detail="Message needs either a key_session_id or legacy wrapped keys")

    now = utcnow()
    expires_at = None
    disappearing_seconds = get_disappearing_seconds_for_send(db, current_user, payload.receiver_id)
    if disappearing_seconds and disappearing_seconds > 0:
        expires_at = now + timedelta(seconds=int(disappearing_seconds))

    msg = Message(
        sender_id=current_user.id,
        receiver_id=payload.receiver_id,
        message_type=payload.message_type,
        client_message_id=payload.client_message_id,
        ciphertext=protect_message_field(payload.ciphertext) or "",
        iv=protect_message_field(payload.iv) or "",
        key_session_id=payload.key_session_id,
        blob_id=message_blob_id,
        # When a temporary key session is used, keep the wrapped AES key in
        # message_key_sessions only. Storing/protecting the same key on every
        # message wastes CPU and disk I/O. Legacy per-message wrapped-key sends
        # still work without key_session_id.
        encrypted_key_for_receiver=None if payload.key_session_id else (protect_message_field(payload.encrypted_key_for_receiver or "") or ""),
        encrypted_key_for_sender=None if payload.key_session_id else (protect_message_field(payload.encrypted_key_for_sender or "") or ""),
        reply_to_id=payload.reply_to_id,
        expires_at=expires_at,
    )
    db.add(msg)
    db.flush()
    if HUB.has_connections(payload.receiver_id):
        # Delivery tick: if a recipient browser/device is actively connected to
        # the realtime highway, the message has reached a recipient device. This
        # does not mean read; /api/messages marks read only when the chat is opened.
        msg.delivered_at = now
    # Hot path: build the response from already-known plaintext API payloads.
    # Calling messages_to_dicts() here decrypts server-protected fields that we
    # just encrypted. That is wasted work on every send and was visible on old laptops.
    out = {
        "id": msg.id,
        "sender_id": current_user.id,
        "receiver_id": payload.receiver_id,
        "message_type": payload.message_type,
        "client_message_id": payload.client_message_id,
        "ciphertext": payload.ciphertext,
        "iv": payload.iv,
        "encrypted_key_for_receiver": None if payload.key_session_id else payload.encrypted_key_for_receiver,
        "encrypted_key_for_sender": None if payload.key_session_id else payload.encrypted_key_for_sender,
        "key_session_id": payload.key_session_id,
        "blob_id": message_blob_id,
        "blob_url": f"/api/blobs/{message_blob_id}" if message_blob_id else None,
        "session_encrypted_key_for_receiver": session_out_receiver_key or (unprotect_session_field(session.encrypted_key_for_receiver) if payload.key_session_id and session else None),
        "session_encrypted_key_for_sender": session_out_sender_key or (unprotect_session_field(session.encrypted_key_for_sender) if payload.key_session_id and session else None),
        "session_expires_at": session.expires_at if payload.key_session_id and session else None,
        "created_at": msg.created_at,
        "expires_at": expires_at,
        "edited_at": None,
        "reply_to_id": payload.reply_to_id,
        "reactions": [],
        "delivered_at": msg.delivered_at,
        "read_at": None,
    }
    db.commit()
    await HUB.send_to_user(payload.receiver_id, {
        "type": "message:new",
        "conversation_user_id": current_user.id,
        "message_id": msg.id,
        "message": jsonable_encoder(out),
    })
    await HUB.send_to_user(current_user.id, {
        "type": "message:sent",
        "conversation_user_id": payload.receiver_id,
        "message_id": msg.id,
        "message": jsonable_encoder(out),
    })
    queue_message_push(payload.receiver_id, current_user, msg.id, payload.message_type)
    return out


@app.get("/api/messages/{other_user_id}/after/{after_id}", response_model=list[MessageOut])
async def get_messages_after(
    other_user_id: int,
    after_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: int = 60,
) -> list[dict]:
    """Return only messages newer than after_id for cheap live sync.

    This is the safety-net path when a laptop sleeps, a websocket event is missed,
    or the browser throttles a tab. It is intentionally much cheaper than
    reloading the whole conversation on every check.
    """
    if is_blocked_between(db, current_user.id, other_user_id):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")
    after_id = max(0, int(after_id or 0))
    limit = max(1, min(int(limit or 60), 80))
    condition = or_(
        and_(Message.sender_id == current_user.id, Message.receiver_id == other_user_id),
        and_(Message.sender_id == other_user_id, Message.receiver_id == current_user.id),
    )
    rows = db.scalars(
        select(Message)
        .where(condition, Message.id > after_id, live_message_clause())
        .order_by(Message.id.asc())
        .limit(limit)
    ).all()

    now = utcnow()
    unread_ids = [row.id for row in rows if row.receiver_id == current_user.id and row.read_at is None]
    delivered_ids = [row.id for row in rows if row.receiver_id == current_user.id and row.delivered_at is None]
    if unread_ids or delivered_ids:
        if delivered_ids:
            db.execute(update(Message).where(Message.id.in_(delivered_ids), Message.delivered_at.is_(None)).values(delivered_at=now))
        if unread_ids:
            db.execute(update(Message).where(Message.id.in_(unread_ids), Message.read_at.is_(None)).values(read_at=now))
        db.commit()
        for row in rows:
            if row.id in delivered_ids and row.delivered_at is None:
                row.delivered_at = now
            if row.id in unread_ids and row.read_at is None:
                row.read_at = now
        await HUB.send_to_user(other_user_id, {
            "type": "message:read",
            "conversation_user_id": current_user.id,
            "reader_id": current_user.id,
        })

    return messages_to_dicts(db, rows, include_reactions=True)


@app.get("/api/messages/{other_user_id}", response_model=list[MessageOut])
async def get_messages(
    other_user_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
    limit: int = 40,
    before_id: int | None = None,
) -> list[dict]:
    configured_limit = int(getattr(settings, "message_page_limit", 40) or 40)
    limit = max(1, min(limit or configured_limit, min(80, max(20, configured_limit))))
    if is_blocked_between(db, current_user.id, other_user_id):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")

    condition = or_(
        and_(Message.sender_id == current_user.id, Message.receiver_id == other_user_id),
        and_(Message.sender_id == other_user_id, Message.receiver_id == current_user.id),
    )
    query = select(Message).where(condition, live_message_clause())
    if before_id is not None:
        query = query.where(Message.id < before_id)

    rows_desc = db.scalars(query.order_by(Message.id.desc()).limit(limit)).all()
    rows = list(reversed(rows_desc))

    now = utcnow()
    unread_ids = [row.id for row in rows if row.receiver_id == current_user.id and row.read_at is None]
    delivered_ids = [row.id for row in rows if row.receiver_id == current_user.id and row.delivered_at is None]
    if unread_ids or delivered_ids:
        # Bulk updates avoid per-row ORM writes/refreshes on weak laptops.
        if delivered_ids:
            db.execute(update(Message).where(Message.id.in_(delivered_ids), Message.delivered_at.is_(None)).values(delivered_at=now))
        if unread_ids:
            db.execute(update(Message).where(Message.id.in_(unread_ids), Message.read_at.is_(None)).values(read_at=now))
        db.commit()
        for row in rows:
            if row.id in delivered_ids and row.delivered_at is None:
                row.delivered_at = now
            if row.id in unread_ids and row.read_at is None:
                row.read_at = now
        await HUB.send_to_user(other_user_id, {
            "type": "message:read",
            "conversation_user_id": current_user.id,
            "reader_id": current_user.id,
        })

    return messages_to_dicts(db, rows, include_reactions=True)




@app.post("/api/presence", response_model=PresenceOut)
async def update_presence(
    payload: PresenceUpdate,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PresenceOut:
    presence = apply_presence(current_user, db, payload.status, payload.peer_id)
    payload_out = {"type": "presence:update", "presence": presence.model_dump(mode="json")}
    targets = {current_user.id}
    if payload.peer_id and not is_blocked_between(db, current_user.id, payload.peer_id):
        targets.add(payload.peer_id)
    await HUB.fanout(targets, payload_out)
    return presence


@app.get("/api/presence/{user_id}", response_model=PresenceOut)
def get_presence(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> PresenceOut:
    user = db.get(User, user_id)
    if not user or user.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    if is_blocked_between(db, current_user.id, user_id):
        return PresenceOut(user_id=user_id, status="offline", last_seen_at=None, peer_id=None)
    return current_presence_for(user, current_user.id)

@app.get("/api/blocks", response_model=list[BlockedUserOut])
def list_blocks(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    rows = db.scalars(select(BlockedUser).where(BlockedUser.blocker_id == current_user.id).order_by(BlockedUser.created_at.desc())).all()
    return [blocked_user_to_out(row, db) for row in rows]


@app.post("/api/blocks/{user_id}", response_model=BlockedUserOut)
async def block_user(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot block yourself")
    target = db.get(User, user_id)
    if not target or target.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    existing = db.scalar(select(BlockedUser).where(BlockedUser.blocker_id == current_user.id, BlockedUser.blocked_id == user_id))
    if existing:
        return blocked_user_to_out(existing, db)
    block = BlockedUser(blocker_id=current_user.id, blocked_id=user_id, created_at=utcnow())
    db.add(block)
    db.commit()
    db.refresh(block)
    out = blocked_user_to_out(block, db)
    event = {"type": "user:blocked", "blocker_id": current_user.id, "blocked_id": user_id}
    await HUB.fanout({current_user.id, user_id}, event)
    return out


@app.delete("/api/blocks/{user_id}")
async def unblock_user(
    user_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict[str, str]:
    existing = db.scalar(select(BlockedUser).where(BlockedUser.blocker_id == current_user.id, BlockedUser.blocked_id == user_id))
    if existing:
        db.delete(existing)
        db.commit()
        await HUB.fanout({current_user.id, user_id}, {"type": "user:unblocked", "blocker_id": current_user.id, "blocked_id": user_id})
    return {"status": "unblocked"}




def report_to_out(report: UserReport) -> dict:
    return {
        "id": report.id,
        "reporter_id": report.reporter_id,
        "reported_id": report.reported_id,
        "reason": report.reason,
        "details": unprotect_text(report.details, REPORT_AAD) if report.details else None,
        "status": report.status,
        "created_at": report.created_at,
    }


@app.post("/api/reports", response_model=UserReportOut)
def create_report(
    payload: UserReportCreate,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    if payload.reported_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot report yourself")
    reported = db.get(User, payload.reported_user_id)
    if not reported or reported.is_deleted:
        raise HTTPException(status_code=404, detail="Reported user not found")
    evidence_json = None
    if payload.evidence:
        # E2EE rule: this contains only plaintext the reporter explicitly chose to disclose.
        cleaned = []
        for item in payload.evidence[:20]:
            cleaned.append({
                "message_id": item.get("message_id"),
                "created_at": str(item.get("created_at") or "")[:80],
                "direction": str(item.get("direction") or "")[:20],
                "text": reject_control_chars(str(item.get("text") or "")[:2000], "report evidence"),
            })
        evidence_json = protect_text(json.dumps(cleaned, ensure_ascii=False), REPORT_AAD)
    report = UserReport(
        reporter_id=current_user.id,
        reported_id=payload.reported_user_id,
        reason=payload.reason[:120],
        details=protect_text(payload.details[:2000], REPORT_AAD) if payload.details else None,
        evidence_json=evidence_json,
        status="open",
        created_at=utcnow(),
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report_to_out(report)


@app.get("/api/devices", response_model=list[DeviceOut])
def list_devices(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    cleanup_old_device_rows(db)
    recent_revoked_cutoff = utcnow() - timedelta(days=DEVICE_REVOKED_VISIBLE_DAYS)
    rows = db.scalars(
        select(Device)
        .where(
            Device.user_id == current_user.id,
            or_(Device.revoked_at.is_(None), Device.revoked_at >= recent_revoked_cutoff),
        )
        .order_by(Device.revoked_at.is_not(None), Device.created_at.desc())
    ).all()
    return [device_to_out(row) for row in rows]


def device_to_out(device: Device) -> dict:
    return {
        "id": device.id,
        "name": device.name,
        "status": getattr(device, "status", "trusted") or "trusted",
        "created_at": device.created_at,
        "approved_at": getattr(device, "approved_at", None),
        "last_seen_at": device.last_seen_at,
        "revoked_at": device.revoked_at,
    }


def active_trusted_device_exists(db: Session, user_id: int, exclude_device_id: str | None = None) -> bool:
    query = select(Device.id).where(
        Device.user_id == user_id,
        Device.revoked_at.is_(None),
        Device.status == "trusted",
    )
    if exclude_device_id:
        query = query.where(Device.id != exclude_device_id)
    return bool(db.scalar(query.limit(1)))


def ensure_pending_device_link(db: Session, user: User, device: Device, public_key_jwk: dict | None) -> DeviceLinkSession:
    now = utcnow()
    existing = db.scalar(
        select(DeviceLinkSession)
        .where(
            DeviceLinkSession.user_id == user.id,
            DeviceLinkSession.new_device_id == device.id,
            DeviceLinkSession.status.in_(["pending", "approved", "email_approved"]),
            DeviceLinkSession.consumed_at.is_(None),
            DeviceLinkSession.expires_at > now,
        )
        .order_by(DeviceLinkSession.created_at.desc())
    )
    if existing:
        return existing
    session = DeviceLinkSession(
        id=uuid.uuid4().hex,
        user_id=user.id,
        new_device_id=device.id,
        new_device_name=device.name[:120],
        new_device_public_key_jwk=json.dumps(public_key_jwk or {}),
        status="pending",
        created_at=now,
        expires_at=now + timedelta(hours=24),
    )
    db.add(session)
    return session


@app.post("/api/devices/ensure", response_model=DeviceTrustOut)
def ensure_current_device_trust(
    payload: DeviceTrustRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DeviceTrustOut:
    if payload.public_key_jwk:
        assert_public_key_jwk(payload.public_key_jwk)
    device_id = require_hex_id(payload.device_id, "device id")
    now = utcnow()
    device = db.get(Device, device_id)
    if device and device.user_id != current_user.id:
        raise HTTPException(status_code=409, detail="Device id collision")
    if not device:
        device = Device(id=device_id, user_id=current_user.id, name=payload.name[:120], created_at=now)
        db.add(device)
    device.name = payload.name[:120]
    if payload.public_key_jwk:
        device.public_key_jwk = json.dumps(payload.public_key_jwk)
    device.last_seen_at = now

    has_other_trusted = active_trusted_device_exists(db, current_user.id, exclude_device_id=device_id)
    if not has_other_trusted:
        device.status = "trusted"
        device.approved_at = device.approved_at or now
        device.revoked_at = None
        db.commit()
        db.refresh(device)
        return {"device": device_to_out(device), "status": "trusted", "requires_approval": False, "detail": "This device is trusted."}

    if device.status == "trusted" and not device.revoked_at:
        db.commit()
        db.refresh(device)
        return {"device": device_to_out(device), "status": "trusted", "requires_approval": False, "detail": "This known device is trusted."}

    device.status = "pending"
    device.revoked_at = None
    session = ensure_pending_device_link(db, current_user, device, payload.public_key_jwk)
    db.commit()
    db.refresh(device)
    db.refresh(session)
    return {
        "device": device_to_out(device),
        "status": session.status,
        "requires_approval": session.status == "pending",
        "link_session_id": session.id,
        "detail": "Waiting for approval from a trusted device or registered-email confirmation.",
    }


@app.post("/api/devices/current", response_model=DeviceOut)
def register_current_device(
    payload: DeviceRegisterRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> Device:
    # Kept for compatibility; normal UI now uses /api/devices/ensure automatically.
    device_id = require_hex_id(payload.device_id, "device id")
    now = utcnow()
    device = db.get(Device, device_id)
    if device and device.user_id != current_user.id:
        raise HTTPException(status_code=409, detail="Device id collision")
    if not device:
        device = Device(id=device_id, user_id=current_user.id, name=payload.name[:120], created_at=now, status="trusted", approved_at=now)
        db.add(device)
    device.name = payload.name[:120]
    device.status = "trusted"
    device.approved_at = device.approved_at or now
    device.public_key_jwk = json.dumps(payload.public_key_jwk) if payload.public_key_jwk else device.public_key_jwk
    device.last_seen_at = now
    db.commit()
    db.refresh(device)
    return device


@app.delete("/api/devices/{device_id}")
def revoke_device(
    device_id: str,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict[str, str]:
    safe_id = require_hex_id(device_id, "device id")
    device = db.get(Device, safe_id)
    if not device or device.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Device not found")
    device.revoked_at = utcnow()
    device.status = "revoked"
    db.commit()
    return {"status": "revoked"}


@app.get("/api/devices/link/pending", response_model=list[DeviceLinkSessionOut])
def list_pending_device_links(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    now = utcnow()
    rows = db.scalars(
        select(DeviceLinkSession)
        .where(DeviceLinkSession.user_id == current_user.id, DeviceLinkSession.expires_at > now, DeviceLinkSession.consumed_at.is_(None))
        .order_by(DeviceLinkSession.created_at.desc())
        .limit(20)
    ).all()
    return [link_session_to_out(row, include_secret=True) for row in rows]


@app.get("/api/devices/link/{session_id}/status", response_model=DeviceLinkSessionOut)
def get_device_link_status(
    session_id: str,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    safe_id = require_hex_id(session_id, "link session id")
    session = db.get(DeviceLinkSession, safe_id)
    if not session or session.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Device link request not found")
    return link_session_to_out(session, include_secret=False)


@app.post("/api/devices/link/start", response_model=DeviceLinkSessionOut)
def start_device_link(
    payload: DeviceLinkStartRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    if payload.public_key_jwk:
        assert_public_key_jwk(payload.public_key_jwk)
    device_id = require_hex_id(payload.device_id, "device id")
    now = utcnow()
    device = db.get(Device, device_id)
    if not device:
        device = Device(id=device_id, user_id=current_user.id, name=payload.device_name[:120], status="pending", created_at=now, last_seen_at=now)
        db.add(device)
    elif device.user_id != current_user.id:
        raise HTTPException(status_code=409, detail="Device id collision")
    else:
        device.name = payload.device_name[:120]
        device.status = "pending"
        device.last_seen_at = now
    if payload.public_key_jwk:
        device.public_key_jwk = json.dumps(payload.public_key_jwk)
    session = ensure_pending_device_link(db, current_user, device, payload.public_key_jwk)
    db.commit()
    db.refresh(session)
    return link_session_to_out(session, include_secret=False)


@app.post("/api/devices/link/{session_id}/approve", response_model=DeviceLinkSessionOut)
def approve_device_link(
    session_id: str,
    payload: DeviceLinkApproveRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    safe_id = require_hex_id(session_id, "link session id")
    session = db.get(DeviceLinkSession, safe_id)
    if not session or session.user_id != current_user.id or session.expires_at <= utcnow():
        raise HTTPException(status_code=404, detail="Device link request not found or expired")
    if session.consumed_at:
        raise HTTPException(status_code=409, detail="Device link was already consumed")
    if session.status == "rejected":
        raise HTTPException(status_code=409, detail="Device link was rejected")
    session.encrypted_key_package_json = payload.encrypted_key_package_json
    session.status = "approved"
    session.approved_at = utcnow()
    device = db.get(Device, session.new_device_id)
    if device and device.user_id == current_user.id:
        device.status = "trusted"
        device.approved_at = session.approved_at
        device.revoked_at = None
    db.commit()
    db.refresh(session)
    return link_session_to_out(session, include_secret=False)


@app.post("/api/devices/link/{session_id}/reject", response_model=DeviceLinkSessionOut)
def reject_device_link(
    session_id: str,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    safe_id = require_hex_id(session_id, "link session id")
    session = db.get(DeviceLinkSession, safe_id)
    if not session or session.user_id != current_user.id or session.expires_at <= utcnow():
        raise HTTPException(status_code=404, detail="Device link request not found or expired")
    if session.consumed_at:
        raise HTTPException(status_code=409, detail="Device link was already consumed")
    now = utcnow()
    session.status = "rejected"
    session.rejected_at = now
    device = db.get(Device, session.new_device_id)
    if device and device.user_id == current_user.id:
        device.status = "revoked"
        device.revoked_at = now
    db.commit()
    db.refresh(session)
    return link_session_to_out(session, include_secret=False)


@app.post("/api/devices/link/{session_id}/lost-device/start", response_model=DeviceLostStartOut)
def start_lost_device_email_confirmation(
    session_id: str,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DeviceLostStartOut:
    safe_id = require_hex_id(session_id, "link session id")
    session = db.get(DeviceLinkSession, safe_id)
    if not session or session.user_id != current_user.id or session.expires_at <= utcnow():
        raise HTTPException(status_code=404, detail="Device link request not found or expired")
    if session.status not in {"pending", "email_sent"}:
        raise HTTPException(status_code=409, detail="This device link is not waiting for email confirmation")
    sent_key, inflight_key = begin_email_request(db, "device_lost_confirm", session.id)
    previous_status = session.status
    try:
        token = secrets.token_urlsafe(32)
        session.email_token_hash = recovery_token_hash(token)
        session.email_requested_at = utcnow()
        session.status = "email_sent"
        db.commit()
        base = str(settings.public_base_url).rstrip("/")
        link = f"{base}/?device_confirm_token={token}"
        body = (
            f"ChatE received a login request from a new device: {session.new_device_name}.\n\n"
            "Only continue if this was you. Email confirmation allows the new device into the account, "
            "but it does not recover old encrypted chats without your security.json/key passphrase or another trusted device.\n\n"
            f"Confirm this device: {link}\n\n"
            "If this was not you, ignore this email and revoke the pending device from an already trusted device."
        )
        deliver_account_email(get_user_email(current_user), "Confirm new ChatE device", body)
        finish_email_request_success(db, sent_key, inflight_key)
    except Exception:
        session.email_token_hash = None
        session.email_requested_at = None
        session.status = previous_status
        db.commit()
        finish_email_request_failure(db, inflight_key)
        raise
    return DeviceLostStartOut(detail="Confirmation email sent to the registered email address.")


@app.post("/api/devices/link/lost-device/confirm", response_model=AuthFlowResponse)
def confirm_lost_device_email(
    payload: DeviceLostConfirmRequest,
    db: Annotated[Session, Depends(get_db)],
) -> AuthFlowResponse:
    token_hash = recovery_token_hash(payload.token)
    session = db.scalar(select(DeviceLinkSession).where(DeviceLinkSession.email_token_hash == token_hash))
    if not session or session.expires_at <= utcnow() or session.consumed_at:
        raise HTTPException(status_code=400, detail="Invalid or expired device confirmation link")
    if session.status not in {"email_sent", "pending"}:
        raise HTTPException(status_code=409, detail="Device request is no longer waiting for email confirmation")
    now = utcnow()
    session.status = "email_approved"
    session.email_approved_at = now
    session.approved_at = now
    session.email_token_hash = None
    device = db.get(Device, session.new_device_id)
    if device and device.user_id == session.user_id:
        device.status = "trusted"
        device.approved_at = now
        device.revoked_at = None
    db.commit()
    return AuthFlowResponse(detail="New device confirmed by email. Return to the waiting ChatE tab to continue. Old encrypted chats still need your key package or trusted-device approval.")


@app.post("/api/devices/link/{session_id}/complete", response_model=DeviceLinkCompleteOut)
def complete_device_link(
    session_id: str,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DeviceLinkCompleteOut:
    safe_id = require_hex_id(session_id, "link session id")
    session = db.get(DeviceLinkSession, safe_id)
    if not session or session.user_id != current_user.id or session.new_device_id == "" or session.expires_at <= utcnow():
        raise HTTPException(status_code=404, detail="Device link request not found or expired")
    if session.status == "rejected":
        raise HTTPException(status_code=403, detail="Device link was rejected")
    if session.status not in {"approved", "email_approved"}:
        raise HTTPException(status_code=409, detail="Device link is not approved yet")
    if session.consumed_at:
        raise HTTPException(status_code=409, detail="Device link was already consumed")
    if session.status == "approved" and not session.encrypted_key_package_json:
        raise HTTPException(status_code=409, detail="Trusted device did not attach a key package")
    session.consumed_at = utcnow()
    session.status = "consumed"
    device = db.get(Device, session.new_device_id)
    if device and device.user_id == current_user.id:
        device.last_seen_at = utcnow()
        device.status = "trusted"
        device.revoked_at = None
        device.approved_at = device.approved_at or utcnow()
    db.commit()
    if session.encrypted_key_package_json:
        return DeviceLinkCompleteOut(status="approved", encrypted_key_package_json=session.encrypted_key_package_json, detail="Trusted device approved this login and shared your encrypted key package.")
    return DeviceLinkCompleteOut(status="email_approved", encrypted_key_package_json=None, detail="Email confirmed this device. Old encrypted chats still require security.json/key passphrase or trusted-device approval.")


@app.get("/api/conversations/{other_user_id}/settings", response_model=ConversationSettingsOut)
def get_chat_settings(
    other_user_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ConversationSettingsOut:
    other = db.get(User, other_user_id)
    if not other or other.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    setting = get_conversation_setting(db, current_user.id, other_user_id)
    return ConversationSettingsOut(
        other_user_id=other_user_id,
        disappearing_seconds=setting.disappearing_seconds if setting else None,
        updated_by_id=setting.updated_by_id if setting else None,
        updated_at=setting.updated_at if setting else None,
    )


@app.put("/api/conversations/{other_user_id}/settings", response_model=ConversationSettingsOut)
async def update_chat_settings(
    other_user_id: int,
    payload: ConversationSettingsUpdate,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ConversationSettingsOut:
    other = db.get(User, other_user_id)
    if not other or other.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")
    if is_blocked_between(db, current_user.id, other_user_id):
        raise HTTPException(status_code=403, detail="Messaging is blocked for this conversation")
    low, high = conversation_pair(current_user.id, other_user_id)
    setting = get_conversation_setting(db, current_user.id, other_user_id)
    if not setting:
        setting = ConversationSetting(user_low_id=low, user_high_id=high, updated_at=utcnow())
        db.add(setting)
    seconds = payload.disappearing_seconds
    setting.disappearing_seconds = int(seconds) if seconds and seconds > 0 else None
    setting.updated_by_id = current_user.id
    setting.updated_at = utcnow()
    db.commit()
    db.refresh(setting)
    notice = {
        "type": "conversation:settings",
        "conversation_user_id": current_user.id,
        "other_user_id": other_user_id,
        "disappearing_seconds": setting.disappearing_seconds,
        "updated_by_id": current_user.id,
        "updated_at": setting.updated_at.isoformat() + "Z",
    }
    await HUB.send_to_user(other_user_id, notice)
    await HUB.send_to_user(current_user.id, {**notice, "conversation_user_id": other_user_id})
    return ConversationSettingsOut(
        other_user_id=other_user_id,
        disappearing_seconds=setting.disappearing_seconds,
        updated_by_id=setting.updated_by_id,
        updated_at=setting.updated_at,
    )


@app.patch("/api/messages/{message_id}", response_model=MessageOut)
async def edit_message(
    message_id: int,
    payload: MessageEditRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    msg = db.get(Message, message_id)
    if not msg or msg.sender_id != current_user.id:
        raise HTTPException(status_code=404, detail="Editable message not found")
    if msg.message_type != "text":
        raise HTTPException(status_code=400, detail="Only text messages can be edited in this MVP")
    if payload.key_session_id:
        session = db.get(MessageKeySession, payload.key_session_id)
        if not session or session.sender_id != current_user.id or session.receiver_id != msg.receiver_id:
            raise HTTPException(status_code=403, detail="Temporary key session does not belong to this message")
    elif not payload.encrypted_key_for_receiver or not payload.encrypted_key_for_sender:
        raise HTTPException(status_code=400, detail="Edited message needs a key session or wrapped keys")
    msg.ciphertext = protect_message_field(payload.ciphertext) or ""
    msg.iv = protect_message_field(payload.iv) or ""
    msg.key_session_id = payload.key_session_id
    msg.encrypted_key_for_receiver = protect_message_field(payload.encrypted_key_for_receiver or "") or ""
    msg.encrypted_key_for_sender = protect_message_field(payload.encrypted_key_for_sender or "") or ""
    msg.edited_at = utcnow()
    db.commit()
    db.refresh(msg)
    out = message_to_dict(msg, db)
    event = {"type": "message:edited", "message_id": msg.id, "conversation_user_id": current_user.id, "message": jsonable_encoder(out)}
    await HUB.send_to_user(msg.receiver_id, event)
    await HUB.send_to_user(current_user.id, {**event, "conversation_user_id": msg.receiver_id})
    return out


@app.post("/api/messages/{message_id}/reactions", response_model=MessageOut)
async def react_to_message(
    message_id: int,
    payload: MessageReactionRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    msg = db.get(Message, message_id)
    if not msg or current_user.id not in {msg.sender_id, msg.receiver_id}:
        raise HTTPException(status_code=404, detail="Message not found")
    emoji = payload.emoji.strip()[:16]
    existing_same = db.scalar(select(MessageReaction).where(MessageReaction.message_id == message_id, MessageReaction.user_id == current_user.id, MessageReaction.emoji == emoji))
    if existing_same:
        db.delete(existing_same)
    else:
        # Keep one active reaction per user per message for predictable UI.
        for old in db.scalars(select(MessageReaction).where(MessageReaction.message_id == message_id, MessageReaction.user_id == current_user.id)).all():
            db.delete(old)
        db.add(MessageReaction(message_id=message_id, user_id=current_user.id, emoji=emoji, created_at=utcnow()))
    db.commit()
    db.refresh(msg)
    out = message_to_dict(msg, db)
    other_id = msg.receiver_id if current_user.id == msg.sender_id else msg.sender_id
    event = {"type": "message:reaction", "message_id": msg.id, "conversation_user_id": current_user.id, "message": jsonable_encoder(out)}
    await HUB.send_to_user(other_id, event)
    await HUB.send_to_user(current_user.id, {**event, "conversation_user_id": other_id})
    return out


@app.delete("/api/messages/{message_id}")
async def delete_message(
    message_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict[str, str]:
    msg = db.get(Message, message_id)
    if not msg or (msg.sender_id != current_user.id and msg.receiver_id != current_user.id):
        raise HTTPException(status_code=404, detail="Message not found")

    sender_id = msg.sender_id
    receiver_id = msg.receiver_id
    deleted_at = utcnow().isoformat()
    blob_id = msg.blob_id

    db.delete(msg)
    if blob_id:
        blob = db.get(EncryptedBlob, blob_id)
        safe_delete_blob_file(blob)
        if blob:
            db.delete(blob)
    db.commit()

    event = {
        "type": "message:deleted",
        "message_id": message_id,
        "sender_id": sender_id,
        "receiver_id": receiver_id,
        "deleted_by": current_user.id,
        "deleted_at": deleted_at,
    }
    await HUB.fanout({sender_id, receiver_id}, event)
    return {"status": "deleted"}


@app.delete("/api/conversations/{other_user_id}")
async def delete_conversation(
    other_user_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict[str, int]:
    other = db.get(User, other_user_id)
    if not other or other.is_deleted:
        raise HTTPException(status_code=404, detail="User not found")

    rows = db.execute(
        select(Message.id, Message.blob_id).where(
            or_(
                and_(Message.sender_id == current_user.id, Message.receiver_id == other_user_id),
                and_(Message.sender_id == other_user_id, Message.receiver_id == current_user.id),
            )
        )
    ).all()
    message_ids = [int(row[0]) for row in rows]
    blob_ids = [row[1] for row in rows if row[1]]
    count = len(message_ids)
    if blob_ids:
        blobs = db.scalars(select(EncryptedBlob).where(EncryptedBlob.id.in_(blob_ids))).all()
        for blob in blobs:
            safe_delete_blob_file(blob)
        db.execute(delete(EncryptedBlob).where(EncryptedBlob.id.in_(blob_ids)))
    if message_ids:
        db.execute(delete(MessageReaction).where(MessageReaction.message_id.in_(message_ids)))
        db.execute(delete(Message).where(Message.id.in_(message_ids)))
    db.commit()

    await HUB.send_to_user(current_user.id, {
        "type": "conversation:deleted",
        "conversation_user_id": other_user_id,
        "deleted_by": current_user.id,
        "message_ids": message_ids,
    })
    await HUB.send_to_user(other_user_id, {
        "type": "conversation:deleted",
        "conversation_user_id": current_user.id,
        "deleted_by": current_user.id,
        "message_ids": message_ids,
    })
    return {"deleted": count}


@app.post("/api/account/deletion-request", response_model=DeletionRequestOut)
def request_account_deletion(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DeletionRequestOut:
    now = utcnow()
    current_user.deletion_requested_at = now
    current_user.deletion_scheduled_at = now + timedelta(days=7)
    db.commit()
    db.refresh(current_user)
    return DeletionRequestOut(
        deletion_requested_at=current_user.deletion_requested_at,
        deletion_scheduled_at=current_user.deletion_scheduled_at,
    )
