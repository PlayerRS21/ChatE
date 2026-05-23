# ChatE email sending

ChatE uses a backend mailer abstraction. Auth flows call one service, and the service either writes a dev email log or sends through SMTP.

## Local development

Use the default:

```env
CHATE_MAIL_MODE=dev
CHATE_PUBLIC_BASE_URL=http://127.0.0.1:8000
```

Verification and recovery emails are written to:

```text
backend/storage/mailbox/dev_mailbox.log
```

The same message is printed to the backend terminal.

## Where to put `.env`

Put `.env` in the project root, next to `.env.example`:

```text
chate_mvp_fixed_v37/
├── .env
├── .env.example
├── backend/
├── frontend/
└── scripts/
```

From v37 onward, the backend automatically loads `<project>/.env`, so you can start it normally:

```bash
cd backend
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

You no longer need `--env-file ../.env`. Real shell environment variables still override `.env`, which is the correct production behavior.

## Production SMTP

Set:

```env
CHATE_MAIL_MODE=smtp
CHATE_PUBLIC_BASE_URL=https://your-domain.example
CHATE_SMTP_HOST=smtp.your-provider.example
CHATE_SMTP_PORT=587
CHATE_SMTP_USERNAME=your-smtp-user-or-api-key
CHATE_SMTP_PASSWORD=your-smtp-password-or-api-secret
CHATE_SMTP_FROM=ChatE <no-reply@your-domain.example>
CHATE_SMTP_TLS=true
CHATE_SMTP_SSL=false
```

Use `CHATE_SMTP_SSL=true` only for implicit SSL ports such as 465. For port 587, use `CHATE_SMTP_TLS=true`.

## E2EE rule

Email recovers account access only. It never recovers encryption keys. Old messages still need one of these:

- exported `security.json` plus its passphrase
- trusted-device handoff
- a browser/device that already has the key cached and unlocked

That is intentional. If email alone could recover old messages, ChatE would not have serious E2EE.
