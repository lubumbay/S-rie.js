// Backend Swahili Man : catalogue, paiement manuel / pawaPay, espace administrateur
// Node 18+ requis (fetch intégré)
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.SITE_URL || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const {
  PAWAPAY_TOKEN, PAWAPAY_BASE = "https://api.sandbox.pawapay.io", RETURN_URL,
  ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_KEY, PORT = 3000,
} = process.env;

// ---------- Stockage : Supabase si configuré, sinon fichiers (effacés par Render !) ----------
const useDb = SUPABASE_URL && SUPABASE_KEY;
const dbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

async function kvGet(key, fallback) {
  if (useDb) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/kv?key=eq.${key}&select=value`, { headers: dbHeaders });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0].value : fallback;
  }
  const f = `./${key}.json`;
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : fallback;
}
async function kvSet(key, value) {
  if (useDb) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/kv`, {
      method: "POST", headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, value }),
    });
    if (!r.ok) throw new Error("Supabase " + r.status);
    return;
  }
  fs.writeFileSync(`./${key}.json`, JSON.stringify(value, null, 2));
}

const h = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "Erreur serveur" }); });
const fmt = (n, cur) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " " + cur;
const ytId = (s) => {
  s = String(s || "").trim();
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
  return m ? m[1] : /^[\w-]{11}$/.test(s) ? s : "";
};

// Catalogue : au premier démarrage, reprend series.json (la série de départ)
async function getSeries() {
  let s = await kvGet("catalog", null);
  if (s) return s;
  s = {};
  if (fs.existsSync("./series.json")) {
    const seed = JSON.parse(fs.readFileSync("./series.json", "utf8"));
    for (const [id, v] of Object.entries(seed)) {
      s[id] = {
        title: v.title, ep: 10, video: "WAkkpz51Zuc", driveLink: v.driveLink,
        descSw: "Ayoumani anakataa kufa kwa sababu ya mpenzi wake wa zamani. Kati ya mapenzi, usaliti na matumaini, anapigania kuanza maisha mapya. Je, atashinda?",
        descFr: "Ayoumani refuse de mourir à cause de son ex. Entre amour, trahison et espoir, il se bat pour reprendre sa vie en main. Y arrivera-t-il ?",
        priceTZS: v.price.TZA.amount, priceCDF: v.price.COD.amount,
      };
    }
  }
  return s;
}

const pawapay = (path, options = {}) =>
  fetch(PAWAPAY_BASE + path, { ...options, headers: { Authorization: `Bearer ${PAWAPAY_TOKEN}`, "Content-Type": "application/json" } }).then((r) => r.json());

// ---------- Public ----------
app.get("/series", h(async (req, res) => {
  const s = await getSeries();
  res.json(Object.entries(s).map(([id, v]) => ({
    id, type: v.type || "serie", title: v.title, ep: v.ep, video: v.video,
    desc: { sw: v.descSw, fr: v.descFr, en: v.descFr },
    price: { TZA: fmt(v.priceTZS, "TZS"), COD: fmt(v.priceCDF, "FC") },
  })));
}));

app.get("/access", h(async (req, res) => {
  const { userId, seriesId } = req.query;
  const db = await kvGet("purchases", {});
  const paid = Object.values(db).some((p) => p.userId === userId && p.seriesId === seriesId && p.status === "PAID");
  const s = await getSeries();
  if (!paid || !s[seriesId]) return res.status(403).json({ paid: false });
  res.json({ paid: true, link: s[seriesId].driveLink });
}));

// Paiement manuel : le client dit "j'ai payé" et donne la référence
app.post("/manual-pay", h(async (req, res) => {
  const { userId, seriesId, country = "TZA", reference } = req.body || {};
  const ref = String(reference || "").trim().slice(0, 40);
  const s = await getSeries();
  if (!/^\d{9,15}$/.test(String(userId || "")) || !s[seriesId] || ref.length < 4) return res.status(400).json({ error: "Données invalides" });
  const db = await kvGet("purchases", {});
  const same = Object.entries(db).find(([, p]) => p.method === "manual" && p.userId === userId && p.seriesId === seriesId && p.status === "PENDING_MANUAL");
  const id = same ? same[0] : crypto.randomUUID();
  db[id] = { method: "manual", userId, seriesId, country, reference: ref, status: "PENDING_MANUAL", createdAt: new Date().toISOString() };
  await kvSet("purchases", db);
  res.json({ ok: true });
}));

// ---------- pawaPay automatique (pour plus tard) ----------
app.post("/pay", h(async (req, res) => {
  const { userId, seriesId, country = "TZA" } = req.body;
  const s = await getSeries();
  if (!userId || !s[seriesId]) return res.status(400).json({ error: "Données invalides" });
  const amount = country === "COD" ? s[seriesId].priceCDF : s[seriesId].priceTZS;
  const currency = country === "COD" ? "CDF" : "TZS";
  const depositId = crypto.randomUUID();
  const result = await pawapay("/v2/paymentpage", {
    method: "POST",
    body: JSON.stringify({ depositId, returnUrl: RETURN_URL, amountDetails: { amount: String(amount), currency }, country, reason: `Serie: ${s[seriesId].title}`.slice(0, 50), language: "EN" }),
  });
  if (!result.redirectUrl) { console.error("Erreur pawaPay :", JSON.stringify(result)); return res.status(502).json({ error: "pawaPay" }); }
  const db = await kvGet("purchases", {});
  db[depositId] = { userId, seriesId, status: "PENDING", createdAt: new Date().toISOString() };
  await kvSet("purchases", db);
  res.json({ paymentUrl: result.redirectUrl, depositId });
}));

app.post("/pawapay/callback", async (req, res) => {
  res.sendStatus(200);
  try {
    const { depositId } = req.body || {};
    const db = await kvGet("purchases", {});
    if (!depositId || !db[depositId]) return;
    const check = await pawapay(`/v2/deposits/${depositId}`);
    db[depositId].status = (check?.data?.status ?? check?.status) === "COMPLETED" ? "PAID" : "FAILED";
    await kvSet("purchases", db);
  } catch (e) { console.error(e); }
});

// ---------- Espace administrateur ----------
const fails = {};
function adminAuth(req, res, next) {
  const f = fails[req.ip] || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return res.status(429).json({ error: "Trop d'essais" });
  const a = Buffer.from(String(req.headers["x-admin-password"] || ""));
  const b = Buffer.from(ADMIN_PASSWORD || "");
  if (!(ADMIN_PASSWORD && a.length === b.length && crypto.timingSafeEqual(a, b))) { f.n++; fails[req.ip] = f; return res.status(401).json({ error: "Non autorisé" }); }
  next();
}

app.get("/admin/requests", adminAuth, h(async (req, res) => {
  const db = await kvGet("purchases", {});
  const s = await getSeries();
  res.json(Object.entries(db).filter(([, p]) => p.method === "manual")
    .map(([id, p]) => ({ id, ...p, title: s[p.seriesId] ? s[p.seriesId].title : p.seriesId }))
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 50));
}));

app.post("/admin/decision", adminAuth, h(async (req, res) => {
  const { id, approve } = req.body || {};
  const db = await kvGet("purchases", {});
  if (!db[id] || db[id].method !== "manual") return res.status(404).json({ error: "Introuvable" });
  db[id].status = approve ? "PAID" : "REJECTED";
  await kvSet("purchases", db);
  res.json({ ok: true });
}));

app.get("/admin/series", adminAuth, h(async (req, res) => {
  const s = await getSeries();
  res.json(Object.entries(s).map(([id, v]) => ({ id, ...v })));
}));

// Créer ou modifier une série
app.post("/admin/series", adminAuth, h(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim().slice(0, 80);
  const video = ytId(b.video);
  const link = String(b.driveLink || "").trim();
  const type = b.type === "film" ? "film" : "serie";
  const ep = type === "film" ? 1 : parseInt(b.ep, 10), pt = Number(b.priceTZS), pc = Number(b.priceCDF);
  if (!title || !video || !/^https:\/\//.test(link) || !(ep >= 1 && ep <= 500) || !(pt > 0) || !(pc > 0))
    return res.status(400).json({ error: "Champs invalides : vérifiez titre, lien YouTube, lien Drive (https://), épisodes et prix." });
  const s = await getSeries();
  const id = b.id && s[b.id] ? b.id : "s" + Date.now().toString(36);
  s[id] = { type, title, ep, video, driveLink: link, descSw: String(b.descSw || "").slice(0, 500), descFr: String(b.descFr || "").slice(0, 500), priceTZS: Math.round(pt), priceCDF: Math.round(pc) };
  await kvSet("catalog", s);
  res.json({ ok: true, id });
}));

app.post("/admin/series-delete", adminAuth, h(async (req, res) => {
  const s = await getSeries();
  if (!s[(req.body || {}).id]) return res.status(404).json({ error: "Introuvable" });
  delete s[req.body.id];
  await kvSet("catalog", s);
  res.json({ ok: true });
}));

app.listen(PORT, () => console.log(`Serveur sur le port ${PORT} (stockage : ${useDb ? "Supabase" : "fichiers"})`));
        
