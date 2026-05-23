const API = "/api";

const state = {
  token: localStorage.getItem("chate_token"),
  user: JSON.parse(localStorage.getItem("chate_user") || "null"),
  deferredInstallPrompt: null,
  crop: {
    fileUrl: null,
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
    dragging: false,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    naturalWidth: 0,
    naturalHeight: 0,
  },
};

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

const themeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function applyThemePreference() {
  const pref = localStorage.getItem("chate_theme") || "system";
  const dark = pref === "dark" || (pref === "system" && Boolean(themeQuery?.matches));
  document.body.classList.toggle("dark", dark);
  const select = $("themeSelect");
  if (select) select.value = pref;
}

if (themeQuery?.addEventListener) {
  themeQuery.addEventListener("change", () => {
    if ((localStorage.getItem("chate_theme") || "system") === "system") applyThemePreference();
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  const btn = $("installAppBtn");
  if (btn) btn.disabled = false;
});

function toast(message, timeout = 3400) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), timeout);
}

const EMAIL_COOLDOWN_MS = 30_000;
const emailCooldownTimers = new Map();

function startButtonCooldown(button, storageKey, label, ms = EMAIL_COOLDOWN_MS) {
  if (!button) return;
  localStorage.setItem(storageKey, String(Date.now() + ms));
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
  const key = `chate_email_cooldown_v50:${scope}:${String(identity || "current").trim().toLowerCase()}`;
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

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("chate_token", token);
  localStorage.setItem("chate_user", JSON.stringify(user));
}

function clearSession(revokeTrustedDevice = false) {
  if (revokeTrustedDevice) {
    clearDeviceUnlockSecrets();
    idbClearStore("unlockedKeys").catch(() => {});
    clearMessagesUnlockedThisLogin();
  }
  localStorage.removeItem("chate_token");
  localStorage.removeItem("chate_user");
  state.token = null;
  state.user = null;
}

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
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("Network timeout. Check connection and retry.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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

function publicKeyIdentity(jwk) {
  if (!jwk) return null;
  return { kty: jwk.kty || "RSA", n: jwk.n, e: jwk.e };
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

async function idbGet(storeName, key) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, key, value) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClearStore(storeName) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

function deviceSecretStorageKey(userId = state.user?.id) {
  return userId ? `chate_device_unlock_secret:${userId}` : null;
}

function sessionUnlockFlagKey(userId = state.user?.id) {
  return userId ? `chate_messages_unlocked_this_login:${userId}` : null;
}

function markMessagesUnlockedThisLogin() {
  const key = sessionUnlockFlagKey();
  if (key) sessionStorage.setItem(key, "1");
}

function clearMessagesUnlockedThisLogin(userId = state.user?.id) {
  const key = sessionUnlockFlagKey(userId);
  if (key) sessionStorage.removeItem(key);
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

async function getOrCreateDeviceCacheKey() {
  const key = deviceSecretStorageKey();
  if (!key) throw new Error("Login required before trusting this device.");
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
  await idbPut("unlockedKeys", `trusted:${state.user.id}:${fingerprint}`, {
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

async function saveEncryptedKeyPackage(pkg, makeActive = true) {
  const fingerprint = await fingerprintPublicJwk(pkg.publicKeyJwk);
  await idbPut("keyPackages", `key:${fingerprint}`, pkg);
  if (makeActive) await idbPut("keyPackages", "active", fingerprint);
  return fingerprint;
}

async function loadEncryptedKeyPackage() {
  const active = await idbGet("keyPackages", "active");
  if (active) {
    const pkg = await idbGet("keyPackages", `key:${active}`);
    if (pkg) return pkg;
  }
  const legacy = await idbGet("keyPackages", "default");
  if (legacy) {
    const fingerprint = await saveEncryptedKeyPackage(legacy, true);
    return await idbGet("keyPackages", `key:${fingerprint}`);
  }
  return null;
}

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
  await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  return { privateJwk, publicKeyJwk: pkg.publicKeyJwk };
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

async function updateMyPublicKey(publicKeyJwk) {
  const user = await api("/users/me/public-key", {
    method: "PUT",
    body: JSON.stringify({ public_key_jwk: publicKeyJwk }),
  });
  saveSession(state.token, user);
  return user;
}

function parseServerDate(value) {
  if (!value) return null;
  const raw = String(value);
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fmtDate(value) {
  const parsed = parseServerDate(value);
  return parsed ? parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never";
}

function renderSettings(data) {
  $("settingsUser").textContent = `@${data.username}`;
  $("settingsEmail").textContent = data.email;
  const isEmailVerified = Boolean(data.email_verified_at);
  if ($("emailVerifiedStatus")) $("emailVerifiedStatus").textContent = isEmailVerified ? `Verified · ${fmtDate(data.email_verified_at)}` : "Not verified";
  const emailVerificationRow = $("emailVerificationRow");
  const sendVerificationEmailBtn = $("sendVerificationEmailBtn");
  if (emailVerificationRow) emailVerificationRow.classList.toggle("hidden", isEmailVerified);
  if (sendVerificationEmailBtn) {
    sendVerificationEmailBtn.disabled = isEmailVerified;
    sendVerificationEmailBtn.setAttribute("aria-hidden", isEmailVerified ? "true" : "false");
  }
  $("lastLogin").textContent = fmtDate(data.last_login_at);
  $("lastSeen").textContent = fmtDate(data.last_seen_at);
  $("autoDeleteAfterDays").value = data.auto_delete_after_days ? String(data.auto_delete_after_days) : "";
  if ($("defaultDisappearingSeconds")) $("defaultDisappearingSeconds").value = data.default_disappearing_seconds ? String(data.default_disappearing_seconds) : "";
  if ($("profileDisplayName")) $("profileDisplayName").value = data.display_name || data.username || "";
  if ($("profileBio")) $("profileBio").value = data.bio || "";
  if ($("publicShowDisplayName")) $("publicShowDisplayName").checked = data.public_show_display_name !== false;
  if ($("publicShowAvatar")) $("publicShowAvatar").checked = data.public_show_avatar !== false;
  if ($("publicShowBio")) $("publicShowBio").checked = data.public_show_bio !== false;
  if ($("publicShowEmail")) $("publicShowEmail").checked = data.public_show_email === true;
  if ($("publicShowLastSeen")) $("publicShowLastSeen").checked = data.public_show_last_seen === true;
  setAvatarElement($("profileAvatarPreview"), { ...state.user, avatar_url: data.avatar_url, display_name: data.display_name, username: data.username });
  renderSecurityPanel().catch(() => {});
}

function groupFingerprint(fp) {
  return String(fp || "").match(/.{1,8}/g)?.join(" ") || "Unavailable";
}

function setSecurityStatus(el, text, level = "neutral", title = "") {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("security-ok", "security-warn", "security-bad", "security-neutral");
  el.classList.add(`security-${level}`);
  if (title) el.title = title;
  else el.removeAttribute("title");
}

async function safeIndexedDbAvailable() {
  try {
    if (!window.indexedDB) return false;
    await openKeyDb();
    return true;
  } catch (_) {
    return false;
  }
}

async function renderSecurityPanel() {
  const fpEl = $("myKeyFingerprint");
  const localEl = $("localKeyStatus");
  const trustEl = $("trustedCacheStatus");
  const histEl = $("keyHistoryStatus");
  const detailEl = $("securityCheckDetails");

  if (detailEl) detailEl.textContent = "Checking this browser and account security state…";

  let serverKey = state.user?.public_key_jwk || null;
  if (!serverKey && state.token) {
    try {
      const me = await api("/users/me");
      saveSession(state.token, me);
      serverKey = me.public_key_jwk || null;
    } catch (err) {
      if (detailEl) detailEl.textContent = `Could not refresh account key: ${err.message}`;
    }
  }

  if (!isValidPublicKeyJwk(serverKey)) {
    try {
      const pkg = await loadEncryptedKeyPackage();
      if (isValidPublicKeyJwk(pkg?.publicKeyJwk)) {
        const repaired = await updateMyPublicKey(pkg.publicKeyJwk);
        serverKey = repaired.public_key_jwk || pkg.publicKeyJwk;
        if (detailEl) detailEl.textContent = "Account encryption public key was missing and has been repaired from this browser's active key package.";
      }
    } catch (_) {}
  }

  if (!isValidPublicKeyJwk(serverKey)) {
    if (fpEl) {
      fpEl.textContent = "No account encryption key found";
      fpEl.dataset.rawFingerprint = "";
    }
    setSecurityStatus(localEl, "Needs key setup", "bad", "Your account is missing a public encryption key.");
    setSecurityStatus(trustEl, "Skipped", "neutral");
    setSecurityStatus(histEl, "Skipped", "neutral");
    if (detailEl) detailEl.textContent = "Your account does not expose an encryption public key. Use Reset/Create encryption key below before using secure chats.";
    return;
  }

  try {
    const fp = await fingerprintPublicJwk(serverKey);
    if (fpEl) {
      fpEl.textContent = groupFingerprint(fp);
      fpEl.dataset.rawFingerprint = fp;
      fpEl.classList.remove("security-bad", "security-warn");
      fpEl.classList.add("security-ok");
    }
  } catch (err) {
    if (fpEl) {
      fpEl.textContent = "Could not calculate fingerprint";
      fpEl.dataset.rawFingerprint = "";
      fpEl.classList.remove("security-ok", "security-warn");
      fpEl.classList.add("security-bad");
    }
    if (detailEl) detailEl.textContent = `Fingerprint calculation failed: ${err.message}`;
  }

  const idbReady = await safeIndexedDbAvailable();
  if (!idbReady) {
    setSecurityStatus(localEl, "Browser storage blocked", "bad", "IndexedDB is unavailable. Private mode, browser policy, or storage permissions may be blocking key storage.");
    setSecurityStatus(trustEl, "Browser storage blocked", "bad");
    if (detailEl) detailEl.textContent = "Browser storage is blocked, so ChatE cannot check or cache encrypted key packages on this device.";
  } else {
    try {
      const pkg = await loadEncryptedKeyPackage();
      if (pkg) {
        setSecurityStatus(localEl, "Key package saved on this browser", "ok", "This browser has the encrypted key package needed to unlock old chats with your passphrase.");
      } else {
        setSecurityStatus(localEl, "No local key package", "warn", "This browser can use your public identity, but old chats need an imported/exported encrypted key package.");
      }
    } catch (err) {
      setSecurityStatus(localEl, "Could not read local keys", "bad", err.message);
    }

    try {
      const trustedRecords = await unlockedStoreGetAll();
      if (trustedRecords.length) {
        setSecurityStatus(trustEl, `${trustedRecords.length} trusted cache record(s)`, "ok", "Private-key cache is encrypted with a browser-local secret.");
      } else {
        setSecurityStatus(trustEl, "Not trusted on this browser", "warn", "This is normal until you unlock/import keys and choose to trust this browser.");
      }
    } catch (err) {
      setSecurityStatus(trustEl, "Could not inspect cache", "bad", err.message);
    }
  }

  if (state.user?.id) {
    try {
      const history = await api(`/security/key-history/${state.user.id}`);
      const rotations = Array.isArray(history) ? history.filter((row) => row.event_type === "rotated").length : 0;
      setSecurityStatus(histEl, history?.length ? `${history.length} event(s), ${rotations} rotation(s)` : "No history yet", history?.length ? "ok" : "warn");
    } catch (err) {
      setSecurityStatus(histEl, "Could not load history", "warn", err.message);
    }
  } else {
    setSecurityStatus(histEl, "Login required", "neutral");
  }

  if (detailEl && detailEl.textContent.startsWith("Checking")) {
    detailEl.textContent = "Security check complete. Warnings are actionable, not fatal: export/import your encrypted key package if this browser is missing it.";
  }
}

async function loadBlockedUsers() {
  const box = $("blockedUsersList");
  if (!box || !state.token) return;
  try {
    const rows = await api("/blocks");
    box.replaceChildren();
    if (!rows.length) {
      box.innerHTML = `<p class="hint">No blocked users.</p>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const user = row.blocked_user;
      const item = document.createElement("div");
      item.className = "blocked-user-item";
      const avatar = document.createElement("div");
      avatar.className = "avatar tiny";
      setAvatarElement(avatar, user);
      const meta = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = user.display_name || user.username;
      const handle = document.createElement("span");
      handle.textContent = `@${user.username}`;
      meta.append(name, handle);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "small-btn";
      btn.textContent = "Unblock";
      btn.addEventListener("click", async () => {
        await api(`/blocks/${user.id}`, { method: "DELETE" });
        toast(`Unblocked @${user.username}`);
        await loadBlockedUsers();
      });
      item.append(avatar, meta, btn);
      frag.appendChild(item);
    }
    box.appendChild(frag);
  } catch (err) {
    box.innerHTML = `<p class="hint">Could not load blocked users.</p>`;
  }
}


function currentBrowserDeviceIdOrNull() {
  if (!state.user?.id) return null;
  return localStorage.getItem(`chate_browser_device_id:${state.user.id}`);
}

async function loadDevices() {
  const box = $("devicesList");
  if (!box || !state.token) return;
  try {
    const rows = await api("/devices");
    const currentDeviceId = currentBrowserDeviceIdOrNull();
    box.replaceChildren();
    if (!rows.length) {
      box.innerHTML = `<p class="hint">No registered devices yet. This browser will be added automatically after login/device verification.</p>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const isCurrent = Boolean(currentDeviceId && row.id === currentDeviceId);
      const item = document.createElement("div");
      item.className = `blocked-user-item device-row${isCurrent ? " current-device" : ""}`;
      if (isCurrent) item.setAttribute("aria-current", "true");

      const icon = document.createElement("div");
      icon.className = "avatar tiny";
      icon.textContent = row.revoked_at ? "×" : isCurrent ? "✓" : "⌁";

      const meta = document.createElement("div");
      meta.className = "device-meta";
      const nameLine = document.createElement("div");
      nameLine.className = "device-name-line";
      const name = document.createElement("strong");
      name.textContent = row.name || "Unnamed device";
      nameLine.appendChild(name);
      if (isCurrent) {
        const badge = document.createElement("span");
        badge.className = "badge-soft current-device-badge";
        badge.textContent = "This device";
        nameLine.appendChild(badge);
      }
      const sub = document.createElement("span");
      sub.textContent = row.revoked_at
        ? `Revoked · ${fmtDate(row.revoked_at)}`
        : `${row.status || "trusted"} · Last seen ${fmtDate(row.last_seen_at || row.created_at)}`;
      meta.append(nameLine, sub);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "small-btn danger-link";
      btn.textContent = row.revoked_at ? "Revoked" : isCurrent ? "Current" : "Revoke";
      btn.disabled = Boolean(row.revoked_at || isCurrent);
      btn.title = isCurrent ? "This is the browser/device you are using now. Log out instead of revoking it here." : "Revoke this device";
      btn.addEventListener("click", async () => {
        if (isCurrent) return;
        await api(`/devices/${encodeURIComponent(row.id)}`, { method: "DELETE" });
        toast("Device revoked.");
        await loadDevices();
        await loadPendingDeviceLinks();
      });
      item.append(icon, meta, btn);
      frag.appendChild(item);
    }
    box.appendChild(frag);
  } catch (err) {
    box.innerHTML = `<p class="hint">Could not load devices.</p>`;
  }
}

function getOrCreateBrowserDeviceId() {
  const key = `chate_browser_device_id:${state.user?.id}`;
  let id = localStorage.getItem(key);
  if (!id) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(key, id);
  }
  return id;
}

async function registerThisDevice() {
  const name = prompt("Device name:", navigator.userAgent.includes("Mobile") ? "My phone browser" : "My desktop browser");
  if (!name) return;
  await api("/devices/current", {
    method: "POST",
    body: JSON.stringify({ device_id: getOrCreateBrowserDeviceId(), name: name.slice(0, 120), public_key_jwk: state.user?.public_key_jwk || null }),
  });
  toast("Device registered.", 4200);
  await loadDevices();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function renderQrPayload(container, payload) {
  // Real camera QR scanning can be layered on later. This MVP renders a short-lived
  // QR payload as copyable JSON so the protocol is usable without a third-party QR lib/CDN.
  container.innerHTML = `
    <div class="qr-lite-card">
      <strong>Device link payload</strong>
      <p class="hint">Copy this payload to a trusted logged-in device if camera scanning is unavailable. Expires in 10 minutes.</p>
      <textarea readonly rows="5">${escapeHtml(payload)}</textarea>
      <button type="button" class="small-btn" data-action="copy-qr-payload">Copy payload</button>
    </div>`;
  container.querySelector("[data-action='copy-qr-payload']")?.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(payload);
    toast("Device-link payload copied.");
  });
}

async function startDeviceLinkRequest() {
  const box = $("deviceLinkBox");
  if (!box) return;
  try {
    const name = prompt("Name this new device:", navigator.userAgent.includes("Mobile") ? "My phone browser" : "My desktop browser");
    if (!name) return;
    const pkg = await loadEncryptedKeyPackage();
    if (!isValidPublicKeyJwk(pkg?.publicKeyJwk)) throw new Error("This browser has no valid active key package. Import or create security.json first.");
    await api("/devices/current", {
      method: "POST",
      body: JSON.stringify({ device_id: getOrCreateBrowserDeviceId(), name: name.slice(0, 120), public_key_jwk: pkg.publicKeyJwk }),
    });
    const out = await api("/devices/link/start", {
      method: "POST",
      body: JSON.stringify({ device_id: getOrCreateBrowserDeviceId(), device_name: name.slice(0, 120), public_key_jwk: pkg.publicKeyJwk }),
    });
    box.classList.remove("hidden");
    renderQrPayload(box, out.qr_payload || out.id);
    localStorage.setItem(`chate_pending_device_link:${state.user?.id}`, out.id);
    toast("Device link request created. Approve it from a trusted device.", 6500);
    await loadPendingDeviceLinks();
  } catch (err) {
    toast(err.message, 6500);
  }
}

async function loadPendingDeviceLinks() {
  const box = $("pendingDeviceLinks");
  if (!box) return;
  try {
    const rows = await api("/devices/link/pending");
    box.replaceChildren();
    if (!rows.length) {
      box.innerHTML = `<p class="hint">No pending device links.</p>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "blocked-user-item";
      const meta = document.createElement("div");
      meta.innerHTML = `<strong>${escapeHtml(row.new_device_name)}</strong><span>${escapeHtml(row.status)} · expires ${fmtDate(row.expires_at)}</span><code>${escapeHtml(row.id)}</code>`;
      const actions = document.createElement("div");
      actions.className = "row compact-row";
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "small-btn";
      approve.textContent = row.status === "pending" ? "Approve" : "Approved";
      approve.disabled = row.status !== "pending";
      approve.addEventListener("click", async () => approveDeviceLink(row.id));
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "small-btn danger-link";
      reject.textContent = "Reject";
      reject.disabled = row.status !== "pending" && row.status !== "email_sent";
      reject.addEventListener("click", async () => rejectDeviceLink(row.id));
      const complete = document.createElement("button");
      complete.type = "button";
      complete.className = "small-btn";
      complete.textContent = "Claim here";
      complete.disabled = row.status !== "approved" && row.status !== "email_approved";
      complete.addEventListener("click", async () => completeDeviceLink(row.id));
      actions.append(approve, reject, complete);
      item.append(meta, actions);
      frag.appendChild(item);
    }
    box.appendChild(frag);
  } catch (err) {
    box.innerHTML = `<p class="hint">Could not load device links: ${escapeHtml(err.message)}</p>`;
  }
}

async function rejectDeviceLink(sessionId) {
  try {
    const ok = confirm("Reject this new-device login request? This revokes that pending device.");
    if (!ok) return;
    await api(`/devices/link/${encodeURIComponent(sessionId)}/reject`, { method: "POST", body: JSON.stringify({}) });
    toast("Device link rejected.", 5200);
    await loadPendingDeviceLinks();
    await loadDevices();
  } catch (err) {
    toast(err.message, 6500);
  }
}

async function approveDeviceLink(sessionId) {
  try {
    const pkg = await loadEncryptedKeyPackage();
    if (!pkg) throw new Error("No active encrypted security package found on this trusted device.");
    const ok = confirm("Approve this device link? The server receives only your already-encrypted security.json package, never the passphrase or raw private key.");
    if (!ok) return;
    await api(`/devices/link/${encodeURIComponent(sessionId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ encrypted_key_package_json: JSON.stringify(pkg) }),
    });
    toast("Device link approved. On the new device, click Claim here and enter the same key passphrase.", 7500);
    await loadPendingDeviceLinks();
  } catch (err) {
    toast(err.message, 6500);
  }
}

async function completeDeviceLink(sessionId = null) {
  try {
    const id = sessionId || localStorage.getItem(`chate_pending_device_link:${state.user?.id}`) || prompt("Paste device link session id:");
    if (!id) return;
    const out = await api(`/devices/link/${encodeURIComponent(id)}/complete`, { method: "POST", body: JSON.stringify({}) });
    if (!out.encrypted_key_package_json) {
      toast("Device confirmed by email. No key package was shared; old chats still need security.json/key passphrase.", 7500);
      await loadPendingDeviceLinks();
      return;
    }
    const pkg = JSON.parse(out.encrypted_key_package_json);
    await saveEncryptedKeyPackage(pkg, false);
    const makeActive = confirm("Key package received. Make it active for future messages too? OK is usually correct for your own trusted device.");
    if (makeActive) await updateMyPublicKey(pkg.publicKeyJwk);
    const passphrase = prompt("Enter the key package passphrase to unlock old chats on this device now, or leave blank to import only:");
    if (passphrase) {
      const unlocked = await decryptPrivateKeyPackage(pkg, passphrase);
      const fingerprint = await fingerprintPublicJwk(pkg.publicKeyJwk);
      await persistTrustedDeviceKey(fingerprint, unlocked.privateJwk, pkg.publicKeyJwk, makeActive);
      markMessagesUnlockedThisLogin();
    }
    localStorage.removeItem(`chate_pending_device_link:${state.user?.id}`);
    toast(passphrase ? "Trusted device linked and key unlocked." : "Encrypted key package imported. Unlock it later with passphrase.", 6500);
    await loadPendingDeviceLinks();
  } catch (err) {
    toast(err.message, 6500);
  }
}

async function handleKeyImport(file) {
  if (!file) return;
  const pkg = JSON.parse(await file.text());
  if (!pkg.ciphertext || !pkg.publicKeyJwk) throw new Error("Invalid key package.");

  await saveEncryptedKeyPackage(pkg, false);

  const makeActive = confirm("Make this imported key active for future messages too? Choose OK only if this is your recovered/current key. Choose Cancel to keep it only for old-chat recovery.");
  if (makeActive) await updateMyPublicKey(pkg.publicKeyJwk);

  const passphrase = prompt("Optional: enter this key package passphrase now to trust this device, or leave blank to skip.");
  if (passphrase) {
    const unlocked = await decryptPrivateKeyPackage(pkg, passphrase);
    const fingerprint = await fingerprintPublicJwk(pkg.publicKeyJwk);
    await persistTrustedDeviceKey(fingerprint, unlocked.privateJwk, pkg.publicKeyJwk, makeActive);
    markMessagesUnlockedThisLogin();
  }

  toast(passphrase ? "Key package imported and unlocked for this login session." : "Key package imported. Unlock it from chat when needed.", 5600);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (_) {
    return null;
  }
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) throw new Error("This browser does not support desktop notifications.");
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  localStorage.setItem("chate_desktop_notifications", "enabled");
  await registerServiceWorker();
  return true;
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

async function ensureBackgroundPushSubscription({ quiet = false } = {}) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support background Web Push.");
  await requestNotificationPermission();
  const keyInfo = await api("/push/vapid-public-key");
  if (!keyInfo?.enabled || !keyInfo.public_key) throw new Error(keyInfo?.detail || "Web Push is not configured on the server.");
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyInfo.public_key) });
  }
  await api("/push/subscribe", { method: "POST", body: JSON.stringify({ ...subscription.toJSON(), device_id: await getPushDeviceId() }) });
  localStorage.setItem("chate_desktop_notifications", "enabled");
  if (!quiet) toast("Background push notifications enabled for this browser.");
  return true;
}

async function disableBackgroundPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const subscription = await registration?.pushManager?.getSubscription?.();
  if (subscription) {
    await api("/push/unsubscribe", { method: "POST", body: JSON.stringify(subscription.toJSON()) }).catch(() => null);
    await subscription.unsubscribe().catch(() => null);
  }
  localStorage.setItem("chate_desktop_notifications", "disabled");
}


async function showNotification(title, body) {
  await requestNotificationPermission();
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  if (registration?.showNotification) {
    await registration.showNotification(title, { body, tag: "chate-test" });
  } else {
    new Notification(title, { body });
  }
}

function openCropModal(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("Choose an image file.", 4200);
    return;
  }
  if (file.size > 8_000_000) {
    toast("Image is too large. Choose one under 8 MB.", 5200);
    return;
  }
  if (state.crop.fileUrl) URL.revokeObjectURL(state.crop.fileUrl);
  state.crop.fileUrl = URL.createObjectURL(file);
  state.crop.offsetX = 0;
  state.crop.offsetY = 0;
  state.crop.zoom = 1;
  const cropImage = $("cropImage");
  cropImage.onload = () => {
    state.crop.naturalWidth = cropImage.naturalWidth;
    state.crop.naturalHeight = cropImage.naturalHeight;
    updateCropTransform();
  };
  cropImage.onerror = () => toast("Could not load selected image.", 5200);
  cropImage.src = state.crop.fileUrl;
  $("cropZoom").value = "1";
  $("avatarCropModal").classList.remove("hidden");
  requestAnimationFrame(updateCropTransform);
}

function closeCropModal() {
  $("avatarCropModal").classList.add("hidden");
  if (state.crop.fileUrl) URL.revokeObjectURL(state.crop.fileUrl);
  state.crop.fileUrl = null;
  $("cropImage").removeAttribute("src");
}

function clampCropOffset(stageSize, displayW, displayH) {
  const maxX = Math.max(0, (displayW - stageSize) / 2);
  const maxY = Math.max(0, (displayH - stageSize) / 2);
  state.crop.offsetX = Math.max(-maxX, Math.min(maxX, state.crop.offsetX));
  state.crop.offsetY = Math.max(-maxY, Math.min(maxY, state.crop.offsetY));
}

function getCropGeometry() {
  const img = $("cropImage");
  const stage = $("cropStage");
  if (!img || !stage || !img.naturalWidth || !img.naturalHeight) return null;
  const stageSize = Math.max(220, stage.clientWidth || 320);
  const baseScale = Math.max(stageSize / img.naturalWidth, stageSize / img.naturalHeight) * state.crop.zoom;
  const displayW = img.naturalWidth * baseScale;
  const displayH = img.naturalHeight * baseScale;
  clampCropOffset(stageSize, displayW, displayH);
  const dx = (stageSize - displayW) / 2 + state.crop.offsetX;
  const dy = (stageSize - displayH) / 2 + state.crop.offsetY;
  return { img, stageSize, displayW, displayH, dx, dy };
}

function updateCropTransform() {
  const geometry = getCropGeometry();
  if (!geometry) return;
  const { img, displayW, displayH } = geometry;
  img.style.width = `${displayW}px`;
  img.style.height = `${displayH}px`;
  img.style.transform = `translate(calc(-50% + ${state.crop.offsetX}px), calc(-50% + ${state.crop.offsetY}px))`;
}

async function saveCroppedAvatar() {
  const geometry = getCropGeometry();
  if (!geometry) throw new Error("Image is not ready yet.");
  const { img, stageSize, displayW, displayH, dx, dy } = geometry;

  const outputSize = 512;
  const outScale = outputSize / stageSize;
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, outputSize, outputSize);
  ctx.drawImage(img, dx * outScale, dy * outScale, displayW * outScale, displayH * outScale);

  const dataUrl = canvas.toDataURL("image/png", 0.92);
  const user = await api("/users/me/avatar", { method: "POST", body: JSON.stringify({ image_data_url: dataUrl }) });
  saveSession(state.token, user);
  setAvatarElement($("profileAvatarPreview"), user);
  closeCropModal();
  toast("Profile picture updated.");
}

async function bootstrap() {
  applyThemePreference();
  if (localStorage.getItem("chate_compact_mode") === "enabled") document.body.classList.add("compact-mode");
  if ($("desktopNotifications")) $("desktopNotifications").checked = localStorage.getItem("chate_desktop_notifications") === "enabled";
  if ($("compactMode")) $("compactMode").checked = localStorage.getItem("chate_compact_mode") === "enabled";
  await registerServiceWorker();

  if (!state.token || !state.user) {
    toast("Login first, then open Settings.", 5000);
    setTimeout(() => { window.location.href = "/"; }, 900);
    return;
  }

  try {
    const me = await api("/users/me");
    saveSession(state.token, me);
    const settings = await api("/settings");
    renderSettings(settings);
    await loadBlockedUsers();
    await loadDevices();
  } catch (err) {
    clearSession();
    toast(err.message || "Session expired. Login again.", 5000);
    setTimeout(() => { window.location.href = "/"; }, 1000);
  }
}

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const user = await api("/users/me/profile", {
      method: "PUT",
      body: JSON.stringify({
        display_name: $("profileDisplayName").value.trim() || null,
        avatar_url: state.user?.avatar_url || null,
        bio: $("profileBio")?.value.trim() || null,
        public_show_display_name: $("publicShowDisplayName")?.checked !== false,
        public_show_avatar: $("publicShowAvatar")?.checked !== false,
        public_show_bio: $("publicShowBio")?.checked !== false,
        public_show_email: $("publicShowEmail")?.checked === true,
        public_show_last_seen: $("publicShowLastSeen")?.checked === true,
      }),
    });
    saveSession(state.token, user);
    const settings = await api("/settings");
    renderSettings(settings);
    await loadBlockedUsers();
    await loadDevices();
    toast("Profile updated.");
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("passwordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const currentPassword = $("currentPassword").value;
    const newPassword = $("newPassword").value;
    if (!currentPassword || !newPassword) throw new Error("Enter both current and new password.");
    await api("/account/password", {
      method: "PUT",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    $("currentPassword").value = "";
    $("newPassword").value = "";
    toast("Password changed. Other sessions were revoked. Login again if this page stops responding.", 6500);
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("autoDeleteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const raw = $("autoDeleteAfterDays").value;
    const disappearingRaw = $("defaultDisappearingSeconds")?.value || "";
    const payload = {
      auto_delete_after_days: raw ? Number(raw) : null,
      default_disappearing_seconds: disappearingRaw ? Number(disappearingRaw) : null,
    };
    const settings = await api("/settings", { method: "PUT", body: JSON.stringify(payload) });
    renderSettings(settings);
    toast(raw ? `Automatic deletion set to ${raw} inactive days.` : "Automatic inactivity deletion disabled. Disappearing-message default saved.");
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("exportKeyBtn").addEventListener("click", async () => {
  try {
    const pkg = await loadEncryptedKeyPackage();
    if (!pkg) throw new Error("No active key package found on this device.");
    downloadJson(`chate-security-${state.user?.username || "user"}.json`, pkg);
    localStorage.setItem(`chate_key_export_reminder_done:${state.user?.id}`, "1");
    toast("Encrypted security.json exported. It still needs its passphrase.");
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("importKeyInput").addEventListener("change", async (e) => {
  try {
    await handleKeyImport(e.target.files[0]);
  } catch (err) {
    toast(err.message, 5200);
  } finally {
    e.target.value = "";
  }
});

$("resetKeyBtn").addEventListener("click", async () => {
  const ok = confirm("This creates a fresh encryption key for future chats and uploads its public key to the server. Old chats remain encrypted until you import/unlock the old key package. Continue?");
  if (!ok) return;
  const passphrase = prompt("Set a passphrase for the new encrypted key package:");
  if (!passphrase) return;
  if (passphrase.length < 8) {
    toast("Key passphrase must be at least 8 characters.", 5200);
    return;
  }
  try {
    toast("Creating fresh encryption identity...", 5000);
    const pkg = await createEncryptedKeyPackage(passphrase);
    await saveEncryptedKeyPackage(pkg, true);
    const unlocked = await decryptPrivateKeyPackage(pkg, passphrase);
    const fingerprint = await fingerprintPublicJwk(pkg.publicKeyJwk);
    await persistTrustedDeviceKey(fingerprint, unlocked.privateJwk, pkg.publicKeyJwk, true);
    markMessagesUnlockedThisLogin();
    await updateMyPublicKey(pkg.publicKeyJwk);
    toast("Fresh encryption key is active for this login session. Export the new package.", 6500);
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("clearLocalKeysBtn").addEventListener("click", async () => {
  const ok = confirm("This removes encrypted and unlocked key packages stored on this browser only. Server account and encrypted messages remain untouched. Continue?");
  if (!ok) return;
  try {
    await idbClearStore("keyPackages");
    await idbClearStore("unlockedKeys");
    clearDeviceUnlockSecrets();
    clearMessagesUnlockedThisLogin();
    toast("Local key packages and trusted-device unlock cache cleared from this browser.", 5200);
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("desktopNotifications").addEventListener("change", async (e) => {
  if (e.target.checked) {
    try {
      await ensureBackgroundPushSubscription({ quiet: false });
    } catch (err) {
      e.target.checked = false;
      localStorage.setItem("chate_desktop_notifications", "disabled");
      toast(err.message, 6500);
    }
  } else {
    await disableBackgroundPushSubscription();
    toast("Notifications disabled for this browser.");
  }
});

$("testNotificationBtn").addEventListener("click", async () => {
  try {
    await ensureBackgroundPushSubscription({ quiet: true });
    const out = await api("/push/test", { method: "POST", body: JSON.stringify({}) });
    toast(out?.detail || "Background push test queued.", 6500);
    const el = $("pwaStatusText");
    if (el) el.textContent = await describePwaStatus();
  } catch (err) {
    const el = $("pwaStatusText");
    if (el) el.textContent = await describePwaStatus().catch(() => `Push test failed: ${err.message}`);
    toast(err.message || "Background push test failed.", 8500);
  }
});

const installAppBtn = $("installAppBtn");
if (installAppBtn) installAppBtn.addEventListener("click", async () => {
  try {
    if (state.deferredInstallPrompt) {
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice.catch(() => null);
      state.deferredInstallPrompt = null;
      toast("Install prompt handled.");
    } else {
      toast("Install from your browser menu if no install prompt appears. HTTPS is usually required.", 6500);
    }
  } catch (err) { toast(err.message, 5200); }
});

const sendVerificationEmailBtn = $("sendVerificationEmailBtn");
if (sendVerificationEmailBtn) sendVerificationEmailBtn.addEventListener("click", async () => {
  try {
    const identity = state.user?.id || state.user?.email || "current";
    const out = await runEmailCooldownAction(sendVerificationEmailBtn, "email_verify", identity, () =>
      api("/auth/email-verification/start", { method: "POST", body: JSON.stringify({}) })
    );
    if (out) toast(out.detail || "Check your email.", 7000);
    const settings = await api("/settings").catch(() => null);
    if (settings) renderSettings(settings);
  } catch (err) { toast(err.message, 5200); }
});

const registerThisDeviceBtn = $("registerThisDeviceBtn");
if (registerThisDeviceBtn) registerThisDeviceBtn.addEventListener("click", () => registerThisDevice().catch((err) => toast(err.message, 5200)));

const startDeviceLinkBtn = $("startDeviceLinkBtn");
if (startDeviceLinkBtn) startDeviceLinkBtn.addEventListener("click", () => startDeviceLinkRequest());

const refreshDeviceLinksBtn = $("refreshDeviceLinksBtn");
if (refreshDeviceLinksBtn) refreshDeviceLinksBtn.addEventListener("click", () => loadPendingDeviceLinks());

$("compactMode").addEventListener("change", (e) => {
  document.body.classList.toggle("compact-mode", e.target.checked);
  localStorage.setItem("chate_compact_mode", e.target.checked ? "enabled" : "disabled");
});


const copyFingerprintBtn = $("copyFingerprintBtn");
if (copyFingerprintBtn) copyFingerprintBtn.addEventListener("click", async () => {
  const fp = $("myKeyFingerprint")?.dataset.rawFingerprint || $("myKeyFingerprint")?.textContent || "";
  if (!fp) return toast("No fingerprint available.");
  try { await navigator.clipboard.writeText(fp); toast("Fingerprint copied."); }
  catch (_) { toast("Could not copy fingerprint. Select and copy it manually.", 5200); }
});

const runSecurityCheckBtn = $("runSecurityCheckBtn");
if (runSecurityCheckBtn) runSecurityCheckBtn.addEventListener("click", async () => {
  await renderSecurityPanel();
  toast("Security check refreshed. Warnings now show the exact missing piece.", 5200);
});

const exportSecurityKeyShortcutBtn = $("exportSecurityKeyShortcutBtn");
if (exportSecurityKeyShortcutBtn) exportSecurityKeyShortcutBtn.addEventListener("click", () => {
  $("exportKeyBtn")?.click();
});

const importSecurityKeyShortcutBtn = $("importSecurityKeyShortcutBtn");
if (importSecurityKeyShortcutBtn) importSecurityKeyShortcutBtn.addEventListener("click", () => {
  $("importKeyInput")?.click();
});

const themeSelect = $("themeSelect");
if (themeSelect) themeSelect.addEventListener("change", (e) => {
  localStorage.setItem("chate_theme", e.target.value || "system");
  applyThemePreference();
});

$("avatarFileInput").addEventListener("change", (e) => {
  openCropModal(e.target.files[0]);
  e.target.value = "";
});

$("cropZoom").addEventListener("input", (e) => {
  state.crop.zoom = Number(e.target.value || 1);
  updateCropTransform();
});

$("cropStage").addEventListener("pointerdown", (e) => {
  state.crop.dragging = true;
  state.crop.startX = e.clientX;
  state.crop.startY = e.clientY;
  state.crop.startOffsetX = state.crop.offsetX;
  state.crop.startOffsetY = state.crop.offsetY;
  $("cropStage").setPointerCapture(e.pointerId);
});

$("cropStage").addEventListener("pointermove", (e) => {
  if (!state.crop.dragging) return;
  state.crop.offsetX = state.crop.startOffsetX + (e.clientX - state.crop.startX);
  state.crop.offsetY = state.crop.startOffsetY + (e.clientY - state.crop.startY);
  updateCropTransform();
});

$("cropStage").addEventListener("pointerup", (e) => {
  state.crop.dragging = false;
  try { $("cropStage").releasePointerCapture(e.pointerId); } catch (_) {}
});

$("resetCropBtn").addEventListener("click", () => {
  state.crop.offsetX = 0;
  state.crop.offsetY = 0;
  state.crop.zoom = 1;
  $("cropZoom").value = "1";
  updateCropTransform();
});

$("cancelCropBtn").addEventListener("click", closeCropModal);
$("saveAvatarBtn").addEventListener("click", async () => {
  try {
    await saveCroppedAvatar();
  } catch (err) {
    toast(err.message, 5200);
  }
});


// ---------- Local emoji / GIF / sticker pack management ----------
function secureRandomToken(length = 10) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(file);
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

function normalizePackItem(raw, source = "settings-import") {
  const label = String(raw.label || raw.name || raw.title || "Imported sticker").slice(0, 80);
  const rawType = String(raw.kind || raw.type || raw.mime || "").toLowerCase();
  const kind = rawType.includes("gif") || rawType.includes("video") || rawType.includes("webm") || rawType.includes("mp4") ? "gif" : "sticker";
  const dataUrl = raw.dataUrl || raw.url || "";
  if (!dataUrl || !String(dataUrl).startsWith("data:")) return null;
  return {
    id: raw.id || `pack_${Date.now()}_${secureRandomToken(10)}`,
    source,
    label,
    kind,
    emoji: raw.emoji || "✨",
    dataUrl,
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((x) => String(x).toLowerCase()).slice(0, 24) : label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 10),
    importedAt: Date.now(),
  };
}

async function updatePackCount() {
  const el = $("settingsPackCount");
  if (!el) return;
  try {
    const items = await packStoreGetAll();
    el.textContent = `${items.length} local GIF/sticker item${items.length === 1 ? "" : "s"} installed on this browser.`;
  } catch (_) {
    el.textContent = "Pack storage unavailable in this browser.";
  }
}

async function importPackMediaFiles(files) {
  const maxItemBytes = 12 * 1024 * 1024;
  const items = [];
  for (const file of [...files].slice(0, 80)) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !/\.(gif|webp|png|jpe?g|svg|webm|mp4)$/i.test(file.name)) continue;
    if (file.size > maxItemBytes) {
      toast(`${file.name} skipped; one pack item must be under 20 MB.`, 5200);
      continue;
    }
    const dataUrl = await fileToDataUrl(file);
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Imported sticker";
    const item = normalizePackItem({ label: name, kind: file.type === "image/gif" || file.type.startsWith("video/") || /\.(gif|webm|mp4)$/i.test(file.name) ? "gif" : "sticker", dataUrl }, "settings-media");
    if (item) items.push(item);
  }
  if (!items.length) throw new Error("No valid GIF/sticker files selected.");
  await packStorePutMany(items);
  await updatePackCount();
  toast(`Imported ${items.length} local pack item${items.length === 1 ? "" : "s"}.`);
}

async function importPackJson(file) {
  const parsed = JSON.parse(await file.text());
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  const items = list.slice(0, 300).map((item) => normalizePackItem(item, parsed.name || "settings-json")).filter(Boolean);
  if (!items.length) throw new Error("No valid items found in JSON pack.");
  await packStorePutMany(items);
  await updatePackCount();
  toast(`Imported ${items.length} JSON pack item${items.length === 1 ? "" : "s"}.`);
}

async function importPackUrl() {
  const input = $("settingsPackUrlInput");
  const url = input?.value.trim();
  if (!url) return;
  const out = await api("/media/import-url", { method: "POST", body: JSON.stringify({ url }) });
  const item = normalizePackItem({ label: out.label, kind: out.mime_type.includes("gif") ? "gif" : "sticker", dataUrl: out.data_url, keywords: [out.label] }, "third-party-url");
  if (!item) throw new Error("Imported URL did not contain a usable image/GIF.");
  await packStorePutMany([item]);
  if (input) input.value = "";
  await updatePackCount();
  toast("Imported third-party GIF/sticker URL.");
}

$("deleteAccountBtn").addEventListener("click", async () => {
  const ok = confirm("This logs you out immediately. If you log back in within 7 days, deletion is cancelled. Continue?");
  if (!ok) return;
  try {
    await api("/account/deletion-request", { method: "POST", body: JSON.stringify({}) });
    clearSession(true);
    toast("Account deletion requested. You were logged out. Login within 7 days to cancel.", 6000);
    setTimeout(() => { window.location.href = "/"; }, 900);
  } catch (err) {
    toast(err.message, 5200);
  }
});

$("logoutBtn").addEventListener("click", async () => {
  clearSession();
  window.location.href = "/";
});

updatePackCount().catch(() => {});

const settingsPackMediaInput = $("settingsPackMediaInput");
if (settingsPackMediaInput) settingsPackMediaInput.addEventListener("change", async (e) => {
  try { await importPackMediaFiles(e.target.files || []); }
  catch (err) { toast(err.message, 5200); }
  finally { e.target.value = ""; }
});

const settingsPackJsonInput = $("settingsPackJsonInput");
if (settingsPackJsonInput) settingsPackJsonInput.addEventListener("change", async (e) => {
  try { if (e.target.files?.[0]) await importPackJson(e.target.files[0]); }
  catch (err) { toast(err.message, 5200); }
  finally { e.target.value = ""; }
});

const settingsPackUrlBtn = $("settingsPackUrlBtn");
if (settingsPackUrlBtn) settingsPackUrlBtn.addEventListener("click", () => importPackUrl().catch((err) => toast(err.message, 5200)));

const settingsClearPacksBtn = $("settingsClearPacksBtn");
if (settingsClearPacksBtn) settingsClearPacksBtn.addEventListener("click", async () => {
  if (!confirm("Clear all local imported GIF/sticker packs on this browser?")) return;
  await idbClearStore("packItems");
  await updatePackCount();
  toast("Local packs cleared.");
});


bootstrap();

// v38: PWA/mobile diagnostics and offline-cache maintenance.
async function describePwaStatus() {
  const displayMode = window.matchMedia?.("(display-mode: standalone)")?.matches ? "installed/standalone" : "browser tab";
  const swSupported = "serviceWorker" in navigator;
  const registration = swSupported ? await navigator.serviceWorker.getRegistration().catch(() => null) : null;
  const cacheNames = "caches" in window ? await caches.keys().catch(() => []) : [];
  const notification = "Notification" in window ? Notification.permission : "unsupported";
  const online = navigator.onLine ? "online" : "offline";
  let push = "not checked";
  if (state.token) {
    const diag = await api("/push/diagnostics").catch((err) => ({ detail: err.message }));
    push = `${diag.enabled ? "ready" : "not ready"}; subscriptions=${diag.active_subscriptions ?? "?"}; pywebpush=${diag.pywebpush_installed ? "yes" : "no"}; publicKey=${diag.has_public_key ? "yes" : "no"}; privateKey=${diag.has_private_key ? "yes" : "no"}; ${diag.detail || ""}`;
  }
  return `Mode: ${displayMode}. Network: ${online}. Service worker: ${registration ? "registered" : swSupported ? "not registered" : "unsupported"}. Notifications: ${notification}. Offline caches: ${cacheNames.filter((name) => name.startsWith("chate-shell-")).join(", ") || "none"}. Push server: ${push}.`;
}

const checkPwaBtn = $("checkPwaBtn");
if (checkPwaBtn) checkPwaBtn.addEventListener("click", async () => {
  const el = $("pwaStatusText");
  if (el) el.textContent = await describePwaStatus();
});

const clearShellCacheBtn = $("clearShellCacheBtn");
if (clearShellCacheBtn) clearShellCacheBtn.addEventListener("click", async () => {
  try {
    const registration = await navigator.serviceWorker?.ready.catch(() => null);
    registration?.active?.postMessage({ type: "CLEAR_SHELL_CACHE" });
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("chate-shell-")).map((key) => caches.delete(key)));
    }
    await registerServiceWorker();
    const el = $("pwaStatusText");
    if (el) el.textContent = await describePwaStatus();
    toast("Offline shell cache refreshed. Reload if old UI is still visible.", 6500);
  } catch (err) { toast(err.message, 5200); }
});

window.addEventListener("online", () => toast("Back online."));
window.addEventListener("offline", () => toast("You are offline. Settings already loaded can still be viewed."));
