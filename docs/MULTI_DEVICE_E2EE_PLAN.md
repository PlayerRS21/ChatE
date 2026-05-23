# ChatE multi-device E2EE plan

Email/password login recovers account access only. It must not recover E2EE message keys.

## Supported safe paths

### 1. Trusted-device QR handoff

A logged-in trusted device approves a new device. The existing device encrypts key material specifically for the new device. The server only relays ciphertext.

Flow:

1. New device logs in and shows a QR/linking code.
2. Existing trusted device scans it.
3. Both devices verify a challenge.
4. Existing device encrypts the required key package for the new device.
5. New device imports and unlocks locally.
6. ChatE posts a system notice: `A new device was linked`.

### 2. security.json import fallback

The user imports the encrypted `chate-security-<username>.json` file and enters its passphrase. This is recovery, not convenience sync.

## What must never happen

- Do not store raw private keys on the server.
- Do not let email reset decrypt old chats.
- Do not silently sync decrypted keys across devices.
- Do not hide device additions from the user.

## Current v35 status

- Device registry endpoints and Settings UI exist.
- security.json export reminder exists.
- Full QR encrypted key handoff is not complete yet.
