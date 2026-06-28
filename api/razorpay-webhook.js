const crypto = require("crypto");

const WEBHOOK_SECRET   = process.env.RAZORPAY_WEBHOOK_SECRET;
const FIREBASE_PROJECT = "momentum-trackerapp";

// ── Daily rates (paise → rupees handled at detection, rates in rupees) ────────
const DAILY_RATES = {
  pro_monthly:  79   / 30,   // ₹2.633/day
  pro_yearly:   699  / 365,  // ₹1.915/day
  plus_monthly: 149  / 30,   // ₹4.967/day
  plus_yearly:  1499 / 365,  // ₹4.106/day
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const rawBody  = await getRawBody(req);
    const signature = req.headers["x-razorpay-signature"];

    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ""))) {
      console.error("❌ Invalid signature");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody.toString());
    console.log("✅ Event:", event.event);
    if (event.event !== "payment.captured")
      return res.status(200).json({ message: "Ignored: " + event.event });

    const payment   = event.payload.payment.entity;
    const amount    = payment.amount;
    const notes     = payment.notes || {};

    // ── Identity resolution ───────────────────────────────────────────────────
    const emailFromNotes   = (notes.email   || "").toLowerCase().trim();
    const emailFromPayment = (payment.email || "").toLowerCase().trim();
    const uid      = (notes.uid  || "").trim();
    const planNote = (notes.plan || "").toLowerCase().trim();
    const email    = (emailFromNotes && emailFromNotes !== "void@razorpay.com")
      ? emailFromNotes : emailFromPayment;

    // ── Pro→Plus proration metadata (passed from app payLink notes) ───────────
    const upgradeFrom         = (notes.upgradeFrom        || "").toLowerCase().trim();
    const proRemainingDays    = parseInt(notes.proRemainingDays    || "0", 10) || 0;
    const bonusDays           = parseInt(notes.bonusDays           || "0", 10) || 0;
    const proCreditsRemaining = parseInt(notes.proCreditsRemaining || "0", 10) || 0;
    const bonusPool           = parseInt(notes.bonusPool           || "0", 10) || 0;
    const isUpgradeFromPro    = upgradeFrom === "pro" && proRemainingDays > 0;

    console.log(
      "Email:", email, "| UID:", uid, "| Plan:", planNote, "| Amount:", amount,
      isUpgradeFromPro
        ? `| PRO→PLUS UPGRADE | proRemDays:${proRemainingDays} bonusDays:${bonusDays} proCredits:${proCreditsRemaining} bonusPool:${bonusPool}`
        : ""
    );

    const { plan, planKey, baseDays } = detectPlan(planNote, amount);
    console.log("Detected plan:", plan, "| planKey:", planKey, "| baseDays:", baseDays);

    const token = await getFirebaseToken();
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
      await logFailedPayment(token, email, uid, plan, baseDays, amount, notes);
      return res.status(200).json({ message: "User not found — logged for manual review" });
    }

    // ── Apply plan update (with proration if Pro→Plus upgrade) ───────────────
    const result = await upgradePlan(
      token, userUID, plan, planKey, baseDays,
      isUpgradeFromPro ? { bonusDays, proCreditsRemaining, bonusPool, isProYearlyUpgrade: bonusPool > 10 } : null
    );

    console.log("✅ Upgraded:", userUID, "→", plan, "| expiry:", result.newExpiry,
      isUpgradeFromPro ? `| bonusDays:${bonusDays} | newCredits:${result.newCredits} | bonusPool:${result.newBonusPool}` : ""
    );

    return res.status(200).json({ success: true, uid: userUID, plan, baseDays, ...result });

  } catch (err) {
    console.error("❌ Webhook error:", err.message, err.stack);
    return res.status(500).json({ error: "Internal error" });
  }
};

// ── Plan detection: planNote first, amount fallback ───────────────────────────
function detectPlan(planNote, amount) {
  // planNote can include suffixes like _winback, _from_pro — normalise
  const normalised = planNote
    .replace(/_winback$/, "")
    .replace(/_from_pro$/, "")
    .replace(/_pro_winback$/, "");

  const MAP = {
    "pro_monthly":  { plan:"pro",  planKey:"pro_monthly",  baseDays:30  },
    "pro_yearly":   { plan:"pro",  planKey:"pro_yearly",   baseDays:365 },
    "plus_monthly": { plan:"plus", planKey:"plus_monthly", baseDays:30  },
    "plus_yearly":  { plan:"plus", planKey:"plus_yearly",  baseDays:365 },
  };
  if (MAP[normalised]) return MAP[normalised];

  // Amount fallback (amount in paise)
  if (amount === 7900)    return { plan:"pro",  planKey:"pro_monthly",  baseDays:30  };
  if (amount === 69900)   return { plan:"pro",  planKey:"pro_yearly",   baseDays:365 };
  if (amount === 14900)   return { plan:"plus", planKey:"plus_monthly", baseDays:30  };
  if (amount === 149900)  return { plan:"plus", planKey:"plus_yearly",  baseDays:365 };

  console.log("⚠️ Unknown plan/amount — defaulting to Pro monthly");
  return { plan:"pro", planKey:"pro_monthly", baseDays:30 };
}

// ── Firebase token via service account JWT ────────────────────────────────────
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

  const header   = Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT" })).toString("base64url");
  const body     = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${header}.${body}`;
  const sign     = crypto.createSign("RSA-SHA256");
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

// ── Firestore helpers ─────────────────────────────────────────────────────────
async function getUserByUID(token, uid) {
  const url  = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`;
  const resp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const doc  = await resp.json();
  return doc.name ? doc : null;
}

async function findUserByEmail(token, email) {
  const url  = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery`;
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

// ── Core plan upgrade — handles both fresh purchases and Pro→Plus proration ───
async function upgradePlan(token, uid, plan, planKey, baseDays, prorationMeta) {
  const url     = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${uid}`;
  const getResp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const doc     = await getResp.json();

  const fields          = doc.fields || {};
  const currentPlan     = fields.planExpiry?.stringValue || null;
  const currentExpiry   = fields.planExpiry?.stringValue || null;
  const existingCredits = parseInt(fields.aiCredits?.integerValue || fields.aiCredits?.doubleValue || "0", 10) || 0;
  const existingBonus   = parseInt(fields.aiCreditsBonus?.integerValue || "0", 10) || 0;
  const today           = new Date(); today.setHours(0, 0, 0, 0);

  // ── Expiry calculation ────────────────────────────────────────────────────
  // For Pro→Plus upgrade: fresh baseDays + bonusDays from proration
  // For fresh purchase:   baseDays from today (never stack on existing — new plan starts fresh)
  let newExpiry;
  let actualBonusDays = 0;

  if (prorationMeta && prorationMeta.bonusDays > 0) {
    // Pro→Plus upgrade: fresh Plus period + bonus days from remaining Pro value
    actualBonusDays = prorationMeta.bonusDays;
    const exp = new Date();
    exp.setDate(exp.getDate() + baseDays + actualBonusDays);
    newExpiry = exp.toISOString().split("T")[0];
    console.log(`Pro→Plus proration: baseDays=${baseDays} + bonusDays=${actualBonusDays} → expiry ${newExpiry}`);
  } else {
    // Fresh purchase: start from today
    const exp = new Date();
    exp.setDate(exp.getDate() + baseDays);
    newExpiry = exp.toISOString().split("T")[0];
  }

  // ── AI Credits calculation ────────────────────────────────────────────────
  // Monthly credits reset to plan max on 1st of month (handled in app)
  // Here we only write the bonus pool and carry-over for Pro→Plus upgrade
  const thisMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  let newCredits    = 50;  // Plus monthly base (or 10 for Pro)
  let newBonusPool  = 0;

  if (plan === "plus") {
    if (prorationMeta) {
      if (prorationMeta.isProYearlyUpgrade) {
        // Pro Yearly → Plus: full bonus pool carries separately
        // Monthly credits reset to 50 normally; bonus pool is extra
        newCredits   = 50;
        newBonusPool = prorationMeta.bonusPool;   // e.g. 96 credits
        console.log(`Pro Yearly→Plus: fresh 50 monthly + bonusPool=${newBonusPool}`);
      } else {
        // Pro Monthly → Plus: carry remaining Pro credits into first month's 50
        // Max possible carry = 10 (unused Pro credits) + 50 = 60
        const carry  = Math.min(prorationMeta.proCreditsRemaining, 10);
        newCredits   = 50 + carry;
        newBonusPool = 0;
        console.log(`Pro Monthly→Plus: 50 + ${carry} carry = ${newCredits} first month`);
      }
    } else {
      // Fresh Plus purchase (no proration)
      newCredits   = 50;
      newBonusPool = 0;
    }
  } else if (plan === "pro") {
    // Fresh Pro purchase
    newCredits   = 10;
    newBonusPool = 0;
  }

  // ── Build Firestore PATCH fields ─────────────────────────────────────────
  const updateFields = {
    plan:                { stringValue:  plan      },
    planExpiry:          { stringValue:  newExpiry },
    planPurchaseDate:    { stringValue:  today.toISOString().split("T")[0] },
    aiCredits:           { integerValue: String(newCredits)   },
    aiCreditsBonus:      { integerValue: String(newBonusPool) },
    aiCreditsResetMonth: { stringValue:  thisMonth },
  };

  // upgradeLog: array of past upgrades — append to existing (cap at 10)
  const existingLog = fields.upgradeLog?.arrayValue?.values || [];
  const logEntry = {
    mapValue: { fields: {
      from:               { stringValue:  existingLog.length > 0 ? (fields.plan?.stringValue || "free") : "free" },
      to:                 { stringValue:  plan },
      planKey:            { stringValue:  planKey },
      date:               { stringValue:  today.toISOString().split("T")[0] },
      baseDays:           { integerValue: String(baseDays) },
      bonusDays:          { integerValue: String(actualBonusDays) },
      newExpiry:          { stringValue:  newExpiry },
      creditsGranted:     { integerValue: String(newCredits) },
      bonusPoolGranted:   { integerValue: String(newBonusPool) },
      proRemainingDays:   { integerValue: String(prorationMeta?.bonusDays ? prorationMeta.bonusDays : 0) },
      isProration:        { booleanValue: !!(prorationMeta && prorationMeta.bonusDays > 0) },
    }}
  };
  const updatedLog = [...existingLog.slice(-9), logEntry]; // keep last 10
  updateFields.upgradeLog = { arrayValue: { values: updatedLog } };

  // ── Build updateMask ──────────────────────────────────────────────────────
  const maskFields = Object.keys(updateFields)
    .map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");

  const patchResp = await fetch(`${url}?${maskFields}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: updateFields })
  });

  if (!patchResp.ok) {
    const errBody = await patchResp.text();
    throw new Error(`Firestore PATCH failed: ${patchResp.status} — ${errBody}`);
  }

  console.log("Firestore updated:", { plan, newExpiry, newCredits, newBonusPool });
  return { newExpiry, newCredits, newBonusPool: newBonusPool, bonusDays: actualBonusDays };
}

// ── Log failed payments for manual recovery ───────────────────────────────────
async function logFailedPayment(token, email, uid, plan, days, amount, notes) {
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/payment_issues`,
    {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          email:             { stringValue:  email || "" },
          uid:               { stringValue:  uid   || "" },
          plan:              { stringValue:  plan },
          days:              { integerValue: String(days) },
          amount:            { integerValue: String(amount) },
          timestamp:         { stringValue:  new Date().toISOString() },
          resolved:          { booleanValue: false },
          // Proration recovery data — enough to manually apply upgrade
          upgradeFrom:       { stringValue:  (notes.upgradeFrom        || "") },
          proRemainingDays:  { integerValue: String(parseInt(notes.proRemainingDays    || "0", 10)) },
          bonusDays:         { integerValue: String(parseInt(notes.bonusDays           || "0", 10)) },
          proCredits:        { integerValue: String(parseInt(notes.proCreditsRemaining || "0", 10)) },
          bonusPool:         { integerValue: String(parseInt(notes.bonusPool           || "0", 10)) },
        }
      })
    }
  );
}

// ── Raw body reader ───────────────────────────────────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data",  c  => chunks.push(c));
    req.on("end",   () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
                                 }
