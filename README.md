## v38 PWA/mobile polish

This build focuses on phone/install UX: upgraded PWA manifest/icons, offline fallback page, service-worker update banner, encrypted outbox retry for already-encrypted text/sticker/GIF messages, mobile long-press action sheet, swipe-to-reply, safe-area fixes, keyboard viewport handling, bigger touch targets, and PWA diagnostics in Settings.

Attachment offline queue is intentionally not enabled yet because attachments require encrypted blob replay storage; doing that lazily would risk plaintext or broken blob state.

# ChatE MVP v17 v9

End-to-end encrypted one-to-one chat MVP built with FastAPI, SQLite, and browser WebCrypto.

## Run locally

```bash
cd chate_mvp_fixed_v37/backend
python -m venv env
source env/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:8000
```

From v37 onward, ChatE automatically loads the project-root `.env` file. You do not need `--env-file ../.env` when starting uvicorn.

## Share temporary public link

```bash
cd chate_mvp_fixed_v37/backend
python share.py
```

Keep the terminal open. The printed `https://*.trycloudflare.com` link dies when the process stops.

## v9 changes

- Refreshed chat UI with cleaner sidebar, better mobile layout, profile cards, and improved message area.
- Settings controls are consolidated into the dedicated `/settings` page.
- Added profile editing: display name and avatar URL.
- Added password change.
- Added conversation search.
- Added desktop notification toggle for incoming messages.
- Added compact layout toggle.
- Added local key package clearing on the current device.
- Added sent/delivered/read indicators.
- Added Enter-to-send and Shift+Enter newline.

## Security model

- Server stores only public keys and encrypted message payloads.
- Private keys are stored locally as encrypted key packages in IndexedDB.
- Losing the key package or key passphrase means old messages cannot be decrypted.
- Login password reset/change does not recover old chats.

This is still MVP-grade. Do not treat it as production until WebSocket realtime, rate limiting, audit logging, proper email reset, deployment hardening, and stronger device-key management are implemented.

## v10 notes

- Messages stay unlocked across reloads because the app stores non-extractable unlocked CryptoKeys in IndexedDB after login/unlock. Clicking **Lock messages** or logging out clears those unlocked keys.
- New text messages use a 10-minute temporary AES-GCM key session. RSA-OAEP wraps that temporary key once per session instead of once per message.
- Message history is paginated. The client loads the latest page first and fetches older messages dynamically when scrolling upward.
- Settings now includes an avatar uploader with crop/zoom/drag selection instead of avatar URLs.
- Notifications use the browser Notification API with a service worker fallback. Use the Settings test button to verify browser permission.


## v13 notes

- Messages stay locked unless the key passphrase was explicitly entered in the current login session.
- New chats can still use fresh temporary AES sessions without decrypting old history.
- Online/offline/typing/recording indicators are polling-based for MVP testing.
- Profile pictures use the new cropper in Settings.


## v14 changes

- Better responsive UI for desktop, tablet, and mobile.
- Mobile chat mode with an Inbox button.
- Duplicate-send protection on both client and server.
- Backend idempotency using `client_message_id`.
- Per-chat local drafts.
- Emoji picker.
- Copy button for decrypted messages.


## v15 additions

- Encrypted attachments: images, video, voice notes, and small files.
- Click the mic button once to start a voice note, click again to stop and send.
- Live user search in the search/new-chat drawer.
- Pin, mute, block, delete chat, and per-message delete controls.
- Search inside loaded decrypted messages from the chat top bar.
- Blocked users can be managed from Settings.

MVP attachment limit is 4 MB because encrypted payloads are stored inside SQLite messages. For production, move encrypted blobs to S3/MinIO and keep only encrypted metadata + blob URL in the database.


## v16 notes

- Attachments now send correctly. Supported MVP uploads: images, videos, audio/voice notes, PDFs, text/markdown/CSV, ZIP/JSON, Office documents, and generic small files up to 8 MB.
- Enter the key passphrase once on a browser to trust that device. Reloads and later logins stay unlocked until you click **Lock messages**, clear local keys, or request account deletion.
- Appearance is now controlled from Settings using **System default / Dark mode / Light mode**.
- The chat UI uses fixed viewport-height containers and responsive breakpoints so resizing the browser does not stretch/crash the layout.


## v17 UI hotfix

- Rebuilt the responsive CSS layout.
- Fixed missing composer/text area.
- Fixed topbar/action-button overflow.
- Fixed chat area clipping on narrow and resized windows.


## v18 UI hotfix

- Composer/text box stays pinned at the bottom of the chat.
- Chat list/header avatars now use real image elements for consistent profile pictures.
- CSS/JS URLs include cache busting; still hard refresh once after upgrade.

## v19 highlights

- WebSocket realtime highway at `/ws` for new-message, presence, typing, recording, and read-state events.
- Polling is now a fallback instead of the primary delivery mechanism.
- Animated emoji/sticker picker and built-in encrypted GIF-style stickers.
- Voice recording tray with pulse/wave animation, timer, cancel, and send controls.
- Custom voice-note player instead of a plain browser audio tag.

Security note: the WebSocket highway carries service events only. Message bodies are still encrypted client-side before storage/transmission.

## v20 Telegram-style emoji suggestions

Type a supported emoji such as 🔥, 😂, ❤️, 🎉, 🚀, 👍, 🐱 or a shortcut such as `:fire`, `:lol`, `:heart`, `:cat` in the composer. ChatE shows a suggestion tray with encrypted animated emoji and built-in GIF-style stickers. The generated stickers are encrypted before upload like normal messages.


## v22 update

Realtime delete sync is fixed. Message and conversation deletes now update both sides instantly through the WebSocket highway.


## v24 media architecture

v24 adds encrypted blob storage. Files are encrypted in the browser first, uploaded as encrypted bytes to `backend/storage/blobs/`, and only metadata is stored in SQLite. The encrypted message payload stores the file key/IV so the server still cannot decrypt the attachment.

Emoji, GIF, and sticker support now includes local pack imports from image files or JSON packs. Imported packs are stored in IndexedDB and searched from the picker.


## v24 feature notes

- Large attachments use encrypted blob storage with chunked upload support and progress UI.
- GIF/sticker packs can be imported from Settings using media files, JSON packs, or third-party image/GIF URLs. Imported packs are kept in IndexedDB on the current browser.
- Chat actions now include reply, edit, react, forward, copy, and delete.
- Logout is now in Settings. The home screen uses a lock icon for message lock/unlock.


## v25 production-oriented additions

- Environment-driven configuration via `.env.example`.
- Dockerfile and docker-compose for repeatable deployment.
- Security headers, trusted-host support, and basic rate limiting.
- `/api/health` reports version/storage/environment.
- Optional PostgreSQL URL support through `CHATE_DATABASE_URL`.
- Encrypted blob storage remains the default for large files; the server still stores encrypted bytes only.
- Emoji/GIF/sticker system now includes a much larger built-in no-key library plus local import support for GIF, WebP, PNG, JPEG, SVG, WebM, MP4, URL imports, and JSON packs.

This is production-oriented, not magic. For a serious public deployment, use HTTPS, a real domain, backups, monitoring, PostgreSQL, object storage, and a proper process manager.

## v28 Security Notes

v28 adds a Security center, safety fingerprints, stronger browser security headers, production secret-key guardrails, safer attachment filtering, and more robust low-risk network error handling.

For sensitive chats, compare the peer safety fingerprint out-of-band before trusting the conversation. This helps detect unexpected public-key changes or server-side key substitution.

No browser E2EE app can honestly claim 100% security. The design goal is to keep message/file contents unreadable to the server, network observers, and database/blob leaks, assuming endpoint devices and delivered frontend code are trusted.

## v29 security/stability hardening

- Adds local peer key-change detection. If a contact's encryption public key changes unexpectedly, the chat shows a warning and asks before sending.
- Adds verified safety-number state per peer on the current browser.
- Adds server-side public-key validation and key-rotation audit history.
- Adds `/api/security/key-history/{user_id}` for key-history inspection.
- Adds stricter login/register brute-force throttling.
- Adds no-store cache headers for API responses.
- Hardens the chat three-dot action menu using data-action delegation and capture fallback.

Security claim stays narrow: message/file contents are designed to remain unreadable to the server/network/database/blob-store leaks, assuming endpoint devices and delivered frontend code are trusted.


## Email setup quick start

Local development uses `CHATE_MAIL_MODE=dev` and writes verification/password-reset emails to:

```text
backend/storage/mailbox/dev_mailbox.log
```

For SMTP, copy `.env.example`, set `CHATE_MAIL_MODE=smtp`, and fill the `CHATE_SMTP_*` values. Email reset restores account login only; old encrypted chats still need `security.json`, its passphrase, or trusted-device handoff. See `docs/EMAIL_SETUP.md`.

## Multi-device status

ChatE auto-registers the current browser/device. If a trusted device already exists, the new login waits for approval from an existing trusted device. The approval relays the already-encrypted security package through the server; the server never receives raw private keys or passphrases. If the old device is lost, email confirmation can allow account login, but old encrypted chats still need the exported security package or a trusted device handoff.

## Performance profile

v46 is tuned for old laptops: lower polling pressure, batched SQLite queries, grouped conversation loading, cached decrypted message text, cached generated GIF/sticker art, lazy media rendering, and chunked message painting. Use `scripts/run_fast_local.sh` or run Uvicorn without `--reload` for smooth local testing.

## Production/local preflight

Before sharing or deploying a build, run:

```bash
./scripts/preflight_check.sh
```

For smoother old-laptop testing, avoid reload mode:

```bash
./scripts/run_fast_local.sh
```

For production-style local execution after setting `.env` secrets:

```bash
./scripts/run_prod_local.sh
```
