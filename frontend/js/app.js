const API = "/api";
const TEMP_KEY_ROTATE_MS = 10 * 60 * 1000;

const state = {
  token: localStorage.getItem("chate_token"),
  user: JSON.parse(localStorage.getItem("chate_user") || "null"),
  peer: null,
  privateKey: null,
  publicKeyJwk: null,
  privateKeys: new Map(),
  activeKeyFingerprint: null,
  tempSessions: new Map(),
  tempSessionPromises: new Map(),
  decryptedSessions: new Map(),
  conversations: [],
  conversationLatestIds: new Map(),
  initialConversationLoadDone: false,
  conversationRenderSignature: "",
  conversationLoadPromise: null,
  conversationLastLoadAt: 0,
  activeMessageSignature: "",
  activePeerLatestMessageId: null,
  activeMessages: [],
  oldestMessageId: null,
  hasMoreMessages: true,
  loadingOlderMessages: false,
  loadingMessages: false,
  conversationSearch: "",
  rotationTimer: null,
  pollTimer: null,
  presenceTimer: null,
  peerPresenceTimer: null,
  realtimeSocket: null,
  realtimeReconnectTimer: null,
  realtimeHeartbeatTimer: null,
  realtimeConnected: false,
  realtimeReconnectAttempts: 0,
  typingTimer: null,
  recording: false,
  messagesUnlocked: false,
  notifiedMessageIds: new Set(),
  sendingMessage: false,
  decryptedTextByMessageId: new Map(),
  messageSearch: "",
  pinnedChats: new Set(JSON.parse(localStorage.getItem("chate_pinned_chats") || "[]")),
  mutedChats: new Set(JSON.parse(localStorage.getItem("chate_muted_chats") || "[]")),
  userSearchTimer: null,
  mediaRecorder: null,
  recordedChunks: [],
  recordingStartedAt: 0,
  recordingTimer: null,
  cancelRecording: false,
  activeAudio: null,
  blobUrlCache: new Map(),
  importedPackItems: [],
  replyToMessageId: null,
  editingMessageId: null,
  uploading: false,
  peerSecurity: { status: "unknown", fingerprint: null, verified: false },
  outboxReplaying: false,
  swRegistration: null,
  swReloadPending: false,
  longPressTimer: null,
  swipeStart: null,
  pendingDeviceLinkId: null,
  pendingDeviceLoginPassword: null,
  pendingKeyPassphrase: null,
  pendingDevicePollTimer: null,
  deviceApprovalPollTimer: null,
  trustedDevicePromptIds: new Set(),
  messageSearchRenderTimer: null,
  localSearchQueue: new Map(),
  localSearchFlushTimer: null,
  localSearchIndexedIds: new Set(),
  decryptedMessageSignatures: new Map(),
  parsedPayloadByMessageId: new Map(),
  generatedMediaUrlCache: new Map(),
  packSearchCache: new Map(),
  packSearchCacheLimit: 160,
  profileCache: new Map(),
  profilePromiseCache: new Map(),
  conversationRefreshTimer: null,
  localMessageCounter: 0,
  renderYieldEvery: 8,
  lowPowerMode: false,
  pendingOutboundClientIds: new Set(),
  suppressConversationSyncUntil: 0,
  messageRenderSeq: 0,
  lastSendTimings: [],
  publicKeyImportCache: new Map(),
  activeIdentityCheckedFingerprint: null,
  ignoreMessageScrollUntil: 0,
  lastManualMessageScrollAt: 0,
  activeMessageSyncTimer: null,
  activeMessageSyncInFlight: false,
  lastActiveMessageSyncAt: 0,
  pushSubscriptionPromise: null,
  pushLastEnsureAt: 0,
  expiryTimer: null,
  lastPaintYieldAt: 0,
};

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

const themeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function detectLowPowerMode() {
  const forced = localStorage.getItem("chate_low_power_mode");
  if (forced === "on") return true;
  if (forced === "off") return false;
  const cores = Number(navigator.hardwareConcurrency || 4);
  const memory = Number(navigator.deviceMemory || 4);
  const reducedMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  return reducedMotion || cores <= 4 || memory <= 4;
}

function applyPerformanceMode() {
  state.lowPowerMode = detectLowPowerMode();
  state.renderYieldEvery = state.lowPowerMode ? 5 : 10;
  document.documentElement.classList.toggle("low-power", state.lowPowerMode);
  document.body?.classList?.toggle("low-power", state.lowPowerMode);
}

function nextRenderSlice() {
  return new Promise((resolve) => {
    const settle = () => { state.lastPaintYieldAt = Date.now(); resolve(); };
    if (window.scheduler?.postTask) {
      window.scheduler.postTask(settle, { priority: "user-visible" }).catch(() => requestAnimationFrame(settle));
    } else if (window.requestIdleCallback) {
      requestIdleCallback(settle, { timeout: state.lowPowerMode ? 120 : 60 });
    } else {
      requestAnimationFrame(settle);
    }
  });
}

function nowMs() {
  return performance?.now ? performance.now() : Date.now();
}

function recordSendTiming(label, startedAt, extra = {}) {
  const ms = Math.round(nowMs() - startedAt);
  state.lastSendTimings.push({ label, ms, at: new Date().toISOString(), ...extra });
  if (state.lastSendTimings.length > 20) state.lastSendTimings.shift();
  if (ms > 1200) console.warn(`[ChatE slow] ${label}: ${ms}ms`, extra);
  return ms;
}

function messageListIsNearBottom(list = $("messageList"), threshold = 160) {
  if (!list) return true;
  return list.scrollHeight - list.scrollTop - list.clientHeight < threshold;
}

function markProgrammaticMessageScroll(ms = 900) {
  state.ignoreMessageScrollUntil = Math.max(state.ignoreMessageScrollUntil || 0, Date.now() + ms);
}

function scrollMessagesToBottom(list = $("messageList")) {
  if (!list) return;
  markProgrammaticMessageScroll(1200);
  const apply = () => { list.scrollTop = list.scrollHeight; };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

function captureMessageScrollAnchor(list = $("messageList")) {
  if (!list || !list.children?.length) return null;
  const bubbles = Array.from(list.querySelectorAll(".bubble[data-message-id]"));
  for (const bubble of bubbles) {
    const rect = bubble.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (rect.bottom >= listRect.top + 4) {
      return { id: bubble.dataset.messageId, topOffset: rect.top - listRect.top };
    }
  }
  return null;
}

function restoreMessageScrollAnchor(anchor, list = $("messageList")) {
  if (!anchor || !list) return false;
  const bubble = list.querySelector(`.bubble[data-message-id="${CSS.escape(String(anchor.id))}"]`);
  if (!bubble) return false;
  const rect = bubble.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  list.scrollTop += (rect.top - listRect.top) - anchor.topOffset;
  return true;
}

function messageDecryptSignature(msg) {
  if (Object.prototype.hasOwnProperty.call(msg, "local_plaintext")) {
    return `local:${msg.id}:${msg.local_status || ""}:${msg.local_plaintext || ""}`;
  }
  return `${msg.id}:${msg.edited_at || ""}:${msg.key_session_id || "legacy"}:${msg.iv || ""}:${msg.ciphertext || ""}`;
}

function pruneDecryptionCaches(activeIds) {
  const keep = activeIds || new Set((state.activeMessages || []).map((msg) => Number(msg.id)));
  const maxCache = state.lowPowerMode ? 260 : 600;
  for (const id of Array.from(state.decryptedTextByMessageId.keys())) {
    if (!keep.has(Number(id))) {
      state.decryptedTextByMessageId.delete(id);
      state.decryptedMessageSignatures.delete(id);
      state.parsedPayloadByMessageId.delete(id);
    }
  }
  if (state.decryptedTextByMessageId.size > maxCache) {
    const extra = state.decryptedTextByMessageId.size - maxCache;
    for (const id of Array.from(state.decryptedTextByMessageId.keys()).slice(0, extra)) {
      state.decryptedTextByMessageId.delete(id);
      state.decryptedMessageSignatures.delete(id);
      state.parsedPayloadByMessageId.delete(id);
    }
  }
}


applyPerformanceMode();

function applyThemePreference() {
  const pref = localStorage.getItem("chate_theme") || "system";
  const dark = pref === "dark" || (pref === "system" && Boolean(themeQuery?.matches));
  document.body.classList.toggle("dark", dark);
}

if (themeQuery?.addEventListener) {
  themeQuery.addEventListener("change", () => {
    if ((localStorage.getItem("chate_theme") || "system") === "system") applyThemePreference();
  });
}

function syncResponsiveLayout() {
  if (window.innerWidth > 920) document.body.classList.remove("mobile-chat-active");
}
let resizeSyncTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeSyncTimer);
  resizeSyncTimer = setTimeout(() => { syncResponsiveLayout(); applyPerformanceMode(); }, 120);
}, { passive: true });

function toast(message, timeout = 3200) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), timeout);
}

const EMAIL_COOLDOWN_MS = 30_000;
const emailCooldownTimers = new Map();

function normalizeCooldownIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function startButtonCooldown(button, storageKey, label, ms = EMAIL_COOLDOWN_MS) {
  if (!button) return;
  const until = Date.now() + ms;
  localStorage.setItem(storageKey, String(until));
  applyButtonCooldown(button, storageKey, label);
}

function applyButtonCooldown(button, storageKey, label) {
  if (!button) return false;
  const originalLabel = label || button.dataset.originalLabel || button.textContent || "Send email";
  button.dataset.originalLabel = originalLabel;
  clearInterval(emailCooldownTimers.get(storageKey));

  const update = () => {
    const until = Number(localStorage.getItem(storageKey) || 0);
    const remaining = Math.ceil((until - Date.now()) / 1000);
    if (remaining > 0) {
      button.disabled = true;
      button.textContent = `${originalLabel} (${remaining}s)`;
      return true;
    }
    button.disabled = false;
    button.textContent = originalLabel;
    localStorage.removeItem(storageKey);
    clearInterval(emailCooldownTimers.get(storageKey));
    emailCooldownTimers.delete(storageKey);
    return false;
  };

  const active = update();
  if (active) emailCooldownTimers.set(storageKey, setInterval(update, 1000));
  return active;
}

async function runEmailCooldownAction(button, scope, identity, action) {
  const key = `chate_email_cooldown_v50:${scope}:${normalizeCooldownIdentity(identity) || "current"}`;
  if (applyButtonCooldown(button, key)) {
    toast("Wait for the email cooldown before requesting another email.", 3600);
    return null;
  }
  button.disabled = true;
  try {
    const result = await action();
    startButtonCooldown(button, key, button.dataset.originalLabel || button.textContent || "Send email");
    return result;
  } finally {
    applyButtonCooldown(button, key);
  }
}

window.addEventListener("error", (event) => {
  console.error("ChatE frontend error:", event.error || event.message);
  toast("Something went wrong in the UI. Your encrypted data was not exposed. Try again or refresh.", 5200);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("ChatE async error:", event.reason);
  const msg = event.reason?.message || "A background action failed.";
  if (!/locked encrypted|matching key unavailable/i.test(msg)) toast(msg, 5200);
});

function setAvatarElement(el, userOrText, avatarUrl = null) {
  if (!el) return;
  const label = typeof userOrText === "string"
    ? userOrText
    : (userOrText?.display_name || userOrText?.username || "?");
  const url = avatarUrl || (typeof userOrText === "object" ? userOrText?.avatar_url : null);

  el.replaceChildren();
  el.style.backgroundImage = "";
  el.classList.remove("has-image");

  if (url) {
    const img = document.createElement("img");
    img.alt = label || "Profile picture";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = url;
    img.onerror = () => {
      el.replaceChildren();
      el.classList.remove("has-image");
      el.textContent = (label || "?").slice(0, 1).toUpperCase();
    };
    el.classList.add("has-image");
    el.appendChild(img);
    return;
  }

  el.textContent = (label || "?").slice(0, 1).toUpperCase();
}

function shouldNotifyIncoming() {
  return localStorage.getItem("chate_desktop_notifications") === "enabled";
}

function showServiceWorkerUpdateBanner(registration) {
  const banner = $("swUpdateBanner");
  if (!banner) return;
  banner.classList.remove("hidden");
  const apply = $("applyUpdateBtn");
  const later = $("dismissUpdateBtn");
  if (apply && !apply.dataset.bound) {
    apply.dataset.bound = "1";
    apply.addEventListener("click", () => {
      const waiting = state.swRegistration?.waiting || registration?.waiting;
      if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
      else location.reload();
    });
  }
  if (later && !later.dataset.bound) {
    later.dataset.bound = "1";
    later.addEventListener("click", () => banner.classList.add("hidden"));
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    state.swRegistration = registration;
    if (registration.waiting && navigator.serviceWorker.controller) showServiceWorkerUpdateBanner(registration);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showServiceWorkerUpdateBanner(registration);
      });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (state.swReloadPending) return;
      state.swReloadPending = true;
      window.location.reload();
    });
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "REPLAY_OUTBOX") replayOutbox({ silent: true }).catch(() => null);
    });
    if (state.token) ensureBackgroundPushSubscription({ quiet: true }).catch(() => null);
    return registration;
  } catch (_) {
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getPushDeviceId() {
  try { return await getOrCreateDeviceId(); }
  catch (_) { return null; }
}

async function ensureBackgroundPushSubscription({ quiet = true, force = false } = {}) {
  if (!state.token) return false;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    if (!quiet) toast("This browser does not support background Web Push.", 5200);
    return false;
  }
  if (!window.isSecureContext) {
    if (!quiet) toast("Background push needs HTTPS, localhost, or 127.0.0.1. Use share.py/HTTPS for phone testing.", 7500);
    return false;
  }

  const userEnabled = localStorage.getItem("chate_desktop_notifications") === "enabled";
  const alreadyGranted = Notification.permission === "granted";
  const shouldAskNow = force || !quiet || userEnabled;
  if (!userEnabled && !alreadyGranted && !shouldAskNow) return false;

  const permission = Notification.permission === "default" && shouldAskNow
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== "granted") {
    if (!quiet) toast("Notification permission was not granted.", 5200);
    return false;
  }

  const now = Date.now();
  if (!force && state.pushSubscriptionPromise && now - state.pushLastEnsureAt < 30000) return state.pushSubscriptionPromise;
  state.pushLastEnsureAt = now;
  state.pushSubscriptionPromise = (async () => {
    const keyInfo = await api("/push/vapid-public-key").catch((err) => {
      if (!quiet) toast(err.message || "Push is not configured on server.", 5200);
      return null;
    });
    if (!keyInfo?.enabled || !keyInfo.public_key) {
      if (!quiet) toast(keyInfo?.detail || "Web Push is not configured on server.", 6500);
      return false;
    }
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyInfo.public_key),
      });
    }
    await api("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ ...subscription.toJSON(), device_id: await getPushDeviceId() }),
    });
    localStorage.setItem("chate_desktop_notifications", "enabled");
    if (!quiet) toast("Background notifications enabled for this browser.");
    return true;
  })().finally(() => {
    setTimeout(() => { state.pushSubscriptionPromise = null; }, 1000);
  });
  return state.pushSubscriptionPromise;
}

async function disableBackgroundPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const subscription = await registration?.pushManager?.getSubscription?.();
  if (!subscription) return;
  await api("/push/unsubscribe", { method: "POST", body: JSON.stringify(subscription.toJSON()) }).catch(() => null);
  await subscription.unsubscribe().catch(() => null);
}


async function showSystemNotification(title, body, options = {}) {
  if (!shouldNotifyIncoming()) return;
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch (_) {}
  }
  if (Notification.permission !== "granted") return;

  const tag = options.tag || "chate-incoming";
  const data = options.data || {};
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  if (registration?.showNotification) {
    await registration.showNotification(title, { body, tag, renotify: true, data });
  } else {
    new Notification(title, { body, tag, data });
  }
}

async function notifyIncomingMessage(user, messageId = null) {
  const title = `New encrypted message from ${user.display_name || user.username}`;
  await showSystemNotification(title, "Open ChatE to decrypt and read it.", {
    tag: messageId ? `chate-message-${messageId}` : `chate-user-${user.id || user.username || "incoming"}`,
    data: { sender_id: user.id || null, message_id: messageId || null, url: user.id ? `/?chat=${user.id}&focus=reply` : "/" },
  });
}


function setKeyUI(isUnlocked = state.messagesUnlocked) {
  const el = $("lockState");
  const btn = $("unlockBtn");
  const unlocked = Boolean(isUnlocked && state.privateKeys.size > 0);
  if (el) {
    el.textContent = unlocked ? "Secure" : "Locked";
    el.className = unlocked ? "pill unlocked" : "pill locked";
    el.title = unlocked ? "Messages are available on this trusted browser." : "Unlock messages to read encrypted history.";
  }
  if (btn) {
    btn.textContent = unlocked ? "🔓" : "🔒";
    btn.title = unlocked ? "Lock messages" : "Unlock messages";
    btn.setAttribute("aria-label", btn.title);
  }
}

function publicKeyIdentity(jwk) {
  if (!jwk) return null;
  return {
    kty: jwk.kty || "RSA",
    n: jwk.n,
    e: jwk.e,
  };
}

function isValidPublicKeyJwk(jwk) {
  return Boolean(
    jwk
      && typeof jwk === "object"
      && (jwk.kty || "RSA") === "RSA"
      && typeof jwk.n === "string"
      && jwk.n.length >= 300
      && typeof jwk.e === "string"
      && jwk.e.length >= 2
  );
}

async function fingerprintPublicJwk(jwk) {
  if (!isValidPublicKeyJwk(jwk)) throw new Error("Invalid encryption public key");
  const stable = JSON.stringify(publicKeyIdentity(jwk));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(stable)));
  return bytesToBase64(digest).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function publicKeysMatch(a, b) {
  if (!isValidPublicKeyJwk(a) || !isValidPublicKeyJwk(b)) return false;
  return await fingerprintPublicJwk(a) === await fingerprintPublicJwk(b);
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("chate_token", token);
  localStorage.setItem("chate_user", JSON.stringify(user));
}

function clearSession(revokeTrustedDevice = false, { notifyServer = true } = {}) {
  if (notifyServer) sendPresence("offline").catch(() => {});
  disconnectRealtime();
  clearAllMessageUnlockSessionFlags();
  localStorage.removeItem("chate_token");
  localStorage.removeItem("chate_user");
  state.token = null;
  state.user = null;
  state.peer = null;
  state.conversations = [];
  state.conversationLatestIds.clear();
  state.initialConversationLoadDone = false;
  state.conversationRenderSignature = "";
  state.activeMessageSignature = "";
  state.activePeerLatestMessageId = null;
  state.activeMessages = [];
  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
  state.oldestMessageId = null;
  state.hasMoreMessages = true;
  document.body.classList.remove("mobile-chat-active");
  clearInterval(state.pollTimer);
  clearInterval(state.presenceTimer);
  clearInterval(state.peerPresenceTimer);
  clearInterval(state.pendingDevicePollTimer);
  clearInterval(state.deviceApprovalPollTimer);
  clearInterval(state.activeMessageSyncTimer);
  state.pollTimer = null;
  state.presenceTimer = null;
  state.peerPresenceTimer = null;
  state.pendingDevicePollTimer = null;
  state.deviceApprovalPollTimer = null;
  state.activeMessageSyncTimer = null;
  state.activeMessageSyncInFlight = false;
  state.conversationLoadPromise = null;
  renderConversationList();
  lockPrivateKey(Boolean(revokeTrustedDevice));
}

function lockPrivateKey(clearPersisted = true) {
  if (clearPersisted) clearMessagesUnlockedThisLogin();
  state.messagesUnlocked = false;
  state.privateKey = null;
  state.publicKeyJwk = null;
  state.activeKeyFingerprint = null;
  state.privateKeys.clear();
  state.tempSessions.clear();
  state.decryptedSessions.clear();
  state.decryptedTextByMessageId.clear();
  state.decryptedMessageSignatures.clear();
  state.parsedPayloadByMessageId.clear();
  clearInterval(state.rotationTimer);
  state.rotationTimer = null;
  if (clearPersisted) {
    clearDeviceUnlockSecrets();
    clearPersistedUnlockedKeys().catch(() => {});
  }
  setKeyUI(false);
  const params = new URLSearchParams(window.location.search);
  if (params.get("reset_token")) {
    $("authRecoveryPanel")?.classList.remove("hidden");
    if ($("passwordResetToken")) $("passwordResetToken").value = params.get("reset_token");
  }
  if (params.get("verify_email_token")) {
    api("/auth/email-verification/complete", { method: "POST", body: JSON.stringify({ token: params.get("verify_email_token") }) })
      .then((out) => toast(out.detail || "Email verified.", 6500))
      .catch((err) => toast(err.message, 5200));
  }
  if (params.get("device_confirm_token")) {
    api("/devices/link/lost-device/confirm", { method: "POST", body: JSON.stringify({ token: params.get("device_confirm_token") }) })
      .then((out) => {
        toast(out.detail || "Device confirmed by email.", 8500);
        const clean = new URL(window.location.href);
        clean.searchParams.delete("device_confirm_token");
        window.history.replaceState({}, document.title, clean.toString());
      })
      .catch((err) => toast(err.message, 6500));
  }
}

function rotateTemporaryMessageKeys(showToast = true) {
  state.tempSessions.clear();
  if (showToast && state.privateKeys.size > 0) {
    
  }
}

function startTemporaryKeyRotation() {
  clearInterval(state.rotationTimer);
  state.rotationTimer = setInterval(() => rotateTemporaryMessageKeys(true), TEMP_KEY_ROTATE_MS);
  setKeyUI();
}

async function getTemporaryMessageSession(peerId, receiverPublicJwk, senderPublicJwk) {
  const now = Date.now();
  const existing = state.tempSessions.get(peerId);
  if (existing && now < existing.expiresAt - 15_000) return existing;
  const inflight = state.tempSessionPromises.get(peerId);
  if (inflight) return inflight;

  const promise = (async () => {
    const aesKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const rawAesKey = new Uint8Array(await crypto.subtle.exportKey("raw", aesKey));

    const [receiverPublicKey, senderPublicKey] = await Promise.all([
      importPublicKey(receiverPublicJwk),
      importPublicKey(senderPublicJwk),
    ]);
    const [encryptedKeyForReceiver, encryptedKeyForSender] = await Promise.all([
      crypto.subtle.encrypt({ name: "RSA-OAEP" }, receiverPublicKey, rawAesKey),
      crypto.subtle.encrypt({ name: "RSA-OAEP" }, senderPublicKey, rawAesKey),
    ]);

    const idBytes = crypto.getRandomValues(new Uint8Array(24));
    const id = bytesToBase64(idBytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const session = {
      id,
      aesKey,
      createdAt: now,
      // WhatsApp-style fast path: create the client session locally and let the
      // first message register the wrapped session key inline. This removes one
      // whole round-trip from the send path while keeping E2EE intact.
      expiresAt: now + (10 * 60 * 1000),
      encryptedKeyForReceiver: bytesToBase64(new Uint8Array(encryptedKeyForReceiver)),
      encryptedKeyForSender: bytesToBase64(new Uint8Array(encryptedKeyForSender)),
      registered: false,
    };
    state.tempSessions.set(peerId, session);
    return session;
  })();

  state.tempSessionPromises.set(peerId, promise);
  try {
    return await promise;
  } finally {
    state.tempSessionPromises.delete(peerId);
  }
}

function hasUsableTemporarySession(peerId) {
  const existing = state.tempSessions.get(peerId);
  return Boolean(existing && Date.now() < existing.expiresAt - 15_000);
}

function shouldAutoClearSessionOn401(path) {
  const clean = String(path || "").split("?")[0];
  if (!state.token) return false;
  // Login/register/recovery failures are user input errors, not stale-session errors.
  return !clean.startsWith("/auth/login")
    && !clean.startsWith("/auth/register")
    && !clean.startsWith("/auth/password-reset")
    && !clean.startsWith("/auth/forgot-username")
    && !clean.startsWith("/auth/email-verification");
}

function handleSessionExpired({ silent = false } = {}) {
  if (!state.token && !state.user) return;
  clearSession(false, { notifyServer: false });
  renderAuthState();
  renderChatShell();
  renderConversationList();
  if (!silent) toast("Session expired or this browser has a stale login. Login again.", 6500);
}

function prewarmTemporaryMessageSession(peer = state.peer) {
  if (!peer || !state.user || !state.token) return Promise.resolve(null);
  if (!isValidPublicKeyJwk(peer.public_key_jwk) || !isValidPublicKeyJwk(state.user.public_key_jwk)) return Promise.resolve(null);
  if (hasUsableTemporarySession(peer.id)) return Promise.resolve(state.tempSessions.get(peer.id));
  return getTemporaryMessageSession(peer.id, peer.public_key_jwk, state.user.public_key_jwk).catch(() => null);
}

async function api(path, options = {}) {
  const { timeoutMs = 45000, ...fetchOptions } = options;
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { ...fetchOptions, headers, signal: options.signal || controller.signal });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { detail: text }; }
    }
    if (!res.ok) {
      const error = new Error(data?.detail || `HTTP ${res.status}`);
      error.status = res.status;
      error.response = data;
      if (res.status === 401 && shouldAutoClearSessionOn401(path)) {
        handleSessionExpired({ silent: true });
        error.sessionCleared = true;
      }
      throw error;
    }
    return data;
  } catch (err) {
    if (err?.name === "AbortError") {
      const error = new Error("Network timeout. Check connection and retry.");
      error.isNetworkError = true;
      throw error;
    }
    if (err instanceof TypeError && /fetch|network|failed/i.test(err.message || "")) {
      err.isNetworkError = true;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- IndexedDB key storage ----------------
function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("chate-key-store", 7);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("keyPackages")) db.createObjectStore("keyPackages");
      if (!db.objectStoreNames.contains("unlockedKeys")) db.createObjectStore("unlockedKeys");
      if (!db.objectStoreNames.contains("packItems")) db.createObjectStore("packItems", { keyPath: "id" });
      if (!db.objectStoreNames.contains("localSearch")) db.createObjectStore("localSearch", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keyPackages", "readonly");
    const req = tx.objectStore("keyPackages").get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keyPackages", "readwrite");
    tx.objectStore("keyPackages").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAllKeys() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keyPackages", "readonly");
    const req = tx.objectStore("keyPackages").getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function unlockedStoreGetAll() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("unlockedKeys", "readonly");
    const req = tx.objectStore("unlockedKeys").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function unlockedStorePut(fingerprint, record) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("unlockedKeys", "readwrite");
    tx.objectStore("unlockedKeys").put(record, fingerprint);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearPersistedUnlockedKeys() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("unlockedKeys", "readwrite");
    tx.objectStore("unlockedKeys").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function packStoreGetAll() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("packItems", "readonly");
    const req = tx.objectStore("packItems").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function packStorePutMany(items) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("packItems", "readwrite");
    const store = tx.objectStore("packItems");
    for (const item of items) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function localSearchPut(record) {
  if (!state.user?.id || !record?.text) return;
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("localSearch", "readwrite");
    tx.objectStore("localSearch").put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function localSearchPutMany(records) {
  const rows = (records || []).filter((record) => state.user?.id && record?.text);
  if (!rows.length) return;
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("localSearch", "readwrite");
    const store = tx.objectStore("localSearch");
    for (const record of rows) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function scheduleLocalSearchFlush() {
  if (state.localSearchFlushTimer) return;
  state.localSearchFlushTimer = setTimeout(async () => {
    state.localSearchFlushTimer = null;
    const rows = Array.from(state.localSearchQueue.values());
    state.localSearchQueue.clear();
    try { await localSearchPutMany(rows); } catch (_) {}
  }, state.lowPowerMode ? 1800 : 900);
}

async function localSearchGetAll() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("localSearch", "readonly");
    const req = tx.objectStore("localSearch").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function localSearchClear() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("localSearch", "readwrite");
    tx.objectStore("localSearch").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function outboxPut(record) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function outboxGetAll() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("outbox", "readonly");
    const req = tx.objectStore("outbox").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function outboxDelete(id) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function isRetryableNetworkError(err) {
  return !navigator.onLine || Boolean(err?.isNetworkError) || /network|failed to fetch|timeout/i.test(err?.message || "");
}

function deliveryStateLabel(msg) {
  if (msg.local_status === "uploading") return "↥ Uploading";
  if (msg.local_status === "sending") return "⏳ Sending";
  if (msg.local_status === "queued") return "⏱ Queued";
  if (msg.local_status === "failed") return "⚠ Failed";
  if (msg.read_at) return "✓✓ Read";
  if (msg.delivered_at) return "✓✓ Delivered";
  return "✓ Sent";
}

function deliveryStateClass(msg) {
  if (msg.local_status === "failed") return "delivery-failed";
  if (msg.local_status === "queued") return "delivery-queued";
  if (msg.local_status === "sending" || msg.local_status === "uploading") return "delivery-sending";
  if (msg.read_at) return "delivery-read";
  if (msg.delivered_at) return "delivery-delivered";
  return "delivery-sent";
}

function shouldShowRetryAction(msg) {
  return Number(msg.sender_id) === Number(state.user?.id) && ["queued", "failed"].includes(msg.local_status || "");
}

async function queueEncryptedMessage(body, peerId, kind = "message") {
  if (!state.user?.id) throw new Error("Login required before queueing messages.");
  const id = `${state.user.id}:${body.client_message_id || secureRandomToken(20)}`;
  await outboxPut({
    id,
    userId: state.user.id,
    peerId,
    kind,
    path: "/messages",
    method: "POST",
    body,
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
  updateNetworkUi();
  if (navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready.then((registration) => registration.sync?.register?.("chate-outbox-sync")).catch(() => null);
  }
  return id;
}

async function getPendingOutboxCount() {
  if (!state.user?.id) return 0;
  const all = await outboxGetAll().catch(() => []);
  return all.filter((item) => Number(item.userId) === Number(state.user.id)).length;
}

async function replayOutbox({ silent = false } = {}) {
  if (!state.token || !state.user || state.outboxReplaying || !navigator.onLine) {
    updateNetworkUi();
    return;
  }
  state.outboxReplaying = true;
  try {
    const all = (await outboxGetAll()).filter((item) => Number(item.userId) === Number(state.user.id));
    if (!all.length) return;
    let sent = 0;
    for (const item of all) {
      try {
        let saved = null;
        if (item.kind === "attachment") {
          saved = await sendQueuedAttachmentRecord(item);
        } else {
          saved = await api(item.path || "/messages", { method: item.method || "POST", body: JSON.stringify(item.body || {}) });
        }
        await outboxDelete(item.id);
        sent += 1;
        if (saved && state.peer && Number(saved.receiver_id) === Number(state.peer.id)) {
          mergeMessages([saved]);
          updateLocalConversationFromMessage(saved, { render: true });
          renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => null);
        }
      } catch (err) {
        if (err.status === 409) {
          await outboxDelete(item.id);
          continue;
        }
        item.attempts = Number(item.attempts || 0) + 1;
        item.lastError = err.message || "Send failed";
        await outboxPut(item);
        if (!isRetryableNetworkError(err)) break;
      }
    }
    if (sent && !silent) toast(`Sent ${sent} queued encrypted message${sent === 1 ? "" : "s"}.`);
    if (sent) {
      await loadMessages({ force: true, preserveScroll: true }).catch(() => null);
      await loadConversations({ silent: true }).catch(() => null);
    }
  } finally {
    state.outboxReplaying = false;
    updateNetworkUi();
  }
}

async function updateNetworkUi() {
  const box = $("networkStatus");
  const text = $("networkStatusText");
  if (!box || !text) return;
  const pending = await getPendingOutboxCount();
  const online = navigator.onLine;
  if (online && !pending) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  text.textContent = online
    ? `${pending} encrypted message${pending === 1 ? "" : "s"} waiting to sync.`
    : pending
      ? `Offline · ${pending} encrypted message${pending === 1 ? "" : "s"} queued.`
      : "Offline · messages will sync when connection returns.";
}

function localSearchPreview(text, query) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!query) return clean.slice(0, 120);
  const i = clean.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return clean.slice(0, 120);
  return clean.slice(Math.max(0, i - 40), i + query.length + 80);
}

function indexDecryptedMessage(msg, plaintext, parsedPayload = null) {
  try {
    if (!state.user?.id || !state.peer?.id || !plaintext || String(plaintext).startsWith("[locked")) return;
    const id = `${state.user.id}:${msg.id}`;
    if (state.localSearchIndexedIds.has(id)) return;
    const text = parsedPayload ? `${parsedPayload.label || parsedPayload.name || ""} ${parsedPayload.type || parsedPayload.kind || ""}` : String(plaintext);
    if (!text.trim()) return;
    state.localSearchIndexedIds.add(id);
    state.localSearchQueue.set(id, {
      id,
      userId: state.user.id,
      peerId: state.peer.id,
      peerUsername: state.peer.username,
      peerDisplayName: state.peer.display_name || state.peer.username,
      messageId: msg.id,
      direction: msg.sender_id === state.user.id ? "sent" : "received",
      createdAt: msg.created_at,
      type: msg.message_type,
      text: text.slice(0, 4000),
      indexedAt: new Date().toISOString(),
    });
    scheduleLocalSearchFlush();
  } catch (_) {
    // Search index is best-effort and local only. Rendering must never fail because of it.
  }
}

async function packStoreClear() {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("packItems", "readwrite");
    tx.objectStore("packItems").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deviceSecretStorageKey(userId = state.user?.id) {
  return userId ? `chate_device_unlock_secret:${userId}` : null;
}

function sessionUnlockFlagKey(userId = state.user?.id) {
  return userId ? `chate_messages_unlocked_this_login:${userId}` : null;
}

function markMessagesUnlockedThisLogin() {
  const key = sessionUnlockFlagKey();
  if (key) sessionStorage.setItem(key, "1");
  state.messagesUnlocked = true;
  setKeyUI(true);
}

function clearMessagesUnlockedThisLogin(userId = state.user?.id) {
  const key = sessionUnlockFlagKey(userId);
  if (key) sessionStorage.removeItem(key);
  state.messagesUnlocked = false;
  state.decryptedSessions.clear();
  state.decryptedTextByMessageId.clear();
  state.decryptedMessageSignatures.clear();
  state.parsedPayloadByMessageId.clear();
  setKeyUI(false);
  const params = new URLSearchParams(window.location.search);
  if (params.get("reset_token")) {
    $("authRecoveryPanel")?.classList.remove("hidden");
    if ($("passwordResetToken")) $("passwordResetToken").value = params.get("reset_token");
  }
  if (params.get("verify_email_token")) {
    api("/auth/email-verification/complete", { method: "POST", body: JSON.stringify({ token: params.get("verify_email_token") }) })
      .then((out) => toast(out.detail || "Email verified.", 6500))
      .catch((err) => toast(err.message, 5200));
  }
}

function messagesMayAutoUnlockThisLogin() {
  const key = sessionUnlockFlagKey();
  return Boolean(key && sessionStorage.getItem(key) === "1");
}

function clearAllMessageUnlockSessionFlags() {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("chate_messages_unlocked_this_login:")) sessionStorage.removeItem(key);
  }
}

function clearDeviceUnlockSecrets() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("chate_device_unlock_secret:")) localStorage.removeItem(key);
  }
}

async function importDeviceCacheSecret(secretB64) {
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(secretB64),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function getDeviceCacheKeyIfPresent() {
  const key = deviceSecretStorageKey();
  if (!key) return null;
  const secretB64 = localStorage.getItem(key);
  if (!secretB64) return null;
  return importDeviceCacheSecret(secretB64);
}

async function getOrCreateDeviceCacheKey() {
  const key = deviceSecretStorageKey();
  if (!key) throw new Error("Login required before caching unlocked keys on this device.");
  let secretB64 = localStorage.getItem(key);
  if (!secretB64) {
    secretB64 = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem(key, secretB64);
  }
  return importDeviceCacheSecret(secretB64);
}

async function persistTrustedDeviceKey(fingerprint, privateJwk, publicKeyJwk, makeActive = false) {
  if (!state.user?.id || !privateJwk) return;
  const key = await getOrCreateDeviceCacheKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(privateJwk)),
  );
  await unlockedStorePut(`trusted:${state.user.id}:${fingerprint}`, {
    type: "trusted-device-private-jwk-v1",
    userId: state.user.id,
    fingerprint,
    publicKeyJwk,
    active: Boolean(makeActive),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    savedAt: new Date().toISOString(),
  });
}

async function importPrivateJwk(privateJwk) {
  return crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
}

async function loadPersistedUnlockedKeys() {
  const records = await unlockedStoreGetAll();
  let count = 0;
  const deviceCacheKey = await getDeviceCacheKeyIfPresent();

  for (const record of records) {
    try {
      let privateKey = null;
      let publicKeyJwk = null;
      let fingerprint = null;
      let active = false;

      if (record?.type === "trusted-device-private-jwk-v1") {
        if (!deviceCacheKey || record.userId !== state.user?.id) continue;
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64ToBytes(record.iv) },
          deviceCacheKey,
          base64ToBytes(record.ciphertext),
        );
        const privateJwk = JSON.parse(dec.decode(plaintext));
        privateKey = await importPrivateJwk(privateJwk);
        publicKeyJwk = record.publicKeyJwk;
        fingerprint = record.fingerprint;
        active = Boolean(record.active);
      } else if (record?.fingerprint && record?.privateKey && record?.publicKeyJwk) {
        // Backward compatibility with v10 records that stored CryptoKey directly.
        privateKey = record.privateKey;
        publicKeyJwk = record.publicKeyJwk;
        fingerprint = record.fingerprint;
        active = Boolean(record.active);
      }

      if (!fingerprint || !privateKey || !publicKeyJwk) continue;
      state.privateKeys.set(fingerprint, privateKey);
      count += 1;
      if (active || !state.privateKey) {
        state.privateKey = privateKey;
        state.publicKeyJwk = publicKeyJwk;
        state.activeKeyFingerprint = fingerprint;
      }
    } catch (_) {
      // Ignore stale or corrupted local trusted-device cache entries.
    }
  }

  if (count > 0) {
    // Trusted-device cache is created only after the key passphrase was entered once.
    // After that, this browser can decrypt after reloads/relogins until the user clicks Lock messages or clears local keys.
    state.messagesUnlocked = true;
    startTemporaryKeyRotation();
    setKeyUI(true);
  } else {
    state.messagesUnlocked = false;
    setKeyUI(false);
  const params = new URLSearchParams(window.location.search);
  if (params.get("reset_token")) {
    $("authRecoveryPanel")?.classList.remove("hidden");
    if ($("passwordResetToken")) $("passwordResetToken").value = params.get("reset_token");
  }
  if (params.get("verify_email_token")) {
    api("/auth/email-verification/complete", { method: "POST", body: JSON.stringify({ token: params.get("verify_email_token") }) })
      .then((out) => toast(out.detail || "Email verified.", 6500))
      .catch((err) => toast(err.message, 5200));
  }
  }
  return count;
}

async function saveEncryptedKeyPackage(pkg, makeActive = true) {
  const fingerprint = await fingerprintPublicJwk(pkg.publicKeyJwk);
  await idbPut(`key:${fingerprint}`, pkg);
  if (makeActive) await idbPut("active", fingerprint);
  return fingerprint;
}

async function loadEncryptedKeyPackage() {
  const active = await idbGet("active");
  if (active) {
    const pkg = await idbGet(`key:${active}`);
    if (pkg) return pkg;
  }

  // Backward compatibility with the old v1 package saved under "default".
  const legacy = await idbGet("default");
  if (legacy) {
    const fingerprint = await saveEncryptedKeyPackage(legacy, true);
    return await idbGet(`key:${fingerprint}`);
  }
  return null;
}

async function loadAllEncryptedKeyPackages() {
  const keys = await idbGetAllKeys();
  const packageKeys = keys.filter((key) => typeof key === "string" && key.startsWith("key:"));
  const packages = [];
  for (const key of packageKeys) {
    const pkg = await idbGet(key);
    if (pkg?.publicKeyJwk && pkg?.ciphertext) packages.push(pkg);
  }

  const legacy = await idbGet("default");
  if (legacy?.publicKeyJwk && legacy?.ciphertext) {
    const legacyFp = await fingerprintPublicJwk(legacy.publicKeyJwk);
    let exists = false;
    for (const pkg of packages) {
      if (await fingerprintPublicJwk(pkg.publicKeyJwk) === legacyFp) {
        exists = true;
        break;
      }
    }
    if (!exists) packages.push(legacy);
  }
  return packages;
}

// ---------------- Encoding helpers ----------------
function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportActiveKeyPackage(markReminderDone = false) {
  const pkg = await loadEncryptedKeyPackage();
  if (!pkg) throw new Error("No active key package found on this device.");
  downloadJson(`chate-security-${state.user?.username || "user"}.json`, pkg);
  if (markReminderDone) dismissKeyExportReminder(true);
  return pkg;
}

function secureRandomToken(bytes = 18) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function draftKey(peerId = state.peer?.id) {
  return state.user?.id && peerId ? `chate_draft:${state.user.id}:${peerId}` : null;
}

function saveDraft(text = $("messageInput")?.value || "") {
  const key = draftKey();
  if (!key) return;
  if (text.trim()) localStorage.setItem(key, text);
  else localStorage.removeItem(key);
}

function loadDraft(peerId = state.peer?.id) {
  const key = draftKey(peerId);
  return key ? (localStorage.getItem(key) || "") : "";
}

function clearDraft(peerId = state.peer?.id) {
  const key = draftKey(peerId);
  if (key) localStorage.removeItem(key);
}

function chatStorageId(peerId = state.peer?.id) {
  return state.user?.id && peerId ? `${state.user.id}:${peerId}` : null;
}

function saveChatSet(name, set) {
  localStorage.setItem(name, JSON.stringify([...set]));
}

function isPinned(peerId = state.peer?.id) {
  const id = chatStorageId(peerId);
  return Boolean(id && state.pinnedChats.has(id));
}

function isMuted(peerId = state.peer?.id) {
  const id = chatStorageId(peerId);
  return Boolean(id && state.mutedChats.has(id));
}

function updateChatActionButtons() {
  const pinBtn = $("pinChatBtn");
  const muteBtn = $("muteChatBtn");
  const blockBtn = $("blockPeerBtn");
  const reportBtn = $("reportPeerBtn");
  const deleteBtn = $("deleteConversationBtn");
  const disabled = !state.peer;
  for (const btn of [pinBtn, muteBtn, blockBtn, reportBtn, deleteBtn]) {
    if (btn) btn.disabled = disabled;
  }
  if (pinBtn) pinBtn.textContent = isPinned() ? "Unpin" : "Pin";
  if (muteBtn) muteBtn.textContent = isMuted() ? "Unmute" : "Mute";
}

function peerTrustStorageKey(peerId = state.peer?.id) {
  return state.user?.id && peerId ? `chate_peer_trust:${state.user.id}:${peerId}` : null;
}

function readPeerTrust(peerId = state.peer?.id) {
  const key = peerTrustStorageKey(peerId);
  if (!key) return null;
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch (_) {
    return null;
  }
}

function writePeerTrust(peerId, fingerprint, verified = false) {
  const key = peerTrustStorageKey(peerId);
  if (!key || !fingerprint) return;
  localStorage.setItem(key, JSON.stringify({
    fingerprint,
    verified: Boolean(verified),
    trustedAt: new Date().toISOString(),
  }));
}

function shortFingerprint(fp = "") {
  if (!fp) return "unknown";
  return fp.match(/.{1,8}/g)?.slice(0, 6).join(" ") || fp;
}

function renderSecurityBanner() {
  // Quiet background security checks: key-change information appears as an
  // undeletable system notice inside the chat instead of a scary header banner.
  const banner = $("securityBanner");
  if (!banner) return;
  banner.className = "security-banner hidden";
  banner.replaceChildren();
}

function currentSecuritySystemNotice() {
  if (!state.peer || !state.peerSecurity) return null;
  if (state.peerSecurity.status !== "changed") return null;
  return {
    id: `security-key-changed:${state.peer.id}:${state.peerSecurity.fingerprint || "unknown"}`,
    title: "Security code changed",
    body: `Your security code with @${state.peer.username} changed. This can happen if they reset encryption keys, changed devices, or restored the account. Messages remain end-to-end encrypted, but verify through another channel for high-trust chats.`,
    action: "Security info",
  };
}

function appendSecuritySystemNotice(fragment) {
  const notice = currentSecuritySystemNotice();
  if (!notice) return;
  const box = document.createElement("article");
  box.className = "system-notice security-system-notice";
  box.dataset.noticeId = notice.id;

  const icon = document.createElement("span");
  icon.className = "system-notice-icon";
  icon.textContent = "🔐";

  const body = document.createElement("div");
  body.className = "system-notice-body";
  const title = document.createElement("strong");
  title.textContent = notice.title;
  const text = document.createElement("p");
  text.textContent = notice.body;
  body.append(title, text);

  const action = document.createElement("button");
  action.type = "button";
  action.className = "small-btn security-info-btn";
  action.textContent = notice.action;
  action.dataset.chatAction = "verify";

  box.append(icon, body, action);
  fragment.appendChild(box);
}

function updateCachedPeerPublicKey(peer) {
  if (!peer?.id || !isValidPublicKeyJwk(peer.public_key_jwk)) return peer;
  const id = Number(peer.id);
  const cached = state.profileCache.get(id);
  state.profileCache.set(id, { ts: Date.now(), user: { ...(cached?.user || {}), ...peer } });
  for (const conv of state.conversations) {
    if (Number(conv.other_user?.id) === id) conv.other_user = { ...conv.other_user, ...peer };
  }
  if (Number(state.peer?.id) === id) state.peer = { ...state.peer, ...peer };
  return peer;
}

async function hydratePeerPublicKey(peer, { force = false } = {}) {
  if (!peer?.id) throw new Error("Select a chat first.");
  if (!force && isValidPublicKeyJwk(peer.public_key_jwk)) return updateCachedPeerPublicKey(peer);
  const out = await api(`/users/${peer.id}/public-key`, { timeoutMs: 12000 });
  const publicKey = out?.public_key_jwk;
  if (!isValidPublicKeyJwk(publicKey)) {
    throw new Error(`@${peer.username || "this user"} is missing an encryption public key. They need to log in once or reset their encryption key.`);
  }
  return updateCachedPeerPublicKey({ ...peer, username: out.username || peer.username, public_key_jwk: publicKey });
}

async function evaluatePeerSecurity(peer = state.peer) {
  if (peer?.id && !isValidPublicKeyJwk(peer.public_key_jwk)) {
    try {
      peer = await hydratePeerPublicKey(peer);
    } catch (_) {}
  }
  if (!peer?.id || !isValidPublicKeyJwk(peer.public_key_jwk) || !state.user?.id) {
    state.peerSecurity = { status: "unknown", fingerprint: null, verified: false };
    renderSecurityBanner();
    return state.peerSecurity;
  }
  const fingerprint = await fingerprintPublicJwk(peer.public_key_jwk);
  const stored = readPeerTrust(peer.id);
  if (!stored?.fingerprint) {
    writePeerTrust(peer.id, fingerprint, false);
    state.peerSecurity = { status: "new", fingerprint, verified: false };
  } else if (stored.fingerprint !== fingerprint) {
    state.peerSecurity = { status: "changed", fingerprint, previousFingerprint: stored.fingerprint, verified: false };
  } else {
    state.peerSecurity = { status: stored.verified ? "verified" : "seen", fingerprint, verified: Boolean(stored.verified) };
  }
  renderSecurityBanner();
  return state.peerSecurity;
}

async function ensurePeerKeySafeForSend() {
  if (!state.peer) return false;
  await ensureMyPublicKeyAvailable({ allowPrompt: true });
  state.peer = await hydratePeerPublicKey(state.peer);
  if (!state.peerSecurity?.fingerprint || state.peerSecurity.status === "unknown") {
    await evaluatePeerSecurity(state.peer);
  }
  // Do not interrupt normal sending with a fingerprint wall. If the peer key
  // changed, the chat gets a WhatsApp-style system notice and the user can open
  // Security info from the notice or the menu.
  if (state.peerSecurity?.status === "changed") {
    state.activeMessageSignature = "";
    renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
    toast(`Security code changed for @${state.peer.username}. See the chat notice.`, 5200);
  }
  return true;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function dataUrlFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read blob"));
    reader.readAsDataURL(blob);
  });
}

function blobFromBytes(bytes, type = "application/octet-stream") {
  return new Blob([bytes], { type });
}

async function uploadEncryptedBlob(encryptedBlob, sourceFile, peerId) {
  const form = new FormData();
  form.append("receiver_id", String(peerId));
  form.append("original_name", sourceFile.name || "encrypted-file");
  form.append("mime_type", sourceFile.type || "application/octet-stream");
  form.append("file", encryptedBlob, `${secureRandomToken(12)}.enc`);
  return api("/blobs", { method: "POST", body: form });
}

async function encryptAttachmentForOutbox(file, onProgress = null) {
  const fileKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", fileKey));
  const fileIv = crypto.getRandomValues(new Uint8Array(12));
  onProgress?.(8, "Reading file");
  const plain = await file.arrayBuffer();
  onProgress?.(28, "Encrypting for offline queue");
  const encryptedBytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: fileIv }, fileKey, plain));
  onProgress?.(72, "Saving encrypted queue copy");
  return {
    encryptedBlob: blobFromBytes(encryptedBytes),
    fileKeyB64: bytesToBase64(rawKey),
    fileIv: bytesToBase64(fileIv),
    encryptedSize: encryptedBytes.byteLength,
  };
}

function createOptimisticAttachmentMessage(file, clientMessageId, replyToId = null, localStatus = "uploading") {
  const id = Date.now() * 1000 + (++state.localMessageCounter % 1000);
  const nowIso = new Date().toISOString();
  const messageType = guessMessageType(file);
  const label = localStatus === "queued" ? `Queued attachment: ${file.name || "attachment"}` : `Uploading attachment: ${file.name || "attachment"}`;
  const msg = {
    id, sender_id: state.user.id, receiver_id: state.peer.id, message_type: messageType,
    client_message_id: clientMessageId, ciphertext: "", iv: "", encrypted_key_for_receiver: null, encrypted_key_for_sender: null,
    key_session_id: null, blob_id: null, blob_url: null, session_encrypted_key_for_receiver: null, session_encrypted_key_for_sender: null,
    created_at: nowIso, expires_at: null, edited_at: null, reply_to_id: replyToId, reactions: [], delivered_at: null, read_at: null,
    local_plaintext: label, local_status: localStatus,
  };
  state.decryptedTextByMessageId.set(id, label);
  state.decryptedMessageSignatures.set(id, messageDecryptSignature(msg));
  state.activePeerLatestMessageId = id;
  upsertActiveMessage(msg, { render: true, preserveScroll: true });
  updateLocalConversationFromMessage(msg, { render: true });
  scrollMessagesToBottom();
  return msg;
}

async function queueEncryptedAttachmentFile(file, peerId, replyToId = null, clientMessageId = null) {
  assertSafeAttachment(file);
  const maxBytes = 100 * 1024 * 1024;
  if (file.size > maxBytes) throw new Error("Attachment too large. Keep files under 100 MB.");
  const messageType = guessMessageType(file);
  const cid = clientMessageId || `cm_${state.user.id}_${Date.now()}_${secureRandomToken(18)}`;
  const encrypted = await encryptAttachmentForOutbox(file, (pct, label) => setUploadProgress(pct, label));
  await outboxPut({
    id: `${state.user.id}:${cid}`,
    userId: state.user.id, peerId, kind: "attachment", attempts: 0, createdAt: new Date().toISOString(),
    peerPublicKeyJwk: state.peer?.public_key_jwk || null, senderPublicKeyJwk: state.user?.public_key_jwk || null,
    attachment: {
      client_message_id: cid, reply_to_id: replyToId, message_type: messageType,
      name: file.name || (messageType === "voice" ? "voice-note.webm" : "attachment"),
      type: file.type || "application/octet-stream", size: file.size,
      encryptedBlob: encrypted.encryptedBlob, fileKeyB64: encrypted.fileKeyB64, fileIv: encrypted.fileIv, encryptedSize: encrypted.encryptedSize,
    },
  });
  updateNetworkUi();
  if (navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready.then((registration) => registration.sync?.register?.("chate-outbox-sync")).catch(() => null);
  }
  return cid;
}

async function sendQueuedAttachmentRecord(item) {
  const a = item.attachment || {};
  if (!a.encryptedBlob || !a.fileKeyB64 || !a.fileIv) throw new Error("Queued attachment is incomplete");
  const fakeFile = { name: a.name || "encrypted-file", type: a.type || "application/octet-stream" };
  const blob = await uploadEncryptedBlob(a.encryptedBlob, fakeFile, item.peerId);
  const payload = JSON.stringify({
    version: 4, storage: "encrypted_blob", mode: "single", blobId: blob.id, blobUrl: blob.download_url,
    fileKeyB64: a.fileKeyB64, fileIv: a.fileIv, encryptedSize: blob.size_bytes || a.encryptedSize || 0,
    name: a.name || "attachment", type: a.type || "application/octet-stream", size: a.size || 0,
  });
  let receiverKey = item.peerPublicKeyJwk || state.peer?.public_key_jwk;
  let senderKey = item.senderPublicKeyJwk || state.user?.public_key_jwk;
  if (!isValidPublicKeyJwk(senderKey)) {
    await ensureMyPublicKeyAvailable({ quiet: true });
    senderKey = state.user?.public_key_jwk;
  }
  if (!isValidPublicKeyJwk(receiverKey) && item.peerId) {
    const peer = await hydratePeerPublicKey({ id: item.peerId, username: "contact" });
    receiverKey = peer.public_key_jwk;
    item.peerPublicKeyJwk = receiverKey;
    await outboxPut(item).catch(() => null);
  }
  if (!isValidPublicKeyJwk(receiverKey) || !isValidPublicKeyJwk(senderKey)) throw new Error("Queued attachment is missing encryption public keys");
  const encrypted = await encryptMessagePayload(payload, a.message_type || "file", receiverKey, senderKey, item.peerId);
  return api("/messages", {
    method: "POST",
    body: JSON.stringify({ receiver_id: item.peerId, client_message_id: a.client_message_id, blob_id: blob.id, reply_to_id: a.reply_to_id || null, ...encrypted }),
    timeoutMs: 45000,
  });
}

async function encryptAndUploadFileBlob(file, peerId) {
  const chunkSize = 3 * 1024 * 1024;
  const fileKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", fileKey));
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const useChunked = totalChunks > 1;

  if (!useChunked) {
    const fileIv = crypto.getRandomValues(new Uint8Array(12));
    setUploadProgress(10, "Encrypting");
    const plain = await file.arrayBuffer();
    const encryptedBytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: fileIv }, fileKey, plain));
    setUploadProgress(45, "Uploading");
    const blob = await uploadEncryptedBlob(blobFromBytes(encryptedBytes), file, peerId);
    setUploadProgress(100, "Uploaded");
    return {
      blob,
      metadata: {
        version: 4,
        storage: "encrypted_blob",
        mode: "single",
        blobId: blob.id,
        blobUrl: blob.download_url,
        fileKeyB64: bytesToBase64(rawKey),
        fileIv: bytesToBase64(fileIv),
        encryptedSize: blob.size_bytes,
      },
    };
  }

  const start = await api("/blob-uploads/start", {
    method: "POST",
    body: JSON.stringify({
      receiver_id: peerId,
      original_name: file.name || "encrypted-file",
      mime_type: file.type || "application/octet-stream",
      total_size: file.size,
      total_chunks: totalChunks,
    }),
  });

  const chunkIvs = [];
  const encryptedChunkSizes = [];
  for (let i = 0; i < totalChunks; i += 1) {
    const from = i * chunkSize;
    const to = Math.min(file.size, from + chunkSize);
    const plain = await file.slice(from, to).arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, fileKey, plain));
    chunkIvs.push(bytesToBase64(iv));
    encryptedChunkSizes.push(encrypted.byteLength);
    const form = new FormData();
    form.append("file", blobFromBytes(encrypted), `${file.name || "file"}.part${i}`);
    let attempt = 0;
    while (true) {
      try {
        await api(`/blob-uploads/${start.upload_id}/chunks/${i}`, { method: "PUT", body: form });
        break;
      } catch (err) {
        attempt += 1;
        if (attempt >= 3) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    setUploadProgress(((i + 1) / totalChunks) * 92, "Encrypting/uploading chunks");
  }
  const blob = await api(`/blob-uploads/${start.upload_id}/complete`, { method: "POST", body: JSON.stringify({ upload_id: start.upload_id }) });
  setUploadProgress(100, "Uploaded");
  return {
    blob,
    metadata: {
      version: 4,
      storage: "encrypted_blob",
      mode: "chunked",
      blobId: blob.id,
      blobUrl: blob.download_url,
      fileKeyB64: bytesToBase64(rawKey),
      chunkSize,
      chunkIvs,
      encryptedChunkSizes,
      encryptedSize: blob.size_bytes,
    },
  };
}

async function decryptBlobPayload(parsedPayload) {
  if (!parsedPayload?.blobId) throw new Error("Missing encrypted blob id");
  if (state.blobUrlCache.has(parsedPayload.blobId)) return state.blobUrlCache.get(parsedPayload.blobId);
  const res = await fetch(`${API}/blobs/${encodeURIComponent(parsedPayload.blobId)}`, {
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
  });
  if (!res.ok) throw new Error(`Could not download encrypted file: HTTP ${res.status}`);
  const encryptedBytes = await res.arrayBuffer();
  const fileKey = await crypto.subtle.importKey("raw", base64ToBytes(parsedPayload.fileKeyB64), "AES-GCM", false, ["decrypt"]);
  let plainParts;
  if (parsedPayload.mode === "chunked" && Array.isArray(parsedPayload.chunkIvs) && Array.isArray(parsedPayload.encryptedChunkSizes)) {
    plainParts = [];
    let offset = 0;
    for (let i = 0; i < parsedPayload.encryptedChunkSizes.length; i += 1) {
      const size = Number(parsedPayload.encryptedChunkSizes[i]);
      const chunk = encryptedBytes.slice(offset, offset + size);
      offset += size;
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(parsedPayload.chunkIvs[i]) }, fileKey, chunk);
      plainParts.push(plain);
    }
  } else {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(parsedPayload.fileIv) }, fileKey, encryptedBytes);
    plainParts = [plain];
  }
  const blob = new Blob(plainParts, { type: parsedPayload.type || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const cached = { blob, url, name: parsedPayload.name || "encrypted-file", type: parsedPayload.type || blob.type, size: parsedPayload.size || blob.size };
  state.blobUrlCache.set(parsedPayload.blobId, cached);
  return cached;
}

function renderEncryptedBlobCard(parsedPayload, msg, messageType) {
  const card = document.createElement("div");
  card.className = `blob-card blob-${messageType || "file"}`;
  const title = document.createElement("strong");
  title.textContent = parsedPayload.name || "Encrypted file";
  const meta = document.createElement("span");
  meta.textContent = `${parsedPayload.type || "file"} · ${formatBytes(parsedPayload.size || 0)} · stored as encrypted blob`;
  const action = document.createElement("button");
  action.type = "button";
  action.className = "small-btn";
  action.textContent = messageType === "image" ? "Load image" : messageType === "video" ? "Load video" : messageType === "voice" ? "Load voice" : "Decrypt file";
  card.append(title, meta, action);
  const load = async () => {
    action.disabled = true;
    action.textContent = "Decrypting…";
    try {
      const out = await decryptBlobPayload(parsedPayload);
      card.replaceChildren();
      if (messageType === "image") {
        const img = document.createElement("img");
        img.className = "message-image";
        img.src = out.url;
        img.alt = out.name;
        card.appendChild(img);
      } else if (messageType === "video") {
        const video = document.createElement("video");
        video.className = "message-video";
        video.src = out.url;
        video.controls = true;
        card.appendChild(video);
      } else if (messageType === "voice") {
        card.appendChild(renderVoiceNote({ ...parsedPayload, dataUrl: out.url, name: out.name, size: out.size }, msg));
      } else {
        const link = document.createElement("a");
        link.href = out.url;
        link.download = out.name;
        link.textContent = "Download decrypted file";
        card.append(title, meta, link);
      }
      const caption = document.createElement("div");
      caption.className = "attachment-caption";
      caption.textContent = `${out.name} · ${formatBytes(out.size || 0)}`;
      card.appendChild(caption);
    } catch (err) {
      action.disabled = false;
      action.textContent = "Retry decrypt";
      toast(err.message, 6000);
    }
  };
  action.addEventListener("click", load);
  if (state.blobUrlCache.has(parsedPayload.blobId)) load().catch(() => {});
  return card;
}

function guessMessageType(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "voice";
  return "file";
}

const RISKY_ATTACHMENT_EXTENSIONS = new Set([
  ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".psm1", ".vbs",
  ".js", ".jse", ".jar", ".apk", ".ipa", ".deb", ".rpm", ".appimage", ".desktop",
  ".sh", ".bash", ".zsh", ".fish", ".run", ".bin"
]);

function assertSafeAttachment(file) {
  const name = (file?.name || "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (RISKY_ATTACHMENT_EXTENSIONS.has(ext)) {
    throw new Error(`Blocked risky executable attachment type: ${ext}. Send normal documents/media only.`);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setUploadProgress(percent, label = "Uploading encrypted file") {
  const wrap = $("uploadProgress");
  if (!wrap) return;
  const bar = wrap.querySelector("span");
  const text = wrap.querySelector("strong");
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  wrap.classList.remove("hidden");
  if (bar) bar.style.width = `${p}%`;
  if (text) text.textContent = `${label} · ${p}%`;
}

function hideUploadProgress() {
  const wrap = $("uploadProgress");
  if (!wrap) return;
  wrap.classList.add("hidden");
  const bar = wrap.querySelector("span");
  if (bar) bar.style.width = "0%";
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeAnimatedGifDataUrl(item) {
  const cacheKey = `${item.emoji || "✨"}|${item.label || "GIF"}|${item.c1 || ""}|${item.c2 || ""}`;
  const cached = state.generatedMediaUrlCache.get(cacheKey);
  if (cached) return cached;
  const emoji = escapeXml(item.emoji || "✨");
  const title = escapeXml(item.label || "GIF");
  const c1 = item.c1 || "#335cff";
  const c2 = item.c2 || "#f97316";
  const generated = svgDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="420" height="300" viewBox="0 0 420 300">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="${c1}" offset="0"/><stop stop-color="${c2}" offset="1"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-opacity=".35"/></filter>
  </defs>
  <rect width="420" height="300" rx="38" fill="url(#bg)"/>
  <circle cx="80" cy="70" r="56" fill="rgba(255,255,255,.22)">
    <animate attributeName="r" values="44;70;44" dur="2s" repeatCount="indefinite"/>
  </circle>
  <circle cx="330" cy="230" r="70" fill="rgba(255,255,255,.16)">
    <animate attributeName="cx" values="330;290;330" dur="2.4s" repeatCount="indefinite"/>
  </circle>
  <text x="210" y="165" text-anchor="middle" dominant-baseline="middle" font-size="104" filter="url(#shadow)">${emoji}
    <animateTransform attributeName="transform" type="translate" values="0 0;0 -18;0 0" dur="1.15s" repeatCount="indefinite"/>
    <animateTransform additive="sum" attributeName="transform" type="rotate" values="-5 210 150;6 210 150;-5 210 150" dur="1.15s" repeatCount="indefinite"/>
  </text>
  <text x="210" y="262" text-anchor="middle" font-size="28" font-family="Inter,Arial,sans-serif" font-weight="800" fill="white" opacity=".92">${title}</text>
</svg>`);
  state.generatedMediaUrlCache.set(cacheKey, generated);
  if (state.generatedMediaUrlCache.size > 300) {
    const firstKey = state.generatedMediaUrlCache.keys().next().value;
    state.generatedMediaUrlCache.delete(firstKey);
  }
  return generated;
}

function isSingleEmojiText(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 8) return false;
  return /^\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Extended_Pictographic})*$/u.test(value);
}

async function sendStructuredMessage(messageType, payload) {
  if (!state.peer || !state.user) return;
  if (!(await ensurePeerKeySafeForSend())) return;
  const clientMessageId = `cm_${state.user.id}_${Date.now()}_${secureRandomToken(18)}`;
  const encrypted = await encryptMessagePayload(JSON.stringify(payload), messageType, state.peer.public_key_jwk, state.user.public_key_jwk, state.peer.id);
  const body = { receiver_id: state.peer.id, client_message_id: clientMessageId, ...encrypted };
  try {
    const saved = await api("/messages", { method: "POST", body: JSON.stringify(body), timeoutMs: 30000 });
    if (state.peer?.id === body.receiver_id) {
      mergeMessages([saved]);
      updateLocalConversationFromMessage(saved, { render: true });
      renderLoadedMessages({ force: true, preserveScroll: false }).catch(() => {});
      scheduleConversationRefresh(4500);
    }
  } catch (err) {
    if (!isRetryableNetworkError(err)) throw err;
    await queueEncryptedMessage(body, state.peer.id, messageType);
    toast("Offline: encrypted message queued and will sync when online.", 6200);
  }
}

function buildVoiceWave(container, count = 28) {
  container.replaceChildren();
  for (let i = 0; i < count; i += 1) {
    const bar = document.createElement("span");
    bar.style.height = `${10 + ((i * 17) % 22)}px`;
    bar.style.animationDelay = `${-(i % 8) * 0.08}s`;
    container.appendChild(bar);
  }
}

function renderVoiceNote(parsedPayload, msg) {
  const wrap = document.createElement("div");
  wrap.className = "voice-card";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "voice-play";
  play.textContent = "▶";

  const main = document.createElement("div");
  main.className = "voice-main";
  const wave = document.createElement("div");
  wave.className = "voice-wave";
  buildVoiceWave(wave);
  const time = document.createElement("div");
  time.className = "voice-time";
  time.textContent = "00:00";
  main.append(wave, time);

  const download = document.createElement("a");
  download.className = "voice-download";
  download.href = parsedPayload.dataUrl;
  download.download = parsedPayload.name || `voice-note-${msg.id}.webm`;
  download.title = "Download voice note";
  download.textContent = "↓";

  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = parsedPayload.dataUrl;
  audio.className = "hidden";

  const update = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const progress = duration ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;
    wave.style.setProperty("--progress", `${progress}%`);
    time.textContent = `${formatDuration(current)} / ${duration ? formatDuration(duration) : "00:00"}`;
  };

  play.addEventListener("click", async () => {
    if (state.activeAudio && state.activeAudio !== audio) state.activeAudio.pause();
    if (audio.paused) {
      state.activeAudio = audio;
      await audio.play();
    } else {
      audio.pause();
    }
  });
  wave.addEventListener("click", (event) => {
    if (!Number.isFinite(audio.duration) || !audio.duration) return;
    const rect = wave.getBoundingClientRect();
    audio.currentTime = ((event.clientX - rect.left) / rect.width) * audio.duration;
    update();
  });
  audio.addEventListener("loadedmetadata", update);
  audio.addEventListener("timeupdate", update);
  audio.addEventListener("play", () => { play.textContent = "❚❚"; wave.classList.add("playing"); });
  audio.addEventListener("pause", () => { play.textContent = "▶"; wave.classList.remove("playing"); });
  audio.addEventListener("ended", () => { play.textContent = "▶"; wave.classList.remove("playing"); wave.style.setProperty("--progress", "0%"); });

  wrap.append(play, main, download, audio);
  return wrap;
}

function showRecordingTray() {
  const tray = $("recordingTray");
  const timer = $("recordingTimer");
  if (!tray) return;
  tray.classList.remove("hidden");
  clearInterval(state.recordingTimer);
  const update = () => {
    if (timer) timer.textContent = formatDuration((Date.now() - state.recordingStartedAt) / 1000);
  };
  update();
  state.recordingTimer = setInterval(update, 250);
}

function hideRecordingTray() {
  const tray = $("recordingTray");
  if (tray) tray.classList.add("hidden");
  clearInterval(state.recordingTimer);
  state.recordingTimer = null;
}

function isMessageVisibleInSearch(msg, text) {
  const q = state.messageSearch.trim().toLowerCase();
  if (!q) return true;
  const haystack = `${text || ""} ${msg.message_type || ""}`.toLowerCase();
  return haystack.includes(q);
}

function appendHighlightedText(container, text, query) {
  const value = String(text ?? "");
  const q = String(query || "").trim();
  if (!q) {
    container.textContent = value;
    return;
  }
  const lower = value.toLowerCase();
  const needle = q.toLowerCase();
  let idx = 0;
  while (idx < value.length) {
    const hit = lower.indexOf(needle, idx);
    if (hit < 0) {
      container.appendChild(document.createTextNode(value.slice(idx)));
      break;
    }
    if (hit > idx) container.appendChild(document.createTextNode(value.slice(idx, hit)));
    const mark = document.createElement("mark");
    mark.className = "search-highlight";
    mark.textContent = value.slice(hit, hit + needle.length);
    container.appendChild(mark);
    idx = hit + needle.length;
  }
}

function autoGrowComposer() {
  const input = $("messageInput");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

function setReplyTarget(messageId) {
  state.replyToMessageId = messageId ? Number(messageId) : null;
  const bar = $("replyBar");
  const preview = $("replyPreview");
  if (!bar) return;
  if (!state.replyToMessageId) {
    bar.classList.add("hidden");
    if (preview) preview.textContent = "";
    return;
  }
  const text = state.decryptedTextByMessageId.get(state.replyToMessageId) || "Encrypted message";
  if (preview) preview.textContent = text.slice(0, 110);
  bar.classList.remove("hidden");
  $("messageInput")?.focus();
}

function clearReplyTarget() {
  setReplyTarget(null);
}

function getReplyPreview(replyToId) {
  if (!replyToId) return "";
  return state.decryptedTextByMessageId.get(Number(replyToId)) || "Encrypted message";
}

function startEditingMessage(messageId) {
  const text = state.decryptedTextByMessageId.get(Number(messageId));
  if (!text) return toast("Unlock/decrypt this message before editing.");
  state.editingMessageId = Number(messageId);
  const input = $("messageInput");
  if (input) {
    input.value = text;
    input.focus();
    autoGrowComposer();
  }
  const sendBtn = $("sendBtn");
  if (sendBtn) sendBtn.textContent = "Save";
  toast("Editing message. Send saves the edited encrypted text.");
}

function stopEditingMessage() {
  state.editingMessageId = null;
  const sendBtn = $("sendBtn");
  if (sendBtn) sendBtn.textContent = state.sendingMessage ? "Sending…" : (state.editingMessageId ? "Save" : "Send");
}

async function reactToMessage(messageId, emoji) {
  const updated = await api(`/messages/${messageId}/reactions`, {
    method: "POST",
    body: JSON.stringify({ emoji }),
  });
  const idx = state.activeMessages.findIndex((msg) => Number(msg.id) === Number(messageId));
  if (idx >= 0) state.activeMessages[idx] = updated;
  state.activeMessageSignature = "";
  await renderLoadedMessages({ force: true, preserveScroll: true });
}

async function forwardMessage(messageId) {
  const text = state.decryptedTextByMessageId.get(Number(messageId));
  if (!text) return toast("Unlock/decrypt the message before forwarding.");
  const username = prompt("Forward to username:");
  if (!username) return;
  const peer = await hydratePeerPublicKey(await api(`/users/by-username/${encodeURIComponent(username.trim())}`));
  const encrypted = await encryptMessageText(text, peer.public_key_jwk, state.user.public_key_jwk, peer.id);
  await api("/messages", {
    method: "POST",
    body: JSON.stringify({ receiver_id: peer.id, client_message_id: `cm_${state.user.id}_${Date.now()}_${secureRandomToken(18)}`, ...encrypted }),
  });
  toast(`Forwarded to @${peer.username}.`);
}

function updateComposerAvailability() {
  const composer = $("composer");
  if (!composer) return;

  const loggedIn = Boolean(state.token && state.user);
  const activeChat = Boolean(loggedIn && state.peer);
  composer.classList.toggle("hidden", !loggedIn);
  composer.classList.toggle("disabled-composer", loggedIn && !activeChat);

  const input = $("messageInput");
  const sendBtn = $("sendBtn");
  const attachBtn = $("attachBtn");
  const emojiBtn = $("emojiBtn");
  const recordBtn = $("recordBtn");
  const gifBtn = $("gifBtn");

  if (input) {
    input.disabled = !activeChat;
    input.readOnly = activeChat && state.sendingMessage;
    input.placeholder = activeChat
      ? "Type encrypted message... Enter sends, Shift+Enter adds line"
      : "Select a chat to start messaging";
  }

  for (const btn of [sendBtn, attachBtn, emojiBtn, gifBtn, recordBtn]) {
    if (!btn) continue;
    btn.disabled = !activeChat || state.sendingMessage;
    btn.classList.toggle("loading", Boolean(state.sendingMessage && btn === sendBtn));
  }

  if (sendBtn) sendBtn.textContent = state.sendingMessage ? "Sending…" : (state.editingMessageId ? "Save" : "Send");
}

function setComposerBusy(isBusy) {
  state.sendingMessage = Boolean(isBusy);
  updateComposerAvailability();
}

// ---------------- Crypto ----------------
async function derivePassphraseKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPrivateJwk(privateJwk, publicJwk, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePassphraseKey(passphrase, salt);
  const plaintext = enc.encode(JSON.stringify(privateJwk));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    version: 2,
    app: "ChatE",
    createdAt: new Date().toISOString(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 310000 },
    cipher: { name: "AES-GCM", length: 256 },
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    publicKeyJwk: publicJwk,
  };
}

async function decryptPrivateKeyPackage(pkg, passphrase) {
  const salt = base64ToBytes(pkg.salt);
  const iv = base64ToBytes(pkg.iv);
  const key = await derivePassphraseKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBytes(pkg.ciphertext),
  );
  const privateJwk = JSON.parse(dec.decode(plaintext));
  const privateKey = await importPrivateJwk(privateJwk);
  return { privateKey, privateJwk, publicKeyJwk: pkg.publicKeyJwk };
}

async function createEncryptedKeyPackage(passphrase) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return encryptPrivateJwk(privateJwk, publicJwk, passphrase);
}

async function addUnlockedKey(pkg, passphrase, makeActive = false) {
  const unlocked = await decryptPrivateKeyPackage(pkg, passphrase);
  const fingerprint = await fingerprintPublicJwk(unlocked.publicKeyJwk);
  state.privateKeys.set(fingerprint, unlocked.privateKey);
  state.privateKey = unlocked.privateKey;
  state.publicKeyJwk = unlocked.publicKeyJwk;
  if (makeActive) {
    state.activeKeyFingerprint = fingerprint;
    await idbPut("active", fingerprint);
  }
  await persistTrustedDeviceKey(fingerprint, unlocked.privateJwk, unlocked.publicKeyJwk, makeActive);
  startTemporaryKeyRotation();
  return { ...unlocked, fingerprint };
}

async function unlockPrivateKey(passphrase) {
  const pkg = await loadEncryptedKeyPackage();
  if (!pkg) throw new Error("No encrypted private-key package found on this device. Login can still work; create a replacement key for new chats or import your old key package.");
  return addUnlockedKey(pkg, passphrase, true);
}

async function unlockAnyStoredKey(passphrase) {
  const packages = await loadAllEncryptedKeyPackages();
  if (!packages.length) throw new Error("No encrypted private-key package found on this device.");

  let unlockedCount = 0;
  let lastError = null;
  for (const pkg of packages) {
    try {
      await addUnlockedKey(pkg, passphrase, false);
      unlockedCount += 1;
    } catch (err) {
      lastError = err;
    }
  }
  if (!unlockedCount) throw new Error(lastError?.message || "Could not unlock any stored key with that passphrase.");
  setKeyUI(true);
  return unlockedCount;
}

async function importPublicKey(jwk) {
  if (!isValidPublicKeyJwk(jwk)) throw new Error("Missing or invalid encryption public key");
  const identity = publicKeyIdentity(jwk);
  const cacheKey = identity ? JSON.stringify(identity) : JSON.stringify(jwk);
  const cached = state.publicKeyImportCache.get(cacheKey);
  if (cached) return cached;
  const promise = crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  state.publicKeyImportCache.set(cacheKey, promise);
  if (state.publicKeyImportCache.size > 24) {
    const first = state.publicKeyImportCache.keys().next().value;
    state.publicKeyImportCache.delete(first);
  }
  return promise;
}

async function updateMyPublicKey(publicKeyJwk) {
  const user = await api("/users/me/public-key", {
    method: "PUT",
    body: JSON.stringify({ public_key_jwk: publicKeyJwk }),
  });
  saveSession(state.token, user);
  renderAuthState();
  return user;
}

async function createReplacementEncryptionIdentity(passphrase, reason = "new chats", unlockForReading = true) {
  if (!passphrase || passphrase.length < 8) throw new Error("Key passphrase must be at least 8 characters.");
  toast(`Creating a fresh encryption key for ${reason}...`, 5000);
  const pkg = await createEncryptedKeyPackage(passphrase);
  await saveEncryptedKeyPackage(pkg, true);
  if (unlockForReading) {
    await addUnlockedKey(pkg, passphrase, true);
    markMessagesUnlockedThisLogin();
  }
  await updateMyPublicKey(pkg.publicKeyJwk);
  toast(unlockForReading
    ? "Fresh encryption key is active and messages are unlocked for this login session."
    : "Fresh encryption key is active for new chats. Existing messages stay locked until you unlock them.", 6500);
  return pkg;
}

async function ensureMyPublicKeyAvailable({ repairPassphrase = "", allowPrompt = false, quiet = false } = {}) {
  if (isValidPublicKeyJwk(state.user?.public_key_jwk)) return true;

  if (state.token) {
    try {
      const me = await api("/users/me", { timeoutMs: 12000 });
      saveSession(state.token, me);
      if (isValidPublicKeyJwk(me.public_key_jwk)) return true;
    } catch (_) {}
  }

  const pkg = await loadEncryptedKeyPackage().catch(() => null);
  if (isValidPublicKeyJwk(pkg?.publicKeyJwk)) {
    await updateMyPublicKey(pkg.publicKeyJwk);
    if (!quiet) toast("Account encryption public key was missing and has been repaired from this browser's key package.", 6500);
    return true;
  }

  let passphrase = repairPassphrase || "";
  if (!passphrase && allowPrompt) {
    passphrase = prompt("Your account is missing its encryption public key. Set a passphrase to create a replacement key for future chats:") || "";
  }
  if (!passphrase) throw new Error("Your account encryption public key is missing. Open Settings → Security and create/reset your encryption key.");
  await createReplacementEncryptionIdentity(passphrase, "public-key repair", false);
  clearMessagesUnlockedThisLogin();
  setKeyUI(false);
  return true;
}

async function ensureActiveEncryptionIdentity() {
  await ensureMyPublicKeyAvailable({ allowPrompt: true });
  const fingerprint = await fingerprintPublicJwk(state.user.public_key_jwk);
  if (state.activeIdentityCheckedFingerprint === fingerprint) return true;

  const packages = await loadAllEncryptedKeyPackages();
  for (const pkg of packages) {
    if (await publicKeysMatch(pkg.publicKeyJwk, state.user.public_key_jwk)) {
      state.activeIdentityCheckedFingerprint = fingerprint;
      return true;
    }
  }

  const ok = confirm("This browser has no local package for the active server key. Create a fresh encryption key for future chats? Old chats remain encrypted until the old package is imported/unlocked.");
  if (!ok) throw new Error("No active local encryption package available.");
  const passphrase = prompt("Set a passphrase for the new encrypted key package:");
  if (!passphrase) throw new Error("Key creation cancelled.");
  await createReplacementEncryptionIdentity(passphrase, "new chats", false);
  state.activeIdentityCheckedFingerprint = await fingerprintPublicJwk(state.user.public_key_jwk);
  clearMessagesUnlockedThisLogin();
  setKeyUI(false);
  return true;
}

async function encryptMessageText(plaintext, receiverPublicJwk, senderPublicJwk, peerId) {
  await ensureActiveEncryptionIdentity();
  const session = await getTemporaryMessageSession(peerId, receiverPublicJwk, senderPublicJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, session.aesKey, enc.encode(plaintext)));

  return {
    message_type: "text",
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    key_session_id: session.id,
    encrypted_key_for_receiver: session.registered ? null : session.encryptedKeyForReceiver,
    encrypted_key_for_sender: session.registered ? null : session.encryptedKeyForSender,
  };
}

async function encryptMessagePayload(payloadText, messageType, receiverPublicJwk, senderPublicJwk, peerId) {
  await ensureActiveEncryptionIdentity();
  const session = await getTemporaryMessageSession(peerId, receiverPublicJwk, senderPublicJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, session.aesKey, enc.encode(payloadText)));
  return {
    message_type: messageType,
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    key_session_id: session.id,
    encrypted_key_for_receiver: session.registered ? null : session.encryptedKeyForReceiver,
    encrypted_key_for_sender: session.registered ? null : session.encryptedKeyForSender,
  };
}

async function getAesKeyForMessage(msg) {
  if (msg.key_session_id) {
    const cached = state.decryptedSessions.get(msg.key_session_id);
    if (cached) return cached;

    const wrapped = msg.sender_id === state.user.id
      ? msg.session_encrypted_key_for_sender
      : msg.session_encrypted_key_for_receiver;
    if (!wrapped) throw new Error("Missing temporary key session material");
    const wrappedBytes = base64ToBytes(wrapped);

    for (const privateKey of state.privateKeys.values()) {
      try {
        const rawAesKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, wrappedBytes);
        const aesKey = await crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
        state.decryptedSessions.set(msg.key_session_id, aesKey);
        return aesKey;
      } catch (_) {
        // Try next unlocked private key.
      }
    }
    throw new Error("No unlocked key can unwrap this temporary message key");
  }

  // Backward compatibility with old v9 and earlier per-message wrapped keys.
  const wrapped = msg.sender_id === state.user.id ? msg.encrypted_key_for_sender : msg.encrypted_key_for_receiver;
  if (!wrapped) throw new Error("Missing wrapped message key");
  const wrappedBytes = base64ToBytes(wrapped);
  for (const privateKey of state.privateKeys.values()) {
    try {
      const rawAesKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, wrappedBytes);
      return await crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    } catch (_) {
      // Try next unlocked private key.
    }
  }
  throw new Error("No unlocked key can decrypt this message");
}

async function decryptMessageText(msg) {
  if (Object.prototype.hasOwnProperty.call(msg, "local_plaintext")) {
    return String(msg.local_plaintext || "");
  }
  if (!state.messagesUnlocked) throw new Error("Messages are locked");
  if (!state.privateKeys.size) throw new Error("Private keys are locked");
  const sig = messageDecryptSignature(msg);
  if (state.decryptedMessageSignatures.get(msg.id) === sig && state.decryptedTextByMessageId.has(msg.id)) {
    return state.decryptedTextByMessageId.get(msg.id);
  }
  const aesKey = await getAesKeyForMessage(msg);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(msg.iv) },
    aesKey,
    base64ToBytes(msg.ciphertext),
  );
  const text = dec.decode(plaintext);
  state.decryptedTextByMessageId.set(msg.id, text);
  state.decryptedMessageSignatures.set(msg.id, sig);
  return text;
}


// ---------------- Realtime highway ----------------
function realtimeUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function realtimeProtocols() {
  return state.token ? ["chate.v1", `token.${state.token}`] : ["chate.v1"];
}

function sendRealtime(event) {
  const ws = state.realtimeSocket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(event));
  return true;
}

function disconnectRealtime() {
  clearTimeout(state.realtimeReconnectTimer);
  clearInterval(state.realtimeHeartbeatTimer);
  state.realtimeReconnectTimer = null;
  state.realtimeHeartbeatTimer = null;
  state.realtimeConnected = false;
  if (state.realtimeSocket) {
    try { state.realtimeSocket.onclose = null; state.realtimeSocket.close(); } catch (_) {}
  }
  state.realtimeSocket = null;
}

function scheduleRealtimeReconnect() {
  if (!state.token) return;
  clearTimeout(state.realtimeReconnectTimer);
  const delay = Math.min(12000, 700 * (2 ** Math.min(state.realtimeReconnectAttempts, 4)));
  state.realtimeReconnectTimer = setTimeout(() => connectRealtime(), delay);
}

async function handleRealtimeEvent(event) {
  if (!event || !event.type) return;

  if (event.type === "auth:error") {
    handleSessionExpired({ silent: false });
    return;
  }

  if (event.type === "highway:ready") {
    state.realtimeConnected = true;
    state.realtimeReconnectAttempts = 0;
    startFallbackPolling(true);
    return;
  }

  if (event.type === "presence:update") {
    const presence = event.presence;
    if (presence && state.peer?.id === presence.user_id) {
      renderPresence(presence.status, presence.last_seen_at);
    }
    return;
  }

  if (event.type === "message:new" || event.type === "message:sent") {
    const targetPeerId = Number(event.conversation_user_id);
    const clientId = event.message?.client_message_id || null;
    const isOwnEcho = event.type === "message:sent" || (event.message && Number(event.message.sender_id) === Number(state.user?.id));
    if (clientId && isOwnEcho && state.pendingOutboundClientIds.has(clientId)) {
      // The POST /api/messages response already merged this message. Do not
      // re-render/reload on the WebSocket echo; that caused duplicate work and
      // visible scroll jumps on weak laptops.
      return;
    }
    if (event.message) {
      if (state.peer?.id === targetPeerId) {
        mergeMessages([event.message]);
        state.activePeerLatestMessageId = event.message.id;
        await renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
      }
      updateLocalConversationFromMessage(event.message, { render: true });
      if (!isOwnEcho) scheduleConversationRefresh(12000);
    } else if (!isOwnEcho) {
      scheduleConversationRefresh(5000);
      if (state.peer?.id === targetPeerId) syncActiveMessagesSinceLatest({ force: true }).catch(() => null);
    }
    if (event.type === "message:new") {
      const conv = state.conversations.find((entry) => Number(entry.other_user.id) === targetPeerId);
      if (conv && !state.notifiedMessageIds.has(event.message_id) && !isMuted(targetPeerId)) {
        state.notifiedMessageIds.add(event.message_id);
        if (state.peer?.id !== targetPeerId) toast(`New encrypted message from @${conv.other_user.username}`);
        if (document.hidden || state.peer?.id !== targetPeerId) notifyIncomingMessage(conv.other_user, event.message_id).catch(() => {});
      }
    }
    return;
  }

  if (event.type === "message:edited" || event.type === "message:reaction") {
    const targetPeerId = Number(event.conversation_user_id);
    if (event.message) {
      const idx = state.activeMessages.findIndex((msg) => Number(msg.id) === Number(event.message.id));
      if (idx >= 0) state.activeMessages[idx] = event.message;
      else if (state.peer?.id === targetPeerId) state.activeMessages.push(event.message);
      state.activeMessages.sort((a, b) => a.id - b.id);
      state.activeMessageSignature = "";
    }
    if (state.peer?.id === targetPeerId) {
      await renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
    }
    await loadConversations({ silent: true });
    return;
  }

  if (event.type === "message:deleted") {
    const messageId = Number(event.message_id);
    const senderId = Number(event.sender_id);
    const receiverId = Number(event.receiver_id);
    const peerId = senderId === state.user?.id ? receiverId : senderId;

    if (messageId) {
      state.activeMessages = state.activeMessages.filter((msg) => Number(msg.id) !== messageId);
      state.decryptedTextByMessageId.delete(messageId);
    }

    if (state.peer?.id === peerId) {
      state.activeMessageSignature = "";
      await renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
    }
    await loadConversations({ silent: true });
    return;
  }

  if (event.type === "conversation:deleted") {
    const peerId = Number(event.conversation_user_id);
    const deletedIds = Array.isArray(event.message_ids) ? new Set(event.message_ids.map(Number)) : null;

    if (deletedIds) {
      state.activeMessages = state.activeMessages.filter((msg) => !deletedIds.has(Number(msg.id)));
      for (const id of deletedIds) state.decryptedTextByMessageId.delete(id);
    }

    if (state.peer?.id === peerId) {
      state.peer = null;
      state.activeMessages = [];
      state.oldestMessageId = null;
      state.hasMoreMessages = true;
      state.activePeerLatestMessageId = null;
      document.body.classList.remove("mobile-chat-active");
      renderChatShell();
    }
    await loadConversations({ silent: true });
    toast("Conversation was deleted.");
    return;
  }


  if (event.type === "conversation:settings") {
    const peerId = Number(event.conversation_user_id || event.other_user_id);
    if (state.peer?.id === peerId) {
      const label = event.disappearing_seconds ? `${event.disappearing_seconds}s` : "off";
      toast(`Disappearing messages are ${label}.`, 4200);
      state.activeMessageSignature = "";
      await renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
    }
    return;
  }

  if (event.type === "user:blocked") {
    const blockerId = Number(event.blocker_id);
    const blockedId = Number(event.blocked_id);
    const peerId = blockerId === Number(state.user?.id) ? blockedId : blockerId;
    if (state.peer?.id === peerId) {
      state.peer = null;
      state.activeMessages = [];
      state.activeMessageSignature = "";
      clearTimeout(state.expiryTimer);
      document.body.classList.remove("mobile-chat-active");
      renderChatShell();
      toast(blockerId === Number(state.user?.id) ? "User blocked." : "This user blocked the conversation.", 6200);
    }
    await loadConversations({ silent: true, force: true });
    return;
  }

  if (event.type === "user:unblocked") {
    await loadConversations({ silent: true, force: true });
    return;
  }

  if (event.type === "message:read") {
    if (state.peer?.id === Number(event.reader_id)) {
      const nowIso = new Date().toISOString();
      let changed = false;
      for (const msg of state.activeMessages) {
        if (Number(msg.sender_id) === Number(state.user?.id) && !msg.read_at) {
          msg.delivered_at = msg.delivered_at || nowIso;
          msg.read_at = nowIso;
          changed = true;
        }
      }
      if (changed) {
        state.activeMessageSignature = "";
        await renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
      }
    }
  }
}

function connectRealtime() {
  if (!state.token || !state.user) return;
  if (state.realtimeSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.realtimeSocket.readyState)) return;
  disconnectRealtime();
  try {
    const ws = new WebSocket(realtimeUrl(), realtimeProtocols());
    state.realtimeSocket = ws;
    ws.addEventListener("open", () => {
      state.realtimeConnected = true;
      state.realtimeReconnectAttempts = 0;
      sendRealtime({ type: "presence", status: document.hidden ? "idle" : "online", peer_id: state.peer?.id || null });
      clearInterval(state.realtimeHeartbeatTimer);
      state.realtimeHeartbeatTimer = setInterval(() => {
        sendRealtime({ type: "ping" });
        if (!document.hidden) sendRealtime({ type: "presence", status: "online", peer_id: state.peer?.id || null });
      }, state.lowPowerMode ? 90000 : 60000);
      startFallbackPolling(true);
    });
    ws.addEventListener("message", (message) => {
      try {
        handleRealtimeEvent(JSON.parse(message.data)).catch(() => {});
      } catch (_) {}
    });
    ws.addEventListener("close", (event) => {
      state.realtimeConnected = false;
      clearInterval(state.realtimeHeartbeatTimer);
      state.realtimeHeartbeatTimer = null;
      if (event?.code === 4401 || event?.code === 4403) {
        handleSessionExpired({ silent: false });
        return;
      }
      state.realtimeReconnectAttempts += 1;
      startFallbackPolling(false);
      scheduleRealtimeReconnect();
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch (_) {}
    });
  } catch (_) {
    state.realtimeConnected = false;
    startFallbackPolling(false);
    scheduleRealtimeReconnect();
  }
}

function startFallbackPolling(highwayHealthy = false) {
  clearInterval(state.pollTimer);
  if (!state.token) return;
  if (highwayHealthy) {
    // Safety net only. WebSocket events do the realtime work; this low-frequency
    // sync catches missed events after laptop sleep or tunnel reconnect.
    state.pollTimer = setInterval(async () => {
      const result = await loadConversations({ silent: true });
      if (state.peer && result.activeChanged) {
        await loadMessages({ force: true, preserveScroll: true }).catch(() => {});
      }
    }, 180000);
  } else {
    // Offline fallback when WebSocket is blocked/disconnected.
    state.pollTimer = setInterval(async () => {
      const result = await loadConversations({ silent: true });
      if (state.peer && result.activeChanged) {
        await loadMessages({ force: true, preserveScroll: true }).catch(() => {});
      }
    }, state.lowPowerMode ? 45000 : 30000);
  }
}

// ---------------- Presence / activity ----------------
async function sendPresence(status = "online", peerId = state.peer?.id || null) {
  if (!state.token || !state.user) return;
  if (sendRealtime({ type: "presence", status, peer_id: peerId })) return;
  try {
    await api("/presence", { method: "POST", body: JSON.stringify({ status, peer_id: peerId }) });
  } catch (err) {
    if (err?.status === 401) {
      // Stale token or stale tab. Stop noisy unauthorized polling instead of
      // hammering the backend every visibility/heartbeat event.
      clearInterval(state.presenceTimer);
      clearInterval(state.peerPresenceTimer);
      state.presenceTimer = null;
      state.peerPresenceTimer = null;
      return;
    }
    throw err;
  }
}

function presenceLabel(status) {
  if (status === "typing") return "typing…";
  if (status === "recording") return "recording audio…";
  if (status === "online") return "online";
  if (status === "idle") return "idle";
  return "offline";
}

function renderPresence(status = "offline", lastSeen = null) {
  const el = $("presenceText");
  if (!el) return;
  let text = presenceLabel(status);
  if (status === "offline" && lastSeen) text = `offline · last seen ${fullDateTime(lastSeen)}`;
  el.textContent = text;
  el.className = `presence-line ${status}`;
}

async function refreshPeerPresence() {
  if (!state.peer || !state.token) return;
  try {
    const presence = await api(`/presence/${state.peer.id}`);
    renderPresence(presence.status, presence.last_seen_at);
  } catch (_) {
    renderPresence("offline");
  }
}

function startPresenceLoops() {
  clearInterval(state.presenceTimer);
  clearInterval(state.peerPresenceTimer);
  if (!state.token) return;
  connectRealtime();
  if (!document.hidden) sendPresence("online").catch(() => {});
  state.presenceTimer = setInterval(() => {
    if (state.token && state.user && !document.hidden) sendPresence("online").catch(() => {});
  }, state.lowPowerMode ? 120000 : 90000);
  state.peerPresenceTimer = setInterval(() => {
    if (!state.realtimeConnected && !document.hidden) refreshPeerPresence();
  }, state.lowPowerMode ? 60000 : 35000);
}

function scheduleTypingPresence() {
  if (!state.peer || !state.token || state.recording) return;
  sendPresence("typing", state.peer.id).catch(() => {});
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => sendPresence("online", state.peer?.id || null).catch(() => {}), 4500);
}

// ---------------- UI ----------------
function renderAuthState() {
  const loggedIn = Boolean(state.token && state.user);
  $("authPanel").classList.toggle("hidden", loggedIn);
  $("userPanel").classList.toggle("hidden", !loggedIn);
  updateComposerAvailability();

  if (loggedIn) {
    $("currentName").textContent = state.user.display_name || state.user.username;
    $("currentHandle").textContent = `@${state.user.username}`;
    setAvatarElement($("avatarBox"), state.user);
  }
}

function renderChatShell() {
  if (!state.peer) {
    document.body.classList.remove("mobile-chat-active");
    document.querySelector(".chat-peer")?.classList.remove("profile-clickable");
    $("chatTitle").textContent = "No chat selected";
    $("chatSubtitle").textContent = "Select a chat from the sidebar or find a user by username.";
    renderPresence("offline");
    setAvatarElement($("chatAvatar"), "E");
    updateComposerAvailability();
    renderConversationList();
    renderSecurityBanner();
    updateChatActionButtons();
    return;
  }
  document.querySelector(".chat-peer")?.classList.add("profile-clickable");
  $("chatTitle").textContent = state.peer.display_name || state.peer.username;
  $("chatTitle").title = "Open public profile";
  const sec = state.peerSecurity?.status === "verified" ? "Verified E2EE" : "E2EE text chat";
  $("chatSubtitle").textContent = `@${state.peer.username} · ${sec}`;
  renderSecurityBanner();
  renderPresence("offline");
  refreshPeerPresence().catch(() => {});
  setAvatarElement($("chatAvatar"), state.peer);
  updateComposerAvailability();
  renderConversationList();
  updateChatActionButtons();
}

function parseServerDate(value) {
  if (!value) return null;
  const raw = String(value);
  // FastAPI emits naive UTC timestamps for SQLite. Treat naive server values as
  // UTC so users in India/other zones see the real local day/time, not a shifted
  // browser-guess date.
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function conversationTime(value) {
  const d = parseServerDate(value);
  if (!d) return "";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startToday - startDate) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

function fullDateTime(value) {
  const d = parseServerDate(value);
  return d ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Not shared";
}

function shortDate(value) {
  const d = parseServerDate(value);
  return d ? d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "later";
}

function futureTimeLeft(value) {
  const d = parseServerDate(value);
  if (!d) return null;
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "now";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.ceil(min / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.ceil(hrs / 24)}d`;
}

function pruneExpiredLocalMessages({ render = false } = {}) {
  const now = Date.now();
  const before = state.activeMessages.length;
  state.activeMessages = state.activeMessages.filter((msg) => {
    const expiresAt = parseServerDate(msg.expires_at)?.getTime?.();
    return !expiresAt || expiresAt > now;
  });
  const changed = before !== state.activeMessages.length;
  if (changed) {
    const activeIds = new Set(state.activeMessages.map((msg) => Number(msg.id)));
    pruneDecryptionCaches(activeIds);
    state.activeMessageSignature = "";
    loadConversations({ silent: true, force: true }).catch(() => {});
    if (render) renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
  }
  return changed;
}

function scheduleNextExpiry() {
  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
  if (!state.activeMessages.length) return;
  const times = state.activeMessages
    .map((msg) => parseServerDate(msg.expires_at)?.getTime?.())
    .filter((time) => Number.isFinite(time));
  if (!times.length) return;
  const next = Math.min(...times);
  const delay = Math.max(250, Math.min(next - Date.now() + 120, 2147480000));
  state.expiryTimer = setTimeout(() => pruneExpiredLocalMessages({ render: true }), delay);
}

function renderConversationList(force = false) {
  const list = $("conversationList");
  if (!list) return;

  if (!state.token) {
    const signature = "logged-out";
    if (!force && state.conversationRenderSignature === signature) return;
    state.conversationRenderSignature = signature;
    list.innerHTML = `<p class="hint">Login to load chats.</p>`;
    return;
  }

  if (!state.conversations.length) {
    const signature = "empty";
    if (!force && state.conversationRenderSignature === signature) return;
    state.conversationRenderSignature = signature;
    list.innerHTML = `<p class="hint">No chats yet. Incoming chats will appear here automatically.</p>`;
    return;
  }

  const query = state.conversationSearch.trim().toLowerCase();
  let filteredConversations = query
    ? state.conversations.filter((conv) => {
        const user = conv.other_user;
        return `${user.display_name || ""} ${user.username || ""}`.toLowerCase().includes(query);
      })
    : [...state.conversations];

  filteredConversations = [...filteredConversations].sort((a, b) => {
    const ap = isPinned(a.other_user.id) ? 1 : 0;
    const bp = isPinned(b.other_user.id) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (parseServerDate(b.latest_message.created_at)?.getTime() || 0) - (parseServerDate(a.latest_message.created_at)?.getTime() || 0);
  });

  if (!filteredConversations.length) {
    const signature = `filtered-empty:${query}`;
    if (!force && state.conversationRenderSignature === signature) return;
    state.conversationRenderSignature = signature;
    list.innerHTML = `<p class="hint">No chats match this search.</p>`;
    return;
  }

  const activeId = state.peer?.id || 0;
  const signature = `${query}|` + filteredConversations
    .map((conv) => `${conv.other_user.id}:${conv.latest_message.id}:${conv.latest_message.created_at || ""}:${conv.unread_count || 0}:${activeId === conv.other_user.id ? 1 : 0}:${isPinned(conv.other_user.id) ? 1 : 0}:${isMuted(conv.other_user.id) ? 1 : 0}`)
    .join("|");
  if (!force && state.conversationRenderSignature === signature) return;
  state.conversationRenderSignature = signature;

  const fragment = document.createDocumentFragment();
  for (const conv of filteredConversations) {
    const user = conv.other_user;
    const msg = conv.latest_message;
    const isActive = activeId === user.id;
    const mine = msg.sender_id === state.user.id;
    const unread = conv.unread_count || 0;

    const item = document.createElement("button");
    item.type = "button";
    item.className = `conversation-item ${isActive ? "active" : ""}`;
    item.dataset.userId = String(user.id);

    const avatar = document.createElement("div");
    avatar.className = "conversation-avatar";
    setAvatarElement(avatar, user);

    const main = document.createElement("div");
    main.className = "conversation-main";
    const name = document.createElement("div");
    name.className = "conversation-name";
    name.textContent = `${isPinned(user.id) ? "📌 " : ""}${isMuted(user.id) ? "🔕 " : ""}${user.display_name || user.username}`;
    const preview = document.createElement("div");
    preview.className = "conversation-preview";
    const status = mine ? (msg.read_at ? "Read" : msg.delivered_at ? "Delivered" : "Sent") : "Encrypted";
    preview.textContent = `${mine ? "You: " : ""}${status} message`;
    main.append(name, preview);

    const meta = document.createElement("div");
    meta.className = "conversation-meta";
    const time = document.createElement("span");
    time.textContent = conversationTime(msg.created_at);
    time.title = fullDateTime(msg.created_at);
    meta.appendChild(time);
    if (unread > 0 && !isActive) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      meta.appendChild(badge);
    }

    item.append(avatar, main, meta);
    fragment.appendChild(item);
  }

  list.replaceChildren(fragment);
}

function messagesSignature(messages) {
  return messages.map((msg) => {
    const reactions = Array.isArray(msg.reactions) ? msg.reactions.map((r) => `${r.user_id}:${r.emoji}`).join(",") : "";
    return `${msg.id}:${msg.client_message_id || ""}:${msg.local_status || ""}:${msg.read_at || ""}:${msg.delivered_at || ""}:${msg.edited_at || ""}:${msg.expires_at || ""}:${msg.reply_to_id || ""}:${reactions}:${msg.key_session_id || "legacy"}`;
  }).join("|");
}

function messageSortValue(msg) {
  if (Number.isFinite(Number(msg.id)) && Number(msg.id) > 1_000_000_000_000) return Number(msg.id);
  const created = parseServerDate(msg.created_at)?.getTime?.();
  if (Number.isFinite(created)) return created * 1000 + Math.min(999, Number(msg.id) || 0);
  return Number(msg.id) || Date.now() * 1000;
}

function sortActiveMessages() {
  state.activeMessages.sort((a, b) => messageSortValue(a) - messageSortValue(b));
  state.oldestMessageId = state.activeMessages.length ? state.activeMessages.find((msg) => Number(msg.id) < 1_000_000_000_000)?.id || state.activeMessages[0].id : null;
}

function mergeMessages(messages) {
  const byId = new Map(state.activeMessages.map((msg) => [msg.id, msg]));
  const byClientId = new Map(state.activeMessages.filter((msg) => msg.client_message_id).map((msg) => [msg.client_message_id, msg]));
  for (const msg of messages) {
    const local = msg.client_message_id ? byClientId.get(msg.client_message_id) : null;
    if (local && local.id !== msg.id) {
      const plain = state.decryptedTextByMessageId.get(local.id);
      byId.delete(local.id);
      state.decryptedMessageSignatures.delete(local.id);
      state.parsedPayloadByMessageId.delete(local.id);
      if (plain && !state.decryptedTextByMessageId.has(msg.id)) state.decryptedTextByMessageId.set(msg.id, plain);
    }
    byId.set(msg.id, msg);
  }
  state.activeMessages = [...byId.values()];
  sortActiveMessages();
}

function upsertActiveMessage(msg, { render = true, preserveScroll = false } = {}) {
  mergeMessages([msg]);
  if (render) renderLoadedMessages({ force: true, preserveScroll }).catch(() => {});
}

function createOptimisticTextMessage(text, clientMessageId, replyToId = null) {
  const id = Date.now() * 1000 + (++state.localMessageCounter % 1000);
  const nowIso = new Date().toISOString();
  const msg = {
    id,
    sender_id: state.user.id,
    receiver_id: state.peer.id,
    message_type: "text",
    client_message_id: clientMessageId,
    ciphertext: "",
    iv: "",
    encrypted_key_for_receiver: null,
    encrypted_key_for_sender: null,
    key_session_id: null,
    blob_id: null,
    blob_url: null,
    session_encrypted_key_for_receiver: null,
    session_encrypted_key_for_sender: null,
    created_at: nowIso,
    expires_at: null,
    edited_at: null,
    reply_to_id: replyToId,
    reactions: [],
    delivered_at: null,
    read_at: null,
    local_plaintext: text,
    local_status: "sending",
  };
  state.decryptedTextByMessageId.set(id, text);
  state.decryptedMessageSignatures.set(id, messageDecryptSignature(msg));
  state.activePeerLatestMessageId = id;
  upsertActiveMessage(msg, { render: true, preserveScroll: true });
  updateLocalConversationFromMessage(msg, { render: true });
  scrollMessagesToBottom();
  return msg;
}

function patchOptimisticMessage(clientMessageId, patch = {}) {
  const idx = state.activeMessages.findIndex((msg) => msg.client_message_id === clientMessageId);
  if (idx < 0) return null;
  state.activeMessages[idx] = { ...state.activeMessages[idx], ...patch };
  state.activeMessageSignature = "";
  return state.activeMessages[idx];
}

function patchOptimisticBubbleDom(clientMessageId, saved) {
  const list = $("messageList");
  if (!list || !clientMessageId || !saved) return false;
  const bubble = list.querySelector(`.bubble[data-client-message-id="${CSS.escape(String(clientMessageId))}"]`);
  if (!bubble) return false;
  bubble.dataset.messageId = String(saved.id);
  bubble.dataset.clientMessageId = String(clientMessageId);
  const meta = bubble.querySelector(".meta");
  if (meta) {
    const left = futureTimeLeft(saved.expires_at);
    const vanish = saved.expires_at ? ` · disappears ${left ? `in ${left}` : shortDate(saved.expires_at)}` : "";
    meta.className = `meta ${deliveryStateClass(saved)}`;
    meta.textContent = `${fullDateTime(saved.created_at)}${saved.edited_at ? " · edited" : ""}${vanish} · ${deliveryStateLabel(saved)}`;
  }
  return true;
}

function updateLocalConversationFromMessage(msg, { render = true } = {}) {
  if (!state.peer || !msg) return;
  const peer = Number(msg.sender_id) === Number(state.user?.id) ? state.peer : (state.conversations.find((c) => Number(c.other_user?.id) === Number(msg.sender_id))?.other_user || state.peer);
  const peerId = Number(peer.id);
  const idx = state.conversations.findIndex((conv) => Number(conv.other_user?.id) === peerId);
  const latest = { ...msg };
  if (idx >= 0) {
    state.conversations[idx] = { ...state.conversations[idx], other_user: peer, latest_message: latest };
  } else {
    state.conversations.unshift({ other_user: peer, latest_message: latest, unread_count: 0 });
  }
  state.conversations.sort((a, b) => messageSortValue(b.latest_message) - messageSortValue(a.latest_message));
  state.conversationLatestIds.set(peerId, latest.id);
  if (state.peer && Number(state.peer.id) === peerId) state.activePeerLatestMessageId = latest.id;
  if (render) renderConversationList();
}

function scheduleConversationRefresh(delay = 2500) {
  const now = Date.now();
  if (now < state.suppressConversationSyncUntil) return;
  clearTimeout(state.conversationRefreshTimer);
  const minDelay = state.lowPowerMode ? 18000 : 9000;
  state.conversationRefreshTimer = setTimeout(() => {
    if (state.token && !document.hidden && Date.now() >= state.suppressConversationSyncUntil) {
      loadConversations({ silent: true }).catch(() => {});
    }
  }, Math.max(delay, minDelay));
}

function latestConfirmedActiveMessageId() {
  let latest = Number(state.activePeerLatestMessageId || 0);
  for (const msg of state.activeMessages || []) {
    if (msg.local_status === "sending" || msg.local_status === "queued" || msg.local_status === "failed") continue;
    const id = Number(msg.id || 0);
    // Optimistic IDs are Date.now()*1000 scale; DB row IDs are normal ints.
    // Do not let a temporary optimistic ID block incoming sync-after checks.
    if (Number.isFinite(id) && id > 0 && id < 1_000_000_000_000) latest = Math.max(latest, id);
  }
  return latest;
}

async function syncActiveMessagesSinceLatest({ force = false } = {}) {
  if (!state.token || !state.user || !state.peer) return false;
  if (document.hidden && !force) return false;
  if (state.activeMessageSyncInFlight) return false;
  const now = Date.now();
  const minGap = state.lowPowerMode ? 6500 : 3500;
  if (!force && now - state.lastActiveMessageSyncAt < minGap) return false;
  const afterId = latestConfirmedActiveMessageId();
  if (!afterId) return false;
  state.activeMessageSyncInFlight = true;
  state.lastActiveMessageSyncAt = now;
  try {
    const incoming = await api(`/messages/${state.peer.id}/after/${afterId}?limit=60`);
    if (!Array.isArray(incoming) || incoming.length === 0) return false;
    const wasNearBottom = messageListIsNearBottom();
    mergeMessages(incoming);
    pruneExpiredLocalMessages({ render: false });
    const latest = incoming[incoming.length - 1];
    if (latest?.id) state.activePeerLatestMessageId = Math.max(Number(state.activePeerLatestMessageId || 0), Number(latest.id));
    for (const msg of incoming) updateLocalConversationFromMessage(msg, { render: false });
    await renderLoadedMessages({ force: true, preserveScroll: !wasNearBottom });
    if (wasNearBottom) scrollMessagesToBottom();
    renderConversationList();
    return true;
  } catch (err) {
    if (err?.status === 401) {
      clearSession(false, { notifyServer: false });
      renderAuthState();
    }
    return false;
  } finally {
    state.activeMessageSyncInFlight = false;
  }
}

function startActiveMessageSyncLoop() {
  clearInterval(state.activeMessageSyncTimer);
  state.activeMessageSyncTimer = null;
  if (!state.token || !state.user || !state.peer) return;
  const interval = state.lowPowerMode ? 7000 : 4500;
  state.activeMessageSyncTimer = setInterval(() => {
    syncActiveMessagesSinceLatest().catch(() => null);
  }, interval);
}

function stopActiveMessageSyncLoop() {
  clearInterval(state.activeMessageSyncTimer);
  state.activeMessageSyncTimer = null;
  state.activeMessageSyncInFlight = false;
}

async function renderLoadedMessages({ preserveScroll = true, force = false } = {}) {
  const list = $("messageList");
  if (!list) return false;
  pruneExpiredLocalMessages({ render: false });
  const renderSeq = ++state.messageRenderSeq;
  const wasNearBottom = messageListIsNearBottom(list);
  const oldScrollTop = list.scrollTop;
  const oldScrollHeight = list.scrollHeight;
  const scrollAnchor = preserveScroll && !wasNearBottom ? captureMessageScrollAnchor(list) : null;
  const securityNotice = currentSecuritySystemNotice();
  const signature = `${messagesSignature(state.activeMessages)}|q=${state.messageSearch}|u=${state.messagesUnlocked ? 1 : 0}|sec=${securityNotice?.id || "none"}`;
  if (!force && signature === state.activeMessageSignature) return false;
  state.activeMessageSignature = signature;

  if (!state.activeMessages.length) {
    list.className = "messages empty";
    list.innerHTML = `<div class="empty-state"><h3>No messages yet</h3><p>Send the first encrypted message.</p></div>`;
    scheduleNextExpiry();
    return true;
  }

  list.className = "messages";
  const activeIds = new Set(state.activeMessages.map((msg) => Number(msg.id)));
  pruneDecryptionCaches(activeIds);
  const fragment = document.createDocumentFragment();

  if (state.hasMoreMessages) {
    const older = document.createElement("button");
    older.id = "loadOlderMessagesBtn";
    older.type = "button";
    older.className = "load-older-btn";
    older.textContent = state.loadingOlderMessages ? "Loading older messages..." : "Load older messages";
    fragment.appendChild(older);
  }

  appendSecuritySystemNotice(fragment);

  let visibleCount = 0;
  let renderedLoopIndex = 0;
  for (const msg of state.activeMessages) {
    const mine = msg.sender_id === state.user.id;
    let plaintext = state.messagesUnlocked ? "[encrypted message — matching key unavailable]" : "[locked encrypted message — unlock messages to read]";
    let failed = false;
    try {
      plaintext = await decryptMessageText(msg);
    } catch (_) {
      failed = true;
    }

    let parsedPayload = null;
    if (!failed && msg.message_type !== "text") {
      const sig = state.decryptedMessageSignatures.get(msg.id) || messageDecryptSignature(msg);
      const cachedPayload = state.parsedPayloadByMessageId.get(msg.id);
      if (cachedPayload && cachedPayload.sig === sig) {
        parsedPayload = cachedPayload.value;
      } else {
        try { parsedPayload = JSON.parse(plaintext); } catch (_) { parsedPayload = null; }
        state.parsedPayloadByMessageId.set(msg.id, { sig, value: parsedPayload });
      }
    }
    const searchText = parsedPayload ? `${parsedPayload.label || parsedPayload.name || ""} ${parsedPayload.type || parsedPayload.kind || ""}` : plaintext;
    if (!failed) indexDecryptedMessage(msg, plaintext, parsedPayload);
    if (!isMessageVisibleInSearch(msg, searchText)) continue;
    visibleCount += 1;
    renderedLoopIndex += 1;
    if (renderedLoopIndex % state.renderYieldEvery === 0 || Date.now() - state.lastPaintYieldAt > 48) await nextRenderSlice();

    const bubble = document.createElement("article");
    bubble.className = `bubble ${mine ? "me" : "them"} ${failed ? "locked-bubble" : ""}`;
    bubble.dataset.messageId = String(msg.id);
    if (msg.client_message_id) bubble.dataset.clientMessageId = String(msg.client_message_id);
    let senderLink = null;
    if (!mine && state.peer) {
      senderLink = document.createElement("button");
      senderLink.type = "button";
      senderLink.className = "sender-profile-link";
      senderLink.dataset.userId = String(state.peer.id);
      senderLink.textContent = state.peer.display_name || `@${state.peer.username}`;
      senderLink.title = "Open sender profile";
    }
    const body = document.createElement("div");
    body.className = "bubble-body";

    if (msg.reply_to_id) {
      const reply = document.createElement("button");
      reply.type = "button";
      reply.className = "reply-preview";
      reply.dataset.messageId = String(msg.reply_to_id);
      reply.textContent = `↪ ${getReplyPreview(msg.reply_to_id).slice(0, 90)}`;
      body.appendChild(reply);
    }

    if (failed || msg.message_type === "text" || !parsedPayload) {
      if (!failed && msg.message_type === "text" && isSingleEmojiText(plaintext)) {
        const big = document.createElement("span");
        big.className = "big-emoji-message";
        big.textContent = plaintext.trim();
        body.appendChild(big);
      } else {
        appendHighlightedText(body, plaintext, state.messageSearch);
      }
    } else if (msg.message_type === "image") {
      if (parsedPayload.blobId) {
        body.appendChild(renderEncryptedBlobCard(parsedPayload, msg, "image"));
      } else {
        const img = document.createElement("img");
        img.className = "message-image";
        img.loading = "lazy";
        img.decoding = "async";
        img.src = parsedPayload.dataUrl;
        img.alt = parsedPayload.name || "encrypted image";
        const caption = document.createElement("div");
        caption.className = "attachment-caption";
        caption.textContent = `${parsedPayload.name || "Image"} · ${formatBytes(parsedPayload.size || 0)}`;
        body.append(img, caption);
      }
    } else if (msg.message_type === "video") {
      if (parsedPayload.blobId) {
        body.appendChild(renderEncryptedBlobCard(parsedPayload, msg, "video"));
      } else {
        const video = document.createElement("video");
        video.className = "message-video";
        video.preload = "metadata";
        video.src = parsedPayload.dataUrl;
        video.controls = true;
        const caption = document.createElement("div");
        caption.className = "attachment-caption";
        caption.textContent = `${parsedPayload.name || "Video"} · ${formatBytes(parsedPayload.size || 0)}`;
        body.append(video, caption);
      }
    } else if (msg.message_type === "voice") {
      if (parsedPayload.blobId) {
        body.appendChild(renderEncryptedBlobCard(parsedPayload, msg, "voice"));
      } else {
        const voice = renderVoiceNote(parsedPayload, msg);
        const caption = document.createElement("div");
        caption.className = "attachment-caption";
        caption.textContent = `${parsedPayload.name || "Voice note"} · ${formatBytes(parsedPayload.size || 0)}`;
        body.append(voice, caption);
      }
    } else if (msg.message_type === "sticker") {
      const sticker = document.createElement("div");
      sticker.className = "message-sticker";
      if (parsedPayload.dataUrl) {
        sticker.appendChild(createPackMediaElement(parsedPayload.dataUrl, "message-sticker-media", parsedPayload.label || "Imported sticker"));
      } else {
        sticker.innerHTML = animatedEmojiMarkup(parsedPayload.emoji || "✨", parsedPayload.label || "Animated emoji");
      }
      sticker.title = parsedPayload.label || "Animated emoji";
      body.appendChild(sticker);
    } else if (msg.message_type === "gif") {
      const img = createPackMediaElement(parsedPayload.dataUrl, "message-gif", parsedPayload.label || "encrypted GIF sticker");
      const caption = document.createElement("div");
      caption.className = "attachment-caption";
      caption.textContent = parsedPayload.label || "Animated GIF";
      body.append(img, caption);
    } else {
      const card = document.createElement("div");
      card.className = "file-card";
      const name = document.createElement("strong");
      name.textContent = parsedPayload.name || "Encrypted file";
      const meta = document.createElement("span");
      meta.textContent = `${parsedPayload.type || "file"} · ${formatBytes(parsedPayload.size || 0)}`;
      const link = document.createElement("a");
      if (parsedPayload.blobId) {
        body.appendChild(renderEncryptedBlobCard(parsedPayload, msg, "file"));
      } else {
        link.href = parsedPayload.dataUrl;
        link.download = parsedPayload.name || "chate-file";
        link.textContent = "Download";
        card.append(name, meta, link);
        body.appendChild(card);
      }
    }

    const meta = document.createElement("div");
    meta.className = failed ? "meta failed" : `meta ${mine ? deliveryStateClass(msg) : ""}`.trim();
    const left = futureTimeLeft(msg.expires_at);
    const vanish = msg.expires_at ? ` · disappears ${left ? `in ${left}` : shortDate(msg.expires_at)}` : "";
    const status = mine ? ` · ${deliveryStateLabel(msg)}` : "";
    meta.textContent = failed ? (state.messagesUnlocked ? "Encrypted · key unavailable" : "Encrypted · locked") : `${fullDateTime(msg.created_at)}${msg.edited_at ? " · edited" : ""}${vanish}${status}`;

    if (Array.isArray(msg.reactions) && msg.reactions.length) {
      const reactions = document.createElement("div");
      reactions.className = "reaction-row";
      const grouped = new Map();
      for (const reaction of msg.reactions) {
        const entry = grouped.get(reaction.emoji) || { count: 0, mine: false };
        entry.count += 1;
        if (reaction.user_id === state.user.id) entry.mine = true;
        grouped.set(reaction.emoji, entry);
      }
      for (const [emoji, entry] of grouped) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `reaction-chip ${entry.mine ? "mine" : ""}`;
        chip.dataset.messageId = String(msg.id);
        chip.dataset.emoji = emoji;
        chip.textContent = `${emoji} ${entry.count}`;
        reactions.appendChild(chip);
      }
      body.appendChild(reactions);
    }

    const actions = document.createElement("div");
    actions.className = "bubble-actions";
    if (!failed) {
      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      replyBtn.className = "reply-message-btn";
      replyBtn.dataset.messageId = String(msg.id);
      replyBtn.textContent = "Reply";
      actions.appendChild(replyBtn);

      const reactBtn = document.createElement("button");
      reactBtn.type = "button";
      reactBtn.className = "react-message-btn";
      reactBtn.dataset.messageId = String(msg.id);
      reactBtn.textContent = "React";
      actions.appendChild(reactBtn);

      if (msg.message_type === "text") {
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "copy-message-btn";
        copyBtn.dataset.messageId = String(msg.id);
        copyBtn.textContent = "Copy";
        actions.appendChild(copyBtn);

        const forwardBtn = document.createElement("button");
        forwardBtn.type = "button";
        forwardBtn.className = "forward-message-btn";
        forwardBtn.dataset.messageId = String(msg.id);
        forwardBtn.textContent = "Forward";
        actions.appendChild(forwardBtn);

        if (mine) {
          const editBtn = document.createElement("button");
          editBtn.type = "button";
          editBtn.className = "edit-message-btn";
          editBtn.dataset.messageId = String(msg.id);
          editBtn.textContent = "Edit";
          actions.appendChild(editBtn);
        }
      }
    }
    if (shouldShowRetryAction(msg)) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "retry-message-btn";
      retryBtn.dataset.messageId = String(msg.id);
      retryBtn.textContent = "Retry";
      actions.appendChild(retryBtn);
    }
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete-message-btn";
    deleteBtn.dataset.messageId = String(msg.id);
    deleteBtn.textContent = "Delete";
    actions.appendChild(deleteBtn);
    if (senderLink) bubble.append(senderLink, body, meta, actions);
    else bubble.append(body, meta, actions);
    fragment.appendChild(bubble);
  }

  if (visibleCount === 0 && state.messageSearch.trim()) {
    const empty = document.createElement("div");
    empty.className = "empty-state inline-empty";
    empty.innerHTML = `<h3>No loaded messages match</h3><p>Load older messages if the match may be further back.</p>`;
    fragment.appendChild(empty);
  }

  if (renderSeq !== state.messageRenderSeq) return false;
  list.replaceChildren(fragment);
  scheduleNextExpiry();

  if (!preserveScroll || wasNearBottom) {
    scrollMessagesToBottom(list);
  } else if (!restoreMessageScrollAnchor(scrollAnchor, list)) {
    markProgrammaticMessageScroll(900);
    list.scrollTop = Math.max(0, oldScrollTop + (list.scrollHeight - oldScrollHeight));
  }
  return true;
}

async function loadMessages({ force = false, preserveScroll = true, older = false } = {}) {
  if (!state.peer || !state.user || state.loadingMessages) return false;
  state.loadingMessages = true;
  try {
    const pageLimit = state.lowPowerMode ? 28 : 40;
    const params = new URLSearchParams({ limit: String(pageLimit) });
    if (older && state.oldestMessageId) params.set("before_id", String(state.oldestMessageId));
    const messages = await api(`/messages/${state.peer.id}?${params.toString()}`);

    if (older) {
      if (!messages.length) state.hasMoreMessages = false;
      mergeMessages(messages);
    } else {
      // Initial/latest fetch: merge instead of wiping already fetched older pages.
      if (!state.activeMessages.length) {
        state.hasMoreMessages = messages.length === pageLimit;
      }
      mergeMessages(messages);
    }
    pruneExpiredLocalMessages({ render: false });

    if (messages.length && !older) {
      const latestRealId = Math.max(...messages.map((msg) => Number(msg.id || 0)).filter((id) => Number.isFinite(id)));
      if (latestRealId > 0) state.activePeerLatestMessageId = latestRealId;
    }
    await renderLoadedMessages({ preserveScroll, force: force || older });
    return messages.length > 0;
  } finally {
    state.loadingMessages = false;
  }
}

async function loadOlderMessages() {
  if (!state.peer || !state.hasMoreMessages || state.loadingOlderMessages) return;
  state.loadingOlderMessages = true;
  try {
    await loadMessages({ force: true, preserveScroll: true, older: true });
  } finally {
    state.loadingOlderMessages = false;
  }
}

async function selectPeer(peer) {
  if (!peer || !state.user) return;
  if (peer.id === state.user.id) throw new Error("You cannot chat with yourself in this MVP.");
  peer = await hydratePeerPublicKey(peer);
  state.peer = peer;
  state.activeMessageSignature = "";
  state.activePeerLatestMessageId = null;
  state.activeMessages = [];
  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
  state.oldestMessageId = null;
  state.hasMoreMessages = true;
  await evaluatePeerSecurity(peer);
  renderChatShell();
  document.body.classList.add("mobile-chat-active");
  const input = $("messageInput");
  if (input) {
    input.value = loadDraft(peer.id);
    autoGrowComposer();
  }
  await loadMessages({ force: true, preserveScroll: false });
  prewarmTemporaryMessageSession(peer);
  startPolling();
  startActiveMessageSyncLoop();
  startPresenceLoops();
}


async function loadConversations({ silent = false, force = false } = {}) {
  if (!state.token || !state.user) {
    state.conversations = [];
    state.conversationLoadPromise = null;
    renderConversationList();
    return { changed: false, activeChanged: false };
  }

  const now = Date.now();
  const minGap = state.lowPowerMode ? 6000 : 3500;
  if (!force && now < state.suppressConversationSyncUntil) return { changed: false, activeChanged: false };
  if (!force && state.conversationLoadPromise) return state.conversationLoadPromise;
  if (!force && state.conversationLastLoadAt && now - state.conversationLastLoadAt < minGap) {
    return { changed: false, activeChanged: false };
  }

  state.conversationLoadPromise = (async () => {
    try {
      state.conversationLastLoadAt = Date.now();
      const conversations = await api("/conversations");
      const previousLatest = new Map(state.conversationLatestIds);
      let activeChanged = false;

      for (const conv of conversations) {
        const peerId = conv.other_user.id;
        const latestId = conv.latest_message.id;
        const previousId = previousLatest.get(peerId);
        if (state.initialConversationLoadDone && previousId && previousId !== latestId && conv.latest_message.sender_id !== state.user.id && !state.notifiedMessageIds.has(latestId) && !isMuted(peerId)) {
          state.notifiedMessageIds.add(latestId);
          if (state.peer?.id === peerId) {
            activeChanged = true;
            if (document.hidden) notifyIncomingMessage(conv.other_user).catch(() => {});
          } else {
            toast(`New encrypted message from @${conv.other_user.username}`);
            notifyIncomingMessage(conv.other_user).catch(() => {});
          }
        }
        state.conversationLatestIds.set(peerId, latestId);
      }

      const currentActive = state.peer ? conversations.find((conv) => Number(conv.other_user.id) === Number(state.peer.id)) : null;
      if (currentActive) {
        const latest = currentActive.latest_message || {};
        const latestId = latest.id;
        const latestClientId = latest.client_message_id || null;
        const alreadyMerged = state.activeMessages.some((msg) =>
          Number(msg.id) === Number(latestId) || (latestClientId && msg.client_message_id === latestClientId)
        );
        const ownLatest = Number(latest.sender_id) === Number(state.user?.id);
        if (latestId !== state.activePeerLatestMessageId) {
          // Do not reload the open chat for our own freshly-sent message. The
          // POST response/WebSocket path already merged it locally; reloading here
          // caused WhatsApp-breaking scroll jumps and duplicate work.
          activeChanged = Boolean(state.activePeerLatestMessageId !== null && !alreadyMerged && !ownLatest);
          state.activePeerLatestMessageId = latestId;
        }
      }

      const oldSignature = state.conversations.map((conv) => `${conv.other_user.id}:${conv.latest_message.id}:${conv.unread_count || 0}`).join("|");
      const newSignature = conversations.map((conv) => `${conv.other_user.id}:${conv.latest_message.id}:${conv.unread_count || 0}`).join("|");
      const changed = oldSignature !== newSignature;

      state.conversations = conversations;
      state.initialConversationLoadDone = true;
      if (changed || !silent) renderConversationList();
      return { changed, activeChanged };
    } catch (err) {
      if (err?.status === 401) {
        clearSession(false, { notifyServer: false });
        renderAuthState();
      } else if (!silent) {
        toast(err.message, 5200);
      }
      return { changed: false, activeChanged: false };
    } finally {
      state.conversationLoadPromise = null;
    }
  })();
  return state.conversationLoadPromise;
}


function profileDisplayValue(value, fallback = "Not shared") {
  const text = typeof value === "string" ? value.trim() : value;
  return text || fallback;
}

function addProfileField(container, label, value) {
  if (!container || value === null || value === undefined || value === "") return;
  const row = document.createElement("div");
  row.className = "profile-field-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value;
  row.append(key, val);
  container.appendChild(row);
}

async function getCachedPublicProfile(userId) {
  const id = Number(userId);
  const cached = state.profileCache.get(id);
  if (cached && Date.now() - cached.ts < 5 * 60_000) return cached.user;
  if (state.profilePromiseCache.has(id)) return state.profilePromiseCache.get(id);
  const promise = api(`/users/${id}/profile`).then(async (user) => {
    if (!isValidPublicKeyJwk(user.public_key_jwk)) {
      try {
        const keyInfo = await api(`/users/${id}/public-key`, { timeoutMs: 12000 });
        if (isValidPublicKeyJwk(keyInfo?.public_key_jwk)) user = { ...user, public_key_jwk: keyInfo.public_key_jwk };
      } catch (_) {}
    }
    state.profileCache.set(id, { ts: Date.now(), user });
    return user;
  }).finally(() => state.profilePromiseCache.delete(id));
  state.profilePromiseCache.set(id, promise);
  return promise;
}

async function showPublicProfile(userId = state.peer?.id) {
  if (!userId) return toast("Select a chat first.");
  try {
    const user = await getCachedPublicProfile(userId);
    const modal = $("publicProfileModal");
    const fields = $("publicProfileFields");
    if (!modal || !fields) return;
    setAvatarElement($("publicProfileAvatar"), user);
    const displayName = user.display_name || user.username;
    $("publicProfileName").textContent = displayName;
    $("publicProfileHandle").textContent = `@${user.username}`;
    fields.replaceChildren();
    addProfileField(fields, "Name", user.display_name);
    addProfileField(fields, "Username", `@${user.username}`);
    addProfileField(fields, "Email", user.email);
    addProfileField(fields, "Bio", user.bio);
    addProfileField(fields, "Last seen", user.last_seen_at ? fullDateTime(user.last_seen_at) : null);
    addProfileField(fields, "Joined", user.created_at ? fullDateTime(user.created_at) : null);
    if (!fields.children.length) addProfileField(fields, "Profile", "No optional public fields shared.");
    modal.classList.remove("hidden");
  } catch (err) {
    toast(err.message || "Could not load profile.", 5200);
  }
}

function closePublicProfile() {
  $("publicProfileModal")?.classList.add("hidden");
}

function startPolling() {
  // Kept as a compatibility wrapper. v19 uses the WebSocket highway first.
  connectRealtime();
  startFallbackPolling(state.realtimeConnected);
}


function keyExportReminderDoneKey(userId = state.user?.id) {
  return userId ? `chate_key_export_reminder_done:${userId}` : null;
}

function keyExportReminderLaterKey(userId = state.user?.id) {
  return userId ? `chate_key_export_reminder_later:${userId}` : null;
}

function dismissKeyExportReminder(done = false) {
  const modal = $("keyExportReminder");
  modal?.classList.add("hidden");
  if (done) {
    const doneKey = keyExportReminderDoneKey();
    if (doneKey) localStorage.setItem(doneKey, "1");
    const laterKey = keyExportReminderLaterKey();
    if (laterKey) localStorage.removeItem(laterKey);
  }
}

function remindKeyExportLater() {
  const laterKey = keyExportReminderLaterKey();
  if (laterKey) localStorage.setItem(laterKey, String(Date.now() + 24 * 60 * 60 * 1000));
  dismissKeyExportReminder(false);
}

async function maybeShowKeyExportReminder() {
  if (!state.user?.id || !state.token) return;
  const doneKey = keyExportReminderDoneKey();
  if (doneKey && localStorage.getItem(doneKey) === "1") return;
  const laterKey = keyExportReminderLaterKey();
  const laterUntil = Number(localStorage.getItem(laterKey) || "0");
  if (laterUntil && Date.now() < laterUntil) return;
  const pkg = await loadEncryptedKeyPackage().catch(() => null);
  if (!pkg) return;
  $("keyExportReminder")?.classList.remove("hidden");
}

function getOrCreateBrowserDeviceId() {
  const userPart = state.user?.id || "prelogin";
  const key = `chate_browser_device_id:${userPart}`;
  let id = localStorage.getItem(key);
  if (!id) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(key, id);
  }
  return id;
}

function currentBrowserDeviceName() {
  const ua = navigator.userAgent || "";
  const mobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  const browser = /Firefox/i.test(ua) ? "Firefox" : /Edg\//i.test(ua) ? "Edge" : /Chrome|Chromium/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : "Browser";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iOS" : /Linux/i.test(ua) ? "Linux" : /Windows/i.test(ua) ? "Windows" : /Mac/i.test(ua) ? "macOS" : "device";
  return `${mobile ? "Phone" : "Desktop"} · ${browser} on ${os}`;
}

async function ensureAutomaticDeviceTrust(loginPassword = "", keyPassphrase = "") {
  const pkg = await loadEncryptedKeyPackage().catch(() => null);
  const publicKeyJwk = isValidPublicKeyJwk(pkg?.publicKeyJwk) ? pkg.publicKeyJwk : (isValidPublicKeyJwk(state.user?.public_key_jwk) ? state.user.public_key_jwk : null);
  const out = await api("/devices/ensure", {
    method: "POST",
    body: JSON.stringify({
      device_id: getOrCreateBrowserDeviceId(),
      name: currentBrowserDeviceName(),
      public_key_jwk: publicKeyJwk,
    }),
  });
  if (!out?.requires_approval) return out;
  state.pendingDeviceLinkId = out.link_session_id;
  state.pendingDeviceLoginPassword = loginPassword || "";
  state.pendingKeyPassphrase = keyPassphrase || "";
  showDeviceWaitingModal(out.detail || "Waiting for approval from a trusted device.");
  startPendingDevicePolling();
  return out;
}

function showDeviceWaitingModal(message = "Waiting for approval from a trusted device.") {
  const modal = $("deviceWaitingModal");
  const text = $("deviceWaitingText");
  const status = $("deviceWaitingStatus");
  if (text) text.textContent = message;
  if (status) status.textContent = "Waiting for accept/reject…";
  modal?.classList.remove("hidden");
}

function hideDeviceWaitingModal() {
  $("deviceWaitingModal")?.classList.add("hidden");
}

function stopPendingDevicePolling() {
  clearInterval(state.pendingDevicePollTimer);
  state.pendingDevicePollTimer = null;
}

function startPendingDevicePolling() {
  stopPendingDevicePolling();
  if (!document.hidden) pollPendingDeviceApproval().catch(() => null);
  state.pendingDevicePollTimer = setInterval(() => {
    if (state.token && !document.hidden) pollPendingDeviceApproval().catch(() => null);
  }, state.lowPowerMode ? 20000 : 12000);
}

async function pollPendingDeviceApproval() {
  const id = state.pendingDeviceLinkId || localStorage.getItem(`chate_pending_device_link:${state.user?.id}`);
  if (!id || !state.token) return;
  state.pendingDeviceLinkId = id;
  const row = await api(`/devices/link/${encodeURIComponent(id)}/status`);
  const statusEl = $("deviceWaitingStatus");
  if (statusEl) {
    if (row.status === "pending") statusEl.textContent = "Waiting for trusted-device approval…";
    else if (row.status === "email_sent") statusEl.textContent = "Email sent. Confirm from inbox…";
    else if (row.status === "approved") statusEl.textContent = "Approved by trusted device. Finishing login…";
    else if (row.status === "email_approved") statusEl.textContent = "Email confirmed. Finishing login…";
    else if (row.status === "rejected") statusEl.textContent = "Rejected by trusted device.";
  }
  if (row.status === "approved" || row.status === "email_approved") {
    await completePendingDeviceApproval(id, row.status);
  } else if (row.status === "rejected") {
    stopPendingDevicePolling();
    toast("This device login was rejected.", 7000);
    clearSession(true);
    renderAuthState();
    hideDeviceWaitingModal();
  }
}

async function completePendingDeviceApproval(sessionId, status) {
  stopPendingDevicePolling();
  const out = await api(`/devices/link/${encodeURIComponent(sessionId)}/complete`, { method: "POST", body: JSON.stringify({}) });
  localStorage.removeItem(`chate_pending_device_link:${state.user?.id}`);
  hideDeviceWaitingModal();

  if (out.encrypted_key_package_json) {
    const pkg = JSON.parse(out.encrypted_key_package_json);
    await saveEncryptedKeyPackage(pkg, false);
    const passphrase = state.pendingKeyPassphrase || prompt("Trusted device approved. Enter your key-package passphrase to unlock old chats now, or leave blank to unlock later:");
    if (passphrase) {
      await addUnlockedKey(pkg, passphrase, true);
      await updateMyPublicKey(pkg.publicKeyJwk);
      markMessagesUnlockedThisLogin();
      toast("Device approved and old chat key unlocked.", 6500);
    } else {
      toast("Device approved. Import/unlock the key package later to read old chats.", 6500);
    }
  } else if (status === "email_approved" || out.status === "email_approved") {
    const localPkg = await loadEncryptedKeyPackage().catch(() => null);
    if (!localPkg && state.pendingDeviceLoginPassword) {
      await createReplacementEncryptionIdentity(state.pendingDeviceLoginPassword, "this email-confirmed device", false);
      clearMessagesUnlockedThisLogin();
      lockPrivateKey(false);
    }
    toast("Email confirmed this device. Old chats still need security.json/key passphrase or trusted-device approval.", 8000);
  }

  await continueTrustedLogin({ deletion_was_cancelled: false }, state.pendingDeviceLoginPassword || "", state.pendingKeyPassphrase || "");
  state.pendingDeviceLinkId = null;
  state.pendingDeviceLoginPassword = null;
  state.pendingKeyPassphrase = null;
}

async function requestLostOldDeviceEmail() {
  const id = state.pendingDeviceLinkId || localStorage.getItem(`chate_pending_device_link:${state.user?.id}`);
  if (!id) return toast("No pending device confirmation found.", 5200);
  const out = await api(`/devices/link/${encodeURIComponent(id)}/lost-device/start`, { method: "POST", body: JSON.stringify({}) });
  toast(out.detail || "Confirmation email sent.", 7000);
  const statusEl = $("deviceWaitingStatus");
  if (statusEl) statusEl.textContent = "Email sent. Confirm from inbox…";
}

async function approveTrustedDevicePrompt(sessionId) {
  const pkg = await loadEncryptedKeyPackage();
  if (!pkg) return toast("No local security.json package is available on this trusted device.", 6500);
  await api(`/devices/link/${encodeURIComponent(sessionId)}/approve`, {
    method: "POST",
    body: JSON.stringify({ encrypted_key_package_json: JSON.stringify(pkg) }),
  });
  toast("New device accepted. It still needs the key passphrase to unlock old chats.", 6500);
  hideDeviceApprovalToast();
}

async function rejectTrustedDevicePrompt(sessionId) {
  await api(`/devices/link/${encodeURIComponent(sessionId)}/reject`, { method: "POST", body: JSON.stringify({}) });
  toast("New device rejected and revoked.", 5200);
  hideDeviceApprovalToast();
}

function hideDeviceApprovalToast() {
  const box = $("deviceApprovalToast");
  if (box) box.classList.add("hidden");
}

function renderDeviceApprovalToast(row) {
  const box = $("deviceApprovalToast");
  if (!box || !row) return;
  box.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = "New ChatE device wants access";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = `${row.new_device_name || "Unknown device"} is waiting for confirmation. Accept only if this was you.`;
  const actions = document.createElement("div");
  actions.className = "quick-actions";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "primary small-btn";
  accept.textContent = "Accept";
  accept.addEventListener("click", () => approveTrustedDevicePrompt(row.id).catch((err) => toast(err.message, 6500)));
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "small-btn danger-link";
  reject.textContent = "Reject";
  reject.addEventListener("click", () => rejectTrustedDevicePrompt(row.id).catch((err) => toast(err.message, 6500)));
  const later = document.createElement("button");
  later.type = "button";
  later.className = "small-btn";
  later.textContent = "Later";
  later.addEventListener("click", hideDeviceApprovalToast);
  actions.append(accept, reject, later);
  box.append(title, hint, actions);
  box.classList.remove("hidden");
}

async function checkTrustedDevicePrompts() {
  if (!state.token || !state.user?.id) return;
  const rows = await api("/devices/link/pending").catch(() => []);
  const myDeviceId = getOrCreateBrowserDeviceId();
  const pending = rows.find((row) => row.new_device_id !== myDeviceId && ["pending", "email_sent"].includes(row.status));
  if (pending) renderDeviceApprovalToast(pending);
}

function startDeviceApprovalPolling() {
  clearInterval(state.deviceApprovalPollTimer);
  if (!state.token || !state.user?.id) return;
  if (!document.hidden) checkTrustedDevicePrompts().catch(() => null);
  state.deviceApprovalPollTimer = setInterval(() => {
    if (state.token && state.user?.id && !document.hidden) checkTrustedDevicePrompts().catch(() => null);
  }, state.lowPowerMode ? 120000 : 90000);
}

async function continueTrustedLogin(data, loginPassword, keyPassphrase) {
  await loadConversations({ silent: true });
  ensureBackgroundPushSubscription({ quiet: true }).catch(() => null);
  startPolling();
  startPresenceLoops();
  startDeviceApprovalPolling();

  const localPkg = await loadEncryptedKeyPackage();
  const trustedCount = await loadPersistedUnlockedKeys();
  if (trustedCount > 0 && !keyPassphrase) {
    toast(data.deletion_was_cancelled
      ? `Login successful. Deletion cancelled. Trusted device unlocked ${trustedCount} key package${trustedCount === 1 ? "" : "s"}.`
      : `Login successful. Trusted device unlocked ${trustedCount} key package${trustedCount === 1 ? "" : "s"}.`);
    await maybeShowKeyExportReminder();
    return;
  }

  if (keyPassphrase) {
    try {
      const count = await unlockAnyStoredKey(keyPassphrase);
      markMessagesUnlockedThisLogin();
      toast(data.deletion_was_cancelled
        ? `Login successful. Deletion cancelled. Unlocked and trusted ${count} key package${count === 1 ? "" : "s"} on this browser.`
        : `Login successful. Unlocked and trusted ${count} key package${count === 1 ? "" : "s"} on this browser.`);
      await maybeShowKeyExportReminder();
      return;
    } catch (err) {
      toast(`Login successful, but key unlock failed: ${err.message}`, 6500);
    }
  }

  if (!localPkg) {
    await createReplacementEncryptionIdentity(loginPassword, "this device", false);
    clearMessagesUnlockedThisLogin();
    lockPrivateKey(false);
    toast(data.deletion_was_cancelled
      ? "Login successful. Deletion cancelled. New encryption key created for future chats. Old chats still need the old key package."
      : "Login successful. New encryption key created for future chats. Old chats still need the old key package.", 7500);
    await maybeShowKeyExportReminder();
    return;
  }

  const activeMatchesLocal = await publicKeysMatch(localPkg.publicKeyJwk, state.user.public_key_jwk);
  if (activeMatchesLocal) {
    toast("Login successful. Messages are locked. Enter the key passphrase once to trust this browser. After that, reloads/relogins unlock automatically until you click Lock messages or clear local keys.", 8500);
  } else {
    toast("Login successful. Local key package does not match the current server key. Import/unlock the old key for old chats, or reset for new chats.", 7500);
  }
  await maybeShowKeyExportReminder();
}

async function afterLogin(data, loginPassword, keyPassphrase) {
  saveSession(data.access_token, data.user);
  clearMessagesUnlockedThisLogin(data.user?.id);
  document.body.classList.remove("mobile-chat-active");
  renderAuthState();
  updateNetworkUi();
  replayOutbox({ silent: true }).catch(() => null);
  await ensureMyPublicKeyAvailable({ repairPassphrase: keyPassphrase || loginPassword, quiet: true });

  const trust = await ensureAutomaticDeviceTrust(loginPassword, keyPassphrase);
  if (trust?.requires_approval) {
    toast("Login accepted. Waiting for trusted-device or email confirmation before opening chats.", 8000);
    return;
  }
  await continueTrustedLogin(data, loginPassword, keyPassphrase);
}

async function sendEncryptedAttachment(file) {
  if (!file || !state.peer) return null;
  assertSafeAttachment(file);
  const maxBytes = 100 * 1024 * 1024;
  if (file.size > maxBytes) throw new Error("Attachment too large. Keep files under 100 MB.");
  const messageType = guessMessageType(file);
  const clientMessageId = `cm_${state.user.id}_${Date.now()}_${secureRandomToken(18)}`;
  const replyToId = state.replyToMessageId;
  const optimistic = createOptimisticAttachmentMessage(file, clientMessageId, replyToId, navigator.onLine ? "uploading" : "queued");

  if (!navigator.onLine) {
    await queueEncryptedAttachmentFile(file, state.peer.id, replyToId, clientMessageId);
    patchOptimisticMessage(clientMessageId, { local_status: "queued" });
    renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => null);
    clearReplyTarget();
    toast("Offline: encrypted attachment queued and will upload when online.", 6500);
    return optimistic;
  }

  toast("Encrypting file locally…", 5000);
  try {
    const { blob, metadata } = await encryptAndUploadFileBlob(file, state.peer.id);
    const payload = JSON.stringify({
      ...metadata,
      name: file.name || (messageType === "voice" ? "voice-note.webm" : "attachment"),
      type: file.type || "application/octet-stream",
      size: file.size,
    });
    const encrypted = await encryptMessagePayload(payload, messageType, state.peer.public_key_jwk, state.user.public_key_jwk, state.peer.id);
    patchOptimisticMessage(clientMessageId, { ...encrypted, local_status: "sending" });
    const saved = await api("/messages", {
      method: "POST",
      body: JSON.stringify({ receiver_id: state.peer.id, client_message_id: clientMessageId, blob_id: blob.id, reply_to_id: replyToId, ...encrypted }),
      timeoutMs: 45000,
    });
    mergeMessages([saved]);
    updateLocalConversationFromMessage(saved, { render: true });
    if (!patchOptimisticBubbleDom(clientMessageId, saved)) await renderLoadedMessages({ force: true, preserveScroll: true });
    clearReplyTarget();
    return saved;
  } catch (err) {
    if (!isRetryableNetworkError(err)) {
      patchOptimisticMessage(clientMessageId, { local_status: "failed" });
      renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => null);
      throw err;
    }
    await queueEncryptedAttachmentFile(file, state.peer.id, replyToId, clientMessageId);
    patchOptimisticMessage(clientMessageId, { local_status: "queued" });
    renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => null);
    clearReplyTarget();
    toast("Network dropped: encrypted attachment queued for retry.", 6500);
    return optimistic;
  }
}

async function searchUsersLive(query) {
  const box = $("userSearchResults");
  if (!box) return;
  if (!query || query.trim().length < 2 || !state.token) {
    box.classList.add("hidden");
    box.replaceChildren();
    return;
  }
  try {
    const results = await api(`/users/search?q=${encodeURIComponent(query.trim())}`);
    box.replaceChildren();
    if (!results.length) {
      box.classList.remove("hidden");
      box.innerHTML = `<p class="hint">No users found.</p>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const user of results) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "user-result";
      btn.dataset.userId = String(user.id);
      const avatar = document.createElement("div");
      avatar.className = "avatar tiny";
      setAvatarElement(avatar, user);
      const meta = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = user.display_name || user.username;
      const handle = document.createElement("span");
      handle.textContent = `@${user.username}`;
      meta.append(name, handle);
      btn.append(avatar, meta);
      btn.addEventListener("click", () => selectPeer(user).catch((err) => toast(err.message, 5200)));
      frag.appendChild(btn);
    }
    box.classList.remove("hidden");
    box.appendChild(frag);
  } catch (_) {
    box.classList.add("hidden");
  }
}

// ---------------- Event handlers ----------------
$("loginTab").addEventListener("click", () => {
  $("loginTab").classList.add("active");
  $("registerTab").classList.remove("active");
  $("loginForm").classList.remove("hidden");
  $("registerForm").classList.add("hidden");
});

$("registerTab").addEventListener("click", () => {
  $("registerTab").classList.add("active");
  $("loginTab").classList.remove("active");
  $("registerForm").classList.remove("hidden");
  $("loginForm").classList.add("hidden");
});

$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const keyPassphrase = $("regKeyPassphrase").value;
    if (!keyPassphrase || keyPassphrase.length < 8) throw new Error("Key passphrase must be at least 8 characters.");
    toast("Generating encryption keys. Wait...");
    const pkg = await createEncryptedKeyPackage(keyPassphrase);
    await saveEncryptedKeyPackage(pkg, true);

    const data = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username: $("regUsername").value,
        email: $("regEmail").value,
        display_name: $("regDisplayName").value || null,
        password: $("regPassword").value,
        public_key_jwk: pkg.publicKeyJwk,
      }),
    });

    saveSession(data.access_token, data.user);
    await addUnlockedKey(pkg, keyPassphrase, true);
    markMessagesUnlockedThisLogin();
    await ensureAutomaticDeviceTrust("", keyPassphrase);
    renderAuthState();
    ensureBackgroundPushSubscription({ quiet: true }).catch(() => null);
    await loadConversations({ silent: true });
    await openChatFromUrlParams();
    updateNetworkUi();
    replayOutbox({ silent: true }).catch(() => null);
    startPolling();
    startPresenceLoops();
    toast("Account created. Export your encrypted key package now if old chat recovery matters.");
    await maybeShowKeyExportReminder();
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const loginPassword = $("loginPassword").value;
  const keyPassphrase = $("loginKeyPassphrase").value.trim();
  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ login: $("loginId").value, password: loginPassword }),
    });
    await afterLogin(data, loginPassword, keyPassphrase);
  } catch (err) {
    toast(err.message, 5200);
  } finally {
    $("loginPassword").value = "";
    $("loginKeyPassphrase").value = "";
  }
});


const showForgotUsernameBtn = $("showForgotUsernameBtn");
const showPasswordResetBtn = $("showPasswordResetBtn");
for (const btn of [showForgotUsernameBtn, showPasswordResetBtn]) {
  if (btn) btn.addEventListener("click", () => $("authRecoveryPanel")?.classList.toggle("hidden"));
}

const forgotUsernameBtn = $("forgotUsernameBtn");
if (forgotUsernameBtn) forgotUsernameBtn.addEventListener("click", async () => {
  try {
    const email = $("forgotUsernameEmail")?.value.trim();
    if (!email) throw new Error("Enter your recovery email.");
    const out = await runEmailCooldownAction(forgotUsernameBtn, "forgot_username", email, () =>
      api("/auth/forgot-username", { method: "POST", body: JSON.stringify({ email }) })
    );
    if (out) toast(out.detail || "Check your email.", 6500);
  } catch (err) { toast(err.message, 5200); }
});

const passwordResetStartBtn = $("passwordResetStartBtn");
if (passwordResetStartBtn) passwordResetStartBtn.addEventListener("click", async () => {
  try {
    const login = $("passwordResetLogin")?.value.trim();
    if (!login) throw new Error("Enter username or email.");
    const out = await runEmailCooldownAction(passwordResetStartBtn, "password_reset", login, () =>
      api("/auth/password-reset/start", { method: "POST", body: JSON.stringify({ login }) })
    );
    if (out) toast(out.detail || "Check your email.", 7500);
  } catch (err) { toast(err.message, 5200); }
});

const passwordResetCompleteBtn = $("passwordResetCompleteBtn");
if (passwordResetCompleteBtn) passwordResetCompleteBtn.addEventListener("click", async () => {
  try {
    const token = $("passwordResetToken")?.value.trim();
    const newPassword = $("passwordResetNewPassword")?.value;
    if (!token || !newPassword) throw new Error("Enter reset code and new password.");
    const out = await api("/auth/password-reset/complete", { method: "POST", body: JSON.stringify({ token, new_password: newPassword }) });
    toast(out.detail || "Password reset complete. Login again.", 8500);
    $("authRecoveryPanel")?.classList.add("hidden");
  } catch (err) { toast(err.message, 5200); }
});

const reminderExportKeyBtn = $("reminderExportKeyBtn");
if (reminderExportKeyBtn) reminderExportKeyBtn.addEventListener("click", async () => {
  try {
    await exportActiveKeyPackage(true);
    toast("security.json exported. Keep it somewhere safe. Losing it can make old messages unrecoverable.", 7200);
  } catch (err) { toast(err.message, 5200); }
});
const reminderLaterBtn = $("reminderLaterBtn");
if (reminderLaterBtn) reminderLaterBtn.addEventListener("click", remindKeyExportLater);
const reminderDismissBtn = $("reminderDismissBtn");
if (reminderDismissBtn) reminderDismissBtn.addEventListener("click", () => dismissKeyExportReminder(true));

$("unlockBtn").addEventListener("click", async () => {
  if (state.privateKeys.size > 0) {
    lockPrivateKey();
    toast("Messages locked. Encrypted bubbles stay hidden until you enter the key passphrase again.");
    return;
  }

  const passphrase = prompt("Enter key passphrase to unlock messages:");
  if (!passphrase) return;
  try {
    const count = await unlockAnyStoredKey(passphrase);
    markMessagesUnlockedThisLogin();
    toast(`Messages unlocked on this browser. Reloads/relogins stay unlocked until you click Lock messages or clear local keys.`);
    if (state.peer) await loadMessages({ force: true, preserveScroll: true });
  } catch (err) {
    toast(err.message, 5200);
  }
});

const resetKeyBtn = $("resetKeyBtn");
if (resetKeyBtn) resetKeyBtn.addEventListener("click", async () => {
  const ok = confirm("This creates a fresh encryption key for future chats and uploads its public key to the server. Old chats remain encrypted until you import/unlock the old key package. Continue?");
  if (!ok) return;
  const passphrase = prompt("Set a passphrase for the new encrypted key package:");
  if (!passphrase) return;
  try {
    await createReplacementEncryptionIdentity(passphrase, "future chats");
    markMessagesUnlockedThisLogin();
    if (state.peer) await loadMessages({ force: true, preserveScroll: true });
  } catch (err) {
    toast(err.message, 5200);
  }
});

const exportKeyBtn = $("exportKeyBtn");
if (exportKeyBtn) exportKeyBtn.addEventListener("click", async () => {
  try {
    await exportActiveKeyPackage(false);
    toast("Encrypted security.json exported. It still needs its key passphrase to decrypt.");
  } catch (err) {
    toast(err.message, 5200);
  }
});

async function handleKeyImport(file) {
  if (!file) return;
  try {
    const pkg = JSON.parse(await file.text());
    if (!pkg.ciphertext || !pkg.publicKeyJwk) throw new Error("Invalid key package.");
    await saveEncryptedKeyPackage(pkg, false);

    let madeActive = false;
    if (state.token) {
      madeActive = confirm("Make this imported key active for future messages too? Choose OK if this is your real/recovered key. Choose Cancel to keep it only for reading old chats.");
      if (madeActive) await updateMyPublicKey(pkg.publicKeyJwk);
    }

    const passphrase = prompt("Enter this key package passphrase now to unlock it, or leave blank to unlock later:");
    if (passphrase) {
      await addUnlockedKey(pkg, passphrase, madeActive);
      markMessagesUnlockedThisLogin();
    }
    toast(passphrase ? "Encrypted key package imported and unlocked for this login session." : "Encrypted key package imported. Unlock it later with its passphrase.", 5500);
    if (state.peer) await loadMessages({ force: true, preserveScroll: true });
  } catch (err) {
    toast(err.message, 5200);
  }
}

const importKeyInput = $("importKeyInput");
if (importKeyInput) importKeyInput.addEventListener("change", async (e) => {
  await handleKeyImport(e.target.files[0]);
  e.target.value = "";
});

$("preLoginImportKeyInput").addEventListener("change", async (e) => {
  await handleKeyImport(e.target.files[0]);
  e.target.value = "";
});

const peerUsernameInput = $("peerUsername");
if (peerUsernameInput) peerUsernameInput.addEventListener("input", (e) => {
  clearTimeout(state.userSearchTimer);
  state.userSearchTimer = setTimeout(() => searchUsersLive(e.target.value), state.lowPowerMode ? 450 : 300);
});

const userSearchResults = $("userSearchResults");
if (userSearchResults) userSearchResults.addEventListener("click", (e) => {
  if (e.target.closest(".user-result")) searchDrawer?.classList.add("hidden");
});

$("findPeerBtn").addEventListener("click", async () => {
  try {
    const username = $("peerUsername").value.trim();
    if (!username) return;
    const peer = await api(`/users/by-username/${encodeURIComponent(username)}`);
    await selectPeer(peer);
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.sendingMessage) return;
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text || !state.peer) return;
  if (!(await ensurePeerKeySafeForSend())) return;

  const clientMessageId = `cm_${state.user.id}_${Date.now()}_${secureRandomToken(18)}`;
  const replyToId = state.replyToMessageId;
  const optimistic = !state.editingMessageId ? createOptimisticTextMessage(text, clientMessageId, replyToId) : null;
  input.value = "";
  hideSmartSuggestionTray();
  autoGrowComposer();
  clearDraft(state.peer.id);
  clearReplyTarget();
  const blockComposerUntilDone = Boolean(state.editingMessageId);
  if (blockComposerUntilDone) setComposerBusy(true);
  else updateComposerAvailability();
  const sendStartedAt = nowMs();
  state.pendingOutboundClientIds.add(clientMessageId);
  state.suppressConversationSyncUntil = Date.now() + (state.lowPowerMode ? 16000 : 10000);
  try {
    const encryptionStartedAt = nowMs();
    const encrypted = await encryptMessageText(text, state.peer.public_key_jwk, state.user.public_key_jwk, state.peer.id);
    recordSendTiming("encrypt+key-session", encryptionStartedAt, { peer_id: state.peer.id });
    if (state.editingMessageId) {
      const updated = await api(`/messages/${state.editingMessageId}`, {
        method: "PATCH",
        body: JSON.stringify({ ciphertext: encrypted.ciphertext, iv: encrypted.iv, key_session_id: encrypted.key_session_id }),
      });
      const idx = state.activeMessages.findIndex((msg) => Number(msg.id) === Number(updated.id));
      if (idx >= 0) state.activeMessages[idx] = updated;
      stopEditingMessage();
      await renderLoadedMessages({ force: true, preserveScroll: true });
      scheduleConversationRefresh(1200);
    } else {
      const body = { receiver_id: state.peer.id, client_message_id: clientMessageId, reply_to_id: replyToId, ...encrypted };
      patchOptimisticMessage(clientMessageId, { ...encrypted, local_status: "sending" });
      try {
        const apiStartedAt = nowMs();
        const saved = await api("/messages", { method: "POST", body: JSON.stringify(body), timeoutMs: 20000 });
        recordSendTiming("message-api", apiStartedAt, { peer_id: state.peer.id });
        mergeMessages([saved]);
        state.activePeerLatestMessageId = saved.id;
        const liveSession = state.tempSessions.get(state.peer.id);
        if (liveSession && liveSession.id === saved.key_session_id) liveSession.registered = true;
        state.decryptedTextByMessageId.set(saved.id, text);
        updateLocalConversationFromMessage(saved, { render: true });
        if (!patchOptimisticBubbleDom(clientMessageId, saved)) {
          renderLoadedMessages({ force: true, preserveScroll: true }).then(() => scrollMessagesToBottom()).catch(() => {});
        }
        state.suppressConversationSyncUntil = Date.now() + (state.lowPowerMode ? 30000 : 18000);
        recordSendTiming("total-send", sendStartedAt, { peer_id: state.peer.id });
      } catch (err) {
        if (!isRetryableNetworkError(err)) throw err;
        await queueEncryptedMessage(body, state.peer.id, "text");
        patchOptimisticMessage(clientMessageId, { local_status: "queued" });
        renderLoadedMessages({ force: true, preserveScroll: false }).catch(() => {});
        toast("Offline: encrypted message queued. It will sync when connection returns.", 6500);
      }
    }
    setKeyUI(true);
    prewarmTemporaryMessageSession(state.peer);
  } catch (err) {
    if (optimistic) {
      patchOptimisticMessage(clientMessageId, { local_status: "failed" });
      renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
    }
    toast(err.message, 5200);
  } finally {
    setTimeout(() => state.pendingOutboundClientIds.delete(clientMessageId), 30000);
    if (blockComposerUntilDone) setComposerBusy(false);
    else updateComposerAvailability();
  }
});

const attachBtn = $("attachBtn");
const attachmentInput = $("attachmentInput");
if (attachBtn && attachmentInput) attachBtn.addEventListener("click", () => attachmentInput.click());
if (attachmentInput) attachmentInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (!state.peer) return toast("Select a chat first.");
  if (!(await ensurePeerKeySafeForSend())) return;
  if (state.sendingMessage) return;
  setComposerBusy(true);
  try {
    const sent = await sendEncryptedAttachment(file);
    if (sent?.local_status === "queued") toast("Encrypted attachment queued.");
    else toast("Encrypted attachment sent.");
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    hideUploadProgress();
    setComposerBusy(false);
  }
});



document.addEventListener("click", (e) => {
  const retry = e.target.closest?.(".retry-message-btn");
  if (!retry) return;
  e.preventDefault();
  replayOutbox({ silent: false }).catch((err) => toast(err.message || "Retry failed", 5200));
});

const themeBtn = $("themeBtn");
if (themeBtn) themeBtn.addEventListener("click", () => {
  const current = localStorage.getItem("chate_theme") || "system";
  const next = current === "system" ? "dark" : current === "dark" ? "light" : "system";
  localStorage.setItem("chate_theme", next);
  applyThemePreference();
});

const homeLogoutBtn = $("logoutBtn");
if (homeLogoutBtn) homeLogoutBtn.addEventListener("click", () => {
  clearSession();
  renderAuthState();
  autoGrowComposer();
  renderChatShell();
  renderConversationList();
  $("messageList").className = "messages empty";
  $("messageList").innerHTML = `<div class="empty-state"><h3>Logged out</h3><p>Your private keys have been cleared from memory.</p></div>`;
});

const lostOldDeviceBtn = $("lostOldDeviceBtn");
if (lostOldDeviceBtn) lostOldDeviceBtn.addEventListener("click", async () => {
  try {
    const identity = state.pendingDeviceLinkId || "pending-device";
    await runEmailCooldownAction(lostOldDeviceBtn, "device_lost_confirm", identity, () => requestLostOldDeviceEmail());
  } catch (err) { toast(err.message, 6500); }
});

const checkDeviceApprovalBtn = $("checkDeviceApprovalBtn");
if (checkDeviceApprovalBtn) checkDeviceApprovalBtn.addEventListener("click", () => pollPendingDeviceApproval().catch((err) => toast(err.message, 6500)));

const cancelPendingDeviceBtn = $("cancelPendingDeviceBtn");
if (cancelPendingDeviceBtn) cancelPendingDeviceBtn.addEventListener("click", () => {
  clearSession(true);
  hideDeviceWaitingModal();
  renderAuthState();
  renderChatShell();
  renderConversationList();
  toast("Pending device login cancelled.");
});

const deleteAccountBtn = $("deleteAccountBtn");
if (deleteAccountBtn) deleteAccountBtn.addEventListener("click", async () => {
  const ok = confirm("This logs you out immediately. If you log back in within 7 days, deletion is cancelled. Continue?");
  if (!ok) return;
  try {
    await api("/account/deletion-request", { method: "POST", body: JSON.stringify({}) });
    clearSession(true);
    renderAuthState();
    renderChatShell();
    toast("Account deletion requested. You were logged out. Login within 7 days to cancel.", 6000);
  } catch (err) {
    toast(err.message, 5200);
  }
});

async function openChatFromUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const chatId = Number(params.get("chat") || 0);
  if (!chatId || !state.token || !state.user) return;
  try {
    const peer = await getCachedPublicProfile(chatId);
    await selectPeer(peer);
    if (params.get("focus") === "reply") {
      setTimeout(() => $("messageInput")?.focus(), 80);
    }
    const clean = new URL(window.location.href);
    clean.searchParams.delete("chat");
    clean.searchParams.delete("focus");
    clean.searchParams.delete("message_id");
    window.history.replaceState({}, document.title, clean.toString());
  } catch (err) {
    toast(err.message || "Could not open notification chat.", 5200);
  }
}


async function bootstrap() {
  applyThemePreference();
  syncResponsiveLayout();
  await reloadImportedPackItems();
  if (localStorage.getItem("chate_compact_mode") === "enabled") document.body.classList.add("compact-mode");
  registerServiceWorker().catch(() => {});
  setKeyUI(false);

  const params = new URLSearchParams(window.location.search);
  if (params.get("reset_token")) {
    $("authRecoveryPanel")?.classList.remove("hidden");
    if ($("passwordResetToken")) $("passwordResetToken").value = params.get("reset_token");
  }
  if (params.get("verify_email_token")) {
    api("/auth/email-verification/complete", { method: "POST", body: JSON.stringify({ token: params.get("verify_email_token") }) })
      .then((out) => toast(out.detail || "Email verified.", 6500))
      .catch((err) => toast(err.message, 5200));
  }
  if (params.get("device_confirm_token")) {
    api("/devices/link/lost-device/confirm", { method: "POST", body: JSON.stringify({ token: params.get("device_confirm_token") }) })
      .then((out) => {
        toast(out.detail || "Device confirmed by email.", 8500);
        const clean = new URL(window.location.href);
        clean.searchParams.delete("device_confirm_token");
        window.history.replaceState({}, document.title, clean.toString());
      })
      .catch((err) => toast(err.message, 6500));
  }

  if (state.token) {
    try {
      const me = await api("/users/me");
      saveSession(state.token, me);
      if (!isValidPublicKeyJwk(state.user?.public_key_jwk)) {
        await ensureMyPublicKeyAvailable({ quiet: true }).catch((err) => toast(err.message || "Encryption key repair needed.", 6500));
      }
      const trustedCount = await loadPersistedUnlockedKeys();
      if (!trustedCount) {
        state.messagesUnlocked = false;
        setKeyUI(false);
      }
    } catch (_) {
      clearSession(false, { notifyServer: false });
    }
  }

  renderAuthState();
  autoGrowComposer();
  renderChatShell();
  renderConversationList();

  if (state.token) {
    const trust = await ensureAutomaticDeviceTrust("", "").catch((err) => {
      toast(err.message || "Could not verify this device.", 6500);
      return null;
    });
    if (trust?.requires_approval) {
      return;
    }
    ensureBackgroundPushSubscription({ quiet: true }).catch(() => null);
    await loadConversations({ silent: true });
    await openChatFromUrlParams();
    updateNetworkUi();
    replayOutbox({ silent: true }).catch(() => null);
    startPolling();
    startPresenceLoops();
    startDeviceApprovalPolling();
    await maybeShowKeyExportReminder();
  }
}

const conversationList = $("conversationList");
if (conversationList) conversationList.addEventListener("click", async (e) => {
  const item = e.target.closest(".conversation-item");
  if (!item) return;
  const userId = Number(item.dataset.userId);
  const conv = state.conversations.find((entry) => entry.other_user.id === userId);
  if (!conv) return;
  try {
    await selectPeer(conv.other_user);
  } catch (err) {
    toast(err.message, 5200);
  }
});

const refreshChatsBtn = $("refreshChatsBtn");
if (refreshChatsBtn) refreshChatsBtn.addEventListener("click", () => loadConversations());

const conversationSearch = $("conversationSearch");
if (conversationSearch) conversationSearch.addEventListener("input", (e) => {
  state.conversationSearch = e.target.value || "";
  renderConversationList(true);
});

const messageInput = $("messageInput");
if (messageInput) messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
if (messageInput) messageInput.addEventListener("input", () => {
  saveDraft();
  autoGrowComposer();
  renderSmartSuggestionTray();
  scheduleTypingPresence();
});
if (messageInput) messageInput.addEventListener("keyup", renderSmartSuggestionTray);
if (messageInput) messageInput.addEventListener("click", renderSmartSuggestionTray);

const messageListEl = $("messageList");
if (messageListEl) messageListEl.addEventListener("click", async (e) => {
  const senderProfile = e.target.closest(".sender-profile-link");
  if (senderProfile) {
    await showPublicProfile(Number(senderProfile.dataset.userId)).catch((err) => toast(err.message, 5200));
    return;
  }
  const copyBtn = e.target.closest(".copy-message-btn");
  if (copyBtn) {
    const id = Number(copyBtn.dataset.messageId);
    const text = state.decryptedTextByMessageId.get(id);
    if (!text) return toast("Message text is unavailable.");
    await navigator.clipboard.writeText(text).catch(() => null);
    toast("Message copied.");
    return;
  }
  const replyBtn = e.target.closest(".reply-message-btn");
  if (replyBtn) {
    setReplyTarget(Number(replyBtn.dataset.messageId));
    return;
  }
  const replyPreview = e.target.closest(".reply-preview");
  if (replyPreview) {
    const id = Number(replyPreview.dataset.messageId);
    const target = [...messageListEl.querySelectorAll(".bubble")].find((el) => el.querySelector(`[data-message-id="${id}"]`));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const editBtn = e.target.closest(".edit-message-btn");
  if (editBtn) {
    startEditingMessage(Number(editBtn.dataset.messageId));
    return;
  }
  const forwardBtn = e.target.closest(".forward-message-btn");
  if (forwardBtn) {
    forwardMessage(Number(forwardBtn.dataset.messageId)).catch((err) => toast(err.message, 5200));
    return;
  }
  const reactBtn = e.target.closest(".react-message-btn");
  if (reactBtn) {
    const emoji = prompt("React with emoji:", "👍");
    if (emoji) reactToMessage(Number(reactBtn.dataset.messageId), emoji.trim()).catch((err) => toast(err.message, 5200));
    return;
  }
  const reactionChip = e.target.closest(".reaction-chip");
  if (reactionChip) {
    reactToMessage(Number(reactionChip.dataset.messageId), reactionChip.dataset.emoji || "👍").catch((err) => toast(err.message, 5200));
    return;
  }
  const deleteBtn = e.target.closest(".delete-message-btn");
  if (deleteBtn) {
    const id = Number(deleteBtn.dataset.messageId);
    const ok = confirm("Delete this encrypted message from the server for both sides?");
    if (!ok) return;
    try {
      await api(`/messages/${id}`, { method: "DELETE" });
      state.activeMessages = state.activeMessages.filter((msg) => msg.id !== id);
      state.activeMessageSignature = "";
      await renderLoadedMessages({ force: true, preserveScroll: true });
      await loadConversations({ silent: true });
      toast("Message deleted.");
    } catch (err) {
      toast(err.message, 5200);
    }
    return;
  }
  if (e.target.closest("#loadOlderMessagesBtn")) {
    await loadOlderMessages().catch((err) => toast(err.message, 5200));
    return;
  }
  const bubble = e.target.closest(".bubble");
  if (bubble && !e.target.closest(".bubble-actions, .reaction-chip, .reply-preview, .sender-profile-link, a, button, input, textarea, video, audio")) {
    messageListEl.querySelectorAll(".bubble.actions-open").forEach((openBubble) => {
      if (openBubble !== bubble) openBubble.classList.remove("actions-open");
    });
    bubble.classList.toggle("actions-open");
  }
});

if (messageListEl) messageListEl.addEventListener("touchstart", (e) => {
  const bubble = e.target.closest(".bubble");
  if (!bubble || e.target.closest(".bubble-actions, button, a, input, textarea, video, audio")) return;
  const touch = e.touches?.[0];
  state.swipeStart = touch ? { x: touch.clientX, y: touch.clientY, id: bubble.dataset.messageId, bubble } : null;
  clearTimeout(state.longPressTimer);
  state.longPressTimer = setTimeout(() => {
    messageListEl.querySelectorAll(".bubble.actions-open").forEach((openBubble) => {
      if (openBubble !== bubble) openBubble.classList.remove("actions-open");
    });
    bubble.classList.add("actions-open");
    if (navigator.vibrate) navigator.vibrate(18);
  }, 420);
}, { passive: true });

if (messageListEl) messageListEl.addEventListener("touchmove", (e) => {
  if (!state.swipeStart) return;
  const touch = e.touches?.[0];
  if (!touch) return;
  const dx = touch.clientX - state.swipeStart.x;
  const dy = touch.clientY - state.swipeStart.y;
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12) clearTimeout(state.longPressTimer);
  if (dx > 48 && Math.abs(dy) < 36) state.swipeStart.bubble?.classList.add("swipe-reply");
  else state.swipeStart.bubble?.classList.remove("swipe-reply");
}, { passive: true });

if (messageListEl) messageListEl.addEventListener("touchend", (e) => {
  clearTimeout(state.longPressTimer);
  const start = state.swipeStart;
  state.swipeStart = null;
  if (!start) return;
  const touch = e.changedTouches?.[0];
  start.bubble?.classList.remove("swipe-reply");
  if (!touch) return;
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  if (dx > 72 && Math.abs(dy) < 44 && start.id) {
    setReplyTarget(start.id);
    if (navigator.vibrate) navigator.vibrate(12);
  }
}, { passive: true });

if (messageListEl) messageListEl.addEventListener("touchcancel", () => {
  clearTimeout(state.longPressTimer);
  state.swipeStart?.bubble?.classList.remove("swipe-reply");
  state.swipeStart = null;
}, { passive: true });

if (messageListEl) messageListEl.addEventListener("scroll", async () => {
  if (Date.now() < (state.ignoreMessageScrollUntil || 0)) return;
  state.lastManualMessageScrollAt = Date.now();
  if (messageListEl.scrollTop < 80 && state.hasMoreMessages && !state.loadingOlderMessages && state.activeMessages.length) {
    await loadOlderMessages().catch(() => {});
  }
});

const toggleSearchBtn = $("toggleSearchBtn");
const searchDrawer = $("searchDrawer");
if (toggleSearchBtn && searchDrawer) toggleSearchBtn.addEventListener("click", () => {
  searchDrawer.classList.toggle("hidden");
  if (!searchDrawer.classList.contains("hidden")) $("peerUsername")?.focus();
});

const closeSearchBtn = $("closeSearchBtn");
if (closeSearchBtn && searchDrawer) closeSearchBtn.addEventListener("click", () => searchDrawer.classList.add("hidden"));


async function renderGlobalMessageSearch(query) {
  const box = $("globalMessageSearchResults");
  if (!box) return;
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    box.classList.add("hidden");
    box.replaceChildren();
    return;
  }
  const rows = (await localSearchGetAll())
    .filter((row) => row.userId === state.user?.id && String(row.text || "").toLowerCase().includes(q))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 30);
  box.replaceChildren();
  box.classList.remove("hidden");
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No local decrypted messages match. Open/unlock chats first to build the local index.";
    box.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "user-result local-search-result";
    btn.dataset.peerId = String(row.peerId);
    btn.dataset.messageId = String(row.messageId);
    const title = document.createElement("strong");
    title.textContent = `${row.peerDisplayName || row.peerUsername || "Chat"} · ${row.direction}`;
    const sub = document.createElement("span");
    sub.textContent = `${parseServerDate(row.createdAt)?.toLocaleString?.() || ""} · ${localSearchPreview(row.text, q)}`;
    btn.append(title, sub);
    box.appendChild(btn);
  }
}

let globalSearchTimer = null;
const globalMessageSearchInput = $("globalMessageSearchInput");
if (globalMessageSearchInput) globalMessageSearchInput.addEventListener("input", (e) => {
  clearTimeout(globalSearchTimer);
  globalSearchTimer = setTimeout(() => renderGlobalMessageSearch(e.target.value).catch((err) => toast(err.message, 5200)), state.lowPowerMode ? 420 : 220);
});

const globalMessageSearchResults = $("globalMessageSearchResults");
if (globalMessageSearchResults) globalMessageSearchResults.addEventListener("click", async (e) => {
  const hit = e.target.closest(".local-search-result");
  if (!hit) return;
  const peerId = Number(hit.dataset.peerId);
  const peer = state.conversations.find((c) => c.other_user?.id === peerId)?.other_user || await getCachedPublicProfile(peerId);
  await selectPeer(peer);
  state.messageSearch = globalMessageSearchInput?.value || "";
  if ($("messageSearchInput")) $("messageSearchInput").value = state.messageSearch;
  $("messageSearchBar")?.classList.remove("hidden");
  searchDrawer?.classList.add("hidden");
  await renderLoadedMessages({ force: true, preserveScroll: true });
  setTimeout(() => document.querySelector(`.bubble[data-message-id='${hit.dataset.messageId}']`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 250);
});

const clearLocalSearchIndexBtn = $("clearLocalSearchIndexBtn");
if (clearLocalSearchIndexBtn) clearLocalSearchIndexBtn.addEventListener("click", async () => {
  if (!confirm("Clear this browser's local decrypted-message search index? Server messages stay encrypted and untouched.")) return;
  await localSearchClear();
  state.localSearchIndexedIds.clear();
  state.localSearchQueue.clear();
  if (globalMessageSearchInput) globalMessageSearchInput.value = "";
  await renderGlobalMessageSearch("");
  toast("Local message search index cleared.");
});

const mobileInboxBtn = $("mobileInboxBtn");
if (mobileInboxBtn) mobileInboxBtn.addEventListener("click", () => {
  document.body.classList.remove("mobile-chat-active");
});

const cancelReplyBtn = $("cancelReplyBtn");
if (cancelReplyBtn) cancelReplyBtn.addEventListener("click", clearReplyTarget);

const toggleMessageSearchBtn = $("toggleMessageSearchBtn");
const messageSearchInput = $("messageSearchInput");
const clearMessageSearchBtn = $("clearMessageSearchBtn");
const pinChatBtn = $("pinChatBtn");
const muteChatBtn = $("muteChatBtn");
const blockPeerBtn = $("blockPeerBtn");
const reportPeerBtn = $("reportPeerBtn");
const chatDisappearingBtn = $("chatDisappearingBtn");
const deleteConversationBtn = $("deleteConversationBtn");
const verifyPeerKeyBtn = $("verifyPeerKeyBtn");

async function toggleMessageSearchAction() {
  const bar = $("messageSearchBar");
  bar?.classList.toggle("hidden");
  if (bar && !bar.classList.contains("hidden")) $("messageSearchInput")?.focus();
}

async function verifyPeerKeyAction() {
  if (!state.peer) {
    toast("Select a chat first.");
    return;
  }
  state.peer = await hydratePeerPublicKey(state.peer);
  const fp = await fingerprintPublicJwk(state.peer.public_key_jwk);
  const short = shortFingerprint(fp);
  const status = state.peerSecurity?.status === "changed"
    ? "Changed since this browser last saw it"
    : state.peerSecurity?.status === "verified"
      ? "Verified on this browser"
      : "Saved in background";
  const ok = confirm(
    `Security info for @${state.peer.username}

` +
    `Status: ${status}
` +
    `Short safety code: ${short}

` +
    `The full safety code is hidden by default. For normal use, no action is needed. For high-trust chats, compare safety info through a separate channel.

` +
    `Mark this contact as verified on this browser?`
  );
  if (ok) {
    writePeerTrust(state.peer.id, fp, true);
    state.peerSecurity = { status: "verified", fingerprint: fp, verified: true };
    state.activeMessageSignature = "";
    renderSecurityBanner();
    renderChatShell();
    await renderLoadedMessages({ force: true, preserveScroll: true });
    toast("Contact marked verified on this browser.");
  }
}

function pinChatAction() {
  const id = chatStorageId();
  if (!id) return toast("Select a chat first.");
  if (state.pinnedChats.has(id)) state.pinnedChats.delete(id);
  else state.pinnedChats.add(id);
  saveChatSet("chate_pinned_chats", state.pinnedChats);
  updateChatActionButtons();
  renderConversationList(true);
}

function muteChatAction() {
  const id = chatStorageId();
  if (!id) return toast("Select a chat first.");
  if (state.mutedChats.has(id)) state.mutedChats.delete(id);
  else state.mutedChats.add(id);
  saveChatSet("chate_muted_chats", state.mutedChats);
  updateChatActionButtons();
  renderConversationList(true);
}

async function setChatDisappearingAction() {
  if (!state.peer) return toast("Select a chat first.");
  const current = await api(`/conversations/${state.peer.id}/settings`);
  const choices = [
    ["", "Off"], ["30", "30 seconds"], ["300", "5 minutes"], ["3600", "1 hour"],
    ["86400", "1 day"], ["604800", "7 days"], ["2592000", "30 days"], ["custom", "Custom seconds"],
  ];
  const text = choices.map(([v, label], i) => `${i}: ${label}${String(current.disappearing_seconds || "") === v ? " (current)" : ""}`).join("\n");
  const picked = prompt(`Disappearing messages for @${state.peer.username}:\n${text}\n\nEnter number 0-7:`, "0");
  if (picked === null) return;
  const idx = Number(picked);
  if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) return toast("Invalid choice.");
  let seconds = choices[idx][0];
  if (seconds === "custom") {
    const raw = prompt("Custom timer in seconds (30 to 31536000), or 0 to turn off:", String(current.disappearing_seconds || 604800));
    if (raw === null) return;
    seconds = raw;
  }
  const value = seconds ? Number(seconds) : null;
  const out = await api(`/conversations/${state.peer.id}/settings`, { method: "PUT", body: JSON.stringify({ disappearing_seconds: value && value > 0 ? value : null }) });
  const label = out.disappearing_seconds ? `${out.disappearing_seconds} seconds` : "off";
  state.activeMessageSignature = "";
  await renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
  toast(`Disappearing messages set to ${label}. Both sides receive the setting.`, 6500);
}

async function blockPeerAction() {
  if (!state.peer) return toast("Select a chat first.");
  const ok = confirm(`Block @${state.peer.username}? They cannot message you and this chat disappears from the inbox.`);
  if (!ok) return;
  await api(`/blocks/${state.peer.id}`, { method: "POST", body: JSON.stringify({}) });
  toast("User blocked.");
  state.peer = null;
  state.activeMessages = [];
  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
  document.body.classList.remove("mobile-chat-active");
  await loadConversations({ silent: true });
  renderChatShell();
}


async function reportPeerAction() {
  if (!state.peer) return toast("Select a chat first.");
  const reason = prompt(`Report @${state.peer.username} for what? Example: spam, harassment, scam, abuse`);
  if (!reason) return;
  const includeEvidence = confirm("Include up to 5 decrypted loaded text messages as evidence? Only messages you explicitly include are disclosed to the report log.");
  const evidence = [];
  if (includeEvidence) {
    for (const msg of state.activeMessages.slice(-20)) {
      if (evidence.length >= 5) break;
      const text = state.decryptedTextByMessageId.get(msg.id);
      if (!text || text.startsWith("{")) continue;
      evidence.push({
        message_id: msg.id,
        created_at: msg.created_at,
        direction: msg.sender_id === state.user.id ? "sent" : "received",
        text: text.slice(0, 2000),
      });
    }
  }
  await api("/reports", {
    method: "POST",
    body: JSON.stringify({ reported_user_id: state.peer.id, reason: reason.slice(0, 120), evidence }),
  });
  toast("Report submitted. E2EE stayed intact except evidence you explicitly chose to disclose.", 6500);
}

async function deleteConversationAction() {
  if (!state.peer) return toast("Select a chat first.");
  const ok = confirm(`Delete this whole encrypted conversation with @${state.peer.username} from the server for both sides?`);
  if (!ok) return;
  const peerId = state.peer.id;
  await api(`/conversations/${peerId}`, { method: "DELETE" });
  clearDraft(peerId);
  state.peer = null;
  state.activeMessages = [];
  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
  document.body.classList.remove("mobile-chat-active");
  await loadConversations({ silent: true });
  renderChatShell();
  toast("Conversation deleted.");
}

if (messageSearchInput) messageSearchInput.addEventListener("input", (e) => {
  state.messageSearch = e.target.value || "";
  state.activeMessageSignature = "";
  clearTimeout(state.messageSearchRenderTimer);
  state.messageSearchRenderTimer = setTimeout(() => {
    renderLoadedMessages({ force: true, preserveScroll: true }).catch(() => {});
  }, 140);
});
if (clearMessageSearchBtn) clearMessageSearchBtn.addEventListener("click", async () => {
  state.messageSearch = "";
  if (messageSearchInput) messageSearchInput.value = "";
  state.activeMessageSignature = "";
  await renderLoadedMessages({ force: true, preserveScroll: true });
});

const chatMenuBtn = $("chatMenuBtn");
const chatMenu = $("chatMenu");

// Keep the options menu out of the topbar stacking/overflow context. This fixes
// desktop browsers where the button received the click but the menu rendered
// behind/clipped by the chat header.
if (chatMenu && chatMenu.parentElement !== document.body) {
  document.body.appendChild(chatMenu);
}

function positionChatMenu() {
  if (!chatMenu || !chatMenuBtn || chatMenu.classList.contains("hidden")) return;
  const rect = chatMenuBtn.getBoundingClientRect();
  const menuWidth = Math.min(Math.max(chatMenu.offsetWidth || 224, 224), window.innerWidth - 16);
  const menuHeight = Math.min(chatMenu.offsetHeight || 260, window.innerHeight - 16);
  const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
  const top = Math.max(8, Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 8));
  chatMenu.style.left = `${left}px`;
  chatMenu.style.top = `${top}px`;
  chatMenu.style.right = "auto";
  chatMenu.style.minWidth = `${menuWidth}px`;
}

function closeChatMenu() {
  if (!chatMenu) return;
  chatMenu.classList.add("hidden");
  chatMenuBtn?.setAttribute("aria-expanded", "false");
}

function openChatMenu() {
  if (!chatMenu) return;
  chatMenu.classList.remove("hidden");
  chatMenuBtn?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(positionChatMenu);
}

function toggleChatMenu(event = null) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (!chatMenu) return;
  if (chatMenu.classList.contains("hidden")) openChatMenu();
  else closeChatMenu();
}

async function runChatMenuActionById(idOrAction) {
  const actions = {
    search: toggleMessageSearchAction,
    verify: verifyPeerKeyAction,
    pin: pinChatAction,
    mute: muteChatAction,
    disappearing: setChatDisappearingAction,
    block: blockPeerAction,
    report: reportPeerAction,
    delete: deleteConversationAction,
    toggleMessageSearchBtn: toggleMessageSearchAction,
    verifyPeerKeyBtn: verifyPeerKeyAction,
    pinChatBtn: pinChatAction,
    muteChatBtn: muteChatAction,
    chatDisappearingBtn: setChatDisappearingAction,
    blockPeerBtn: blockPeerAction,
    reportPeerBtn: reportPeerAction,
    deleteConversationBtn: deleteConversationAction,
  };
  const action = actions[idOrAction];
  if (!action) return toast("Unknown chat action.");
  await action();
}

async function handleChatMenuActionElement(item) {
  if (!item) return;
  closeChatMenu();
  if (item.tagName === "A" && item.getAttribute("href")) {
    window.location.href = item.getAttribute("href");
    return;
  }
  await runChatMenuActionById(item.dataset.chatAction || item.id);
}

if (chatMenuBtn) {
  chatMenuBtn.addEventListener("click", (event) => toggleChatMenu(event));
  chatMenuBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
}

if (chatMenu) {
  chatMenu.addEventListener("click", async (event) => {
    const item = event.target.closest("#chatMenu button, #chatMenu a");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    try { await handleChatMenuActionElement(item); }
    catch (err) { toast(err.message || "Chat action failed.", 5200); }
  });
  chatMenu.addEventListener("pointerdown", (event) => event.stopPropagation());
  chatMenu.addEventListener("touchmove", (event) => event.stopPropagation(), { passive: true });
  chatMenu.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
}

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("#chatMenuBtn, #chatMenu")) return;
  closeChatMenu();
  if (event.target.closest(".bubble")) return;
  messageListEl?.querySelectorAll(".bubble.actions-open").forEach((bubble) => bubble.classList.remove("actions-open"));
}, true);

document.addEventListener("click", (event) => {
  if (event.target.closest("#chatMenuBtn, #chatMenu")) return;
  closeChatMenu();
}, true);

window.addEventListener("resize", () => {
  if (chatMenu && !chatMenu.classList.contains("hidden")) positionChatMenu();
});
window.addEventListener("scroll", (event) => {
  if (event.target?.closest?.("#chatMenu")) return;
  if (event.target === chatMenu || chatMenu?.contains?.(event.target)) return;
  closeChatMenu();
}, true);


const chatPeerHeader = document.querySelector(".chat-peer");
if (chatPeerHeader) chatPeerHeader.addEventListener("click", (event) => {
  if (event.target.closest("button, a, input, textarea")) return;
  if (state.peer) showPublicProfile(state.peer.id).catch((err) => toast(err.message, 5200));
});
const closePublicProfileBtn = $("closePublicProfileBtn");
if (closePublicProfileBtn) closePublicProfileBtn.addEventListener("click", closePublicProfile);
const publicProfileModal = $("publicProfileModal");
if (publicProfileModal) publicProfileModal.addEventListener("click", (event) => {
  if (event.target === publicProfileModal) closePublicProfile();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeChatMenu();
    closePublicProfile();
    if (emojiPanel) emojiPanel.classList.add("hidden");
    hideSmartSuggestionTray();
  }
});

// ---------------- Imported emoji / sticker / GIF packs ----------------

function isVideoDataUrl(dataUrl = "") {
  return /^data:video\//i.test(String(dataUrl));
}

function mediaThumbMarkup(item, labelClass = "gif-label") {
  const safeUrl = item.dataUrl || "";
  const safeLabel = escapeXml(item.label || "Pack item");
  if (!safeUrl) return `${animatedEmojiMarkup(item.emoji || "✨", safeLabel)}<span class="${labelClass}">${safeLabel}</span>`;
  if (isVideoDataUrl(safeUrl)) {
    return `<video class="picker-media-thumb" src="${safeUrl}" autoplay muted loop playsinline preload="metadata"></video><span class="${labelClass}">${safeLabel}</span>`;
  }
  return `<img class="picker-media-thumb" src="${safeUrl}" alt=""><span class="${labelClass}">${safeLabel}</span>`;
}

function createPackMediaElement(dataUrl, className, altText = "Sticker") {
  if (isVideoDataUrl(dataUrl)) {
    const video = document.createElement("video");
    video.className = className;
    video.src = dataUrl;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    video.title = altText;
    return video;
  }
  const img = document.createElement("img");
  img.className = className;
  img.loading = "lazy";
  img.decoding = "async";
  img.src = dataUrl;
  img.alt = altText;
  return img;
}

function normalizePackItem(raw, source = "imported") {
  const label = String(raw.label || raw.name || raw.title || "Imported sticker").slice(0, 80);
  const rawType = String(raw.kind || raw.type || raw.mime || "").toLowerCase();
  const type = rawType.includes("gif") || rawType.includes("video") || rawType.includes("webm") || rawType.includes("mp4") ? "gif" : rawType.includes("emoji") ? "sticker" : rawType.includes("image") ? "sticker" : (rawType || "sticker");
  const item = {
    id: raw.id || `pack_${Date.now()}_${secureRandomToken(10)}`,
    source,
    label,
    kind: type === "emoji" ? "sticker" : type,
    emoji: raw.emoji || "✨",
    dataUrl: raw.dataUrl || raw.url || "",
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((x) => String(x).toLowerCase()).slice(0, 24) : label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 10),
    importedAt: Date.now(),
  };
  if (!item.dataUrl && item.kind !== "sticker") return null;
  return item;
}

async function reloadImportedPackItems() {
  try {
    state.importedPackItems = (await packStoreGetAll()).filter(Boolean).slice(0, 400);
  } catch (_) {
    state.importedPackItems = [];
  }
}

async function importStickerMediaFiles(files) {
  const maxItemBytes = 12 * 1024 * 1024;
  const picked = [...files].slice(0, 60);
  const items = [];
  for (const file of picked) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !/\.(gif|webp|png|jpe?g|svg|webm|mp4)$/i.test(file.name)) continue;
    if (file.size > maxItemBytes) {
      toast(`${file.name} skipped; pack item is over 12 MB.`, 5000);
      continue;
    }
    const dataUrl = await fileToDataUrl(file);
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Imported media";
    items.push(normalizePackItem({
      id: `media_${Date.now()}_${secureRandomToken(8)}`,
      label: name,
      kind: file.type === "image/gif" || file.type.startsWith("video/") || /\.(gif|webm|mp4)$/i.test(file.name) ? "gif" : "sticker",
      dataUrl,
      keywords: name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    }, "media-import"));
  }
  const clean = items.filter(Boolean);
  if (!clean.length) throw new Error("No valid GIF/sticker images selected.");
  await packStorePutMany(clean);
  await reloadImportedPackItems();
  state.packSearchCache.clear();
  toast(`Imported ${clean.length} sticker/GIF item${clean.length === 1 ? "" : "s"}.`);
  renderPicker(activePickerTab);
}

async function importStickerJsonPack(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  if (!list.length) throw new Error("Pack JSON must be an array or { items: [...] }.");
  const clean = list.slice(0, 200).map((item) => normalizePackItem(item, parsed.name || "json-pack")).filter(Boolean);
  if (!clean.length) throw new Error("No valid items found in pack JSON.");
  await packStorePutMany(clean);
  await reloadImportedPackItems();
  state.packSearchCache.clear();
  toast(`Imported ${clean.length} pack item${clean.length === 1 ? "" : "s"}.`);
  renderPicker("packs");
}

async function clearImportedPacks() {
  if (!confirm("Clear imported local emoji/sticker/GIF packs from this browser?")) return;
  await packStoreClear();
  await reloadImportedPackItems();
  state.packSearchCache.clear();
  renderPicker(activePickerTab);
  toast("Imported packs cleared from this browser.");
}

const emojiCatalog = [
  { emoji: "😀", label: "Grinning", keywords: ["happy", "smile", "hello"] },
  { emoji: "😄", label: "Big smile", keywords: ["happy", "laugh", "smile"] },
  { emoji: "😁", label: "Beaming", keywords: ["grin", "smile", "happy"] },
  { emoji: "😂", label: "LOL", keywords: ["lol", "laugh", "haha", "funny", "joy"] },
  { emoji: "🤣", label: "Rolling", keywords: ["rofl", "laugh", "funny"] },
  { emoji: "😊", label: "Soft smile", keywords: ["nice", "happy", "cute"] },
  { emoji: "😍", label: "Crush", keywords: ["love", "heart", "eyes", "cute"] },
  { emoji: "🥰", label: "Loved", keywords: ["love", "affection", "cute"] },
  { emoji: "😘", label: "Kiss", keywords: ["kiss", "love", "heart"] },
  { emoji: "😎", label: "Cool", keywords: ["cool", "sunglasses", "boss"] },
  { emoji: "🤩", label: "Starstruck", keywords: ["wow", "star", "amazing"] },
  { emoji: "🥳", label: "Party", keywords: ["party", "celebrate", "congrats"] },
  { emoji: "😭", label: "Crying", keywords: ["cry", "sad", "tears"] },
  { emoji: "😢", label: "Sad", keywords: ["sad", "cry", "down"] },
  { emoji: "😡", label: "Angry", keywords: ["angry", "rage", "mad"] },
  { emoji: "😤", label: "Frustrated", keywords: ["angry", "annoyed", "mad"] },
  { emoji: "💀", label: "Dead", keywords: ["dead", "skull", "bruh", "dark"] },
  { emoji: "🤯", label: "Mind blown", keywords: ["mind", "blown", "shock", "wow"] },
  { emoji: "😱", label: "Scream", keywords: ["shock", "fear", "wow"] },
  { emoji: "😴", label: "Sleepy", keywords: ["sleep", "tired", "night"] },
  { emoji: "🤔", label: "Thinking", keywords: ["think", "hmm", "question"] },
  { emoji: "🙃", label: "Upside down", keywords: ["silly", "sarcasm", "weird"] },
  { emoji: "😉", label: "Wink", keywords: ["wink", "joke", "flirt"] },
  { emoji: "😇", label: "Angel", keywords: ["innocent", "good", "angel"] },
  { emoji: "🫡", label: "Respect", keywords: ["salute", "respect", "sir", "ok"] },
  { emoji: "🤝", label: "Handshake", keywords: ["deal", "agree", "team"] },
  { emoji: "👍", label: "Approved", keywords: ["like", "ok", "yes", "thumb"] },
  { emoji: "👎", label: "Nope", keywords: ["no", "dislike", "bad"] },
  { emoji: "👏", label: "Clap", keywords: ["clap", "applause", "great"] },
  { emoji: "🙏", label: "Thanks", keywords: ["thanks", "pray", "please"] },
  { emoji: "👀", label: "Watching", keywords: ["eyes", "watch", "look", "see"] },
  { emoji: "✅", label: "Done", keywords: ["done", "check", "complete", "yes"] },
  { emoji: "❌", label: "Cancel", keywords: ["no", "wrong", "delete", "cancel"] },
  { emoji: "🔥", label: "Fire", keywords: ["fire", "hot", "lit", "burn"] },
  { emoji: "💯", label: "Hundred", keywords: ["100", "perfect", "score"] },
  { emoji: "⚡", label: "Energy", keywords: ["energy", "fast", "bolt", "shock"] },
  { emoji: "✨", label: "Sparkle", keywords: ["sparkle", "magic", "clean"] },
  { emoji: "⭐", label: "Star", keywords: ["star", "favorite", "best"] },
  { emoji: "🌟", label: "Glow", keywords: ["star", "shine", "bright"] },
  { emoji: "💥", label: "Boom", keywords: ["boom", "blast", "impact"] },
  { emoji: "❤️", label: "Love", keywords: ["heart", "love", "red", "kiss"] },
  { emoji: "🧡", label: "Orange heart", keywords: ["heart", "love", "warm"] },
  { emoji: "💛", label: "Yellow heart", keywords: ["heart", "love", "friend"] },
  { emoji: "💚", label: "Green heart", keywords: ["heart", "love", "nature"] },
  { emoji: "💙", label: "Blue heart", keywords: ["heart", "love", "trust"] },
  { emoji: "💜", label: "Purple heart", keywords: ["heart", "love", "purple"] },
  { emoji: "🖤", label: "Black heart", keywords: ["heart", "dark", "love"] },
  { emoji: "💔", label: "Broken heart", keywords: ["sad", "breakup", "heart"] },
  { emoji: "🚀", label: "Launch", keywords: ["rocket", "launch", "boost", "ship"] },
  { emoji: "🛸", label: "UFO", keywords: ["alien", "space", "weird"] },
  { emoji: "🎉", label: "Celebration", keywords: ["party", "celebrate", "congrats", "done"] },
  { emoji: "🎂", label: "Birthday", keywords: ["birthday", "cake", "party"] },
  { emoji: "🎁", label: "Gift", keywords: ["gift", "present", "surprise"] },
  { emoji: "🏆", label: "Trophy", keywords: ["win", "winner", "award"] },
  { emoji: "💪", label: "Strong", keywords: ["strong", "gym", "power"] },
  { emoji: "🧠", label: "Brain", keywords: ["smart", "brain", "idea"] },
  { emoji: "💡", label: "Idea", keywords: ["idea", "light", "think"] },
  { emoji: "🔒", label: "Secure", keywords: ["lock", "secure", "private"] },
  { emoji: "🔐", label: "Encrypted", keywords: ["lock", "key", "security"] },
  { emoji: "📎", label: "Attachment", keywords: ["file", "attach", "paperclip"] },
  { emoji: "📷", label: "Camera", keywords: ["photo", "camera", "picture"] },
  { emoji: "🎵", label: "Music", keywords: ["music", "audio", "song"] },
  { emoji: "🎙", label: "Voice", keywords: ["voice", "record", "mic"] },
  { emoji: "☕", label: "Coffee", keywords: ["coffee", "tea", "work"] },
  { emoji: "🍕", label: "Pizza", keywords: ["pizza", "food", "hungry"] },
  { emoji: "🍔", label: "Burger", keywords: ["burger", "food", "hungry"] },
  { emoji: "🍟", label: "Fries", keywords: ["fries", "food", "snack"] },
  { emoji: "🍫", label: "Chocolate", keywords: ["sweet", "chocolate", "food"] },
  { emoji: "🐱", label: "Cat", keywords: ["cat", "kitten", "meow"] },
  { emoji: "🐶", label: "Dog", keywords: ["dog", "puppy", "pet"] },
  { emoji: "🐼", label: "Panda", keywords: ["panda", "cute", "animal"] },
  { emoji: "🦁", label: "Lion", keywords: ["lion", "king", "animal"] },
  { emoji: "🐵", label: "Monkey", keywords: ["monkey", "fun", "animal"] },
  { emoji: "🌙", label: "Moon", keywords: ["moon", "night", "sleep"] },
  { emoji: "☀️", label: "Sun", keywords: ["sun", "day", "bright"] },
  { emoji: "🌈", label: "Rainbow", keywords: ["rainbow", "color", "happy"] },
  { emoji: "🌧", label: "Rain", keywords: ["rain", "weather", "sad"] },
  { emoji: "❄️", label: "Snow", keywords: ["snow", "cold", "winter"] },
  { emoji: "🌍", label: "Earth", keywords: ["world", "earth", "global"] },
  { emoji: "🧨", label: "Explosive", keywords: ["boom", "firecracker", "blast"] },
  { emoji: "🫠", label: "Melting", keywords: ["melt", "awkward", "hot"] },
  { emoji: "🥹", label: "Touched", keywords: ["cute", "cry", "emotional"] },
  { emoji: "🤌", label: "Chef kiss", keywords: ["perfect", "italian", "nice"] },
  { emoji: "🗿", label: "Stone face", keywords: ["meme", "bruh", "deadpan"] },
  { emoji: "🤡", label: "Clown", keywords: ["clown", "funny", "joke"] },
  { emoji: "👑", label: "Crown", keywords: ["king", "queen", "boss"] },
  { emoji: "💸", label: "Money flying", keywords: ["money", "cash", "payment"] },
  { emoji: "💰", label: "Money bag", keywords: ["money", "cash", "rich"] },

  { emoji: "😋", label: "Yummy", keywords: ["food", "taste", "hungry"] },
  { emoji: "😜", label: "Crazy wink", keywords: ["fun", "joke", "silly"] },
  { emoji: "🤪", label: "Goofy", keywords: ["crazy", "silly", "meme"] },
  { emoji: "😬", label: "Awkward", keywords: ["awkward", "oops", "nervous"] },
  { emoji: "😮‍💨", label: "Relieved", keywords: ["relief", "tired", "breath"] },
  { emoji: "😶‍🌫️", label: "Hidden", keywords: ["fog", "hide", "mystery"] },
  { emoji: "🤨", label: "Suspicious", keywords: ["sus", "doubt", "really"] },
  { emoji: "🫢", label: "Oops", keywords: ["oops", "shock", "secret"] },
  { emoji: "🫣", label: "Peeking", keywords: ["peek", "shy", "look"] },
  { emoji: "🫶", label: "Heart hands", keywords: ["love", "thanks", "care"] },
  { emoji: "🙌", label: "Hands up", keywords: ["yay", "celebrate", "win"] },
  { emoji: "🤲", label: "Offering", keywords: ["give", "please", "care"] },
  { emoji: "🫰", label: "Finger heart", keywords: ["love", "korean", "heart"] },
  { emoji: "✌️", label: "Peace", keywords: ["peace", "two", "victory"] },
  { emoji: "🤟", label: "Love you", keywords: ["love", "rock", "hand"] },
  { emoji: "👌", label: "Perfect", keywords: ["ok", "perfect", "nice"] },
  { emoji: "👊", label: "Fist bump", keywords: ["bro", "bump", "power"] },
  { emoji: "🤞", label: "Fingers crossed", keywords: ["hope", "luck", "wish"] },
  { emoji: "👋", label: "Wave", keywords: ["hello", "bye", "hi"] },
  { emoji: "💃", label: "Dance", keywords: ["girl", "dance", "party", "glam"] },
  { emoji: "🕺", label: "Dancer", keywords: ["dance", "party", "moves"] },
  { emoji: "💅", label: "Nails", keywords: ["glam", "style", "fashion", "queen"] },
  { emoji: "💄", label: "Lipstick", keywords: ["glam", "fashion", "makeup"] },
  { emoji: "💋", label: "Kiss mark", keywords: ["kiss", "glam", "love"] },
  { emoji: "👠", label: "Heels", keywords: ["fashion", "glam", "style"] },
  { emoji: "👗", label: "Dress", keywords: ["fashion", "glam", "style"] },
  { emoji: "👜", label: "Handbag", keywords: ["fashion", "bag", "style"] },
  { emoji: "💍", label: "Ring", keywords: ["diamond", "wedding", "glam"] },
  { emoji: "💎", label: "Diamond", keywords: ["rich", "glam", "shine"] },
  { emoji: "🦋", label: "Butterfly", keywords: ["cute", "pretty", "glow"] },
  { emoji: "🌹", label: "Rose", keywords: ["love", "flower", "romance"] },
  { emoji: "🌸", label: "Flower", keywords: ["cute", "pretty", "spring"] },
  { emoji: "🧸", label: "Teddy", keywords: ["cute", "soft", "gift"] },
  { emoji: "🐣", label: "Chick", keywords: ["cute", "small", "baby"] },
  { emoji: "🦄", label: "Unicorn", keywords: ["magic", "cute", "rainbow"] },
  { emoji: "🐲", label: "Dragon", keywords: ["fire", "power", "fantasy"] },
  { emoji: "🦊", label: "Fox", keywords: ["animal", "clever", "cute"] },
  { emoji: "🐻", label: "Bear", keywords: ["animal", "cute", "hug"] },
  { emoji: "🐨", label: "Koala", keywords: ["animal", "cute", "sleep"] },
  { emoji: "🦉", label: "Owl", keywords: ["wise", "night", "animal"] },
  { emoji: "🍓", label: "Strawberry", keywords: ["fruit", "cute", "sweet"] },
  { emoji: "🍒", label: "Cherry", keywords: ["fruit", "red", "cute"] },
  { emoji: "🍩", label: "Donut", keywords: ["sweet", "food", "snack"] },
  { emoji: "🍰", label: "Cake", keywords: ["sweet", "birthday", "party"] },
  { emoji: "🥤", label: "Drink", keywords: ["drink", "cold", "soda"] },
  { emoji: "🎮", label: "Gaming", keywords: ["game", "controller", "play"] },
  { emoji: "🎧", label: "Headphones", keywords: ["music", "listen", "audio"] },
  { emoji: "🎬", label: "Movie", keywords: ["movie", "film", "video"] },
  { emoji: "📚", label: "Books", keywords: ["study", "read", "school"] },
  { emoji: "🧩", label: "Puzzle", keywords: ["puzzle", "problem", "solve"] },
  { emoji: "🛠️", label: "Tools", keywords: ["fix", "build", "work"] },
  { emoji: "🧪", label: "Experiment", keywords: ["lab", "test", "science"] },
  { emoji: "🧬", label: "DNA", keywords: ["science", "bio", "genetic"] },
  { emoji: "💻", label: "Laptop", keywords: ["code", "work", "computer"] },
  { emoji: "🖥️", label: "Desktop", keywords: ["computer", "pc", "work"] },
  { emoji: "📱", label: "Phone", keywords: ["mobile", "call", "device"] },
  { emoji: "🧿", label: "Evil eye", keywords: ["protect", "luck", "blue"] },
  { emoji: "🪄", label: "Magic wand", keywords: ["magic", "sparkle", "effect"] },
  { emoji: "🧯", label: "Fire extinguisher", keywords: ["fire", "stop", "safety"] },
  { emoji: "⚽", label: "Football", keywords: ["football", "sports", "soccer"] },
  { emoji: "🏏", label: "Cricket", keywords: ["cricket", "sports", "bat"] },
  { emoji: "🏍️", label: "Motorbike", keywords: ["bike", "speed", "ride"] },
  { emoji: "🚗", label: "Car", keywords: ["car", "drive", "travel"] },
  { emoji: "✈️", label: "Flight", keywords: ["travel", "plane", "trip"] },
  { emoji: "🏝️", label: "Island", keywords: ["vacation", "beach", "travel"] },
  { emoji: "🌆", label: "City", keywords: ["city", "night", "urban"] },
];

const palettePairs = [
  ["#f59e0b", "#22c55e"], ["#f97316", "#84cc16"], ["#ec4899", "#ef4444"], ["#fb7185", "#a855f7"],
  ["#8b5cf6", "#06b6d4"], ["#2563eb", "#7c3aed"], ["#f59e0b", "#eab308"], ["#475569", "#0f172a"],
  ["#22c55e", "#14b8a6"], ["#38bdf8", "#6366f1"], ["#06b6d4", "#3b82f6"], ["#16a34a", "#22c55e"],
  ["#dc2626", "#f97316"], ["#0ea5e9", "#2563eb"], ["#a855f7", "#ec4899"], ["#111827", "#0891b2"],
  ["#92400e", "#f59e0b"], ["#a16207", "#84cc16"], ["#7c3aed", "#f59e0b"], ["#e11d48", "#f43f5e"],
];
const telegramStylePacks = emojiCatalog.map((item, index) => ({
  ...item,
  c1: palettePairs[index % palettePairs.length][0],
  c2: palettePairs[index % palettePairs.length][1],
}));

function makeBuiltInPackItems() {
  const groups = [
    { pack: "Glam reactions", tags: ["glam", "fashion", "style", "queen"], items: [["💃", "Dance queen"], ["💅", "Slay"], ["👑", "Queen energy"], ["💄", "Makeup mood"], ["👠", "Style walk"], ["💎", "Diamond glow"], ["🦋", "Pretty vibe"], ["🌹", "Rose drop"], ["✨", "Glow up"], ["💋", "Kiss mark"]] },
    { pack: "Meme reactions", tags: ["meme", "funny", "reaction"], items: [["😂", "Dead laughing"], ["🤣", "ROFL loop"], ["💀", "I am dead"], ["🤡", "Clown moment"], ["🗿", "Stone face"], ["🤯", "Brain blast"], ["😬", "Awkward"], ["🙃", "Sarcasm"], ["👀", "Watching"], ["🔥", "That is fire"]] },
    { pack: "Cute animals", tags: ["cute", "animal", "pet"], items: [["🐱", "Happy cat"], ["🐶", "Good dog"], ["🐼", "Panda hug"], ["🦊", "Fox wink"], ["🐻", "Bear hug"], ["🐨", "Sleepy koala"], ["🐵", "Monkey fun"], ["🦄", "Magic unicorn"], ["🐣", "Tiny chick"], ["🦋", "Butterfly sparkle"]] },
    { pack: "Work fast", tags: ["work", "code", "secure", "productivity"], items: [["💻", "Code mode"], ["⚡", "Fast lane"], ["🚀", "Ship it"], ["✅", "Done"], ["🧠", "Big brain"], ["💡", "Idea"], ["🔒", "Locked"], ["🔐", "Encrypted"], ["🛠️", "Fixing"], ["📎", "Attached"]] },
    { pack: "Party", tags: ["party", "celebrate", "birthday"], items: [["🎉", "Confetti"], ["🥳", "Party face"], ["🎂", "Birthday"], ["🎁", "Gift"], ["🏆", "Winner"], ["⭐", "Star"], ["🌟", "Glow"], ["💥", "Boom"], ["🙌", "Hands up"], ["🕺", "Dance move"]] },
  ];
  const out = [];
  let index = 0;
  for (const group of groups) {
    for (const [emoji, label] of group.items) {
      const colors = palettePairs[index % palettePairs.length];
      out.push({
        id: `builtin_${group.pack.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${index}`,
        source: group.pack,
        emoji,
        label,
        kind: index % 2 === 0 ? "gif" : "sticker",
        keywords: [...group.tags, label.toLowerCase(), emoji],
        c1: colors[0],
        c2: colors[1],
      });
      index += 1;
    }
  }
  return out;
}
const builtInPackItems = makeBuiltInPackItems();

function makeV26ExtraPackItems() {
  const groups = [
    { pack: "Hot reactions", tags: ["hot", "crazy", "wild", "spicy", "attitude", "bold"], items: [["🔥", "Too hot"], ["🥵", "Heat wave"], ["😈", "Mischief mode"], ["🤪", "Crazy energy"], ["⚡", "Electric mood"], ["💥", "Explosive reply"], ["🌶️", "Spicy take"], ["🧨", "Dynamite"], ["👑", "Boss move"], ["💯", "Peak energy"], ["🕶️", "Cool flex"], ["💎", "Premium vibe"]] },
    { pack: "Flirty safe", tags: ["flirt", "cute", "glam", "crush", "wink", "style"], items: [["😉", "Smooth wink"], ["😍", "Heart eyes"], ["😘", "Kiss drop"], ["🥰", "Soft crush"], ["💋", "Lip mark"], ["🌹", "Rose energy"], ["🦋", "Butterfly vibe"], ["💅", "Slay mode"], ["✨", "Glow up"], ["💄", "Glam shot"], ["🫦", "Cheeky reaction"], ["🤭", "Secret smile"]] },
    { pack: "Dark memes", tags: ["dark", "meme", "sarcasm", "dead", "weird"], items: [["💀", "Dead again"], ["🗿", "No reaction"], ["🤡", "Clown alert"], ["🙃", "Not okay"], ["😵‍💫", "Confused spiral"], ["🫠", "Melting"], ["😬", "Yikes"], ["👁️", "I saw that"], ["🕳️", "Disappear"], ["🥴", "Broken logic"], ["🤨", "Really"], ["😶‍🌫️", "Vanished"]] },
    { pack: "Love and drama", tags: ["love", "heart", "sad", "drama", "miss", "cute"], items: [["❤️", "Love blast"], ["💘", "Cupid hit"], ["💖", "Sparkle heart"], ["💞", "Heart loop"], ["💔", "Heart broken"], ["😭", "Drama cry"], ["🥺", "Please face"], ["😢", "Soft tears"], ["🤗", "Hug drop"], ["🫶", "Heart hands"], ["💌", "Love note"], ["🌙", "Night mood"]] },
    { pack: "Gaming chaos", tags: ["game", "gaming", "win", "lose", "rage", "gg"], items: [["🎮", "Game on"], ["🏆", "Winner"], ["🥇", "First place"], ["💣", "Bomb planted"], ["🕹️", "Retro play"], ["👾", "Alien mode"], ["🛡️", "Shield up"], ["⚔️", "Fight"], ["🧟", "Zombie mode"], ["🎯", "Perfect aim"], ["🔥", "Kill streak"], ["😤", "Rage queue"]] },
    { pack: "Indian reactions", tags: ["india", "desi", "chai", "cricket", "namaste", "bro"], items: [["🙏", "Namaste"], ["☕", "Chai break"], ["🏏", "Cricket mode"], ["🪔", "Diya glow"], ["🎇", "Festival blast"], ["🌶️", "Mirchi reply"], ["🥭", "Mango mood"], ["🛺", "Auto ride"], ["🐯", "Tiger energy"], ["🧿", "Nazar safe"], ["💃", "Desi dance"], ["🔥", "Full power"]] },
  ];
  const out = [];
  let index = 0;
  for (const group of groups) {
    for (const [emoji, label] of group.items) {
      const colors = palettePairs[(index + 7) % palettePairs.length];
      out.push({
        id: `v26_${group.pack.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${index}`,
        source: group.pack,
        emoji,
        label,
        kind: index % 3 === 0 ? "sticker" : "gif",
        keywords: [...group.tags, label.toLowerCase(), emoji],
        c1: colors[0],
        c2: colors[1],
      });
      index += 1;
    }
  }
  return out;
}
const v26ExtraPackItems = makeV26ExtraPackItems();

function makeV36MegaPackItems() {
  const groups = [
    { pack: "WhatsApp GIF moods", tags: ["gif", "mood", "reaction", "whatsapp"], items: [["😂","Laugh attack"],["🤣","Rolling laugh"],["😭","Crying hard"],["😱","Shock wave"],["😎","Cool entry"],["🤯","Mind blown"],["🥳","Celebration loop"],["😴","Sleep mode"],["🤫","Secret drop"],["😤","Angry steam"],["🥶","Cold reply"],["🥴","Confused vibe"],["😇","Innocent face"],["🙄","Eye roll"],["😏","Smirk move"]] },
    { pack: "Telegram animated classics", tags: ["telegram", "animated", "emoji", "classic"], items: [["❤️","Heart pulse"],["🔥","Fire burst"],["👍","Thumbs up pop"],["👎","Thumbs down drop"],["🙏","Prayer glow"],["👏","Clap loop"],["💪","Power flex"],["👀","Eyes peek"],["💯","Hundred smash"],["✨","Sparkle rain"],["⭐","Star bounce"],["🎯","Target hit"],["💣","Bomb boom"],["🚀","Rocket launch"],["⚡","Lightning zap"]] },
    { pack: "Meme replies", tags: ["meme", "funny", "internet", "viral"], items: [["🗿","Stone face"],["🤡","Clown moment"],["💀","Dead meme"],["🐸","Frog stare"],["☕","Tea sip"],["🍿","Drama popcorn"],["🧠","Galaxy brain"],["📉","Down bad"],["📈","Stonks"],["🫠","Melting reply"],["🙃","Upside chaos"],["🤌","Chef kiss"],["🫡","Respect salute"],["🫥","Invisible mode"],["🥲","Pain smile"]] },
    { pack: "Love premium", tags: ["love", "heart", "romance", "cute"], items: [["😍","Heart eyes loop"],["🥰","Warm blush"],["😘","Kiss fly"],["💋","Lip stamp"],["💌","Love letter"],["💘","Cupid strike"],["💖","Heart glitter"],["💞","Heart orbit"],["💕","Two hearts"],["🫶","Hand heart"],["🌹","Rose bloom"],["🦋","Butterflies"],["🌙","Moon miss you"],["🥺","Please please"],["🤗","Hug cloud"]] },
    { pack: "Desi reactions", tags: ["desi", "india", "hindi", "local", "bollywood"], items: [["🙏","Namaste glow"],["☕","Chai loading"],["🏏","Cricket six"],["🎇","Festival blast"],["🪔","Diya shine"],["🌶️","Mirchi mode"],["🥭","Mango season"],["🛺","Auto horn"],["🐯","Sher energy"],["🧿","Nazar shield"],["💃","Bollywood step"],["🕺","Dance floor"],["👑","Raja move"],["🔥","Full power"],["😎","Bhai swag"]] },
    { pack: "Work and coding", tags: ["work", "code", "office", "startup", "dev"], items: [["💻","Coding sprint"],["🐛","Bug found"],["🛠️","Fix deploy"],["🚨","Prod alert"],["✅","Task done"],["📎","File attached"],["🧪","Testing"],["📦","Package ship"],["🔒","Secure mode"],["🧯","Fire fighting"],["📅","Meeting incoming"],["☕","Coffee build"],["🧩","Architecture"],["🧠","Deep work"],["🚀","Release launch"]] },
    { pack: "Gaming", tags: ["gaming", "game", "gg", "rage", "win"], items: [["🎮","Game on"],["🕹️","Retro play"],["🏆","Victory"],["🥇","First place"],["🎯","Headshot"],["💣","Bomb planted"],["⚔️","Duel"],["🛡️","Shield"],["🧟","Zombie rush"],["👾","Alien spawn"],["🔥","Kill streak"],["😤","Rage queue"],["💀","You died"],["🫡","GG salute"],["📡","Lag detected"]] },
    { pack: "Animals cute", tags: ["animal", "cute", "pet", "cat", "dog"], items: [["🐱","Cat bounce"],["🐶","Dog tail"],["🐼","Panda hug"],["🦊","Fox wink"],["🐻","Bear cuddle"],["🐨","Koala sleep"],["🐵","Monkey laugh"],["🦄","Unicorn magic"],["🐣","Chick pop"],["🦋","Butterfly fly"],["🐧","Penguin slide"],["🐰","Bunny hop"],["🐢","Slow turtle"],["🐬","Dolphin jump"],["🦁","Lion roar"]] },
  ];
  const out = [];
  let index = 0;
  for (const group of groups) {
    for (const [emoji, label] of group.items) {
      const colors = palettePairs[(index + 17) % palettePairs.length];
      out.push({
        id: `v36_${group.pack.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${index}`,
        source: group.pack,
        emoji,
        label,
        kind: index % 2 === 0 ? "gif" : "sticker",
        keywords: [...group.tags, label.toLowerCase(), emoji],
        c1: colors[0],
        c2: colors[1],
      });
      index += 1;
    }
  }
  return out;
}
const v36MegaPackItems = makeV36MegaPackItems();

function makeV46HugeMediaItems() {
  const packs = [
    { name: "Everyday reactions", tags: ["daily", "reply", "reaction"], emojis: ["😀","😄","😂","🤣","😊","😎","🤩","🥳","😮","😳","😬","🙄","😴","🤔","🫡","👍","👌","👏","🙏","👀","✅","❌","🔥","💯"] },
    { name: "Love and cute", tags: ["love", "cute", "heart", "romance"], emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","💘","💖","💗","💓","💕","💞","💌","😍","🥰","😘","🥺","🤗","🫶","🌹","🦋"] },
    { name: "Meme zone", tags: ["meme", "funny", "viral", "internet"], emojis: ["💀","🗿","🤡","🙃","🫠","😵‍💫","🥴","🤨","😶‍🌫️","🫥","🐸","🍿","☕","📈","📉","🧠","🤌","😤","😈","👁️","🕳️","🧨","💥","⚰️"] },
    { name: "Desi and India", tags: ["desi", "india", "hindi", "local"], emojis: ["🙏","☕","🏏","🪔","🎇","🌶️","🥭","🛺","🐯","🧿","💃","🕺","👑","🔥","😎","🎉","🎶","🥁","🌙","✨","💫","🍛","🫓","🚩"] },
    { name: "Work and tech", tags: ["work", "code", "tech", "office"], emojis: ["💻","⌨️","🖥️","🐛","🛠️","🚨","✅","📎","🧪","📦","🔒","🔐","🧯","📅","☕","🧩","🧠","💡","🚀","⚡","📊","📌","📝","🔍"] },
    { name: "Gaming and sports", tags: ["gaming", "sports", "game", "win"], emojis: ["🎮","🕹️","🏆","🥇","🎯","💣","⚔️","🛡️","🧟","👾","🔥","😤","💀","🫡","📡","⚽","🏏","🏀","🏐","🎾","🏁","🚗","🏍️","✈️"] },
    { name: "Animals and pets", tags: ["animal", "cute", "pet"], emojis: ["🐱","🐶","🐼","🦊","🐻","🐨","🐵","🦄","🐣","🦋","🐧","🐰","🐢","🐬","🦁","🐯","🐮","🐷","🐸","🐙","🦜","🐝","🐞","🦖"] },
    { name: "Food and mood", tags: ["food", "hungry", "snack"], emojis: ["🍕","🍔","🍟","🌮","🍜","🍛","🍫","🍩","🍪","🎂","🍰","🍦","🍿","☕","🧋","🥤","🍺","🍎","🥭","🍓","🌶️","🥗","🍗","🍳"] },
    { name: "Travel and weather", tags: ["travel", "weather", "place"], emojis: ["🌍","🌙","☀️","🌈","🌧️","❄️","⚡","🌊","🔥","🏝️","🌆","🏔️","🚀","🛸","✈️","🚗","🏍️","🚆","🛶","⛺","🧭","📍","🗺️","🌌"] },
    { name: "Security and ChatE", tags: ["secure", "private", "encrypted", "chate"], emojis: ["🔒","🔐","🛡️","🧿","🔑","🗝️","📎","📷","🎙️","📱","💻","✅","⚠️","🚨","👀","🫥","🕵️","🧠","⚡","🚀","💬","📨","📡","🧬"] },
    { name: "Premium party", tags: ["party", "celebrate", "premium"], emojis: ["🎉","🥳","🎂","🎁","🏆","⭐","🌟","💥","🙌","🕺","💃","✨","💫","🎇","🎆","🥂","🎵","🎧","🎤","🎸","🥁","👑","💎","🚀"] },
    { name: "Attitude and style", tags: ["attitude", "style", "swag"], emojis: ["😎","😏","😈","🤫","🤌","💅","👑","💎","🕶️","🔥","💯","⚡","🦁","🐯","🗿","👀","💋","🌹","🦋","✨","💄","👠","🧥","🪄"] },
  ];
  const moods = ["pop", "bounce", "pulse", "loop", "blast", "shine", "drop", "wave", "spin", "spark", "flash", "glow"];
  const out = [];
  let index = 0;
  for (const pack of packs) {
    for (const emoji of pack.emojis) {
      for (let variant = 0; variant < 2; variant += 1) {
        const mood = moods[(index + variant) % moods.length];
        const colors = palettePairs[(index + variant * 5) % palettePairs.length];
        out.push({
          id: `v46_${pack.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${index}_${variant}`,
          source: pack.name,
          emoji,
          label: `${pack.name.split(" ")[0]} ${mood}`,
          kind: (index + variant) % 3 === 0 ? "sticker" : "gif",
          keywords: [...pack.tags, mood, emoji, "whatsapp", "telegram", "animated", "sticker", "gif"],
          c1: colors[0],
          c2: colors[1],
        });
      }
      index += 1;
    }
  }
  return out;
}
const v46HugeMediaItems = makeV46HugeMediaItems();

function dedupePackItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.source || ""}|${item.label || ""}|${item.emoji || ""}|${item.kind || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
const allBuiltInPackItems = dedupePackItems([...builtInPackItems, ...v26ExtraPackItems, ...v36MegaPackItems, ...v46HugeMediaItems]);

const emojiList = emojiCatalog.map((item) => item.emoji);
const animatedStickerList = [...telegramStylePacks, ...allBuiltInPackItems.filter((item) => item.kind !== "gif")];
const gifStickerList = [...telegramStylePacks, ...allBuiltInPackItems.filter((item) => item.kind === "gif")];
let pickerSearchQuery = "";

function packSearchText(item) {
  if (!item._searchText) item._searchText = [item.label, item.source, item.emoji, ...(item.keywords || [])].join(" ").toLowerCase();
  return item._searchText;
}

function packSourceKey(source) {
  return `${source.length}:${source[0]?.id || "first"}:${source[source.length - 1]?.id || "last"}`;
}

function rememberPackSearchCache(key, value) {
  state.packSearchCache.set(key, value);
  if (state.packSearchCache.size > state.packSearchCacheLimit) {
    const first = state.packSearchCache.keys().next().value;
    state.packSearchCache.delete(first);
  }
}

function searchPackItems(query, source = telegramStylePacks, limit = 80) {
  const q = String(query || "").toLowerCase().replace(/^:/, "").trim();
  const cacheKey = `${packSourceKey(source)}|${limit}|${q}`;
  const cached = state.packSearchCache.get(cacheKey);
  if (cached) return cached;
  let result;
  if (!q) {
    result = source.slice(0, limit);
  } else {
    result = source
      .map((item) => {
        const label = String(item.label || "").toLowerCase();
        const keywords = item.keywords || [];
        const words = packSearchText(item);
        let score = 0;
        if (item.emoji === query || item.emoji === q) score += 100;
        if (label === q) score += 30;
        if (label.startsWith(q)) score += 20;
        for (const kw of keywords) {
          const k = String(kw).toLowerCase();
          if (k === q) { score += 18; break; }
          if (k.startsWith(q)) score += 10;
        }
        if (words.includes(q)) score += 5;
        return score > 0 ? { item, score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((row) => row.item);
  }
  rememberPackSearchCache(cacheKey, result);
  return result;
}

function getPackForEmoji(emoji) {
  return telegramStylePacks.find((item) => item.emoji === emoji) || null;
}

function getPackMatches(query, limit = 8) {
  const source = [...telegramStylePacks, ...allBuiltInPackItems, ...state.importedPackItems];
  return searchPackItems(query, source, limit);
}

function makeSparkleParticles(count = 7) {
  return Array.from({ length: count }, (_, i) => `<i style="--i:${i}"></i>`).join("");
}

function animatedEmojiMarkup(emoji, label = "Animated emoji") {
  return `<span class="tg-emoji-burst" aria-label="${escapeXml(label)}"><span class="tg-emoji-core">${escapeXml(emoji)}</span>${makeSparkleParticles()}</span>`;
}

const emojiPanel = $("emojiPanel");
let activePickerTab = "emoji";

function openPicker(tab = activePickerTab) {
  if (!emojiPanel) return;
  activePickerTab = tab;
  renderPicker(tab);
  emojiPanel.classList.remove("hidden");
}

function pickerTabButton(key, label, activeTab) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `picker-tab ${activeTab === key ? "active" : ""}`;
  btn.dataset.tab = key;
  btn.textContent = label;
  btn.setAttribute("aria-pressed", activeTab === key ? "true" : "false");
  return btn;
}

function renderPicker(tab = "emoji") {
  if (!emojiPanel) return;
  const allowedTabs = new Set(["emoji", "animated", "stickers", "gif", "packs"]);
  activePickerTab = allowedTabs.has(tab) ? tab : "emoji";
  const wasHidden = emojiPanel.classList.contains("hidden");
  emojiPanel.className = `emoji-panel rich-picker ${activePickerTab === "packs" ? "with-pack-tools" : "no-pack-tools"}${wasHidden ? " hidden" : ""}`;
  emojiPanel.replaceChildren();

  const header = document.createElement("div");
  header.className = "picker-head";

  const searchWrap = document.createElement("div");
  searchWrap.className = "picker-search-wrap";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "picker-search";
  search.placeholder = "Search emoji, stickers, GIFs, hot, crazy, love, meme...";
  search.value = pickerSearchQuery;
  search.setAttribute("autocomplete", "off");
  searchWrap.appendChild(search);

  const tabs = document.createElement("div");
  tabs.className = "picker-tabs";
  tabs.setAttribute("role", "tablist");
  [
    ["emoji", "Emoji"],
    ["animated", "Animated"],
    ["stickers", "Stickers"],
    ["gif", "GIFs"],
    ["packs", "My packs"],
  ].forEach(([key, label]) => tabs.appendChild(pickerTabButton(key, label, activePickerTab)));

  const hint = document.createElement("div");
  hint.className = "picker-mini-hint";
  hint.textContent = activePickerTab === "emoji"
    ? "Tap emoji to insert. Long media is sent encrypted."
    : activePickerTab === "packs"
      ? "Your imported packs are stored locally in this browser."
      : "Tap any sticker/GIF to send encrypted.";

  header.append(searchWrap, tabs, hint);

  const importBar = document.createElement("div");
  importBar.className = "pack-import-bar";
  importBar.innerHTML = `
    <label class="small-btn pack-import-btn">Import media<input id="packMediaImportInput" type="file" accept="image/gif,image/webp,image/png,image/jpeg,image/svg+xml,video/webm,video/mp4" multiple hidden></label>
    <label class="small-btn pack-import-btn">Import JSON<input id="packJsonImportInput" type="file" accept="application/json" hidden></label>
    <button id="clearPacksBtn" type="button" class="small-btn danger-link">Clear packs</button>
  `;

  const grid = document.createElement("div");
  grid.className = `picker-grid picker-grid-${activePickerTab}`;

  const query = pickerSearchQuery;
  if (activePickerTab === "emoji") {
    const items = searchPackItems(query, emojiCatalog, 260);
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.emoji;
      btn.title = `${item.label} — ${(item.keywords || []).join(", ")}`;
      btn.className = "emoji-choice";
      btn.dataset.action = "insert-emoji";
      grid.appendChild(btn);
    }
  } else if (activePickerTab === "animated") {
    const source = [...telegramStylePacks, ...animatedStickerList, ...state.importedPackItems.filter((item) => item.kind !== "gif")];
    for (const item of searchPackItems(query, source, state.lowPowerMode ? 180 : 260)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sticker-choice animated-choice";
      btn.dataset.action = "send-sticker";
      btn.dataset.emoji = item.emoji || "✨";
      btn.dataset.label = item.label;
      if (item.dataUrl) btn.dataset.dataUrl = item.dataUrl;
      btn.innerHTML = item.dataUrl ? mediaThumbMarkup(item) : `${animatedEmojiMarkup(item.emoji || "✨", item.label || "Animated") }<span class="gif-label">${escapeXml(item.label || "Animated")}</span>`;
      grid.appendChild(btn);
    }
  } else if (activePickerTab === "stickers") {
    const source = [...animatedStickerList, ...allBuiltInPackItems, ...state.importedPackItems.filter((item) => item.kind !== "gif")];
    for (const item of searchPackItems(query, source, state.lowPowerMode ? 180 : 260)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sticker-choice";
      btn.dataset.action = "send-sticker";
      btn.dataset.emoji = item.emoji || "✨";
      btn.dataset.label = item.label;
      if (item.dataUrl) btn.dataset.dataUrl = item.dataUrl;
      btn.innerHTML = item.dataUrl ? mediaThumbMarkup(item) : `${animatedEmojiMarkup(item.emoji || "✨", item.label || "Sticker") }<span class="gif-label">${escapeXml(item.label || "Sticker")}</span>`;
      grid.appendChild(btn);
    }
  } else if (activePickerTab === "gif") {
    const source = [...gifStickerList, ...allBuiltInPackItems, ...state.importedPackItems.filter((item) => item.kind === "gif")];
    for (const item of searchPackItems(query, source, state.lowPowerMode ? 180 : 260)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gif-choice";
      btn.dataset.action = "send-gif";
      btn.dataset.emoji = item.emoji || "✨";
      btn.dataset.label = item.label;
      btn.dataset.c1 = item.c1 || "";
      btn.dataset.c2 = item.c2 || "";
      if (item.dataUrl) btn.dataset.dataUrl = item.dataUrl;
      btn.innerHTML = item.dataUrl ? mediaThumbMarkup(item) : `<div class="gif-thumb">${animatedEmojiMarkup(item.emoji || "✨", item.label || "GIF")}</div><span class="gif-label">${escapeXml(item.label || "GIF")}</span>`;
      grid.appendChild(btn);
    }
  } else {
    const source = state.importedPackItems;
    for (const item of searchPackItems(query, source, state.lowPowerMode ? 180 : 260)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = item.kind === "gif" ? "gif-choice" : "sticker-choice";
      btn.dataset.action = item.kind === "gif" ? "send-gif" : "send-sticker";
      btn.dataset.emoji = item.emoji || "✨";
      btn.dataset.label = item.label;
      if (item.dataUrl) btn.dataset.dataUrl = item.dataUrl;
      btn.innerHTML = mediaThumbMarkup(item);
      grid.appendChild(btn);
    }
  }

  if (!grid.children.length) {
    const empty = document.createElement("p");
    empty.className = "hint picker-empty";
    empty.textContent = activePickerTab === "packs" ? "No imported packs yet. Import GIF/WebP/PNG/SVG/WebM/MP4 or JSON packs." : "No matches. Try hot, crazy, laugh, love, fire, cat, meme, desi, work, rocket.";
    grid.appendChild(empty);
  }

  if (activePickerTab === "packs") {
    emojiPanel.append(header, importBar, grid);
  } else {
    emojiPanel.append(header, grid);
  }
  search.addEventListener("click", (event) => event.stopPropagation());
  search.addEventListener("input", (event) => {
    pickerSearchQuery = event.target.value || "";
    clearTimeout(search._pickerTimer);
    search._pickerTimer = setTimeout(() => {
      renderPicker(activePickerTab);
      const next = emojiPanel.querySelector(".picker-search");
      if (next) {
        next.focus({ preventScroll: true });
        next.setSelectionRange(next.value.length, next.value.length);
      }
    }, state.lowPowerMode ? 220 : 90);
  });
  const mediaInput = emojiPanel.querySelector("#packMediaImportInput");
  if (mediaInput) mediaInput.addEventListener("change", async (event) => {
    try { await importStickerMediaFiles(event.target.files || []); openPicker("packs"); }
    catch (err) { toast(err.message, 6000); }
  });
  const jsonInput = emojiPanel.querySelector("#packJsonImportInput");
  if (jsonInput) jsonInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await importStickerJsonPack(file); openPicker("packs"); }
    catch (err) { toast(err.message, 6000); }
  });
  const clearBtn = emojiPanel.querySelector("#clearPacksBtn");
  if (clearBtn) clearBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    clearImportedPacks().catch((err) => toast(err.message, 6000));
  });
}

const smartSuggestTray = $("smartSuggestTray");
let smartSuggestContext = null;

function getTypedSuggestionContext() {
  const input = $("messageInput");
  if (!input) return null;
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const compact = before.replace(/\s+$/g, "");
  if (!compact) return null;

  // Telegram-style colon shortcuts like :heart, :lol, :fire.
  const colon = compact.match(/(?:^|\s):([a-z0-9_+-]{1,28})$/i);
  if (colon) {
    const matches = getPackMatches(colon[1], 10);
    if (matches.length) return { mode: "shortcut", token: `:${colon[1]}`, matches };
  }

  // Static emoji typed at the cursor should offer matching animated stickers/GIFs.
  const emojiCandidates = [...telegramStylePacks].sort((a, b) => b.emoji.length - a.emoji.length);
  for (const item of emojiCandidates) {
    if (compact.endsWith(item.emoji)) {
      const related = [item, ...getPackMatches(item.emoji, 10).filter((x) => x.emoji !== item.emoji)];
      return { mode: "emoji", token: item.emoji, matches: related.slice(0, 10) };
    }
  }

  return null;
}

function hideSmartSuggestionTray() {
  if (smartSuggestTray) smartSuggestTray.classList.add("hidden");
  smartSuggestContext = null;
}

function renderSmartSuggestionTray() {
  if (!smartSuggestTray) return;
  const context = getTypedSuggestionContext();
  smartSuggestContext = context;
  if (!context || !state.peer || state.sendingMessage) {
    smartSuggestTray.classList.add("hidden");
    smartSuggestTray.replaceChildren();
    return;
  }

  smartSuggestTray.className = "smart-suggest-tray";
  smartSuggestTray.replaceChildren();

  const top = document.createElement("div");
  top.className = "smart-suggest-top";
  const title = document.createElement("strong");
  title.textContent = context.mode === "shortcut" ? `Suggestions for ${context.token}` : `Animated picks for ${context.token}`;
  const hint = document.createElement("span");
  hint.textContent = "Tap to send encrypted animated emoji, GIF, or sticker";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "smart-suggest-close";
  close.dataset.action = "close-suggestions";
  close.textContent = "×";
  top.append(title, hint, close);

  const row = document.createElement("div");
  row.className = "smart-suggest-row";
  context.matches.slice(0, 8).forEach((item, index) => {
    const sticker = document.createElement("button");
    sticker.type = "button";
    sticker.className = "smart-suggestion-card";
    sticker.dataset.action = "send-sticker";
    sticker.dataset.emoji = item.emoji;
    sticker.dataset.label = item.label;
    sticker.innerHTML = item.dataUrl ? mediaThumbMarkup(item, "") : `${animatedEmojiMarkup(item.emoji, item.label)}<span>${escapeXml(item.label)}</span>`;
    row.appendChild(sticker);

    if (index < 4) {
      const gif = document.createElement("button");
      gif.type = "button";
      gif.className = "smart-suggestion-card gif-suggestion";
      gif.dataset.action = "send-gif";
      gif.dataset.emoji = item.emoji;
      gif.dataset.label = `${item.label} GIF`;
      gif.dataset.c1 = item.c1;
      gif.dataset.c2 = item.c2;
      gif.innerHTML = item.dataUrl ? mediaThumbMarkup(item, "") : `<div class="mini-gif-bg">${animatedEmojiMarkup(item.emoji, item.label)}</div><span>GIF</span>`;
      row.appendChild(gif);
    }
  });

  smartSuggestTray.append(top, row);
}

async function sendStickerOrGifFromButton(btn) {
  if (!state.peer) return toast("Select a chat first.");
  if (!(await ensurePeerKeySafeForSend())) return;
  if (state.sendingMessage) return;
  setComposerBusy(true);
  try {
    const action = btn.dataset.action;
    if (action === "send-sticker") {
      await sendStructuredMessage("sticker", {
        version: 3,
        kind: btn.dataset.dataUrl ? "imported_sticker" : "telegram_style_animated_emoji",
        emoji: btn.dataset.emoji || "✨",
        label: btn.dataset.label || "Animated emoji",
        dataUrl: btn.dataset.dataUrl || null,
      });
      toast("Encrypted animated emoji sent.");
    } else if (action === "send-gif") {
      const item = {
        emoji: btn.dataset.emoji || "✨",
        label: btn.dataset.label || "GIF",
        c1: btn.dataset.c1,
        c2: btn.dataset.c2,
      };
      await sendStructuredMessage("gif", {
        version: 3,
        kind: btn.dataset.dataUrl ? "imported_gif" : "telegram_style_built_in_gif",
        label: item.label,
        dataUrl: btn.dataset.dataUrl || makeAnimatedGifDataUrl(item),
      });
      toast("Encrypted GIF sent.");
    }
    hideSmartSuggestionTray();
    if (emojiPanel) emojiPanel.classList.add("hidden");
    scheduleConversationRefresh(4500);
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    setComposerBusy(false);
    renderSmartSuggestionTray();
  }
}

if (smartSuggestTray) smartSuggestTray.addEventListener("click", async (e) => {
  const close = e.target.closest("[data-action='close-suggestions']");
  if (close) {
    hideSmartSuggestionTray();
    return;
  }
  const btn = e.target.closest("button[data-action='send-sticker'], button[data-action='send-gif']");
  if (btn) await sendStickerOrGifFromButton(btn);
});

const emojiBtn = $("emojiBtn");
if (emojiBtn && emojiPanel) emojiBtn.addEventListener("click", () => {
  if (!emojiPanel.classList.contains("hidden") && activePickerTab === "emoji") {
    emojiPanel.classList.add("hidden");
  } else {
    openPicker("emoji");
  }
});
const gifBtn = $("gifBtn");
if (gifBtn && emojiPanel) gifBtn.addEventListener("click", () => {
  if (!emojiPanel.classList.contains("hidden") && activePickerTab === "gif") {
    emojiPanel.classList.add("hidden");
  } else {
    openPicker("gif");
  }
});

if (emojiPanel) emojiPanel.addEventListener("click", async (e) => {
  const tabBtn = e.target.closest(".picker-tab");
  if (tabBtn) {
    e.preventDefault();
    e.stopPropagation();
    activePickerTab = tabBtn.dataset.tab || "emoji";
    renderPicker(activePickerTab);
    emojiPanel.classList.remove("hidden");
    return;
  }

  const btn = e.target.closest("button[data-action]");
  const input = $("messageInput");
  if (!btn) return;

  if (btn.dataset.action === "insert-emoji") {
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = `${input.value.slice(0, start)}${btn.textContent}${input.value.slice(end)}`;
    const pos = start + btn.textContent.length;
    input.focus();
    input.setSelectionRange(pos, pos);
    saveDraft();
    autoGrowComposer();
    renderSmartSuggestionTray();
    return;
  }

  await sendStickerOrGifFromButton(btn);
});

renderPicker("emoji");

function closePickerOnOutsideClick(e) {
  if (!emojiPanel || emojiPanel.classList.contains("hidden")) return;
  if (e.target.closest("#emojiPanel") || e.target.closest("#emojiBtn") || e.target.closest("#gifBtn")) return;
  emojiPanel.classList.add("hidden");
}
document.addEventListener("click", closePickerOnOutsideClick);

const recordBtn = $("recordBtn");
const cancelRecordingBtn = $("cancelRecordingBtn");
const sendRecordingBtn = $("sendRecordingBtn");

async function stopVoiceRecordingAndSend(send = true) {
  const recorder = state.mediaRecorder;
  if (!recorder || recorder.state === "inactive") return;
  state.cancelRecording = !send;
  recorder.stop();
}

async function startVoiceRecording() {
  if (!state.peer || !state.token) return toast("Select a chat first.");
  if (!navigator.mediaDevices?.getUserMedia) return toast("Voice recording is not supported in this browser.");
  if (state.mediaRecorder && state.mediaRecorder.state === "recording") return stopVoiceRecordingAndSend(true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    state.mediaRecorder = recorder;
    state.recordedChunks = [];
    state.cancelRecording = false;
    recorder.ondataavailable = (event) => {
      if (event.data?.size) state.recordedChunks.push(event.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      recordBtn?.classList.remove("recording");
      if (recordBtn) recordBtn.textContent = "🎙";
      state.recording = false;
      hideRecordingTray();
      sendPresence("online", state.peer?.id || null).catch(() => {});
      const blob = new Blob(state.recordedChunks, { type: recorder.mimeType || "audio/webm" });
      state.recordedChunks = [];
      if (state.cancelRecording) {
        state.cancelRecording = false;
        return toast("Voice recording discarded.");
      }
      if (blob.size < 800) return toast("Voice note was too short.");
      const file = new File([blob], `voice-note-${Date.now()}.webm`, { type: blob.type || "audio/webm" });
      setComposerBusy(true);
      try {
        toast("Encrypting voice note...");
        await sendEncryptedAttachment(file);
        await loadMessages({ force: true, preserveScroll: false });
        await loadConversations({ silent: true });
        toast("Encrypted voice note sent.");
      } catch (err) {
        toast(err.message, 6000);
      } finally {
        setComposerBusy(false);
      }
    };
    recorder.start(500);
    state.recording = true;
    state.recordingStartedAt = Date.now();
    recordBtn?.classList.add("recording");
    if (recordBtn) recordBtn.textContent = "■";
    showRecordingTray();
    sendPresence("recording", state.peer.id).catch(() => {});
  } catch (err) {
    hideRecordingTray();
    toast(err.message || "Microphone permission denied.", 5200);
  }
}

if (recordBtn) {
  recordBtn.addEventListener("click", async () => {
    if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
      await stopVoiceRecordingAndSend(true);
    } else {
      await startVoiceRecording();
    }
  });
}
if (cancelRecordingBtn) cancelRecordingBtn.addEventListener("click", () => stopVoiceRecordingAndSend(false));
if (sendRecordingBtn) sendRecordingBtn.addEventListener("click", () => stopVoiceRecordingAndSend(true));

document.addEventListener("visibilitychange", () => {
  if (!state.token || !state.user) return;
  if (document.hidden) {
    sendPresence("idle", state.peer?.id || null).catch(() => {});
    return;
  }
  if (!state.realtimeConnected) connectRealtime();
  sendPresence("online", state.peer?.id || null).catch(() => {});
  checkTrustedDevicePrompts().catch(() => null);
});
window.addEventListener("pagehide", () => {
  if (!state.token || !state.user) return;
  try {
    fetch(`${API}/presence`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ status: "offline", peer_id: state.peer?.id || null }),
    }).catch(() => {});
  } catch (_) {}
});

window.addEventListener("online", () => {
  updateNetworkUi();
  replayOutbox().catch((err) => toast(err.message, 5200));
});
window.addEventListener("offline", () => updateNetworkUi());
const retryOutboxBtn = $("retryOutboxBtn");
if (retryOutboxBtn) retryOutboxBtn.addEventListener("click", () => replayOutbox().catch((err) => toast(err.message, 5200)));

if (window.visualViewport) {
  const syncViewport = () => {
    const inset = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
    document.documentElement.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
    document.body.classList.toggle("keyboard-open", inset > 80);
  };
  window.visualViewport.addEventListener("resize", syncViewport);
  window.visualViewport.addEventListener("scroll", syncViewport);
  syncViewport();
}


bootstrap();

