import admin from 'firebase-admin';

// ── Firebase Admin init (singleton) ──────────────────────────────────────────
// Mirrors api/ai.js exactly — reuses the same three env vars, so no new Vercel
// configuration is needed. If init throws at cold start (e.g. malformed
// FIREBASE_PRIVATE_KEY) we capture it and fail cleanly in the handler.
let initError = null;
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  } catch (e) {
    initError = e;
    console.error('Firebase Admin init failed:', e.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Local YYYY-MM-DD for a user, given their tzOffsetMin (minutes to add to UTC).
function localDateKey(tzOffsetMin) {
  const now = new Date();
  const local = new Date(now.getTime() + (tzOffsetMin || 0) * 60000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Local hour (0-23) for a user right now.
function localHour(tzOffsetMin) {
  const now = new Date();
  const local = new Date(now.getTime() + (tzOffsetMin || 0) * 60000);
  return local.getUTCHours();
}

// Decide today's message from the user's real habit state. This is where C4
// (streak-at-risk) lives — it's not a separate send, it's the daily push
// adapting to whether the streak is on the line.
function buildMessage(data, todayKey) {
  const habits = Array.isArray(data.habits) ? data.habits : [];
  // Count habits not yet done today (respecting goal-count habits).
  const undone = habits.filter(h => {
    const hasGoal = h.goalCount > 0 && h.goalUnit;
    const logVal = h.log && h.log[todayKey];
    return hasGoal ? !(typeof logVal === 'number' && logVal >= h.goalCount) : !logVal;
  });
  // Highest active streak across habits — used to gauge what's "at risk".
  const maxStreak = habits.reduce((m, h) => Math.max(m, h.streak || 0), 0);

  // C4: streak-at-risk — a real streak exists and today isn't secured yet.
  if (undone.length > 0 && maxStreak >= 3) {
    return {
      title: '🔥 Your streak is on the line',
      body: `${maxStreak}-day streak at risk — ${undone.length} habit${undone.length > 1 ? 's' : ''} left before the day ends.`,
    };
  }
  // Everything done — reinforce.
  if (undone.length === 0 && habits.length > 0) {
    return {
      title: '✅ Fully done today',
      body: "That's how momentum compounds. See you tomorrow.",
    };
  }
  // Some left but no big streak yet — gentle nudge.
  if (undone.length > 0) {
    return {
      title: '⚡ Mo checking in',
      body: `${undone.length} habit${undone.length > 1 ? 's' : ''} still open today — a few minutes is all it takes.`,
    };
  }
  // No habits configured — encourage setup.
  return {
    title: '⚡ Mo checking in',
    body: 'Ready to build today? Add a habit and start your streak.',
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────
// Triggered hourly by an external cron (cron-job.org) hitting this endpoint.
// For every user whose local check-in hour == their current local hour, and who
// hasn't already been pushed today, send one FCM notification.
export default async function handler(req, res) {
  // Auth: only our cron may trigger this. cron-job.org sends the secret as a
  // custom header (x-cron-secret) OR standard Authorization: Bearer.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const headerSecret = req.headers['x-cron-secret'] || '';
  const ok = secret && (auth === `Bearer ${secret}` || headerSecret === secret);
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });

  if (initError || !db) {
    return res.status(500).json({ error: 'Firebase Admin init failed' });
  }

  let sent = 0, skipped = 0, failed = 0, checked = 0;

  try {
    // Only users who opted in and have a token. (Firestore requires this field
    // to exist; users without notifEnabled are simply never returned.)
    const snap = await db.collection('users').where('notifEnabled', '==', true).get();

    const sends = [];
    snap.forEach(docSnap => {
      const data = docSnap.data() || {};
      checked++;
      const token = data.fcmToken;
      if (!token) { skipped++; return; }

      const tzOffsetMin = typeof data.tzOffsetMin === 'number' ? data.tzOffsetMin : 330; // default IST
      const checkInHour = typeof data.checkInHour === 'number' ? data.checkInHour : 20;

      // Only fire during the user's chosen local hour.
      if (localHour(tzOffsetMin) !== checkInHour) { skipped++; return; }

      // De-dupe: one push per user per local day.
      const todayKey = localDateKey(tzOffsetMin);
      if (data.lastPushDate === todayKey) { skipped++; return; }

      const msg = buildMessage(data, todayKey);
      sends.push({ ref: docSnap.ref, token, msg, todayKey });
    });

    // Send sequentially-ish (small user base; keeps within function time budget).
    for (const s of sends) {
      try {
        await admin.messaging().send({
          token: s.token,
          // Data-only payload so the service worker fully controls rendering.
          data: {
            title: s.msg.title,
            body: s.msg.body,
            url: '/',
            tag: 'momentum_daily_' + s.todayKey,
          },
          webpush: {
            headers: { Urgency: 'high', TTL: '3600' },
            fcmOptions: { link: '/' },
          },
        });
        // Mark so we don't double-send within the same local day.
        await s.ref.update({ lastPushDate: s.todayKey }).catch(() => {});
        sent++;
      } catch (e) {
        failed++;
        // A stale/unregistered token means the user uninstalled or revoked —
        // clear it so we stop trying and stop counting them as opted-in.
        const code = e?.errorInfo?.code || e?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          await s.ref.update({ fcmToken: admin.firestore.FieldValue.delete(), notifEnabled: false }).catch(() => {});
        } else {
          console.warn('Push send failed:', code || e.message);
        }
      }
    }

    return res.status(200).json({ ok: true, checked, sent, skipped, failed });
  } catch (e) {
    console.error('push cron error:', e.message);
    return res.status(500).json({ error: 'Cron failed', detail: e.message });
  }
}
