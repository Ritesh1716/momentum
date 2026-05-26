const crypto = require("crypto");

const WEBHOOK_SECRET   = "Polo1716@153";
const FIREBASE_PROJECT = "momentum-trackerapp";

const PLAN_MAP = {
  "pro_monthly":   { plan: "pro",  days: 31  },
  "pro_yearly":    { plan: "pro",  days: 366 },
  "plus_monthly":  { plan: "plus", days: 31  },
  "plus_yearly":   { plan: "plus", days: 366 },
};

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
    if (event.event !== "payment.captured") return res.status(200).json({ message: "Ignored" });

    const payment = event.payload.payment.entity;
    const amount  = payment.amount;
    const notes   = payment.notes || {};

    // Get email and UID from notes (set by app via payLink function)
    const emailFromNotes = (notes.email || "").toLowerCase().trim();
    const emailFromPayment = (payment.email || "").toLowerCase().trim();
    const uid = (notes.uid || "").trim();
    const planFromNotes = (notes.plan || "").toLowerCase().trim();

    // Use notes email first, fallback to payment email
    const email = emailFromNotes && emailFromNotes !== "void@razorpay.com"
      ? emailFromNotes
      : emailFromPayment;

    console.log("Email:", email, "| UID:", uid, "| Plan note:", planFromNotes);
    console.log("Amount:", amount, "paise");

    const { plan, days } = detectPlan(planFromNotes, amount);
    console.log("Plan:", plan, days, "days");

    const token = await getFirebaseToken();

    // Try finding user by UID first (most reliable), then email
    let userDoc = null;
    let uid_used = null;

    if (uid && uid.length > 5) {
      userDoc = await getUserByUID(token, uid);
      if (userDoc) uid_used = uid;
    }

    if (!userDoc && email && email !== "void@razorpay.com") {
      userDoc = await findUserByEmail(token, email);
      if (userDoc) uid_used = userDoc.name.split("/").pop();
    }

    if (!userDoc) {
      console.error("❌ User not found. Email:", email, "UID:", uid);
      await logFailedPayment(token, email, uid, plan, days, amount);
      return res.status(200).json({ message: "User not found — logged" });
    }

    console.log("✅ User found:", uid_used);
    await upgradePlan(token, uid_used, plan, days);
    console.log("✅ Upgraded:", uid_used, "→", plan, days, "days");

    return res.status(200).json({ success: true, uid: uid_used, plan, days });

  } catch (err) {
    console.error("❌ Error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
};

function detectPlan(planNote, amount) {
  // Priority 1: plan name from notes
  if (PLAN_MAP[planNote]) return PLAN_MAP[planNote];

  // Priority 2: amount in paise
  if (amount === 7900)   return { plan:"pro",  days:31  };
  if (amount === 69900)  return { plan:"pro",  days:366 };
  if (amount === 14900)  return { plan:"plus", days:31  };
  if (amount === 149900) return { plan:"plus", days:366 };

  console.log("⚠️ Unknown plan — defaulting Pro monthly");
  return { plan:"pro", days:31 };
}

async function getFirebaseToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw new Error("Missing Firebase env vars");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail, sub: clientEmail,
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore"
  };

  const header = Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify(payload)).toString("base64url");
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
  if (!data.access_token) throw new Error("Token failed: " + JSON.stringify(data));
  return data.access_token;
}

async function getUserByUID(token, uid) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`;
  const resp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const doc = await resp.json();
  if (doc.name) return doc;
  return null;
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
  if (results && results[0] && results[0].document) return results[0].document;
  return null;
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
    body: JSON.stringify({ fields: { plan: { stringValue: plan }, planExpiry: { stringValue: newExpiry } } })
  });
  console.log("Plan:", plan, "until", newExpiry);
}

async function logFailedPayment(token, email, uid, plan, days, amount) {
  await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/payment_issues`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {
      email: { stringValue: email||"" },
      uid:   { stringValue: uid||"" },
      plan:  { stringValue: plan },
      days:  { integerValue: days },
      amount:{ integerValue: amount },
      timestamp: { stringValue: new Date().toISOString() },
      resolved:  { booleanValue: false }
    }})
  });
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
