const CACHE_NAME = "chate-shell-v73";
const OFFLINE_URL = "/offline.html";
const SHELL_ASSETS = [
  "/",
  "/settings",
  OFFLINE_URL,
  "/css/styles.css?v=73",
  "/js/app.js?v=73",
  "/js/settings.js?v=73",
  "/manifest.webmanifest",
  "/assets/message-circle-lock.svg",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/maskable-192.png",
  "/assets/icons/maskable-512.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => null)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CLEAR_SHELL_CACHE") {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("chate-shell-")).map((key) => caches.delete(key)));
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL_ASSETS).catch(() => null);
    })());
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone()).catch(() => null);
        return response;
      } catch (_) {
        return (await caches.match(event.request)) || (await caches.match(OFFLINE_URL));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    const fetchAndCache = fetch(event.request).then((response) => {
      if (response && response.ok && event.request.method === "GET") {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => null);
      }
      return response;
    }).catch(() => cached);
    return cached || fetchAndCache;
  })());
});

self.addEventListener("sync", (event) => {
  if (event.tag === "chate-outbox-sync") {
    event.waitUntil((async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) client.postMessage({ type: "REPLAY_OUTBOX" });
    })());
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const rawUrl = event.notification?.data?.url || "/";
    const targetUrl = new URL(rawUrl, self.location.origin);
    if (event.action === "reply") targetUrl.searchParams.set("focus", "reply");
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === targetUrl.origin && "focus" in client) {
          if ("navigate" in client) await client.navigate(targetUrl.href);
          return client.focus();
        }
      } catch (_) {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl.href);
  })());
});


self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; }
    catch (_) { data = { title: "ChatE", body: "New encrypted message" }; }
    const title = data.title || "ChatE";
    const body = data.body || "New encrypted message";
    const url = data.url || "/";
    const actions = [
      { action: "reply", title: "Reply" },
      { action: "open", title: "Open" },
    ];
    const options = {
      body,
      tag: data.message_id ? `chate-message-${data.message_id}` : "chate-incoming",
      renotify: true,
      requireInteraction: false,
      icon: "/assets/icons/icon-192.png",
      badge: "/assets/icons/maskable-192.png",
      data: { url, sender_id: data.sender_id || null, message_id: data.message_id || null },
      actions,
    };
    try {
      await self.registration.showNotification(title, options);
    } catch (_) {
      delete options.actions;
      await self.registration.showNotification(title, options);
    }
  })());
});
