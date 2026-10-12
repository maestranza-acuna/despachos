/* Service worker: la app abre aunque no haya señal.
   Archivos de la app: primero red (para recibir actualizaciones), si falla, copia guardada.
   Datos de Supabase: nunca se guardan aquí (la app maneja su propia copia). */
const VERSION = "despachos-1.0.0-beta-1";
const ARCHIVOS = [
  "./", "index.html", "estilos.css", "app.js", "config.js", "manifest.webmanifest",
  "iconos/icono-192.png", "iconos/icono-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js"
];

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith(".supabase.co") || url.hostname.endsWith(".supabase.in")) return;
  ev.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) {
        const copia = res.clone();
        caches.open(VERSION).then(c => c.put(req, copia));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html")))
  );
});
