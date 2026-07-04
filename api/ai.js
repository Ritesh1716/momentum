import admin from 'firebase-admin';

// ── Firebase Admin init (singleton) ──────────────────────────────────────────
// If this throws (e.g. malformed FIREBASE_PRIVATE_KEY), it happens at cold-start
// module-load time — before any request handler runs — which is the #1 cause of
// FUNCTION_INVOCATION_FAILED on every single call. Wrapped so we at least log
// clearly instead of failing silently; the handler below also guards against
// admin.firestore() / admin.auth() being unusable if init genuinely failed.
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

// ── Prompt injection sanitizer ────────────────────────────────────────────────
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<\|.*?\|>/g, '')
    .replace(/\[INST\]|\[\/INST\]/gi, '')
    .replace(/###\s*(system|instruction|prompt)/gi, '')
    .slice(0, 4000);
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return { ...msg, content: sanitizeText(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(block =>
          block.type === 'text' ? { ...block, text: sanitizeText(block.text) } : block
        ),
      };
    }
    return msg;
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Top-level safety net: no matter what throws below, the client always gets
  // a clean JSON error instead of a raw FUNCTION_INVOCATION_FAILED crash page.
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (initError || !db) {
      console.error('Firebase Admin unavailable:', initError?.message);
      return res.status(500).json({ error: 'Server misconfigured (Firebase Admin init failed) — check FIREBASE_PRIVATE_KEY/FIREBASE_CLIENT_EMAIL/FIREBASE_PROJECT_ID env vars.' });
    }

    // Guard against missing/malformed body before touching any of its fields.
    const reqBody = (req.body && typeof req.body === 'object') ? req.body : {};

    // ── S2: Verify Firebase ID token ──────────────────────────────────────────
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

    // ── S4: Rate limiting ─────────────────────────────────────────────────────
    if (isRateLimited(uid)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }

    // ── S3: Atomic credit deduction ───────────────────────────────────────────
    const cost = parseInt(reqBody.creditCost) || 1;
    const usageType = reqBody.usageType || 'ai_call';
    const userRef = db.collection('users').doc(uid);

    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(userRef);
        const credits = snap.data()?.aiCredits ?? 0;
        if (credits < cost) throw new Error('insufficient_credits');
        tx.update(userRef, { aiCredits: credits - cost });
      });
    } catch (e) {
      if (e.message === 'insufficient_credits') {
        return res.status(402).json({ error: 'Insufficient credits' });
      }
      console.error('Credit deduction failed:', e.message);
      return res.status(500).json({ error: 'Credit deduction failed' });
    }

    // ── S5: Sanitize prompt ───────────────────────────────────────────────────
    const body = { ...reqBody };
    if (body.messages) body.messages = sanitizeMessages(body.messages);
    delete body.creditCost;
    delete body.usageType;

    // ── Forward to Anthropic ──────────────────────────────────────────────────
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const anthropicOk = response.ok;
      let data;
      try {
        data = await response.json();
      } catch (parseErr) {
        // Anthropic returned a non-JSON body (rare, but same class of bug we just
        // fixed client-side) — refund the credit and surface a clean error.
        await userRef.update({ aiCredits: admin.firestore.FieldValue.increment(cost) }).catch(() => {});
        return res.status(502).json({ error: 'Anthropic returned an unreadable response' });
      }

      if (!anthropicOk) {
        // Refund the credit — the user paid for nothing since the AI call failed.
        await userRef.update({ aiCredits: admin.firestore.FieldValue.increment(cost) }).catch(refundErr => {
          console.error('Credit refund failed after Anthropic error:', refundErr.message);
        });
        return res.status(response.status).json(data);
      }

      // ── Usage log (only on success, capped at 10 entries) ─────────────────
      try {
        const snap = await userRef.get();
        const existing = snap.data()?.aiUsageLog || [];
        const entry = { ts: new Date().toISOString(), type: usageType, cost };
        const updated = [...existing, entry].slice(-10);
        await userRef.update({ aiUsageLog: updated });
      } catch (logErr) {
        console.warn('Usage log write failed (non-fatal):', logErr.message);
      }

      return res.status(response.status).json(data);
    } catch (e) {
      // Network-level failure calling Anthropic — refund the credit too.
      await userRef.update({ aiCredits: admin.firestore.FieldValue.increment(cost) }).catch(() => {});
      console.error('Proxy error:', e.message);
      return res.status(500).json({ error: 'Proxy error', detail: e.message });
    }
  } catch (e) {
    // Absolute last resort — should be unreachable now, but guarantees the
    // client always gets JSON back instead of a raw crash page.
    console.error('Unhandled error in /api/ai:', e);
    return res.status(500).json({ error: 'Unexpected server error', detail: e.message });
  }
}
