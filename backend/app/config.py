from __future__ import annotations

import os
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = Path(__file__).resolve().parents[1]


def _load_project_env() -> None:
    """Load ChatE environment variables from local .env files automatically.

    Priority:
    1. Real process environment variables stay strongest.
    2. Project-root .env: <project>/.env
    3. Backend-local .env: <project>/backend/.env

    This removes the need to start uvicorn with `--env-file ../.env` while
    still allowing production/container environments to override everything.
    """
    try:
        from dotenv import load_dotenv
    except Exception:
        return

    for env_path in (PROJECT_DIR / ".env", BACKEND_DIR / ".env"):
        if env_path.exists():
            load_dotenv(env_path, override=False)


_load_project_env()


def _bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _list(name: str, default: str = "*") -> list[str]:
    raw = os.getenv(name, default).strip()
    if not raw:
        return ["*"]
    return [part.strip() for part in raw.split(",") if part.strip()]


class Settings:
    app_name = os.getenv("CHATE_APP_NAME", "ChatE")
    environment = os.getenv("CHATE_ENV", "development")
    debug = _bool("CHATE_DEBUG", environment != "production")

    secret_key = os.getenv("CHATE_SECRET_KEY", "CHANGE_ME_FOR_PRODUCTION")
    access_token_minutes = _int("CHATE_ACCESS_TOKEN_MINUTES", 60 * 24 * 7)

    database_url = os.getenv("CHATE_DATABASE_URL", "sqlite:///./chate.db")
    cors_origins = _list("CHATE_CORS_ORIGINS", "*")
    trusted_hosts = _list("CHATE_TRUSTED_HOSTS", "*")

    max_blob_bytes = _int("CHATE_MAX_UPLOAD_MB", 100) * 1024 * 1024
    max_import_media_bytes = _int("CHATE_MAX_PACK_IMPORT_MB", 20) * 1024 * 1024
    chunk_size_limit = _int("CHATE_CHUNK_SIZE_MB", 4) * 1024 * 1024
    rate_limit_per_minute = _int("CHATE_RATE_LIMIT_PER_MINUTE", 600)
    cleanup_interval_seconds = _int("CHATE_CLEANUP_INTERVAL_SECONDS", 300)
    last_seen_write_seconds = _int("CHATE_LAST_SEEN_WRITE_SECONDS", 180)
    message_page_limit = _int("CHATE_MESSAGE_PAGE_LIMIT", 40)
    conversation_scan_limit = _int("CHATE_CONVERSATION_SCAN_LIMIT", 240)

    upload_dir = PROJECT_DIR / "backend" / "uploads"
    avatar_dir = upload_dir / "avatars"
    blob_dir = Path(os.getenv("CHATE_BLOB_DIR", str(PROJECT_DIR / "backend" / "storage" / "blobs")))
    blob_upload_tmp_dir = Path(os.getenv("CHATE_BLOB_TMP_DIR", str(PROJECT_DIR / "backend" / "storage" / "blob_uploads")))

    allow_public_registration = _bool("CHATE_ALLOW_PUBLIC_REGISTRATION", True)

    public_base_url = os.getenv("CHATE_PUBLIC_BASE_URL", "http://127.0.0.1:8000")
    mail_mode = os.getenv("CHATE_MAIL_MODE", "dev")  # dev | smtp | off
    smtp_host = os.getenv("CHATE_SMTP_HOST", "")
    smtp_port = _int("CHATE_SMTP_PORT", 587)
    smtp_username = os.getenv("CHATE_SMTP_USERNAME", "")
    smtp_password = os.getenv("CHATE_SMTP_PASSWORD", "")
    smtp_from = os.getenv("CHATE_SMTP_FROM", "ChatE <no-reply@chate.local>")
    smtp_tls = _bool("CHATE_SMTP_TLS", True)
    smtp_ssl = _bool("CHATE_SMTP_SSL", False)
    recovery_token_minutes = _int("CHATE_RECOVERY_TOKEN_MINUTES", 30)

    # Web Push notifications. Generate keys with scripts/generate_vapid_keys.py.
    vapid_public_key = os.getenv("CHATE_VAPID_PUBLIC_KEY", "")
    vapid_private_key = os.getenv("CHATE_VAPID_PRIVATE_KEY", "")
    vapid_subject = os.getenv("CHATE_VAPID_SUBJECT", smtp_from if smtp_from.startswith("mailto:") else f"mailto:{smtp_username or "admin@chate.local"}")

    # App-level metadata protection. This does not make the live server blind,
    # but it prevents a raw database dump from exposing profile fields and message ciphertext fields.
    metadata_encryption = _bool("CHATE_METADATA_ENCRYPTION", True)
    protect_user_plaintext = _bool("CHATE_PROTECT_USER_PLAINTEXT", True)
    server_encryption_key = os.getenv("CHATE_SERVER_ENCRYPTION_KEY", os.getenv("CHATE_DB_ENCRYPTION_KEY", secret_key))


settings = Settings()
