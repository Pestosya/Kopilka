const CACHE = "kopilka-v28";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./sync-config.js",
  "./modules/migrations.js", "./modules/finance.js", "./modules/security.js", "./modules/sync.js",
  "./icon.svg", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Внешние запросы (Supabase Auth/REST) не кэшируем и не перехватываем.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => (event.request.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || "./index.html#recurring";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
      const existing = windows[0];
      if (existing) {
        existing.navigate(target);
        return existing.focus();
      }
      return clients.openWindow(target);
    })
  );
});
