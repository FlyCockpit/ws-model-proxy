/// <reference lib="webworker" />
import { ExpirationPlugin } from "workbox-expiration";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// Workbox precaching (injected by vite-plugin-pwa)
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// --- Runtime Caching ---

// WASM files — CacheFirst, 90 day expiration
registerRoute(
  ({ request }) => request.url.endsWith(".wasm"),
  new CacheFirst({
    cacheName: "wasm-cache",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
);

// Worker scripts — CacheFirst, 90 day expiration
registerRoute(
  ({ request }) => request.destination === "worker",
  new CacheFirst({
    cacheName: "worker-cache",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
);

// Fonts — CacheFirst, 1 year expiration
registerRoute(
  ({ request }) => request.destination === "font",
  new CacheFirst({
    cacheName: "font-cache",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 365 * 24 * 60 * 60,
      }),
    ],
  }),
);

// --- Offline Fallback ---

const OFFLINE_URL = "/offline.html";

// Cache the offline page on install, then activate immediately
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("offline-v1").then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

// Claim all clients so the new SW takes effect without a second navigation
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Serve offline page for failed navigation requests
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open("offline-v1");
      const cached = await cache.match(OFFLINE_URL);
      return cached || new Response("Offline", { status: 503 });
    }),
  );
});
