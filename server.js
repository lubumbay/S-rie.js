// Backend minimal : paiement pawaPay + déblocage du lien Drive
// Node 18+ requis (fetch intégré)
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// Autorise la page web (hébergée ailleurs) à appeler ce serveur
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.SITE_URL || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const {
  PAWAPAY_TOKEN,                  // clé API (jamais dans l'app !)
  PAWAPAY_BASE = "https://api.sandbox.pawapay.io", // prod : https://api.pawapay.io
  RETURN_URL,                     // où renvoyer le client après paiement
  PORT = 3000,
} = process.env;

const SERIES = JSON.parse(fs.readFileSync("./series.json", "utf8"));
const DB_FILE = "./purchases.json";

// --- Mini base de données (fichier JSON). Remplacez par Airtable/Supabase plus tard.
const load = () => (fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : {});
const save = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const pawapay = (path, options = {}) =>
  fetch(PAWAPAY_BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAWAPAY_TOKEN}`,
      "Content-Type": "application/json",
    },
  }).then((r) => r.json());

// 1) Le client clique sur "Lipa" : on crée la page de paiement
app.post("/pay", async (req, res) => {
  const { userId, seriesId, country = "TZA" } = req.body; // TZA ou COD (RDC)
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

  if (!result.redirectUrl) return res.status(502).json({ error: "pawaPay", details: result });

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

app.listen(PORT, () => console.log(`Serveur sur le port ${PORT}`));
