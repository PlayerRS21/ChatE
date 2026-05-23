from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

DATABASE_URL = settings.database_url

engine_kwargs = {"future": True}
if DATABASE_URL.startswith("sqlite"):
    # SQLite is local/in-process; pool_pre_ping adds one extra query per request
    # and makes the chat feel slower on weak machines. Keep it for network DBs only.
    engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    engine_kwargs["pool_pre_ping"] = True

engine = create_engine(DATABASE_URL, **engine_kwargs)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, connection_record):  # pragma: no cover - depends on sqlite driver
        cursor = dbapi_connection.cursor()
        try:
            # WAL allows reads while writes are happening, which matters for chat UIs.
            # Non-critical tuning pragmas must never kill app startup; SQLite can throw
            # transient disk I/O errors when a stale WAL/SHM file exists or a dev server
            # was killed during restart. Keep correctness pragmas, best-effort the rest.
            required = [
                "PRAGMA busy_timeout=8000",
                "PRAGMA foreign_keys=ON",
            ]
            tuning = [
                "PRAGMA journal_mode=WAL",
                "PRAGMA synchronous=NORMAL",
                "PRAGMA temp_store=MEMORY",
                "PRAGMA cache_size=-32000",
                "PRAGMA mmap_size=268435456",
                "PRAGMA optimize",
            ]
            for statement in required:
                cursor.execute(statement)
            for statement in tuning:
                try:
                    cursor.execute(statement)
                except Exception:
                    # Performance tuning is useful, but failing open is better than
                    # refusing to boot the local messenger on a recoverable SQLite state.
                    pass
        finally:
            cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, expire_on_commit=False, bind=engine, future=True)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
