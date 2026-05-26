const CACHE_NAME = 'momentum-v20';
const URLS_TO_CACHE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(URLS_TO_CACHE))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'momentum-kv-store').map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
  startScheduler();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (
    event.request.url.includes('firebase') ||
    event.request.url.includes('googleapis') ||
    event.request.url.includes('gstatic') ||
    event.request.url.includes('fonts') ||
    event.request.url.includes('unpkg') ||
    event.request.url.includes('cdnjs')
  ) return;

  event.respondWith(
    // Network-first for HTML — always fresh
    (event.request.url.includes('index.html') || event.request.url.endsWith('/'))
      ? fetch(event.request)
          .then(r => { caches.open(CACHE_NAME).then(c => c.put(event.request, r.clone())); return r; })
          .catch(() => caches.match(event.request))
      : caches.match(event.request).then(cached =>
          cached || fetch(event.request).then(r => {
            caches.open(CACHE_NAME).then(c => c.put(event.request, r.clone()));
            return r;
          })
        ).catch(() => caches.match('/index.html'))
  );
});

// ── NOTIFICATION SCHEDULER ─────────────────────────────────────
let schedulerInterval = null;

function startScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  checkReminders();
  schedulerInterval = setInterval(checkReminders, 30 * 1000); // every 30s
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
