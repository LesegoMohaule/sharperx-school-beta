// stamp-release.mjs replaces this marker after each production build.
const BUILD_ID = "0b3151ada988d499";
const CACHE_PREFIX = "sharperx-web-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const APP_SHELL = [
  "./",
  "./index.html",
  `./styles.css?release=${BUILD_ID}`,
  `./app.bundle.js?release=${BUILD_ID}`,
  `./legacy-app.js?release=${BUILD_ID}`,
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
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = APP_SHELL.map((path) => new Request(
      new URL(path, self.registration.scope),
      { cache: "reload" },
    ));
    await cache.addAll(requests);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return (await cache.match(request)) || (await cache.match(new URL("./index.html", self.registration.scope).href));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});
