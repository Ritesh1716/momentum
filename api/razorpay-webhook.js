const crypto = require("crypto");

const WEBHOOK_SECRET   = "Polo1716@153";
const FIREBASE_PROJECT = "momentum-trackerapp";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers["x-razorpay-signature"];

    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
    if (expected !== signature) {
      console.error("❌ Invalid signature");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody.toString());
    console.log("✅ Event:", event.event);
    if (event.event !== "payment.captured") return res.status(200).json({ message: "Ignored: " + event.event });

    const payment = event.payload.payment.entity;
    const amount  = payment.amount; // paise
    const notes   = payment.notes  || {};

    // Payment Pages send email in notes (set by payLink function in app)
    const emailFromNotes   = (notes.email   || "").toLowerCase().trim();
    const emailFromPayment = (payment.email || "").toLowerCase().trim();
    const uid   = (notes.uid   || "").trim();
    const planNote = (notes.plan || "").toLowerCase().trim();

    // Use notes email first (most reliable — set by app), fallback to payment email
    const email = (emailFromNotes && emailFromNotes !== "void@razorpay.com")
      ? emailFromNotes
      : emailFromPayment;

    console.log("Email:", email, "| UID:", uid, "| Plan:", planNote, "| Amount:", amount);

    const { plan, days } = detectPlan(planNote, amount);
    console.log("Detected plan:", plan, days, "days");

    const token = await getFirebaseToken();

    // Find user — try UID first (fastest), then email
    let userUID = null;

    if (uid && uid.length > 4) {
      const doc = await getUserByUID(token, uid);
      if (doc) { userUID = uid; console.log("✅ Found by UID:", uid); }
    }

    if (!userUID && email && email !== "void@razorpay.com") {
      const doc = await findUserByEmail(token, email);
      if (doc) { userUID = doc.name.split("/").pop(); console.log("✅ Found by email:", email); }
    }

    if (!userUID) {
      console.error("❌ User not found. Email:", email, "UID:", uid);
      await logFailedPayment(token, email, uid, plan, days, amount);
      return res.status(200).json({ message: "User not found — logged for manual review" });
    }

    await upgradePlan(token, userUID, plan, days);
    console.log("✅ Upgraded:", userUID, "→", plan, days, "days");

    return res.status(200).json({ success: true, uid: userUID, plan, days });

  } catch (err) {
    console.error("❌ Webhook error:", err.message, err.stack);
    return res.status(500).json({ error: "Internal error" });
  }
};

// ── PLAN DETECTION ─────────────────────────────────────────────
function detectPlan(planNote, amount) {
  // Priority 1: plan name from notes (set by app payLink function)
  const MAP = {
    "pro_monthly":  { plan:"pro",  days:31  },
    "pro_yearly":   { plan:"pro",  days:366 },
    "plus_monthly": { plan:"plus", days:31  },
    "plus_yearly":  { plan:"plus", days:366 },
  };
  if (MAP[planNote]) return MAP[planNote];

  // Priority 2: exact amount in paise
  if (amount === 7900)   return { plan:"pro",  days:31  }; // ₹79
  if (amount === 69900)  return { plan:"pro",  days:366 }; // ₹699
  if (amount === 14900)  return { plan:"plus", days:31  }; // ₹149
  if (amount === 149900) return { plan:"plus", days:366 }; // ₹1499

  console.log("⚠️ Unknown plan/amount — defaulting to Pro monthly");
  return { plan:"pro", days:31 };
}

// ── FIREBASE TOKEN ─────────────────────────────────────────────
async function getFirebaseToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw new Error("Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail, sub: clientEmail,
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore"
  };

  const header  = Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT" })).toString("base64url");
  const body    = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${header}.${body}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(privateKey, "base64url")}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Token exchange failed: " + JSON.stringify(data));
  return data.access_token;
}

// ── FIRESTORE HELPERS ──────────────────────────────────────────
async function getUserByUID(token, uid) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`;
  const resp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const doc = await resp.json();
  return doc.name ? doc : null;
}

async function findUserByEmail(token, email) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: { fieldFilter: { field: { fieldPath: "email" }, op: "EQUAL", value: { stringValue: email } } },
        limit: 1
      }
    })
  });
  const results = await resp.json();
  return (results && results[0] && results[0].document) ? results[0].document : null;
}

async function upgradePlan(token, uid, plan, days) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`;
  const getResp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const doc = await getResp.json();
  const currentExpiry = doc.fields?.planExpiry?.stringValue || null;

  const today = new Date();
  let base = (currentExpiry && new Date(currentExpiry) > today) ? new Date(currentExpiry) : new Date(today);
  base.setDate(base.getDate() + days);
  const newExpiry = base.toISOString().split("T")[0];

  await fetch(url + "?updateMask.fieldPaths=plan&updateMask.fieldPaths=planExpiry", {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        plan:       { stringValue: plan },
        planExpiry: { stringValue: newExpiry }
      }
    })
  });
  console.log("Plan updated:", plan, "until", newExpiry);
}

async function logFailedPayment(token, email, uid, plan, days, amount) {
  await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/payment_issues`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        email:     { stringValue: email||"" },
        uid:       { stringValue: uid||"" },
        plan:      { stringValue: plan },
        days:      { integerValue: days },
        amount:    { integerValue: amount },
        timestamp: { stringValue: new Date().toISOString() },
        resolved:  { booleanValue: false }
      }
    })
  });
}

// ── RAW BODY ───────────────────────────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
                                 }
