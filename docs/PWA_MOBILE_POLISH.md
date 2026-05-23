# ChatE v38 PWA/mobile polish

v38 improves the install/mobile shell without compromising E2EE.

## Implemented

- PWA manifest with app id, portrait orientation, install metadata, shortcuts, and maskable PNG icons.
- Offline fallback page at `/offline.html`.
- Service worker cache v38 with navigation fallback and stale-while-revalidate static assets.
- Service worker update banner with Refresh/Later action.
- Settings diagnostics for install/offline/cache state.
- Cache refresh control in Settings.
- Mobile safe-area support for notch/home-indicator devices.
- Keyboard viewport handling via `visualViewport` CSS variable.
- Larger tap targets on touch devices.
- Mobile long-press message action sheet.
- Swipe-right-to-reply on touch devices.
- Encrypted outbox queue for already-encrypted text/sticker/GIF structured messages.

## E2EE rule for offline queue

Queued messages are stored only after encryption. The browser queues ciphertext request bodies, not plaintext. This preserves the product promise: offline retry does not create a local plaintext outbox.

## Not yet implemented

- True server-pushed background notifications. Current notifications are browser/local notifications triggered while the app is running and polling/websocket events arrive. Full push requires VAPID keys, push subscriptions, HTTPS/public deployment, and a backend web-push sender.
- Attachment offline queue. Attachments require encrypted blob replay storage and upload-resume logic. Doing it lazily risks broken media state or plaintext leakage.
