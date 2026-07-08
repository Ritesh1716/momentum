import admin from 'firebase-admin';

// ── Firebase Admin init (singleton) ──────────────────────────────────────────
// Mirrors api/ai.js and api/push.js exactly — same three env vars, no new
// Vercel config needed since they're already set up for those endpoints.
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

// ── In-memory rate limiter ────────────────────────────────────────────────────
// This only ever needs to run once per login (App calls it on boot) plus
// whenever the Refer & Earn card is opened, so a generous window is fine —
// this just stops accidental hammering, not a real abuse vector.
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;
function isRateLimited(uid) {
  const now = Date.now();
  const entry = rateLimitMap.get(uid) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(uid, { count: 1, windowStart: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  rateLimitMap.set(uid, entry);
  return false;
}

// ── Referral tier logic — ported exactly from index.html's
// REFERRAL_TIERS / referralEntitledDays / computeReferralGrant, so the two
// stay in lockstep. If the tiers ever change, update both places. ──────────
const REFERRAL_TIERS = [{ count: 1, days: 7 }, { count: 5, days: 20 }, { count: 10, days: 40 }, { count: 15, days: 60 }];
const REFERRAL_LIFETIME_CAP_DAYS = 60;

function referralEntitledDays(referralCount) {
  let entitled = 0;
  REFERRAL_TIERS.forEach(tier => { if (referralCount >= tier.count) entitled = tier.days; });
  return Math.min(REFERRAL_LIFETIME_CAP_DAYS, entitled);
}

function computeReferralGrant(currentPlan, currentExpiry, alreadyGranted, referralCount) {
  if (currentPlan === 'plus') return null;
  const entitled = referralEntitledDays(referralCount);
  const delta = entitled - (alreadyGranted || 0);
  if (delta <= 0) return null;
  const now = new Date();
  const curExp = currentExpiry ? new Date(currentExpiry) : null;
  const base = (curExp && curExp > now) ? curExp : now; // never reduces existing/paid time — only ever extends forward
  const newExpiry = new Date(base.getTime() + delta * 86400000);
  return { plan: 'pro', planExpiry: newExpiry.toISOString(), referralBonusDaysGranted: entitled };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  try {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (initError || !db) {
      console.error('Firebase Admin unavailable:', initError?.message);
      return res.status(500).json({ error: 'Server misconfigured (Firebase Admin init failed) — check FIREBASE_PRIVATE_KEY/FIREBASE_CLIENT_EMAIL/FIREBASE_PROJECT_ID env vars.' });
    }

    // ── Verify Firebase ID token — same pattern as api/ai.js ──────────────────
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '').trim();
    if (!idToken) return res.status(401).json({ error: 'Missing auth token' });

    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (e) {
      return res.status(401).json({ error: 'Invalid auth token' });
    }

    if (isRateLimited(uid)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }

    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
    const d = userSnap.data();

    // Count real referrals using the Admin SDK — this bypasses Firestore rules
    // entirely (that's the whole point: a trusted server can verify a fact the
    // client is never allowed to see enough of to compute itself). Only counts
    // referred friends who actually completed onboarding, matching the original
    // client-side query exactly.
    const refSnap = await db.collection('users')
      .where('referredBy', '==', uid)
      .where('onboardingCompleted', '==', true)
      .get();
    const referralCount = refSnap.size;

    // Treat an expired plan the same way the client's own boot-time check does —
    // an expired paid plan should be evaluated as "free" for grant purposes, and
    // a legacy "early_access" value should be treated the same way.
    const now = new Date();
    const rawPlan = d.plan || 'free';
    const rawExpiry = d.planExpiry || null;
    const isExpired = rawExpiry && new Date(rawExpiry) < now;
    const isLegacyEarly = rawPlan === 'early_access';
    const basePlan = (isExpired || isLegacyEarly) ? 'free' : rawPlan;
    const baseExpiry = (isExpired || isLegacyEarly) ? null : rawExpiry;

    const grant = computeReferralGrant(basePlan, baseExpiry, d.referralBonusDaysGranted || 0, referralCount);

    let finalWrite = null;
    if (isExpired || isLegacyEarly) finalWrite = { plan: 'free', planExpiry: null };
    if (grant) finalWrite = { ...(finalWrite || {}), ...grant };

    if (finalWrite) {
      await userRef.set(finalWrite, { merge: true });
    }

    return res.status(200).json({
      referralCount,
      plan: finalWrite?.plan || basePlan,
      planExpiry: finalWrite?.planExpiry !== undefined ? finalWrite.planExpiry : baseExpiry,
      granted: finalWrite ? true : false,
    });
  } catch (e) {
    console.error('referral-grant error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
