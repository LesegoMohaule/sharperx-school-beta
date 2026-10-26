const CACHE_NAME = "sharperx-web-shell-v101";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=60",
  "./app.bundle.js?v=62",
  "./legacy-app.js?v=68",
  "./api.js?v=26",
  "./math-display.js",
  "./paper-catalog.json",
  "./math-editor.html?v=17",
  "./canvas-remote.html",
  "./canvas-remote.js?v=20",
  "./canvas-install.html",
  "./remote-control.html",
  "./remote-control.js?v=5",
  "./vendor/qrcode-generator.js?v=17",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("sharperx-web-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match("./index.html"))));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  })));
});
