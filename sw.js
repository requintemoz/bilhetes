// Service worker: guarda a app de porta para abrir sem rede.
const CACHE = "porta-v1";
const FICHEIROS = ["./", "./index.html", "./manifest.webmanifest", "../comum.css", "../config.js", "https://esm.sh/@supabase/supabase-js@2", "https://esm.sh/jsqr@1.4.0"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(FICHEIROS.map((f) => c.add(f))))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.includes("/rest/") || u.pathname.includes("/auth/") || u.pathname.includes("/functions/")) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((resp) => { const copia = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return resp; }).catch(() => r)));
});
