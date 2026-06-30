const CACHE_NAME = 'momentum-v169';
const CDN_CACHE = 'momentum-cdn-v2';
const FONT_CACHE = 'momentum-fonts-v1';

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
];

const CDN_URLS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE).catch(e => console.warn('Precache partial fail:', e))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE && k !== FONT_CACHE && k !== 'momentum-kv-store')
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// C1: Message handler — flush offline queue signal from app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // CDN resources — cache-first, long TTL
  if (CDN_URLS.some(u => event.request.url.startsWith(u.split('/').slice(0,3).join('/')))) {
    event.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(resp => {
            if (resp.ok) cache.put(event.request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  // Google Fonts — cache-first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(resp => {
            if (resp.ok) cache.put(event.request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  // Firebase / API — network only, no caching
  if (url.hostname.includes('firebase') || url.hostname.includes('googleapis') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({error:'offline'}),
        {status:503,headers:{'Content-Type':'application/json'}}
      ))
    );
    return;
  }

  // App shell — network-first with cache fallback
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Mo character images — network-first. These are content assets that get
  // updated independently of app code/SW version bumps (new poses, fixed
  // transparency, etc.), so cache-first was serving stale white-bg versions
  // even after correct files were re-uploaded to the repo. Network-first
  // always checks for the latest file, falling back to cache only when
  // genuinely offline.
  if (url.pathname.startsWith('/mo/') && url.pathname.endsWith('.png')) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match(event.request).then(cached => cached || new Response('', {status: 404})))
    );
    return;
  }

  // Static assets (including /mo/ images) — cache-first, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => new Response('', {status: 404}));
    })
  );
});
