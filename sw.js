const CACHE_NAME = 'momentum-v19';
const URLS_TO_CACHE = ['/', '/index.html', '/manifest.json'];

// ── INSTALL ─────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(URLS_TO_CACHE))
  );
  self.skipWaiting();
});

// ── ACTIVATE ────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
  // Start the notification scheduler on activate
  startNotificationScheduler();
});

// ── FETCH ───────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if (
    event.request.url.includes('firebase') ||
    event.request.url.includes('googleapis') ||
    event.request.url.includes('gstatic') ||
    event.request.url.includes('fonts') ||
    event.request.url.includes('unpkg') ||
    event.request.url.includes('cdnjs')
  ) { return; }

  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    }).catch(() => caches.match('/index.html'))
  );
});

// ── NOTIFICATION SCHEDULER ───────────────────────────────────────
// Checks every minute if any reminder should fire
let schedulerInterval = null;

function startNotificationScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(checkReminders, 60 * 1000); // every 60s
  checkReminders(); // run immediately on start
}

async function checkReminders() {
  try {
    // Read reminders from IndexedDB-like storage via postMessage or just check
    // We use the SW cache to store reminder config
    const remindersRaw = await getSwData('hg_reminders');
    const notifEnabled = await getSwData('hg_notif');
    
    if (!remindersRaw || notifEnabled !== '1') return;
    
    const reminders = JSON.parse(remindersRaw);
    if (!Array.isArray(reminders)) return;

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const currentDate = now.toISOString().split('T')[0];

    for (const r of reminders) {
      if (!r.enabled || !r.time) continue;
      if (r.time !== currentTime) continue;

      // Check if we already fired this reminder today
      const firedKey = `hg_fired_${r.id}_${currentDate}`;
      const alreadyFired = await getSwData(firedKey);
      if (alreadyFired) continue;

      // Fire the notification
      await self.registration.showNotification('⚡ Momentum', {
        body: r.label || 'Time to check your habits! 🔥',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `reminder-${r.id}`,
        requireInteraction: false,
        vibrate: [200, 100, 200],
        actions: [
          { action: 'open', title: '✅ Open App' },
          { action: 'dismiss', title: 'Dismiss' }
        ]
      });

      // Mark as fired for today
      await setSwData(firedKey, '1');
    }
  } catch(e) {
    // Silent fail — SW shouldn't crash
  }
}

// ── NOTIFICATION CLICK ───────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('momentum') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});

// ── MESSAGE HANDLER (from app → SW) ─────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'UPDATE_REMINDERS') {
    // App tells SW reminders changed — restart scheduler
    startNotificationScheduler();
  }
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── SIMPLE KV STORE via SW Cache ─────────────────────────────────
// We piggyback on cache to store small config values
const KV_CACHE = 'momentum-kv-store';

async function getSwData(key) {
  try {
    const cache = await caches.open(KV_CACHE);
    const resp = await cache.match('/__kv__/' + key);
    if (!resp) return null;
    return await resp.text();
  } catch { return null; }
}

async function setSwData(key, value) {
  try {
    const cache = await caches.open(KV_CACHE);
    await cache.put('/__kv__/' + key, new Response(value));
  } catch {}
}

// ── SYNC KV from client localStorage ────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SYNC_STORAGE') {
    const { key, value } = event.data;
    setSwData(key, value);
  }
});
