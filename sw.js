const CACHE_NAME = 'momentum-v57';

// CDN URLs to cache on first load (Fix 9 — cache CDN files)
const CDN_CACHE = 'momentum-cdn-v49';
const CDN_URLS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
];
const FONT_CACHE = 'momentum-fonts-v49';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    Promise.allSettled([
      // Cache app shell
      caches.open(CACHE_NAME).then(cache =>
        Promise.allSettled(['/'].map(url => cache.add(url)))
      ),
      // Cache CDN files (best-effort, don't block install)
      caches.open(CDN_CACHE).then(async cache => {
        for (const url of CDN_URLS) {
          try {
            const res = await fetch(url, {mode:'cors'});
            if (res.ok) await cache.put(url, res);
          } catch(e) {}
        }
      })
    ])
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
    .then(() => {
      // Force all open tabs to reload with the new version
      self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients => {
        clients.forEach(client => client.navigate(client.url));
      });
    })
  );
  startScheduler();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // Firebase APIs — always network, never cache
  if (
    url.includes('/api/') ||
    url.includes('api.anthropic') ||
    url.includes('firestore.googleapis') ||
    url.includes('identitytoolkit') ||
    url.includes('securetoken') ||
    url.includes('firebase.googleapis')
  ) return;

  // CDN files (React, Babel, Firebase SDK) — cache-first, long-lived
  if (
    url.includes('unpkg.com') ||
    url.includes('gstatic.com/firebasejs') ||
    url.includes('cdnjs.cloudflare.com')
  ) {
    event.respondWith(
      caches.open(CDN_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch(e) {
          return cached || new Response('', {status:503});
        }
      })
    );
    return;
  }

  // Google Fonts — cache-first
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.open(FONT_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch(e) { return cached || new Response('', {status:503}); }
      })
    );
    return;
  }

  // HTML root — network-first (always get fresh app)
  if (url.includes('index.html') || url.endsWith('/') || url === self.location.origin + '/') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('/'));
    })
  );
});

// ── NOTIFICATION SCHEDULER ─────────────────────────────────────
let schedulerInterval = null;

function startScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  checkReminders();
  schedulerInterval = setInterval(checkReminders, 30 * 1000);
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

async function checkReminders() {
  try {
    const remindersRaw = await getKV('hg_reminders');
    const notifEnabled = await getKV('hg_notif');
    if (!remindersRaw || notifEnabled !== '1') return;

    const reminders = JSON.parse(remindersRaw);
    if (!Array.isArray(reminders)) return;

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hh}:${mm}`;
    const today = getToday();

    for (const r of reminders) {
      if (!r.enabled || !r.time) continue;
      if (r.time !== currentTime) continue;

      const fireId = `${r.id || r.label}_${r.time}`;
      const firedKey = `fired_${fireId}_${today}`;
      const alreadyFired = await getKV(firedKey);
      if (alreadyFired) continue;

      await self.registration.showNotification('⚡ Momentum', {
        body: r.label || 'Time to check your habits! 🔥',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: fireId,
        requireInteraction: false,
        vibrate: [300, 100, 300, 100, 500],
        actions: [
          { action: 'open', title: '✅ Open App' },
          { action: 'dismiss', title: 'Dismiss' }
        ]
      });

      await setKV(firedKey, '1');
    }
  } catch(e) {}
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('momentum') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/');
    })
  );
});

self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'SYNC_STORAGE') setKV(event.data.key, event.data.value);
  if (event.data.type === 'UPDATE_REMINDERS') { clearInterval(schedulerInterval); startScheduler(); }
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── KV STORE ──────────────────────────────────────────────────
const KV_CACHE = 'momentum-kv-store';
async function getKV(key) {
  try {
    const cache = await caches.open(KV_CACHE);
    const r = await cache.match('/__kv__/' + key);
    return r ? await r.text() : null;
  } catch { return null; }
}
async function setKV(key, value) {
  try {
    const cache = await caches.open(KV_CACHE);
    await cache.put('/__kv__/' + key, new Response(value));
  } catch {}
}
