// Network first so updates show right away; cached copy when the signal drops on the course.
const CACHE = 'yardage-202611181904';
const CORE = ['./', 'index.html', 'round.js', 'shell.js', 'handicap.js', 'importer.js', 'config.js', 'course.json', 'terrain.json', 'objects.json', 'ground.jpg', 'manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // never cache account data or sign-in traffic
  if (/supabase\.co$/.test(u.hostname) || u.hostname.includes('open-meteo') || u.search.includes('code=')) return;
  const cacheable = u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net' || u.hostname.endsWith('gstatic.com') || u.hostname.endsWith('googleapis.com');
  if (!cacheable) return;
  // same-site files: always ask the server if there's something newer (cheap when nothing changed)
  const req = u.origin === location.origin ? new Request(e.request, { cache: 'no-cache' }) : e.request;
  e.respondWith(fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
