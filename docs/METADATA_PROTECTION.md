# ChatE metadata protection

ChatE now adds an application-level protection layer around database fields that used to be readable in a raw SQLite dump.

## What is protected

- Usernames, email addresses, display names, bios, and avatar paths are stored in `users.encrypted_profile_json`.
- Username/email lookup uses keyed blind indexes, so login and exact lookup work without storing the real values in plaintext.
- Existing user rows are backfilled on startup.
- Message `ciphertext`, IVs, legacy wrapped keys, and key-session wrapped keys are wrapped by server-side AES-GCM before being written to the database. The browser payload is still end-to-end encrypted first.
- Report details/evidence are encrypted at rest.
- File metadata remains inside the browser-encrypted message payload instead of `encrypted_blobs` rows.

## What is still visible to the live server

This MVP server still needs enough metadata to function:

- numeric user IDs for auth and routing
- message sender/receiver IDs for delivery and conversation queries
- timestamps
- blob owner/receiver IDs
- block/report relationship IDs
- device relationship IDs

That means this is **metadata minimization and at-rest protection**, not Signal-grade sealed sender or anonymous routing.

## Required production key

Set a long random key before real use:

```bash
python - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
```

Then put it in `.env`:

```env
CHATE_METADATA_ENCRYPTION=true
CHATE_PROTECT_USER_PLAINTEXT=true
CHATE_SERVER_ENCRYPTION_KEY=your-long-random-value
```

Do not lose this key. If it changes, encrypted metadata already stored in the database cannot be decrypted.

## Honest security boundary

A raw database copy becomes much less useful because names/emails/profile text/message ciphertext fields are wrapped. A malicious live server process can still decrypt server-wrapped metadata because it has the server key. Old chat plaintext is still protected by client-side E2EE and remains unavailable to the server.
