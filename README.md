# ChatE

ChatE is a browser-based encrypted one-to-one chat application built with **FastAPI**, **SQLite/PostgreSQL**, **WebSocket realtime**, **browser WebCrypto**, and a **Progressive Web App** frontend.

It is designed as a self-hosted messaging MVP: the backend serves the frontend, API, WebSocket endpoint, encrypted attachment storage, push-subscription endpoints, account flows, and device-linking flows from one application.

> Brutal but important: ChatE is not a static website. Do not expect Netlify/Vercel-style static hosting alone to run the full app. You need a Python backend that can run FastAPI/Uvicorn and support WebSockets.

---

## Table of contents

- [What ChatE includes](#what-chate-includes)
- [Project structure](#project-structure)
- [Requirements](#requirements)
- [Local installation](#local-installation)
- [Running the app locally](#running-the-app-locally)
- [The `.env` file](#the-env-file)
- [Environment variable reference](#environment-variable-reference)
- [Email setup](#email-setup)
- [Web Push notification setup](#web-push-notification-setup)
- [Database setup](#database-setup)
- [File and attachment storage](#file-and-attachment-storage)
- [Security model](#security-model)
- [Device linking and key recovery](#device-linking-and-key-recovery)
- [PWA/mobile behavior](#pwamobile-behavior)
- [Testing and verification](#testing-and-verification)
- [Running with Docker](#running-with-docker)
- [Deployment](#deployment)
- [GitHub upload rules](#github-upload-rules)
- [Troubleshooting](#troubleshooting)
- [Operational checklist](#operational-checklist)

---

## What ChatE includes

ChatE includes the core pieces expected from a modern encrypted messenger MVP:

- Account registration and login.
- Optional email verification and password reset.
- Browser-side encrypted private key package.
- One-to-one encrypted text messages.
- Encrypted attachments and encrypted blob storage.
- Realtime messaging through WebSocket at `/ws`.
- Delivered/read state behavior.
- Presence updates.
- Typing/recording indicators.
- Reactions, reply, edit, forward, copy, and delete actions.
- Conversation deletion.
- Disappearing-message support.
- User profiles, display names, bios, and avatars.
- Public-key lookup and repair flows.
- Safety/key-history checks.
- Device registration and trusted-device handoff flows.
- Lost-device flow through email confirmation.
- Block and report system.
- PWA manifest, service worker, install support, and offline fallback.
- Browser push notification subscription endpoints.
- Local development mailbox for email testing.
- SMTP support for real email sending.
- SQLite by default, PostgreSQL-compatible connection string support.
- Docker and docker-compose support.
- Preflight, test, and security scan scripts.

---

## Project structure

A clean repository should look like this at the top level:

```text
backend/
frontend/
scripts/
tests/
docs/
deploy/
Dockerfile
docker-compose.yml
README.md
SETUP_ARCH.md
.env.example
.gitignore
```

Important folders:

```text
backend/app/                 FastAPI backend source
backend/app/main.py          Main app, API routes, WebSocket route, startup setup
backend/app/config.py        Environment variable configuration
backend/app/models.py        SQLAlchemy models
backend/app/schemas.py       API schemas
backend/app/services/        Email and metadata encryption helpers
frontend/                    HTML/CSS/JS frontend served by FastAPI
frontend/js/app.js           Main chat frontend
frontend/js/settings.js      Settings/security frontend
frontend/sw.js               Service worker
frontend/manifest.webmanifest PWA manifest
scripts/                     Local run, test, security, VAPID, and sharing scripts
tests/                       Backend and frontend smoke tests
docs/                        Extra setup/security notes
```

Runtime folders are created/used by the app and should not be committed:

```text
backend/chate.db
backend/storage/
backend/uploads/
backend/.venv/
__pycache__/
```

---

## Requirements

Recommended:

- Python **3.12** or **3.13**.
- `pip` and `venv`.
- SQLite for simple local/demo use.
- Node.js only if you want frontend syntax checks or Playwright smoke tests.
- A modern browser with WebCrypto support.

Python 3.14 may work with the pinned modern dependency ranges, but for fewer package headaches use Python 3.12 or 3.13.

On Arch Linux:

```bash
sudo pacman -S --needed python python-pip base-devel sqlite nodejs npm
```

Optional for public local testing through Cloudflare Tunnel:

```bash
sudo pacman -S --needed cloudflared
```

---

## Local installation

From the project root:

```bash
cd chate
python -m venv backend/env
source backend/env/bin/activate
python -m pip install --upgrade pip setuptools wheel
pip install -r backend/requirements.txt
```

Create your local `.env` file:

```bash
cp .env.example .env
```

For local development, the default `.env.example` values are mostly usable. At minimum, change secrets before any public deployment.

---

## Running the app locally

### Development run

```bash
source backend/env/bin/activate
cd backend
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:8000
```

The backend automatically loads `.env` from either:

```text
<project>/.env
<project>/backend/.env
```

Real environment variables override values from `.env`.

### Fast local run without reload

This is smoother on weak laptops because reload mode adds overhead:

```bash
./scripts/run_fast_local.sh
```

Open:

```text
http://127.0.0.1:8000
```

### Production-style local run

Use this after setting real secrets in `.env`:

```bash
./scripts/run_prod_local.sh
```

This script refuses to start if `CHATE_SECRET_KEY` is still the unsafe default.

### Temporary public local link

For quick testing from another device:

```bash
./scripts/share_cloudflare.sh
```

This starts the app and opens a temporary Cloudflare Tunnel URL. Keep the terminal open. The public link dies when the process stops.

---

## The `.env` file

The `.env` file controls the features that need secrets or deployment-specific configuration: database URL, email sending, public URL, push notifications, server encryption key, CORS, trusted hosts, and runtime limits.

### Correct rule

```text
.env.example  -> commit this to GitHub
.env          -> never commit this to GitHub
```

Your real `.env` contains secrets. Do not upload it to GitHub. On hosted platforms, copy each `.env` value into the platform’s **Environment Variables** or **Secrets** panel.

### Generate strong secrets

Generate a strong app secret:

```bash
python - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
```

Use separate values for:

```env
CHATE_SECRET_KEY=...
CHATE_SERVER_ENCRYPTION_KEY=...
```

Do not reuse weak strings like `password`, `secret`, `123456`, or `change-me`.

### Minimal local `.env`

Good enough for local testing:

```env
CHATE_ENV=development
CHATE_APP_NAME=ChatE
CHATE_SECRET_KEY=dev-only-change-before-deploy
CHATE_ACCESS_TOKEN_MINUTES=10080
CHATE_CORS_ORIGINS=*
CHATE_TRUSTED_HOSTS=*
CHATE_ALLOW_PUBLIC_REGISTRATION=true
CHATE_DATABASE_URL=sqlite:///./chate.db

CHATE_MAIL_MODE=dev
CHATE_PUBLIC_BASE_URL=http://127.0.0.1:8000

CHATE_METADATA_ENCRYPTION=true
CHATE_PROTECT_USER_PLAINTEXT=true
CHATE_SERVER_ENCRYPTION_KEY=dev-only-change-before-deploy

CHATE_VAPID_PUBLIC_KEY=
CHATE_VAPID_PRIVATE_KEY=
CHATE_VAPID_SUBJECT=mailto:admin@example.com
```

### Production-style `.env`

Use this shape for a real deployment:

```env
CHATE_ENV=production
CHATE_APP_NAME=ChatE
CHATE_SECRET_KEY=replace-with-a-long-random-secret
CHATE_ACCESS_TOKEN_MINUTES=10080

CHATE_PUBLIC_BASE_URL=https://your-domain.example
CHATE_CORS_ORIGINS=https://your-domain.example
CHATE_TRUSTED_HOSTS=your-domain.example,localhost,127.0.0.1
CHATE_ALLOW_PUBLIC_REGISTRATION=true

CHATE_DATABASE_URL=sqlite:///./chate.db
# For PostgreSQL:
# CHATE_DATABASE_URL=postgresql+psycopg://user:password@host:5432/chate

CHATE_MAIL_MODE=smtp
CHATE_SMTP_HOST=smtp.your-provider.example
CHATE_SMTP_PORT=587
CHATE_SMTP_USERNAME=your-smtp-user-or-api-key
CHATE_SMTP_PASSWORD=your-smtp-password-or-api-secret
CHATE_SMTP_FROM=ChatE <no-reply@your-domain.example>
CHATE_SMTP_TLS=true
CHATE_SMTP_SSL=false
CHATE_RECOVERY_TOKEN_MINUTES=30

CHATE_METADATA_ENCRYPTION=true
CHATE_PROTECT_USER_PLAINTEXT=true
CHATE_SERVER_ENCRYPTION_KEY=replace-with-another-long-random-secret

CHATE_MAX_UPLOAD_MB=100
CHATE_MAX_PACK_IMPORT_MB=20
CHATE_RATE_LIMIT_PER_MINUTE=600
CHATE_CHUNK_SIZE_MB=4
CHATE_MESSAGE_PAGE_LIMIT=40
CHATE_CONVERSATION_SCAN_LIMIT=240
CHATE_CLEANUP_INTERVAL_SECONDS=600
CHATE_LAST_SEEN_WRITE_SECONDS=240

CHATE_VAPID_PUBLIC_KEY=your-vapid-public-key
CHATE_VAPID_PRIVATE_KEY=your-vapid-private-key
CHATE_VAPID_SUBJECT=mailto:admin@your-domain.example
```

---

## Environment variable reference

### Core app variables

| Variable | Required | Purpose |
|---|---:|---|
| `CHATE_ENV` | Yes | `development` or `production`. Production enables stricter expectations. |
| `CHATE_APP_NAME` | No | App display name. |
| `CHATE_SECRET_KEY` | Yes | Signs auth tokens/sessions. Change before deployment. |
| `CHATE_ACCESS_TOKEN_MINUTES` | No | Login token lifetime in minutes. |
| `CHATE_PUBLIC_BASE_URL` | Yes for email/push | Public URL used in email links and deployment flows. |
| `CHATE_CORS_ORIGINS` | Yes if split frontend/backend | Comma-separated allowed frontend origins. Use your real domain in production. |
| `CHATE_TRUSTED_HOSTS` | Yes in production | Comma-separated allowed hostnames. |
| `CHATE_ALLOW_PUBLIC_REGISTRATION` | No | `true` allows anyone to register. Set `false` for invite/private deployments. |

### Database/storage variables

| Variable | Required | Purpose |
|---|---:|---|
| `CHATE_DATABASE_URL` | Yes | SQLAlchemy database URL. SQLite default is `sqlite:///./chate.db`. |
| `CHATE_BLOB_DIR` | No | Custom encrypted blob storage directory. |
| `CHATE_BLOB_TMP_DIR` | No | Custom chunk-upload temporary directory. |
| `CHATE_MAX_UPLOAD_MB` | No | Maximum encrypted file upload size. |
| `CHATE_MAX_PACK_IMPORT_MB` | No | Maximum sticker/GIF pack import size. |
| `CHATE_CHUNK_SIZE_MB` | No | Chunk-upload size limit. |

### Email variables

| Variable | Required | Purpose |
|---|---:|---|
| `CHATE_MAIL_MODE` | Yes | `dev`, `smtp`, or `off`. |
| `CHATE_SMTP_HOST` | Required for SMTP | SMTP host. |
| `CHATE_SMTP_PORT` | Required for SMTP | Usually `587` for STARTTLS or `465` for SSL. |
| `CHATE_SMTP_USERNAME` | Required for SMTP | SMTP username/API key. |
| `CHATE_SMTP_PASSWORD` | Required for SMTP | SMTP password/API secret. |
| `CHATE_SMTP_FROM` | Required for SMTP | Sender identity, for example `ChatE <no-reply@example.com>`. |
| `CHATE_SMTP_TLS` | No | `true` for STARTTLS, usually port `587`. |
| `CHATE_SMTP_SSL` | No | `true` for implicit SSL, usually port `465`. |
| `CHATE_RECOVERY_TOKEN_MINUTES` | No | Password-reset/email-flow token lifetime. |

### Metadata protection variables

| Variable | Required | Purpose |
|---|---:|---|
| `CHATE_METADATA_ENCRYPTION` | Recommended | Wraps selected database fields at rest. |
| `CHATE_PROTECT_USER_PLAINTEXT` | Recommended | Protects user profile/lookup fields using encrypted profile storage and blind indexes. |
| `CHATE_SERVER_ENCRYPTION_KEY` | Yes if metadata protection is on | Server-side at-rest encryption key. Do not lose or rotate casually. |

### Push notification variables

| Variable | Required for push | Purpose |
|---|---:|---|
| `CHATE_VAPID_PUBLIC_KEY` | Yes | Public VAPID key sent to browsers. |
| `CHATE_VAPID_PRIVATE_KEY` | Yes | Private VAPID key used to send Web Push. Keep secret. |
| `CHATE_VAPID_SUBJECT` | Yes | Contact string, usually `mailto:admin@example.com`. |

### Performance variables

| Variable | Purpose |
|---|---|
| `CHATE_RATE_LIMIT_PER_MINUTE` | API rate limit per IP/user window. |
| `CHATE_MESSAGE_PAGE_LIMIT` | Default message page size. |
| `CHATE_CONVERSATION_SCAN_LIMIT` | Conversation scan limit for hot query paths. |
| `CHATE_CLEANUP_INTERVAL_SECONDS` | Background cleanup interval for expired records. |
| `CHATE_LAST_SEEN_WRITE_SECONDS` | Reduces excessive presence writes. |

---

## Email setup

### Development mode

Use:

```env
CHATE_MAIL_MODE=dev
CHATE_PUBLIC_BASE_URL=http://127.0.0.1:8000
```

Verification and recovery emails are written to:

```text
backend/storage/mailbox/dev_mailbox.log
```

The backend also prints the dev email content in the terminal.

### SMTP mode

Use SMTP for real email delivery:

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

Use this pairing:

```text
Port 587 -> CHATE_SMTP_TLS=true, CHATE_SMTP_SSL=false
Port 465 -> CHATE_SMTP_TLS=false, CHATE_SMTP_SSL=true
```

Do not use your normal email account password if your provider supports app passwords or API keys. Use a dedicated app password/API key.

Important security fact: email reset restores account access only. It does not decrypt old encrypted messages. Old encrypted chats still need a trusted device or exported security package.

---

## Web Push notification setup

Web Push notifications require:

- HTTPS public deployment.
- Service worker registration.
- Browser notification permission.
- Valid VAPID keys.
- `CHATE_PUBLIC_BASE_URL` set to the real public URL.

Generate VAPID keys:

```bash
source backend/env/bin/activate
python scripts/generate_vapid_keys.py
```

Copy the output into `.env` or your host’s environment-variable panel:

```env
CHATE_VAPID_PUBLIC_KEY=...
CHATE_VAPID_PRIVATE_KEY=...
CHATE_VAPID_SUBJECT=mailto:admin@your-domain.example
```

Do not commit `CHATE_VAPID_PRIVATE_KEY` to GitHub.

If push notifications do not work, check these first:

1. App is served over HTTPS.
2. Browser notification permission is allowed.
3. Service worker is active.
4. `/api/push/vapid-public-key` returns a public key.
5. `/api/push/subscribe` succeeds after login.
6. `CHATE_VAPID_PRIVATE_KEY` is set on the backend.
7. `CHATE_PUBLIC_BASE_URL` matches your real deployed origin.

---

## Database setup

### SQLite

SQLite is the default:

```env
CHATE_DATABASE_URL=sqlite:///./chate.db
```

When running from `backend/`, this creates:

```text
backend/chate.db
```

SQLite is fine for local development, demos, and very small private use.

SQLite is not the best choice for serious public chat traffic. It can become a bottleneck under concurrent writes and must be backed up carefully.

### PostgreSQL

For a real deployment, PostgreSQL is better:

```env
CHATE_DATABASE_URL=postgresql+psycopg://user:password@host:5432/chate
```

If your database password contains special characters, URL-encode it.

### Startup initialization

The app creates required tables at startup. It also includes SQLite compatibility/backfill logic for older local databases. Still, do not treat that as a replacement for serious migration tooling if this becomes a real production project.

### Backups

Back up these together:

```text
Database
backend/storage/
backend/uploads/
CHATE_SERVER_ENCRYPTION_KEY
```

If you lose `CHATE_SERVER_ENCRYPTION_KEY`, protected server-side metadata already stored in the database may become unreadable.

---

## File and attachment storage

ChatE encrypts attachment bytes in the browser before upload. The backend stores encrypted blobs and encrypted metadata only.

Default runtime paths:

```text
backend/storage/blobs/         encrypted attachment blobs
backend/storage/blob_uploads/  temporary chunk uploads
backend/storage/mailbox/       dev email log
backend/uploads/avatars/       uploaded avatars
```

For deployment, these paths must be persistent. If your host deletes local disk on redeploy, uploaded media and SQLite data may disappear. Use persistent volumes or external storage for real usage.

Do not commit these folders to GitHub:

```text
backend/storage/
backend/uploads/
```

---

## Security model

ChatE’s security goal is narrow and specific:

- Message plaintext is encrypted in the browser before reaching the server.
- Attachment bytes are encrypted in the browser before upload.
- Private key material is stored locally as an encrypted browser key package.
- The server stores public keys, ciphertext, routing metadata, device data, and encrypted blobs.
- Optional metadata protection reduces what a raw database dump exposes.

What the live server can still see:

- Numeric sender/receiver IDs.
- Delivery/routing information.
- Timestamps.
- IP/user-agent level request metadata.
- Block/report/device relationships.
- Push subscription records.

What the server should not receive:

- Raw private keys.
- Key passphrases.
- Plain message bodies.
- Plain attachment bytes.

No browser E2EE app can be honestly described as perfect. If the delivered frontend code or user device is compromised, encryption guarantees collapse. That is not ChatE-specific; that is how browser-delivered E2EE works.

### Key passphrase rule

During registration, the user must set a key passphrase. This passphrase protects the local encryption key package. Losing it may mean losing access to old encrypted chats unless a trusted device or exported security package exists.

### Server encryption key warning

`CHATE_SERVER_ENCRYPTION_KEY` protects server-side metadata-at-rest. Do not casually change it after real data exists.

Safe to change on a fresh deployment:

```text
CHATE_SECRET_KEY
CHATE_SERVER_ENCRYPTION_KEY
CHATE_VAPID_PRIVATE_KEY
SMTP password
```

Dangerous to change after data exists:

```text
CHATE_SERVER_ENCRYPTION_KEY
```

Changing `CHATE_SECRET_KEY` logs users out because tokens become invalid. That is annoying but recoverable. Changing `CHATE_SERVER_ENCRYPTION_KEY` can make protected metadata unreadable.

---

## Device linking and key recovery

ChatE supports multiple-device flows without storing raw private keys on the server.

Main paths:

1. Existing trusted device approves a new device.
2. The old device encrypts handoff data for the new device.
3. The server relays ciphertext only.
4. A system/security notice is recorded for device/key changes.

Lost-device flow:

- Email can confirm account ownership.
- Email cannot decrypt old chats.
- Old chats require a trusted device, local key package, or exported security package.

That is intentional. If email alone could recover old message plaintext, the app would not be meaningfully end-to-end encrypted.

---

## PWA/mobile behavior

The frontend includes:

- `frontend/manifest.webmanifest`
- `frontend/sw.js`
- `frontend/offline.html`
- installable icons
- offline fallback
- mobile layout polish
- service-worker caching
- push subscription support

For the best PWA behavior:

- Use HTTPS.
- Use a real domain.
- Set `CHATE_PUBLIC_BASE_URL` to that domain.
- Avoid splitting frontend and backend unless you know how to configure CORS, cookies/tokens, WebSocket URL, service-worker scope, and push origin constraints.

If you host frontend and backend separately, you must configure:

```env
CHATE_CORS_ORIGINS=https://frontend-domain.example
CHATE_PUBLIC_BASE_URL=https://backend-domain.example
CHATE_TRUSTED_HOSTS=backend-domain.example
```

Single-origin deployment is simpler and recommended for this project:

```text
FastAPI serves frontend + API + WebSocket from one domain.
```

---

## Testing and verification

### Preflight check

Run before pushing or deploying:

```bash
./scripts/preflight_check.sh
```

It checks:

- Python syntax.
- Frontend JavaScript syntax.
- Backend test syntax.
- Playwright test syntax.
- Shell script syntax.
- Required file presence.
- No changelog files.

### Test suite

```bash
./scripts/run_tests.sh
```

It runs:

- Python compile checks.
- JS syntax checks.
- Pytest backend tests if `pytest` is installed.
- Playwright smoke test if Node setup is available.

Install optional test tools:

```bash
source backend/env/bin/activate
pip install pytest bandit pip-audit semgrep
npm i -D @playwright/test
npx playwright install chromium
```

### Security scan

```bash
./scripts/security_scan.sh
```

This runs syntax checks, tests, and optional security scanners if installed.

A passing security scan is not a proof of perfect security. It is a regression gate.

### Health check

After starting the server:

```bash
curl http://127.0.0.1:8000/api/health
```

Expected: JSON response with app/storage/environment information.

---

## Running with Docker

Build and run:

```bash
docker compose up --build
```

Open:

```text
http://127.0.0.1:8000
```

The compose file uses:

```text
.env
backend/storage volume
backend/uploads volume
backend database volume
```

For production Docker deployment, set real environment variables and persistent volumes. Do not bake secrets into the image.

---

## Deployment

### Correct deployment shape

ChatE should run as a backend web service:

```text
Uvicorn/FastAPI process
  ├─ serves frontend HTML/CSS/JS
  ├─ serves API routes
  ├─ serves WebSocket /ws
  ├─ stores encrypted blobs
  └─ connects to SQLite/PostgreSQL
```

Use this start command on most Python web-service hosts:

```bash
cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers
```

If the host does not provide `$PORT`, use `8000`:

```bash
cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers
```

### Static hosting warning

Netlify/Vercel-style static hosting alone is not enough for the full app because ChatE needs:

- FastAPI backend.
- WebSocket support.
- Database access.
- Upload/blob storage.
- Push subscription API.
- Email/password reset API.

You may host only the frontend on a static host, but then you must host the backend somewhere else and correctly configure CORS, URLs, service-worker scope, and WebSocket origin handling. For this project, single-origin deployment is cleaner.

### Production checklist

Before public deployment:

1. Use HTTPS.
2. Use a real domain.
3. Set `CHATE_ENV=production`.
4. Set strong `CHATE_SECRET_KEY`.
5. Set strong `CHATE_SERVER_ENCRYPTION_KEY`.
6. Set `CHATE_PUBLIC_BASE_URL=https://your-domain.example`.
7. Set `CHATE_CORS_ORIGINS=https://your-domain.example`.
8. Set `CHATE_TRUSTED_HOSTS=your-domain.example`.
9. Configure SMTP or set `CHATE_MAIL_MODE=off` if email flows are disabled.
10. Generate and set VAPID keys for push notifications.
11. Use persistent storage for database, blobs, and avatars.
12. Run `./scripts/preflight_check.sh`.
13. Run `./scripts/run_tests.sh`.
14. Confirm `/api/health` works.
15. Register a test account.
16. Send a test message.
17. Test WebSocket realtime in two browser windows.
18. Test attachment upload/download.
19. Test password reset/email flow.
20. Test push notification subscription.

---

## GitHub upload rules

Upload source code only.

### Upload these

```text
backend/app/
backend/requirements.txt
backend/share.py
frontend/
scripts/
tests/
docs/
deploy/
Dockerfile
docker-compose.yml
README.md
SETUP_ARCH.md
.env.example
.gitignore
```

### Do not upload these

```text
.env
.env.* except .env.example
backend/chate.db
backend/storage/
backend/uploads/
backend/.venv/
__pycache__/
*.pyc
.DS_Store
```

Your `.gitignore` should include:

```gitignore
.env
.env.*
!.env.example
backend/.venv/
backend/chate.db
backend/storage/
backend/uploads/
__pycache__/
*.pyc
.DS_Store
```

If you use GitHub browser drag-and-drop, manually check the repository after uploading. Browser uploads can accidentally include files that Git would normally ignore.

If you already uploaded `.env` publicly, treat it as leaked:

1. Delete `.env` from GitHub.
2. Rotate SMTP/app passwords.
3. Regenerate VAPID keys.
4. Change `CHATE_SECRET_KEY`.
5. Change `CHATE_SERVER_ENCRYPTION_KEY` only if this is a fresh deployment or you accept losing protected metadata access.

---

## Troubleshooting

### Login returns `401 Unauthorized`

Likely causes:

- Wrong username/password.
- You are using a fresh/empty `chate.db`.
- You uploaded/deployed without the old database.
- You changed environment values and invalidated old sessions.
- You changed `CHATE_SERVER_ENCRYPTION_KEY` and old protected metadata cannot be read correctly.

Fix:

1. Confirm you are using the intended database.
2. Register a fresh test user.
3. Confirm `.env` is loaded.
4. Confirm `CHATE_DATABASE_URL` points where you think it points.

### WebSocket closes with auth error

If `/ws` closes immediately after page load, the browser probably has a stale token or is logged out.

Fix:

1. Log out.
2. Clear site data/local storage if needed.
3. Log in again.
4. Confirm `/api/users/me` returns user data.

### Missing public key

This usually means a user account was created before proper key registration, local key package data is missing, or a browser profile has stale/corrupt key state.

Fix:

1. Open Settings → Security.
2. Try public-key/key-package repair if available.
3. Log out and log back in.
4. Use the correct key passphrase.
5. If it is a test account with no useful data, create a fresh account.

For old encrypted chats, do not expect the server to recover plaintext. You need the local key package, passphrase, trusted-device handoff, or exported security package.

### Email is not sending

Check:

```env
CHATE_MAIL_MODE=smtp
CHATE_SMTP_HOST=...
CHATE_SMTP_PORT=587
CHATE_SMTP_USERNAME=...
CHATE_SMTP_PASSWORD=...
CHATE_SMTP_FROM=ChatE <no-reply@your-domain.example>
CHATE_SMTP_TLS=true
CHATE_SMTP_SSL=false
```

For local testing, use:

```env
CHATE_MAIL_MODE=dev
```

Then read:

```text
backend/storage/mailbox/dev_mailbox.log
```

### Push notifications are not working

Check:

1. HTTPS is enabled.
2. Browser permission is granted.
3. Service worker is registered.
4. VAPID keys are set.
5. `CHATE_PUBLIC_BASE_URL` uses the real deployed URL.
6. The browser supports Web Push.
7. The user is logged in and subscribed.

### Service worker serves stale files

Try:

1. Open Settings and clear/refresh PWA cache if the UI exposes it.
2. Hard refresh the page.
3. In browser devtools, unregister the service worker.
4. Clear site data.
5. Reload.

### Attachments disappear after deployment

Your host likely deleted local runtime storage.

Fix:

- Use persistent volumes.
- Back up `backend/storage/` and `backend/uploads/`.
- Use external object storage for serious production.

### App works locally but not after deployment

Check:

1. Start command uses the right folder.
2. `$PORT` is passed correctly.
3. Environment variables are set on the host.
4. `CHATE_TRUSTED_HOSTS` includes the deployed hostname.
5. `CHATE_CORS_ORIGINS` includes the deployed frontend origin.
6. `CHATE_PUBLIC_BASE_URL` is correct.
7. Persistent disk/database is configured.
8. Logs show no missing dependency.

Correct start command for a normal repo root:

```bash
cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers
```

If you accidentally uploaded the whole project folder as a nested folder, adjust the path:

```bash
cd chate_mvp_fixed_v70_public_key_repair_full_audit/backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers
```

Better fix: make `backend/` exist directly at the repo root.

---

## Operational checklist

Use this checklist every time before sharing the app publicly:

```text
[ ] .env is not committed to GitHub
[ ] backend/chate.db is not committed to GitHub
[ ] backend/storage/ is not committed to GitHub
[ ] backend/uploads/ is not committed to GitHub
[ ] .env.example is committed
[ ] CHATE_SECRET_KEY is strong
[ ] CHATE_SERVER_ENCRYPTION_KEY is strong and backed up
[ ] CHATE_PUBLIC_BASE_URL is correct
[ ] CHATE_CORS_ORIGINS is correct
[ ] CHATE_TRUSTED_HOSTS is correct
[ ] SMTP is configured or intentionally disabled
[ ] VAPID keys are configured if push is needed
[ ] Database storage is persistent
[ ] Blob/upload storage is persistent
[ ] ./scripts/preflight_check.sh passes
[ ] ./scripts/run_tests.sh passes
[ ] /api/health works
[ ] Two-user chat test works
[ ] WebSocket realtime works
[ ] Attachment test works
[ ] Password reset/email test works
[ ] Push subscription test works if push is enabled
```

---

## Final production reality check

ChatE is a strong MVP foundation, not a magic production messenger. For real users you should eventually add:

- PostgreSQL instead of local SQLite.
- Proper database migrations.
- Persistent object storage for encrypted blobs.
- Backups.
- Monitoring.
- Error logging.
- Abuse controls.
- Admin moderation tools.
- Rate-limit tuning.
- Strong deployment isolation.
- Regular dependency audits.

For demo/private use, the current single FastAPI deployment is enough. For public production, harden the infrastructure before pretending it is finished.
