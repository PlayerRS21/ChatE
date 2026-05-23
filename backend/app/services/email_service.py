from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from pathlib import Path

from ..config import PROJECT_DIR, settings
from ..timeutils import utc_iso_z

log = logging.getLogger("chate.email")


class EmailDeliveryError(RuntimeError):
    pass


def _dev_deliver(to_email: str, subject: str, body: str) -> None:
    """Local development mail sink.

    This is intentionally explicit: it writes to a file and stdout so auth flows
    can be tested without silently pretending production email is configured.
    """
    out_dir = PROJECT_DIR / "backend" / "storage" / "mailbox"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = utc_iso_z()
    rendered = f"\n--- {stamp} ---\nTO: {to_email}\nSUBJECT: {subject}\n{body}\n"
    (out_dir / "dev_mailbox.log").open("a", encoding="utf-8").write(rendered)
    print("[ChatE DEV EMAIL]", rendered, flush=True)


def _smtp_deliver(to_email: str, subject: str, body: str) -> None:
    if not settings.smtp_host:
        raise EmailDeliveryError("SMTP host is not configured")

    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    smtp_cls = smtplib.SMTP_SSL if settings.smtp_ssl else smtplib.SMTP
    try:
        with smtp_cls(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
            if settings.smtp_tls and not settings.smtp_ssl:
                smtp.starttls()
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(msg)
    except Exception as exc:
        log.exception("email delivery failed")
        raise EmailDeliveryError("Could not send email. Check SMTP settings.") from exc


def send_account_email(to_email: str, subject: str, body: str) -> None:
    mode = (settings.mail_mode or "dev").strip().lower()
    if mode == "off":
        log.warning("email disabled; dropping email to %s subject=%s", to_email, subject)
        return
    if mode == "dev":
        _dev_deliver(to_email, subject, body)
        return
    if mode == "smtp":
        _smtp_deliver(to_email, subject, body)
        return
    raise EmailDeliveryError(f"Unsupported CHATE_MAIL_MODE={settings.mail_mode!r}")
