/* Kitaplığım service worker: app shell offline, cover images cached as they are seen. */
const VERSION = "v20";
const SHELL = `shell-${VERSION}`, COVERS = "covers-v1";
const FILES = ["./", "index.html", "app.css", "app.js", "store.js", "lookup.js", "manifest.webmanifest",
  "vendor/html5-qrcode.min.js", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // NAS data: never cache sync or login; cover photos never change, so cache them.
  if (url.origin === location.origin && url.pathname.includes("/api/")) {
    if (url.pathname.includes("/api/fotos/")) {
      e.respondWith(caches.open(COVERS).then(async c => {
        const hit = await c.match(req); if (hit) return hit;
        const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res;
      }));
    }
    return;
  }
  // Own files: network first (so updates arrive), cache as fallback when offline.
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, {ignoreSearch: true}).then(r => r || caches.match("index.html"))));
    return;
  }
  // Cover images and fonts: cache first.
  if (req.destination === "image" || url.hostname.endsWith("gstatic.com") || url.hostname === "fonts.googleapis.com") {
    e.respondWith(caches.open(COVERS).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }
      catch { return hit || Response.error(); }
    }));
  }
});
