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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const {
  PAWAPAY_TOKEN, PAWAPAY_BASE = "https://api.sandbox.pawapay.io", RETURN_URL,
  ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_KEY, SMS_SECRET, SMS_SENDER, GOOGLE_CLIENT_ID, SESSION_SECRET, PORT = 3000,
} = process.env;

// ---------- Stockage : Supabase si configuré, sinon fichiers (effacés par Render !) ----------
const useDb = SUPABASE_URL && SUPABASE_KEY;
// Ancienne clé (eyJ…) : envoyée aussi en Bearer. Nouvelle clé (sb_secret_…) : seulement dans apikey.
const dbHeaders = { apikey: SUPABASE_KEY, ...(String(SUPABASE_KEY || "").startsWith("eyJ") ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}), "Content-Type": "application/json" };

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
