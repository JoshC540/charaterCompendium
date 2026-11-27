/* Offline copy of the handbook, so the rules still open at the table without signal.
   Network first: when online you always get the latest files, and each one is saved as it arrives.
   With no connection, the saved copy is used. Only this site's own files are kept; anything from
   Supabase (notes, characters, party money, the bestiary) is never stored here and needs a connection. */
const CACHE = 'handbook-v11';
const FILES = [
  './', 'index.html', 'style.css', 'notes.js', 'play.js', 'dice.js', 'creator.js', 'bank.js', 'craft.js', 'atlas.js', 'table.js', 'finals.js', 'session.js', 'lab.js', 'bestiary.js', 'app.js', 'vendor/supabase.js',
  'content/races.md', 'content/classes.md', 'content/subclasses.md', 'content/spells.md', 'content/advancement.md',
  'content/gods.md', 'content/patch-notes.md', 'content/items.json', 'content/statuses.json',
  'fonts/cinzel-latin-700-normal.woff2', 'fonts/cinzel-latin-600-normal.woff2', 'fonts/cinzel-decorative-latin-700-normal.woff2',
  'fonts/eb-garamond-latin-400-normal.woff2', 'fonts/eb-garamond-latin-400-italic.woff2', 'fonts/eb-garamond-latin-600-normal.woff2',
  'fonts/eb-garamond-latin-600-italic.woff2', 'fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-400-italic.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-700-italic.woff2',
];

self.addEventListener('install', e => {
  // a missing file shouldn't stop the rest being saved
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
    .then(hit => hit || new Response('Offline, and this file wasn’t saved yet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
});
