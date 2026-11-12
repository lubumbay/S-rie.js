// Backend minimal : paiement pawaPay + déblocage du lien Drive
// Node 18+ requis (fetch intégré)
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const  crypto = require ( "crypto" ) ;

const  app = express ( ) ;
app.set ( " trust proxy " , 1 ) ;
app.use ( express.json ( ) );json());

// Autoriser la page web (hébergée ailleurs) à appeler ce serveur
app.use((req, res, next) => {.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.SITE_URL || "*");res.setHeader("Access-Control-Allow-Origin", process.env.SITE_URL || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");
  si (req.method === "OPTIONS") retourner res.sendStatus(204);if (req.method === "OPTIONS") return res.sendStatus(204);
  suivant();next();
}););

const { {
  PAWAPAY_TOKEN, // clé API (jamais dans l'app !)PAWAPAY_TOKEN,                  // clé API (jamais dans l'app !)
  PAWAPAY_BASE = "https://api.sandbox.pawapay.io", // prod : https://api.pawapay.ioPAWAPAY_BASE = "https://api.sandbox.pawapay.io", // prod : https://api.pawapay.io
  RETURN_URL, // où renvoyer le client après paiementRETURN_URL,                     // où renvoyer le client après paiement
  ADMIN_PASSWORD, // mot de passe de l'administrateur d'espaceADMIN_PASSWORD,                 // mot de passe de l'espace administrateur
  PORT = 3000,PORT = 3000,
} = process.env; = process.env;

const SERIES = JSON.parse(fs.readFileSync("./series.json", "utf8")); SERIES = JSON.parse(fs.readFileSync("./series.json", "utf8"));
const DB_FILE = "./purchases.json"; DB_FILE = "./purchases.json";

// --- Mini base de données (fichier JSON). Remplacez par Airtable/Supabase plus tard.
const load = () => (fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : {}); load = () => (fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : {});
const save = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); save = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const pawapay = (chemin, options = {}) => pawapay = (path, options = {}) =>
  récupérer(PAWAPAY_BASE + chemin, {fetch(PAWAPAY_BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAWAPAY_TOKEN}`,
      "Content-Type": "application/json",
    },
  }).then((r) => r.json());

// 1) Le client clique sur "Lipa" : on crée la page de paiement
app.post("/pay", async (req, res) => {
  const { userId, seriesId, country = "TZA" } = req.body; // TZA ou COD (RDC)
  if (!PAWAPAY_TOKEN || !RETURN_URL) console.error("Variable manquante : PAWAPAY_TOKEN ou RETURN_URL");
  const serie = SERIES[seriesId];
  if (!userId || !serie) return res.status(400).json({ error: "Données invalides" });

  const price = country === "COD" ? serie.price.COD : serie.price.TZA;
  const depositId = crypto.randomUUID();

  const result = await pawapay("/v2/paymentpage", {
    method: "POST",
    body: JSON.stringify({
      depositId,
      returnUrl: RETURN_URL,
      amountDetails: { amount: String(price.amount), currency: price.currency },
      country,
      reason: `Serie: ${serie.title}`.slice(0, 50),
      language: "EN",
    }),
  });

  if (!result.redirectUrl) {
    console.error("Erreur pawaPay :", JSON.stringify(result)); // visible dans Render > Logs
    return res.status(502).json({ error: "pawaPay", details: result });
  }

  const db = load();
  db[depositId] = { userId, seriesId, status: "PENDING", createdAt: new Date().toISOString() };
  save(db);

  res.json({ paymentUrl: result.redirectUrl, depositId });
});

// 2) pawaPay nous prévient : on VÉRIFIE auprès de pawaPay avant de débloquer
app.post("/pawapay/callback", async (req, res) => {
  res.sendStatus(200); // répondre vite
  const { depositId } = req.body || {};
  const db = load();
  if (!depositId || !db[depositId]) return;

  const check = await pawapay(`/v2/deposits/${depositId}`);
  const status = check?.data?.status ?? check?.status;

  db[depositId].status = status === "COMPLETED" ? "PAID" : "FAILED";
  save(db);
});

// 3) L'app demande le lien : donné seulement si payé
app.get("/access", (req, res) => {
  const { userId, seriesId } = req.query;
  const db = load();
  const paid = Object.values(db).some(
    (p) => p.userId === userId && p.seriesId === seriesId && p.status === "PAID"
  );
  if (!paid) return res.status(403).json({ paid: false });
  res.json({ paid: true, link: SERIES[seriesId].driveLink });
});


// ---------- Paiement manuel + espace administrateur ----------
// 4) Le client dit "j'ai payé" et donne la référence de sa transaction
app.post("/manual-pay", (req, res) => {
  const { userId, seriesId, country = "TZA", reference } = req.body || {};
  const ref = String(reference || "").trim().slice(0, 40);
  if (!/^\d{9,15}$/.test(String(userId || "")) || !SERIES[seriesId] || ref.length < 4)
    return res.status(400).json({ error: "Données invalides" });

  const db = load();
  const same = Object.entries(db).find(
    ([, p]) => p.method === "manual" && p.userId === userId && p.seriesId === seriesId && p.status === "PENDING_MANUAL"
  );
  const id = same ? same[0] : crypto.randomUUID();
  db[id] = { method: "manual", userId, seriesId, country, reference: ref, status: "PENDING_MANUAL", createdAt: new Date().toISOString() };
  save(db);
  res.json({ ok: true });
});

// Protection de l'espace administrateur (mot de passe + limite d'essais)
const fails = {};
function adminAuth(req, res, next) {
  const f = fails[req.ip] || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return res.status(429).json({ error: "Trop d'essais" });
  const a = Buffer.from(String(req.headers["x-admin-password"] || ""));
  const b = Buffer.from(ADMIN_PASSWORD || "");
  const ok = ADMIN_PASSWORD && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { f.n++; fails[req.ip] = f; return res.status(401).json({ error: "Non autorisé" }); }
  next();
}

// 5) Liste des demandes manuelles (les plus récentes d'abord)
app.get("/admin/requests", adminAuth, (req, res) => {
  const db = load();
  const list = Object.entries(db)
    .filter(([, p]) => p.method === "manual")
    .map(([id, p]) => ({ id, ...p, title: SERIES[p.seriesId] ? SERIES[p.seriesId].title : p.seriesId }))
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
    .slice(0, 50);
  res.json(list);
});

// 6) Valider ou refuser une demande
app.post("/admin/decision", adminAuth, (req, res) => {
  const { id, approve } = req.body || {};
  const db = load();
  if (!db[id] || db[id].method !== "manual") return res.status(404).json({ error: "Introuvable" });
  db[id].status = approve ? "PAID" : "REJECTED";
  save(db);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Serveur sur le port ${PORT}`));
    
