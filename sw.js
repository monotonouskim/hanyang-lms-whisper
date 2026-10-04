// v1.2 cache-cleanup shim.
// v1.1 used a cache-first Service Worker. This file deliberately removes those caches,
// claims existing clients, then unregisters itself. v1.2 does not use a Service Worker.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("hanyang-lms-whisper")).map((k) => caches.delete(k)));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("hanyang-lms-whisper")).map((k) => caches.delete(k)));
    await self.clients.claim();
    await self.registration.unregister();
  })());
});
