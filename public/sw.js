/* Only the public offline page is cached. Sessions, events, and API responses
   always go to the server, including when the app runs in standalone mode. */
const OFFLINE_CACHE = "crashguard-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith("crashguard-offline-") &&
                name !== OFFLINE_CACHE,
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.mode !== "navigate")
    return;
  event.respondWith(
    fetch(event.request).catch(
      async () =>
        (await caches.match(OFFLINE_URL)) ||
        new Response("CrashGuard is offline. Reconnect and try again.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    ),
  );
});

function notificationUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin === self.location.origin && url.pathname === "/")
      return url.href;
  } catch {
    /* A malformed target falls back to the issues view. */
  }
  return `${self.location.origin}/?view=issues`;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    /* Still display a visible notification. */
  }
  const text = (value, fallback, length) =>
    typeof value === "string" ? value.slice(0, length) : fallback;
  event.waitUntil(
    self.registration.showNotification(text(payload.title, "CrashGuard", 100), {
      body: text(payload.body, "There is an update in your workspace.", 250),
      icon: "/icons/pwa-192.png",
      badge: "/icons/badge-96.png",
      tag: text(payload.tag, "crashguard", 100),
      data: { url: notificationUrl(payload.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = notificationUrl(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          const navigated = await client.navigate(url);
          if (navigated) {
            await navigated.focus();
            return;
          }
        } catch {
          /* A closing tab must not prevent opening the issue. */
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
