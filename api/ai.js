import admin from 'firebase-admin';

// ── Firebase Admin init (singleton) ──────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

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

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

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
  const cost = parseInt(req.body.creditCost) || 1;
  const usageType = req.body.usageType || 'ai_call';
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
    return res.status(500).json({ error: 'Credit deduction failed' });
  }

  // ── S5: Sanitize prompt ───────────────────────────────────────────────────
  const body = { ...req.body };
  if (body.messages) body.messages = sanitizeMessages(body.messages);
  delete body.creditCost;
  delete body.usageType;

  // ── Forward to Anthropic ──────────────────────────────────────────────────
  let anthropicOk = false;
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
    const data = await response.json();
    anthropicOk = response.ok;

    // ── Usage log (only on success, capped at 30 entries) ─────────────────
    if (anthropicOk) {
      try {
        const snap = await userRef.get();
        const existing = snap.data()?.aiUsageLog || [];
        const entry = {
          ts: new Date().toISOString(),
          type: usageType,
          cost,
        };
        const updated = [...existing, entry].slice(-10); // cap at 10
        await userRef.update({ aiUsageLog: updated });
      } catch (logErr) {
        console.warn('Usage log write failed (non-fatal):', logErr.message);
      }
    }

    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error', detail: e.message });
  }
}
