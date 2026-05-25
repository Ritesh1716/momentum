const CACHE_NAME = 'momentum-v8';
const URLS_TO_CACHE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', event => {
  // Force immediate activation — don't wait for old SW to finish
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(URLS_TO_CACHE))
  );
});

self.addEventListener('activate', event => {
  // Delete ALL old caches immediately
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => {
        if(k !== CACHE_NAME) {
          console.log('Deleting old cache:', k);
          return caches.delete(k);
        }
      }))
    ).then(() => self.clients.claim()) // Take control of all tabs immediately
  );
  startNotificationScheduler();
});

self.addEventListener('fetch', event => {
  // Skip non-GET and external requests
  if(event.request.method !== 'GET') return;
  if(
    event.request.url.includes('firebase') ||
    event.request.url.includes('googleapis') ||
    event.request.url.includes('gstatic') ||
    event.request.url.includes('fonts') ||
    event.request.url.includes('unpkg') ||
    event.request.url.includes('cdnjs')
  ) return;

  event.respondWith(
    // Network first for HTML — always get fresh index.html
    event.request.url.includes('index.html') || event.request.url.endsWith('/')
      ? fetch(event.request)
          .then(response => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
            return response;
          })
          .catch(() => caches.match(event.request))
      : caches.match(event.request).then(cached =>
          cached || fetch(event.request).then(response => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
            return response;
          })
        ).catch(() => caches.match('/index.html'))
  );
});

// ── NOTIFICATION SCHEDULER ─────────────────────────────────────
let schedulerInterval = null;

function startNotificationScheduler() {
  if(schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(checkReminders, 60 * 1000);
  checkReminders();
}

async function checkReminders() {
  try {
    const remindersRaw = await getSwData('hg_reminders');
    const notifEnabled = await getSwData('hg_notif');
    if(!remindersRaw || notifEnabled !== '1') return;

    const reminders = JSON.parse(remindersRaw);
    if(!Array.isArray(reminders)) return;

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const currentDate = now.toISOString().split('T')[0];

    for(const r of reminders) {
      if(!r.enabled || !r.time) continue;
      if(r.time !== currentTime) continue;

      const firedKey = `hg_fired_${r.id}_${currentDate}`;
      const alreadyFired = await getSwData(firedKey);
      if(alreadyFired) continue;

      await self.registration.showNotification('⚡ Momentum', {
        body: r.label || 'Time to check your habits! 🔥',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `reminder-${r.id}`,
        vibrate: [200, 100, 200],
        actions: [
          { action: 'open', title: '✅ Open App' },
          { action: 'dismiss', title: 'Dismiss' }
        ]
      });

      await setSwData(firedKey, '1');
    }
  } catch(e) {}
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if(event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for(const c of list) {
        if(c.url.includes('momentum') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/');
    })
  );
});

self.addEventListener('message', event => {
  if(!event.data) return;
  if(event.data.type === 'SYNC_STORAGE') setSwData(event.data.key, event.data.value);
  if(event.data.type === 'UPDATE_REMINDERS') startNotificationScheduler();
  if(event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

const KV_CACHE = 'momentum-kv-v8';

async function getSwData(key) {
  try {
    const cache = await caches.open(KV_CACHE);
    const resp = await cache.match('/__kv__/' + key);
    return resp ? await resp.text() : null;
  } catch { return null; }
}

async function setSwData(key, value) {
  try {
    const cache = await caches.open(KV_CACHE);
    await cache.put('/__kv__/' + key, new Response(value));
  } catch {}
}
