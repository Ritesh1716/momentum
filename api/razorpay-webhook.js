const crypto = require("crypto");

// ── CONFIG ─────────────────────────────────────────────────────
const WEBHOOK_SECRET   = "Polo1716@153";
const FIREBASE_PROJECT = "momentum-trackerapp";

// Plan map — payment link ID → plan + days
const PLAN_MAP = {
  "J1yRGww":  { plan: "pro",  days: 31  }, // Pro Monthly  ₹79
  "14bo7fq":  { plan: "pro",  days: 366 }, // Pro Yearly   ₹699
  "VB4xrvUB": { plan: "plus", days: 31  }, // Plus Monthly ₹149
  "u20bd5TY": { plan: "plus", days: 366 }, // Plus Yearly  ₹1499
};

// ── MAIN HANDLER ───────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. Read raw body (needed for signature check)
    const rawBody = await getRawBody(req);
    const signature = req.headers["x-razorpay-signature"];

    // 2. Verify signature — proves request is genuinely from Razorpay
    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (expected !== signature) {
      console.error("❌ Invalid signature");
      return res.status(400).json({ error: "Invalid signature" });
    }

    // 3. Parse event
    const event = JSON.parse(rawBody.toString());
    console.log("✅ Event received:", event.event);

    // Only care about successful payments
    if (event.event !== "payment.captured") {
      return res.status(200).json({ message: "Ignored: " + event.event });
    }

    const payment = event.payload.payment.entity;
    const email   = (payment.email || "").toLowerCase().trim();
    const amount  = payment.amount; // in paise
    const notes   = payment.notes  || {};
    const desc    = (payment.description || "").toLowerCase();

    console.log("Payment:", email, amount, "paise");

    if (!email) {
      console.error("❌ No email in payment");
      return res.status(200).json({ message: "No email" });
    }

    // 4. Detect plan from notes / amount / description
    const { plan, days } = detectPlan(notes, amount, desc);
    console.log("Plan detected:", plan, days, "days");

    // 5. Get Firebase Admin token using service account
    const token = await getFirebaseToken();

    // 6. Find user by email
    const userDoc = await findUserByEmail(token, email);
    if (!userDoc) {
      console.error("❌ User not found:", email);
      // Log to Firestore for manual review
      await logFailedPayment(token, email, plan, days, amount);
      return res.status(200).json({ message: "User not found — logged for manual review" });
    }

    const uid = userDoc.name.split("/").pop();
    console.log("User found:", uid);

    // 7. Update plan in Firestore
    await upgradePlan(token, uid, plan, days);
    console.log("✅ Upgraded:", uid, "→", plan, "for", days, "days");

    return res.status(200).json({ success: true, uid, plan, days });

  } catch (err) {
    console.error("❌ Webhook error:", err.message, err.stack);
    return res.status(500).json({ error: "Internal error" });
  }
};

// ── PLAN DETECTION ─────────────────────────────────────────────
function detectPlan(notes, amount, desc) {
  // Priority 1: explicit plan in payment notes (most reliable)
  // Razorpay lets you add custom notes to payment links
  if (notes.plan) {
    const p = notes.plan.toLowerCase();
    if (p.includes("plus") && (p.includes("year") || notes.period === "yearly")) return { plan:"plus", days:366 };
    if (p.includes("plus"))  return { plan:"plus", days:31  };
    if (p.includes("pro")  && (p.includes("year") || notes.period === "yearly")) return { plan:"pro",  days:366 };
    if (p.includes("pro"))   return { plan:"pro",  days:31  };
  }

  // Priority 2: match by exact amount in paise
  if (amount === 7900)    return { plan:"pro",  days:31  }; // ₹79
  if (amount === 69900)   return { plan:"pro",  days:366 }; // ₹699
  if (amount === 14900)   return { plan:"plus", days:31  }; // ₹149
  if (amount === 149900)  return { plan:"plus", days:366 }; // ₹1499

  // Priority 3: description text
  if (desc.includes("plus") && desc.includes("year")) return { plan:"plus", days:366 };
  if (desc.includes("plus"))  return { plan:"plus", days:31  };
  if (desc.includes("pro")  && desc.includes("year")) return { plan:"pro",  days:366 };
  if (desc.includes("pro"))   return { plan:"pro",  days:31  };

  // Default: Pro monthly
  console.log("⚠️ Could not detect plan — defaulting to Pro monthly");
  return { plan:"pro", days:31 };
}

// ── FIREBASE TOKEN (Service Account JWT) ───────────────────────
async function getFirebaseToken() {
  // Reads from Vercel environment variables:
  // FIREBASE_CLIENT_EMAIL  — service account email
  // FIREBASE_PRIVATE_KEY   — service account private key (with \n)

  const clientEmail  = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKeyRaw) {
    throw new Error("Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY env vars");
  }

  // Fix escaped newlines that Vercel sometimes adds
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore"
  };

  // Build JWT manually (no external libraries needed)
  const header = Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${header}.${body}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign.sign(privateKey, "base64url");

  const jwt = `${unsigned}.${signature}`;

  // Exchange JWT for access token
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error("Token exchange failed: " + JSON.stringify(data));
  }
  return data.access_token;
}

// ── FIRESTORE HELPERS ──────────────────────────────────────────
async function findUserByEmail(token, email) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "email" },
            op: "EQUAL",
            value: { stringValue: email }
          }
        },
        limit: 1
      }
    })
  });

  const results = await resp.json();
  if (results && results[0] && results[0].document) {
    return results[0].document;
  }
  return null;
}

async function upgradePlan(token, uid, plan, days) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`;

  // Get current expiry first
  const getResp = await fetch(url, {
    headers: { Authorization: "Bearer " + token }
  });
  const doc = await getResp.json();
  const currentExpiry = doc.fields?.planExpiry?.stringValue || null;

  // Add days to existing expiry or from today — whichever is later
  const today = new Date();
  let base = (currentExpiry && new Date(currentExpiry) > today)
    ? new Date(currentExpiry)
    : new Date(today);
  base.setDate(base.getDate() + days);
  const newExpiry = base.toISOString().split("T")[0];

  // PATCH only plan and planExpiry fields
  const patchUrl = url + "?updateMask.fieldPaths=plan&updateMask.fieldPaths=planExpiry";
  await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fields: {
        plan:       { stringValue: plan },
        planExpiry: { stringValue: newExpiry }
      }
    })
  });

  console.log("Plan set:", plan, "until", newExpiry);
}

async function logFailedPayment(token, email, plan, days, amount) {
  // Store in a 'payment_issues' collection for manual review
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/payment_issues`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fields: {
        email:     { stringValue: email },
        plan:      { stringValue: plan },
        days:      { integerValue: days },
        amount:    { integerValue: amount },
        timestamp: { stringValue: new Date().toISOString() },
        resolved:  { booleanValue: false }
      }
    })
  });
}

// ── RAW BODY READER ────────────────────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
      }
