/* =========================================================
   SERVICE WORKER — app-shell caching only.
   Firebase Auth/Firestore need a live network connection, so
   this deliberately does NOT try to make the whole app work
   offline. It just makes the shell (HTML/CSS/JS/icons) load
   instantly and installable, with a cache fallback if the
   network briefly drops. Bump CACHE_NAME on every deploy that
   changes these files so old clients pick up the update.
   ========================================================= */
const CACHE_NAME = "gate-tracker-shell-v2";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle same-origin GET requests for the app shell.
  // Everything else (Firebase Auth, Firestore, Google APIs, fonts)
  // passes straight through to the network untouched.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});
