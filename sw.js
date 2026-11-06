/* Lootkit — offline helper (service worker)
   Always tries the network first, so you get the newest version when online.
   When the network is down, it serves the last copy it saw.
   Only the app's own files are kept; your data lives in the browser's storage, not here. */
const CACHE = "lootkit-v3";
const SHELL = ["./", "index.html", "privacy.html", "css/styles.css", "js/app.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-32.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return; // fonts, link icons: browser as usual
  e.respondWith(
    // "no-cache": ask the server every time, so you never get a stale copy while online
    fetch(req, { cache: "no-cache" }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match("index.html")))
  );
});
