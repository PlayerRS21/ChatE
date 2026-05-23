from __future__ import annotations

from datetime import UTC, datetime


def utcnow() -> datetime:
    """Return naive UTC for compatibility with existing SQLite DateTime rows.

    Python 3.13 deprecates datetime.utcnow(). SQLAlchemy's SQLite DateTime
    columns in this project are naive, so keep the storage shape unchanged while
    using the supported timezone-aware clock internally.
    """
    return datetime.now(UTC).replace(tzinfo=None)


def utc_from_timestamp(value: int | float) -> datetime:
    return datetime.fromtimestamp(value, UTC).replace(tzinfo=None)


def utc_iso_z() -> str:
    return utcnow().isoformat() + "Z"
