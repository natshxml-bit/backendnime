const express = require("express");
const adapter = require("./adapter");
const db = require("./db/db");
const fs = require("fs");
const path = require("path");

// Mini ranks module (mirror lib/ranks.ts) — pakai untuk konsistensi leaderboard
// dengan profile (yang derive level dari totalXp). Kalau profile derive Lv 50
// dari totalXp tapi Firestore level field masih 1 (stale), backend leaderboard
// juga akan derive Lv 50 → sinkron.
const MAX_LEVEL = 200;
function getNextLevelXp(lvl) {
  if (lvl >= MAX_LEVEL) return Infinity;
  if (lvl >= 150) return 1800;
  if (lvl >= 100) return 1200;
  if (lvl >= 75) return 800;
  if (lvl >= 50) return 500;
  if (lvl >= 25) return 300;
  if (lvl >= 15) return 180;
  if (lvl >= 5) return 120;
  return 80;
}
const TOTAL_XP_TO_REACH_LEVEL = (() => {
  const arr = new Array(MAX_LEVEL + 1).fill(0);
  let acc = 0;
  for (let i = 0; i < MAX_LEVEL; i++) {
    acc += getNextLevelXp(i);
    arr[i + 1] = acc;
  }
  return arr;
})();
function getLevelFromTotalXp(totalXp) {
  const xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  let lo = 0, hi = MAX_LEVEL, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (TOTAL_XP_TO_REACH_LEVEL[mid] <= xp) { found = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return Math.max(1, found);
}

process.on("unhandledRejection", (e) => {
  console.error("[app] unhandledRejection:", e && e.stack ? e.stack : e);
});
process.on("uncaughtException", (e) => {
  console.error("[app] uncaughtException:", e && e.stack ? e.stack : e);
});

let adminApp = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const { initializeApp, cert } = require("firebase-admin");
  const saPath = path.join(__dirname, "service-account.json");
  if (fs.existsSync(saPath)) {
    adminApp = initializeApp({ credential: cert(saPath) });
  } else if (process.env.FIREBASE_SA_JSON) {
    adminApp = initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SA_JSON)),
    });
  } else if (process.env.FIREBASE_SA_B64) {
    adminApp = initializeApp({
      credential: cert(JSON.parse(Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8"))),
    });
  } else {
    throw new Error("service-account.json tidak ada dan FIREBASE_SA_JSON/B64 kosong");
  }
  return adminApp;
}

const app = express();

app.set("trust proxy", true);

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 300;
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  if (req.path === "/proxy" || req.path.startsWith("/hls-seg/") || req.path === "/hls") return next();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  while (bucket.length && bucket[0] <= now - RATE_WINDOW_MS) bucket.shift();
  if (bucket.length >= RATE_MAX) {
    return res.status(429).json({ error: "terlalu banyak request, coba lagi nanti" });
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  next();
}

setInterval(() => {
  for (const [ip, bucket] of rateBuckets) {
    if (!bucket.length) rateBuckets.delete(ip);
  }
}, 60 * 1000);

app.use(rateLimit);

app.use(express.json({ limit: "8mb" }));

app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Requested-With, Range, Authorization, X-Api-Key",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Gate API key: semua endpoint (kecuali `/` buat health-check dan `/relay`
// yang sudah punya token sendiri) wajib header `X-Api-Key` == APP_API_KEY.
// APP_API_KEY dikonfigurasi via env Railway; di-rotate → clone mati.
const KEYLESS_PATHS = new Set(["/", "/relay"]);

// ---------- SIGNED TOKEN (buat media tag yang gak bisa kirim header) ----------
// <img>/<video> gak bisa set header X-Api-Key → dulu dipaksa pakai ?apikey=
// (APP_API_KEY mentah nongol di URL). Sekarang: token HMAC pendek, umur
// terbatas, cukup buat /proxy & /hls — gak bisa dipakai buat endpoint API lain.
//   GET /media-token  (header X-Api-Key)  → { token, exp }
//   GET /proxy?url=...&t=<token>          ← media pakai ini, bukan apikey
const crypto = require("crypto");
function mediaSecret() {
  return process.env.MEDIA_SECRET || process.env.APP_API_KEY || "hikaback-media";
}
function signMedia(scope, ttlMs = 6 * 60 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac("sha256", mediaSecret()).update(`${scope}.${exp}`).digest("base64url").slice(0, 32);
  return { token: `${exp}.${sig}`, exp };
}
function verifyMedia(scope, token) {
  const s = String(token || "");
  const i = s.indexOf(".");
  if (i <= 0) return false;
  const exp = parseInt(s.slice(0, i), 10);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = crypto.createHmac("sha256", mediaSecret()).update(`${scope}.${exp}`).digest("base64url").slice(0, 32);
  const got = s.slice(i + 1);
  try {
    return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
  } catch { return false; }
}
// scope media: token valid buat /proxy, /hls, /hls-seg (semua jalur media)
app.get("/media-token", async (req, res) => {
  // Boleh: tiket Firebase valid (req.uid diset gate) ATAU app key lama — dua2nya
  // jalur sah; media token-nya tetap HMAC + expire.
  const key = req.get("x-api-key") || req.query.apikey;
  const keyOk = !!process.env.APP_API_KEY && key === process.env.APP_API_KEY;
  if (!keyOk && !req.uid) req.uid = await verifyBearer(req); // route ini terdaftar sebelum gate — verifikasi sendiri
  if (!keyOk && !req.uid) {
    return res.status(401).json({ error: "key atau token firebase wajib" });
  }
  const { token, exp } = signMedia(req.uid && req.uid !== "internal" ? `media:${req.uid}` : "media", 6 * 60 * 60 * 1000);
  res.json({ token, exp, path: "/proxy?url=...&t=" + token });
});
const KEYLESS_PREFIXES = ["/hls-seg/"];

// ---------- AUTH FIREBASE TOKEN (audit → enforce) ----------
// Kunci utama = Firebase ID token (Authorization: Bearer) — cuma device dgn
// app resmi (project hikanimeid-82037) yang bisa punya. APP_API_KEY jadi
// jalur internal saja: watcher/CI kirim header X-Internal: <INTERNAL_TOKEN>.
// AUTH_MODE env:
//   audit   (default) — appkey-only DITERIMA tapi dicatat [auth-audit]
//   enforce           — appkey-only ditolak 401; wajib Bearer atau X-Internal
//   off              — behavior lama (appkey doang)
const AUTH_MODE = String(process.env.AUTH_MODE || "audit").toLowerCase();
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || process.env.RELAY_TOKEN || "";
const bearerCache = new Map(); // idToken -> { uid, exp } (hemat verify round-trip)
async function verifyBearer(req) {
  const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw || raw.length < 30) return null;
  try {
    const hit = bearerCache.get(raw);
    if (hit && hit.exp > Date.now()) return hit.uid;
    const { getAuth } = require("firebase-admin/auth");
    const dec = await getAuth(getAdmin()).verifyIdToken(raw, false);
    const uid = dec && dec.uid ? dec.uid : null;
    if (uid) {
      bearerCache.set(raw, { uid, exp: Date.now() + 5 * 60 * 1000 });
      if (bearerCache.size > 2000) bearerCache.delete(bearerCache.keys().next().value);
    }
    return uid;
  } catch {
    return null;
  }
}

async function requireAppKey(req, res, next) {
  try {
    if (KEYLESS_PATHS.has(req.path)) return next();
    if (KEYLESS_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    // jalur media (/proxy, /hls, /hls-seg) boleh pakai signed token ?t=
    // (media tag gak bisa kirim header) — selain itu tetap wajib app key.
    if (req.path === "/proxy" || req.path === "/hls" || req.path.startsWith("/hls-seg/")) {
      if (verifyMedia("media", req.query.t)) return next();
      // uid-scoped token (yang di-mint dengan Bearer) juga sah untuk media
      if (req.uid && req.uid !== "internal" && verifyMedia(`media:${req.uid}`, req.query.t)) return next();
    }
    if (req.path === "/img") return next(); // proxy poster utk icon FCM — Google bot yang fetch, gak punya Bearer
    const expected = process.env.APP_API_KEY;
    if (!expected) {
      return res.status(503).json({ error: "APP_API_KEY belum dikonfigurasi di server" });
    }
    // route admin self-guard (punya cek token sendiri di handler-nya)
    if (req.path.startsWith("/admin/") || req.path === "/queue-stats") return next();
    // internal service (watcher/CI): header X-Internal
    if (INTERNAL_TOKEN && req.get("x-internal") === INTERNAL_TOKEN) {
      req.uid = "internal";
      return next();
    }
    const uid = await verifyBearer(req);
    if (uid) {
      req.uid = uid;
      return next();
    }
    const provided = req.get("x-api-key") || req.query.apikey;
    if (provided === expected) {
      if (AUTH_MODE === "enforce") {
        return res.status(401).json({ error: "token firebase wajib (app key khusus internal)" });
      }
      if (AUTH_MODE === "audit") {
        console.log(`[auth-audit] ${req.method} ${req.path} via=appkey ip=${String(req.ip || "").slice(0, 18)}`);
      }
      return next();
    }
    return res.status(401).json({ error: "api key salah atau hilang" });
  } catch (e) {
    return res.status(401).json({ error: "auth gagal: " + e.message });
  }
}
app.use(requireAppKey);

// Rate limit khusus /proxy (di-route TIDAK ikut rateLimit global).
const PROXY_RATE_WINDOW_MS = 60 * 1000;
const PROXY_RATE_MAX = 60;
const proxyRateBuckets = new Map();
function proxyRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = proxyRateBuckets.get(ip) || [];
  while (bucket.length && bucket[0] <= now - PROXY_RATE_WINDOW_MS) bucket.shift();
  if (bucket.length >= PROXY_RATE_MAX) {
    return res.status(429).json({ error: "proxy terlalu sering dipakai, tunggu sebentar" });
  }
  bucket.push(now);
  proxyRateBuckets.set(ip, bucket);
  next();
}
app.use("/proxy", proxyRateLimit);

const VALID_LISTS = ["all", "ongoing", "finished", "upcoming", "movie", "donghua", "anime"];

app.get("/", (_req, res) => {
  res.status(204).end();
});

// Pixeldrain queue stats (debug/monitor)
app.get("/queue-stats", (req, res) => {
  const key = req.get("x-api-key") || req.query.apikey;
  if (key !== process.env.APP_API_KEY) {
    return res.status(401).json({ error: "api key salah" });
  }
  res.json({
    pixeldrain: pixeldrain.stats(),
    inflightHls: hlsMod.inflightCount ? hlsMod.inflightCount() : "n/a",
    ts: Date.now(),
  });
});

// status watcher: baca heartbeat yang ditulis watcher tiap tick
app.get("/watcher-status", async (_req, res) => {
  try {
    const snap = await adminFs(getAdmin()).collection("_system").doc("watcher").get();
    if (!snap.exists) return res.status(404).json({ error: "watcher belum pernah tick (heartbeat kosong)" });
    const d = snap.data();
    res.json({
      lastTick: d.lastTick ? new Date(d.lastTick.toMillis()).toISOString() : null,
      lastTickMs: d.lastTick ? d.lastTick.toMillis() : null,
      ageSeconds: d.lastTick ? Math.round((Date.now() - d.lastTick.toMillis()) / 1000) : null,
      lastError: d.lastError || null,
      episodeCount: d.episodeCount || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// proxy gambar utk FCM notification image — sebagian CDN sumber (mis.
// cdn.myanimelist.net) bisa menolak fetcher Google/FCM; lewat sini gambar
// disajikan dari domain sendiri sehingga selalu bisa diambil & ditampilkan.
// HARDENING: allowlist domain (kasus spam/injection via IP datacenter bebas).
const IMG_ALLOWED = /(^|\.)(cdn\.myanimelist\.net|image\.tmdb\.org|media\.kitsu\.app|kitsu\.app|storage\.animekita\.org|animekita\.org|r2\.cloudflarestorage\.com|kotakanimeid\.link|pixeldrain\.com|i\.postimg\.cc|ibb\.co|ui-avatars\.com)$/i;
app.get("/img", async (req, res) => {
  const u = String(req.query.url || "");
  if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: "url harus http(s)" });
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return res.status(400).json({ error: "url tidak valid" });
  }
  if (!IMG_ALLOWED.test(parsed.hostname)) {
    return res.status(403).json({ error: "domain tidak diizinkan" });
  }
  try {
    const r = await fetch(u, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!r.ok) return res.status(502).json({ error: `upstream ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: "gambar terlalu besar" });
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const wrap = (fn) => (req, res) => {
  Promise.resolve()
    .then(() => fn(req))    .then((data) => res.json(data))
    .catch((e) => res.status(502).json({ error: e.message }));
};

// Baca dari database sendiri dulu; kalau basi dan live gagal, tetap
// layani data lama (resilient terhadap blokir animekita).
async function dbFirst(key, liveFn, maxAgeMs) {
  const stored = await db.get(key);
  if (stored && Date.now() - stored.updatedAt <= maxAgeMs) return stored.value;
  try {
    const data = await liveFn();
    await db.set(key, data);
    return data;
  } catch (e) {
    if (stored) return stored.value;
    throw e;
  }
}

// Pencarian offline: cari judul di full catalog (4759 anime) yang tersimpan
// di DB. Mengembalikan bentuk yang sama dengan adapter.searchQuery.
async function localSearch(q) {
  const rec = await db.get("catalog");
  if (!rec) return null;
  const ql = String(q || "").toLowerCase().trim();
  if (!ql) return null;
  const items = Array.isArray(rec.value) ? rec.value : Object.values(rec.value || {}).flat();
  const animeList = [];
  for (const it of items) {
    const title = it.judul || it.anime_name || it.name || "";
    if (!title.toLowerCase().includes(ql)) continue;
    animeList.push(await adapter.cardFromListAsync(it));
    if (animeList.length >= 30) break;
  }
  return { query: String(q), animeList, results: animeList, source: "catalog" };
}

// Feed watcher dari database sendiri: recent upload (baruupload) + jumlah
// episode aktual dari detail anime yang tersimpan. Mengembalikan bentuk
// yang sama dengan adapter.recentDetailed(). null kalau DB belum ada data.
async function recentDetailedFromDb() {
  const home = await db.get("home");
  if (!home) return null;
  const recent = (home.value && Array.isArray(home.value.recent)) ? home.value.recent : [];
  const out = [];
  for (const it of recent) {
    const slug = it.animeId;
    let episode = it.episode || null;
    try {
      const det = await db.get(`anime:${slug}`);
      if (det && det.value && Array.isArray(det.value.episodeList)) {
        episode = det.value.episodeList.length;
      }
    } catch {}
    out.push({ animeId: slug, title: it.title, poster: it.poster || "", episode });
  }
  return out;
}

app.get("/home", wrap(async (req) => {
  const home = await dbFirst("home", () => adapter.home(), 5 * 60 * 1000);
  adapter.refreshHomeRatings(home);
  function enrich(items = []) {
    return items.map((it) => {
      if (!it || it.banner) return it;
      const banner = adapter.getBannerFor(it.animeId);
      if (banner) return { ...it, banner };
      adapter.queueBannerSearch(it.title, it.animeId);
      return it;
    });
  }
  return {
    ...home,
    recent: enrich(home.recent),
    ongoing: { animeList: enrich(home.ongoing?.animeList) },
    completed: { animeList: enrich(home.completed?.animeList) },
    film: { animeList: enrich(home.film?.animeList) },
  };
}));
app.get("/watcher-feed", wrap(async () => {
  const dbFeed = await recentDetailedFromDb();
  if (dbFeed) return dbFeed;
  return adapter.recentDetailed();
}));

// trigger notif tes manual: POST /push-test — WAJIB admin (token Firebase)
// HARDENING: dulu pakai kunci statis "tsukitest" — siapa pun yang tau API key
// (bocor di bundle app) bisa blast FCM ke SEMUA user. Sekarang admin-only.
app.post("/push-test", requireAdmin, async (req, res) => {
  try {
    const title = String(req.query.title || "TsukiNime").slice(0, 80);
    const body = String(req.query.body || "Notifikasi push berhasil dikirim.").slice(0, 200);
    const { getFirestore } = require("firebase-admin/firestore");
    const { getMessaging } = require("firebase-admin/messaging");
    const adm = getAdmin();
    const users = await getFirestore(adm).collection("users").get();
    const tokens = users.docs.flatMap((d) => (Array.isArray(d.data().fcmTokens) ? d.data().fcmTokens : []));
    if (tokens.length === 0) return res.json({ sent: 0, reason: "belum ada token FCM" });
    const r = await getMessaging(adm).sendEachForMulticast({
      tokens,
      notification: { title, body },
      android: { priority: "high", notification: { channelId: "episode_rilis" } },
      data: { test: "1", type: String(req.query.type || "ADMIN").slice(0, 30) },
    });
    res.json({ sent: r.successCount, failed: r.failureCount, tokens: tokens.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/recommendations", wrap((req) => {
  const limit = parseInt(req.query.limit, 10) || 12;
  return adapter.recommendations(limit);
}));

app.get("/schedule", wrap(() => dbFirst("schedule", () => adapter.schedule(), 10 * 60 * 1000)));

// baca announcements (publik) — dipakai dashboard & banner
app.get("/announcements", wrap(async () => {
  const snap = await adminFs(getAdmin()).collection("announcements").orderBy("createdAt", "desc").limit(20).get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return items;
}));

// ---------- ADMIN: kelola announcements (token diverifikasi + cek role) ----------
const { getAuth } = require("firebase-admin/auth");
const { getFirestore: adminFs } = require("firebase-admin/firestore");
const { FieldValue } = require("firebase-admin/firestore");

async function requireAdmin(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "token dibutuhkan" });
    const decoded = await getAuth(getAdmin()).verifyIdToken(token);
    const snap = await adminFs(getAdmin()).collection("users").doc(decoded.uid).get();
    if (snap.data()?.role !== "admin") return res.status(403).json({ error: "bukan admin" });
    req.adminUid = decoded.uid;
    next();
  } catch (e) {
    res.status(401).json({ error: "token tidak valid: " + e.message });
  }
}

// simpan / edit: POST /admin/announcement  { id?, title, message, animeId?, pinned }
app.post("/admin/announcement", requireAdmin, async (req, res) => {
  const { id, title, message, animeId, pinned } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: "judul & pesan wajib" });
  const payload = {
    title: String(title).trim(),
    message: String(message).trim(),
    animeId: animeId ? String(animeId).trim() : null,
    pinned: !!pinned,
  };
  const col = adminFs(getAdmin()).collection("announcements");
  if (id) {
    await col.doc(id).update(payload);
  } else {
    await col.add({ ...payload, createdAt: FieldValue.serverTimestamp() });
  }
  res.json({ ok: true, id: id || null });
});

// hapus: POST /admin/announcement/delete  { id }
app.post("/admin/announcement/delete", requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "id wajib" });
  await adminFs(getAdmin()).collection("announcements").doc(id).delete();
  res.json({ ok: true });
});

// ---------- STATS DASHBOARD ADMIN ----------
// GET /admin/stats — agregasi cepat untuk kartu dashboard:
//   onlineNow   : user dengan lastSeen ≤ 2 menit (heartbeat PresenceHeartbeat)
//   activeDay   : user aktif 24 jam terakhir
//   totalUsers  : total user terdaftar
//   activeRooms : total room nobar di Firestore
//   openReports : laporan link rusak yang belum ditangani
//   watching    : daftar judul yang sedang ditonton (nowWatching + lastSeen segar)
app.get("/admin/stats", requireAdmin, async (_req, res) => {
  const fs = adminFs(getAdmin());
  const now = Date.now();
  const ONLINE_WINDOW = 2 * 60 * 1000;
  const DAY_WINDOW = 24 * 3600 * 1000;

  let onlineNow = 0;
  let activeDay = 0;
  let totalUsers = 0;
  let activeRooms = 0;
  let openReports = 0;
  const watching = [];

  try {
    const usersSnap = await fs.collection("users").get();
    totalUsers = usersSnap.size;
    for (const d of usersSnap.docs) {
      const data = d.data();
      const ls = data.lastSeen;
      let ms = 0;
      if (ls && typeof ls.toMillis === "function") ms = ls.toMillis();
      else if (ls && ls.seconds) ms = ls.seconds * 1000;
      if (ms > 0 && ms >= now - ONLINE_WINDOW) {
        onlineNow++;
        const w = data.nowWatching;
        if (w && (w.title || w.animeId)) watching.push(w.title || w.animeId);
      }
      if (ms > 0 && ms >= now - DAY_WINDOW) activeDay++;
    }
  } catch (e) {
    console.error("[admin/stats] users:", e.message);
  }

  try {
    const rooms = await fs.collection("nobar").get();
    activeRooms = rooms.size;
  } catch (e) {
    console.error("[admin/stats] nobar:", e.message);
  }

  try {
    const rep = await fs.collection("reports").where("status", "==", "open").get();
    openReports = rep.size;
  } catch (e) {
    console.error("[admin/stats] reports:", e.message);
  }

  res.json({
    onlineNow,
    activeDay,
    totalUsers,
    activeRooms,
    openReports,
    watching: watching.slice(0, 10),
    generatedAt: new Date().toISOString(),
  });
});

// ---------- UPLOAD FOTO PROFIL (base64 -> catbox.moe, server-side, bebas CORS) ----------

async function requireAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "token dibutuhkan" });
    const decoded = await getAuth(getAdmin()).verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    res.status(401).json({ error: "token tidak valid: " + e.message });
  }
}

app.post("/upload", async (req, res) => {
  // Log SEBELUM requireAuth — buat diagnosa: nyampe server atau nggak.
  console.log(`[upload] hit dari ${req.ip || "?"} (sebelum auth)`);
  return requireAuth(req, res, async () => {
    const { image } = req.body || {};
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "data image base64 wajib" });
  }
  const b64 = image.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
  if (b64.length > 6 * 1024 * 1024) {
    return res.status(400).json({ error: "ukuran foto terlalu besar (maks 6MB)" });
  }
  console.log(`[upload] uid=${req.uid} bytes=${Math.floor(b64.length * 0.75)}`);

  // Host anonim yang BISA hotlink (cek 18 Agu 2026):
  // - catbox.moe: OK saat ini (files.catbox.moe, hotlink langsung) — naik-turun
  // - imgbb: OK kalau IMGBB_API_KEY di-env (i.ibb.co langsung) — prioritas kalo ada
  // - qu.ax: GUGUR (anti-hotlink — balikin halaman HTML bukan gambar)
  // - vgy.me: butuh akun; pixeldrain: butuh auth — GUGUR
  // Semua fetch wajib timeout — host mati tidak boleh bikin request gantung.
  const UPLOAD_TIMEOUT = 20000;

  async function uploadCatbox(b64data) {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append(
      "fileToUpload",
      new Blob([Buffer.from(b64data, "base64")], { type: "image/png" }),
      "pfp.png"
    );
    const r = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: form,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
        "Accept": "*/*",
      },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    });
    const text = await r.text();
    if (!r.ok || !/^https?:\/\//.test(text.trim())) {
      throw new Error(`catbox HTTP ${r.status} ${text.slice(0, 80)}`);
    }
    return text.trim();
  }

  async function uploadTelegraph(b64data) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from(b64data, "base64")], { type: "image/png" }),
      "pfp.png"
    );
    const r = await fetch("https://telegra.ph/upload", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    });
    const j = await r.json().catch(() => null);
    if (Array.isArray(j) && j[0] && j[0].src) {
      return "https://telegra.ph" + j[0].src;
    }
    throw new Error(`telegra.ph HTTP ${r.status}`);
  }

  async function uploadUguu(b64data) {
    const form = new FormData();
    form.append(
      "files[]",
      new Blob([Buffer.from(b64data, "base64")], { type: "image/png" }),
      "pfp.png"
    );
    const r = await fetch("https://uguu.se/upload", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.success && j.files && j.files[0] && j.files[0].url) {
      return String(j.files[0].url);
    }
    throw new Error(`uguu.se HTTP ${r.status}`);
  }

  async function uploadFilebin(b64data) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from(b64data, "base64")], { type: "image/png" }),
      "pfp.png"
    );
    const r = await fetch("https://filebin.net/tsu-test", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.file && j.file.url) {
      const name = j.file.filename;
      return `https://filebin.net/tsu-test/${name}`;
    }
    throw new Error(`filebin HTTP ${r.status}`);
  }

  async function uploadImgbb(b64data) {
    const key = process.env.IMGBB_API_KEY;
    if (!key) throw new Error("imgbb key belum dikonfigurasi");
    const r = await fetch("https://api.imgbb.com/1/upload", {
      method: "POST",
      body: new URLSearchParams({ key, image: b64data }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && !j.error && j.data && j.data.url) {
      return String(j.data.url);
    }
    throw new Error(`imgbb HTTP ${r.status}`);
  }

  try {
    let url = null;
    if (process.env.IMGBB_API_KEY) {
      try {
        url = await uploadImgbb(b64);
        console.log(`[upload] sukses (imgbb): ${url.slice(0, 60)}`);
      } catch (e) {
        console.log(`[upload] imgbb gagal: ${e.message} — coba catbox`);
      }
    }
    if (!url) {
      try {
        url = await uploadUguu(b64);
        console.log(`[upload] sukses (uguu.se): ${url.slice(0, 60)}`);
      } catch (e) {
        console.log(`[upload] uguu gagal: ${e.message} — coba filebin`);
      }
    }
    if (!url) {
      try {
        url = await uploadFilebin(b64);
        console.log(`[upload] sukses (filebin): ${url.slice(0, 60)}`);
      } catch (e) {
        console.log(`[upload] filebin gagal: ${e.message} — coba telegra.ph`);
      }
    }
    if (!url) {
      try {
        url = await uploadTelegraph(b64);
        console.log(`[upload] sukses (telegra.ph): ${url.slice(0, 60)}`);
      } catch (e) {
        console.log(`[upload] telegra.ph gagal: ${e.message} — coba catbox`);
      }
    }
    if (!url) {
      url = await uploadCatbox(b64);
      console.log(`[upload] sukses (catbox): ${url.slice(0, 60)}`);
    }
    res.json({ url, saved: await simpanFotoKeDb(req.uid, url) });
  } catch (e) {
    console.log(`[upload] error: ${e.message}`);
    res.status(502).json({ error: "upload gagal: " + e.message });
  }
  });
});

// Simpan URL foto ke Firestore via ADMIN SDK (bypass semua client rules —
// klien pernah dapat "permission denied" misterius dari rules meski diizinkan).
async function simpanFotoKeDb(uid, url) {
  try {
    const { getFirestore } = require("firebase-admin/firestore");
    await getFirestore(getAdmin()).collection("users").doc(uid).set({ foto: url }, { merge: true });
    console.log(`[upload] foto disimpan ke db: ${url.slice(0, 45)}`);
    return true;
  } catch (e) {
    console.log(`[upload] simpan ke db GAGAL: ${e.message}`);
    return false;
  }
}

// ---------- NOTIFIKASI IN-APP (anti-spam) ----------
// HARDENING: dulu user lain bisa addDoc LANGSUNG ke users/{uid}/notifications
// (rules: allow create: if auth != null) → spam/injection ke siapa pun.
// Sekarang semua notif lintas-user lewat endpoint ini: WAJIB login, rate
// limit per-uid, dan link hanya boleh relative (cuma "/...", bukan URL ekstern).
const NOTIFY_TYPES = new Set(["REPLY_COMMENT"]);
const notifyBuckets = new Map();

// ===== Beacon debug pfp (sementara): app lapor hasil simpan foto =====
  app.post("/pfp-report", async (req, res) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "token dibutuhkan" });
    try {
      const decoded = await getAuth(getAdmin()).verifyIdToken(token);
      console.log(
        `[pfp-beacon] uid=${decoded.uid} ok=${req.body?.ok} url=${String(req.body?.url || "").slice(0, 50)} err=${String(req.body?.err || "").slice(0, 120)} ts=${new Date().toISOString().slice(11, 19)}`
      );
      res.json({ ok: true });
    } catch {
      res.status(401).json({ error: "token tidak valid" });
    }
  });

app.post("/notify", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "token dibutuhkan" });
    let decoded;
    try {
      decoded = await getAuth(getAdmin()).verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: "token tidak valid" });
    }
    const sender = decoded.uid;
    const now = Date.now();
    const hits = (notifyBuckets.get(sender) || []).filter((t) => t > now - 60 * 1000);
    if (hits.length >= 8) {
      return res.status(429).json({ error: "terlalu banyak notif, tunggu sebentar" });
    }
    hits.push(now);
    notifyBuckets.set(sender, hits);

    const { uid, type, senderName, senderFoto, message, link } = req.body || {};
    if (!uid || typeof uid !== "string" || uid.length > 64) {
      return res.status(400).json({ error: "uid wajib" });
    }
    if (!NOTIFY_TYPES.has(type)) return res.status(400).json({ error: "type tidak diizinkan" });
    if (!message || String(message).length > 200) {
      return res.status(400).json({ error: "message wajib (max 200 karakter)" });
    }
    if (uid === sender) {
      return res.status(400).json({ error: "tidak bisa kirim notif ke diri sendiri" });
    }
    let linkStr = String(link || "");
    if (linkStr && !/^\/(?!\/)/.test(linkStr)) {
      return res.status(400).json({ error: "link harus path relative (diawali /)" });
    }
    linkStr = linkStr.slice(0, 300);

    const { getFirestore } = require("firebase-admin/firestore");
    await getFirestore(getAdmin())
      .collection("users")
      .doc(uid)
      .collection("notifications")
      .add({
        type,
        senderName: String(senderName || "").slice(0, 40),
        senderFoto: String(senderFoto || "").slice(0, 300),
        message: String(message).slice(0, 200),
        link: linkStr,
        time: "Baru saja",
        timestamp: require("firebase-admin/firestore").FieldValue.serverTimestamp(),
      });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- LEADERBOARD HUNTER ----------
// GET /leaderboard?limit=20&uid=xxx — top hunter by (level, exp). Publik,
// tanpa data sensitif (email, fcmTokens). Kalau uid dikirim, sekalian kasih
// posisi hunter itu di papan (myRank).
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const uid = String(req.query.uid || "");
    const snap = await adminFs(getAdmin()).collection("users").get();
    const rows = snap.docs.map((d) => {
        const data = d.data();
        let foto = data.foto || "";
        // HARDENING: foto bisa data URL base64 gede banget (≈1MB/doc) —
        // 20 user × 650KB = overload response tiap panggilan. Kecilin.
        if (foto.length > 4000) foto = "";
        // Fallback ke fotoData (base64 backup) kalau foto URL kosong —
        // dipakai user yang upload PP tanpa sempat simpan URL ke Firestore
        // atau yang `user.photoURL` dari Firebase Auth kosong (login Google
        // tanpa photo / email-password). fotoData juga di-trim supaya
        // response gak meledak.
        if (!foto) {
          const fd = String(data.fotoData || "");
          if (fd && fd.length <= 4000) foto = fd;
        }
        return {
          uid: d.id,
          nama: String(data.nama || "Hunter").slice(0, 40),
          foto,
          // Derive level dari totalXp agar konsisten dengan profile (yg display
          // pakai getLevelFromTotalXp). Firestore level field bisa stale
          // (legacy), jadi recalc di sini. Simpan juga `realLevel` untuk
          // self-heal patch di bawah.
          realLevel: getLevelFromTotalXp(Number(data.totalXp ?? data.exp) || 0),
          level: getLevelFromTotalXp(Number(data.totalXp ?? data.exp) || 0),
          // Sistem XP kumulatif: pakai totalXp (fallback ke exp legacy).
          totalXp: Number(data.totalXp ?? data.exp) || 0,
        };
      })
      // Sort: totalXp desc sebagai primary (konsisten dengan profile yang derive
      // level dari totalXp), level field jadi tiebreaker saja. Sebelumnya sort
      // pakai `b.level - a.level` primary, tapi level field bisa stale
      // (legacy) sehingga leaderboard tidak cocok dengan profile.
      .sort((a, b) => b.totalXp - a.totalXp || b.level - a.level);

    // Self-heal: kalau Firestore `level` field stale (deviation > 1 dari
    // derived getLevelFromTotalXp), patch background. Monotonik (tidak
    // pernah menurunkan level user). Non-blocking — leaderboard response
    // tidak tunggu. Cegah spam write kalau banyak user stale (max 5 patch
    // per panggilan).
    const batch = adminFs(getAdmin()).batch();
    let healCount = 0;
    for (const r of rows) {
      if (Math.abs(r.level - r.realLevel) > 1 && healCount < 5) {
        const ref = adminFs(getAdmin()).collection("users").doc(r.uid);
        batch.update(ref, { level: r.realLevel });
        healCount++;
      }
    }
    if (healCount > 0) batch.commit().catch(() => {});

    const top = rows.slice(0, limit);
    let myRank = null;
    if (uid) {
      const idx = rows.findIndex((r) => r.uid === uid);
      if (idx >= 0) myRank = idx + 1;
    }
    res.json({ list: top, total: rows.length, myRank });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/genres", wrap(() => dbFirst("genres", () => adapter.genres(), 24 * 60 * 60 * 1000)));

app.get("/genre/:slug", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return dbFirst(`genre:${req.params.slug}:${page}`, () => adapter.byGenre(req.params.slug, page), 6 * 60 * 60 * 1000);
}));

app.get("/search/:query", wrap(async (req) => {
  const q = String(req.params.query || "");
  const local = await localSearch(q);
  if (local) return local;
  return adapter.searchQuery(q);
}));

app.get("/ongoing-anime", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return dbFirst(`list:ongoing:${page}`, () => adapter.ongoing(page), 6 * 60 * 60 * 1000);
}));

app.get("/complete-anime", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return dbFirst(`list:finished:${page}`, () => adapter.complete(page), 6 * 60 * 60 * 1000);
}));

app.get("/list/:type", wrap((req) => {
  const type = req.params.type;
  const page = parseInt(req.query.page, 10) || 1;
  if (!VALID_LISTS.includes(type)) {
    const err = new Error(`type harus salah satu dari ${[...VALID_LISTS].sort().join(", ")}`);
    err.status = 400;
    throw err;
  }
  if (type === "ongoing") {
    // ongoing dari otakudesu HTML (tanpa synopsis) → enrich dari DB detail
    // (hasil backfill) biar tiap kartu ada synopsis, genres, score lengkap.
    // MURNI baca DB — tanpa request animekita tambahan.
    return dbFirst(`list:ongoing-enriched:${page}`, async () => {
      const res = await adapter.ongoing(page);
      const al = Array.isArray(res?.animeList) ? res.animeList : [];
      const rows = await db.getAllByPrefix("anime:%");
      const bySlug = {};
      for (const [k, v] of Object.entries(rows || {})) {
        bySlug[String(k).replace(/^anime:/, "").toLowerCase()] = v;
        if (v && v.animeId) bySlug[String(v.animeId).toLowerCase()] = v;
      }
      const animeList = al.map((it) => {
        const keys = [it.animeId, it.anime_id, it.endpoint].filter(Boolean).map((s) => String(s).toLowerCase());
        let d = null;
        for (const k of keys) { if (bySlug[k]) { d = bySlug[k]; break; } }
        if (!d) return it;
        const syn = String(d.synopsis || "").trim();
        const gs = Array.isArray(d.genres) ? d.genres : [];
        return {
          ...it,
          synopsis: (!it.synopsis && syn) ? (syn.length > 400 ? syn.slice(0, 400) + "…" : syn) : (it.synopsis || ""),
          genres: ((!it.genres || it.genres.length === 0) && gs.length) ? gs.slice(0, 8) : (it.genres || []),
          score: (!it.score && d.score) ? d.score : (it.score ?? null),
          status: (!it.status && d.status) ? d.status : (it.status || null),
        };
      });
      return { ...res, animeList };
    }, 60 * 60 * 1000);
  }
  if (type === "finished") return dbFirst(`list:finished:${page}`, () => adapter.complete(page), 6 * 60 * 60 * 1000);
  // movie: sama kayak donghua — baca dari DB detail (type=Movie), lengkap,
  // support filter ?genre=, urut rating. MURNI baca DB (tanpa animekita).
  if (type === "movie") {
    return dbFirst(`list:movie-v2:${page}:${String(req.query.genre || "").toLowerCase()}`, async () => {
      const rows = await db.getAllByPrefix("anime:%");
      const gf = String(req.query.genre || "").toLowerCase().trim();
      const items = [];
      for (const [slug, v] of Object.entries(rows || {})) {
        if (!v || String(v.type || "").toLowerCase() !== "movie") continue;
        const _ms = parseFloat(v.score ?? v.rating) || 0;
        if (!(_ms > 0 && _ms < 10)) continue; // buang entri sampah (test video, score 10)
        const gs = Array.isArray(v.genres) ? v.genres : [];
        if (gf && !gs.some((g) => String(g).toLowerCase().includes(gf))) continue;
        const score = parseFloat(v.score ?? v.rating) || 0;
        const syn = String(v.synopsis || "").trim();
        items.push({
          animeId: v.animeId || slug,
          title: v.title || slug,
          poster: v.poster || "",
          synopsis: syn ? (syn.length > 400 ? syn.slice(0, 400) + "…" : syn) : "",
          score: v.score ?? null,
          status: v.status || null,
          type: v.type || null,
          genres: gs.slice(0, 4),
          _s: score,
        });
      }
      items.sort((a, b) => b._s - a._s);
      const start = (page - 1) * 30;
      const slice = items.slice(start, start + 30).map(({ _s, ...x }) => x);
      return { animeList: slice, has_next: start + 30 < items.length };
    }, 6 * 60 * 60 * 1000);
  }
  // donghua: baca LANGSUNG dari DB detail (type sudah terisi per anime dari
  // backfill) — lengkap semua, paginasi bener, dan MURNI baca DB (tanpa
  // request animekita). Diurutkan rating tertinggi. Filter genre opsional:
  // /list/donghua?genre=action (cocok dgn data genre tiap anime, bukan scrape).
  if (type === "donghua") {
    return dbFirst(`list:donghua-v2:${page}:${String(req.query.genre || "").toLowerCase()}`, async () => {
      const rows = await db.getAllByPrefix("anime:%");
      const gf = String(req.query.genre || "").toLowerCase().trim();
      const items = [];
      for (const [slug, v] of Object.entries(rows || {})) {
        if (!v || String(v.type || "").toLowerCase() !== "donghua") continue;
        const _ms = parseFloat(v.score ?? v.rating) || 0;
        if (!(_ms > 0 && _ms < 10)) continue; // buang entri sampah
        const gs = Array.isArray(v.genres) ? v.genres : [];
        if (gf && !gs.some((g) => String(g).toLowerCase().includes(gf))) continue;
        const score = parseFloat(v.score ?? v.rating) || 0;
        const syn = String(v.synopsis || "").trim();
        items.push({
          animeId: v.animeId || slug,
          title: v.title || slug,
          poster: v.poster || "",
          synopsis: syn ? (syn.length > 400 ? syn.slice(0, 400) + "…" : syn) : "",
          score: v.score ?? null,
          status: v.status || null,
          type: v.type || null,
          genres: gs.slice(0, 4),
          _s: score,
        });
      }
      items.sort((a, b) => b._s - a._s);
      const start = (page - 1) * 30;
      const slice = items.slice(start, start + 30).map(({ _s, ...x }) => x);
      return { animeList: slice, has_next: start + 30 < items.length };
    }, 6 * 60 * 60 * 1000);
  }
  return dbFirst(`list:${type}:${page}`, () => adapter.listByType(type, page), 6 * 60 * 60 * 1000);
}));

app.get("/episode/*splat", wrap((req) => {
  const s = req.params.splat;
  const epPath = (Array.isArray(s) ? s.join("/") : String(s)).replace(/,/g, "/");
  return dbFirst(`ep:${epPath}`, () => adapter.episode(epPath), 12 * 60 * 60 * 1000);
}));

app.get("/anime/*splat", wrap((req) => {
  const s = req.params.splat;
  const animePath = (Array.isArray(s) ? s.join("/") : String(s)).replace(/,/g, "/");
  // TTL pendek (30 mnt): episode baru bisa rilis kapan aja — jangan dikunci
// 6 jam. Sync ongoing + auto-sync tetap isi DB, jadi ini cuma batas "kapan
// boleh re-fetch", bukan kapan data disajikan (data lama tetap dipakai kalau
// fetch gagal — lihat dbFirst).
  return dbFirst(`anime:${animePath}`, () => adapter.animeDetail(animePath), 30 * 60 * 1000);
}));

// ---------- POPULAR ----------
// Ranking rating tertinggi dari detail yang sudah tersimpan di DB (hasil
// backfill). MURNI baca DB — tanpa request ke animekita, jadi bebas 403
// dan independen dari IP server/Railway/user.
// Query: ?limit=20 (max 100), &page=1 (opsional, batasi 100/page)
app.get("/popular", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || "20"), 10) || 20, 100);
    const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
    const cache = await dbFirst("popular:v2", async () => {
      // type valid anime (buang entri "Pengumuman"/spam katalog animekita)
      const TYPE_OK = new Set(["TV", "Movie", "OVA", "ONA", "BD", "Special", "Music", "Donghua"]);
      const rows = await db.getAllByPrefix("anime:%");
      const items = [];
      for (const [slug, v] of Object.entries(rows || {})) {
        if (!v) continue;
        const score = parseFloat(v.score ?? v.rating);
        // rating anime nyata: 0-10 (99 & 10 bulat = entri sampah)
        if (!Number.isFinite(score) || score <= 0 || score >= 10) continue;
        if (!TYPE_OK.has(String(v.type || "").trim())) continue;
        items.push({
          animeId: v.animeId || slug,
          title: v.title || slug,
          poster: v.poster || "",
          banner: v.banner || "",
          score,
          type: v.type || null,
          status: v.status || null,
          genres: Array.isArray(v.genres) ? v.genres.slice(0, 4) : [],
        });
      }
      items.sort((a, b) => b.score - a.score);
      return items;
    }, 60 * 60 * 1000); // ranking di-cache 1 jam (murah, DB-only)
    const start = (page - 1) * limit;
    const items = cache.slice(start, start + limit);
    res.json({
      page,
      limit,
      total: cache.length,
      has_next: start + limit < cache.length,
      animeList: items,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/db/status", async (_req, res) => {
  try {
    const last = await db.get("sync:last");
    const counts = await db.counts();
    res.json({
      mode: db.mode(),
      dbPath: db.DB_PATH,
      counts,
      lastSync: last
        ? { ...last.value, storedAt: new Date(last.updatedAt).toISOString() }
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /db/status — konfigurasi yang di-fetch app saat start (mis. apiBase animekita
// terkini). Supaya kalau animekita ganti domain/versi API, cukup update env
// ANIMEKITA_API_BASE di backend, tanpa rebuild/re-publish app.
app.get("/admin/cache-bust-ep", requireAdmin, async (_req, res) => {
  try {
    const keys = await db.keysLike("ep:%");
    for (const k of keys) await db.del(k);
    res.json({ cleared: keys.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simple admin token (env ADMIN_TOKEN) untuk invalidate cache tanpa Firebase.
app.post("/admin/cache-bust", async (req, res) => {
  const want = process.env.ADMIN_TOKEN || process.env.APP_API_KEY;
  if (!want) return res.status(503).json({ error: "ADMIN_TOKEN/APP_API_KEY belum diset" });
  const got = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (got !== want) return res.status(401).json({ error: "token salah" });
  try {
    const prefix = String(req.body?.prefix || "ep:");
    const keys = await db.keysLike(`${prefix}%`);
    for (const k of keys) await db.del(k);
    res.json({ cleared: keys.length, prefix });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// GET /admin/cache-bust?prefix=anime:xxx&apikey=XXX  (versi gampang buat
// dipanggil dari browser/curl tanpa body JSON)
app.get("/admin/cache-bust", async (req, res) => {
  const want = process.env.ADMIN_TOKEN || process.env.APP_API_KEY;
  if (!want) return res.status(503).json({ error: "ADMIN_TOKEN/APP_API_KEY belum diset" });
  const got = req.get("x-api-key") || req.query.apikey || (req.headers.authorization || "").replace(/^Bearer /, "");
  if (got !== want) return res.status(401).json({ error: "token salah" });
  try {
    const prefix = String(req.query.prefix || "ep:");
    const keys = await db.keysLike(`${prefix}%`);
    for (const k of keys) await db.del(k);
    res.json({ cleared: keys.length, prefix });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/config", async (_req, res) => {
  try {
    res.json({
      apiBase: process.env.ANIMEKITA_API_BASE || adapter.API_BASE,
      ua: process.env.ANIMEKITA_UA || adapter.UA,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const { Readable } = require("stream");
const moov = require("./moov");
const proxyCache = require("./proxyCache");
const remuxMod = require("./remux");
const hlsMod = require("./hls");
const pixeldrain = require("./pixeldrain");
const PROXY_ALLOWED = /(^|\.)(animekita\.org|r2\.cloudflarestorage\.com|kotakanimeid\.link|pixeldrain\.com)$/i;

// HLS streaming — convert MP4 ke HLS playlist (segments .ts) pakai ffmpeg,
// serve playlist + segments dari Railway volume. AnimeLovers-style: ExoPlayer
// + HLS support multiple variants, ABR (adaptive bitrate) otomatis.
// URL: /hls?url=<mp4-url>  → /hls/<hash>/<filename>
app.get("/hls", async (req, res) => {
  const raw = req.query.url;
  if (!raw || !/^https?:\/\//i.test(String(raw))) {
    return res.status(400).json({ error: "url tidak valid" });
  }
  let upstreamUrl;
  try { upstreamUrl = new URL(String(raw)); } catch {
    return res.status(400).json({ error: "url tidak valid" });
  }
  if (!PROXY_ALLOWED.test(upstreamUrl.hostname)) {
    return res.status(403).json({ error: "domain tidak diizinkan" });
  }
  try {
    const d = await hlsMod.generate(String(raw));
    res.set({
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    });
    return res.sendFile(path.join(d, "index.m3u8"));
  } catch (e) {
    console.warn(`[hls] gagal: ${e.message}`);
    return res.status(502).json({ error: "hls generation gagal: " + e.message });
  }
});

// Serve HLS segments (.ts) dari cache dir
app.get("/hls-seg/:hash/:filename", async (req, res) => {
  const { hash, filename } = req.params;
  if (!/^[a-f0-9]{16}$/.test(hash) || !/^seg_\d{3}\.ts$/.test(filename)) {
    return res.status(400).end();
  }
  const p = path.join(hlsMod.CACHE_DIR, hash, filename);
  try {
    const stat = fs.statSync(p);
    res.set({
      "Content-Type": "video/mp2t",
      "Content-Length": String(stat.size),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    return fs.createReadStream(p).pipe(res);
  } catch {
    return res.status(404).end();
  }
});

app.get("/proxy", async (req, res) => {
  const raw = req.query.url;
  if (!raw || !/^https?:\/\//i.test(String(raw))) {
    return res.status(400).json({ error: "url tidak valid" });
  }
  let upstreamUrl;
  try {
    upstreamUrl = new URL(String(raw));
  } catch {
    return res.status(400).json({ error: "url tidak valid" });
  }
  if (!PROXY_ALLOWED.test(upstreamUrl.hostname)) {
    return res.status(403).json({ error: "domain tidak diizinkan" });
  }

  // Remux mode: convert MP4 ke faststart (moov di awal). Dipakai untuk
  // pixeldrain MP4 yang moov-nya di akhir — tanpa faststart, <video> element
  // WebView stuck download full file sebelum play. AnimeLovers V3 pakai ExoPlayer
  // cache yang probe seluruh file; kita pakai ffmpeg remux one-time + cache disk.
  if (req.query.remux === "1" || req.query.remux === "true") {
    if (remuxMod.isCached(String(raw))) {
      const fp = remuxMod.cachePath(String(raw));
      const stat = fs.statSync(fp);
      res.set({
        "Content-Type": "video/mp4",
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Content-Disposition": "inline",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
        "X-Remux-Cache": "HIT",
        "Cache-Control": "public, max-age=3600",
      });
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start < stat.size) {
          const e = Math.min(end, stat.size - 1);
          const stream = fs.createReadStream(fp, { start, end: e });
          res.status(206);
          res.set("Content-Range", `bytes ${start}-${e}/${stat.size}`);
          return stream.pipe(res);
        }
      }
      res.status(200);
      return fs.createReadStream(fp).pipe(res);
    }
    try {
      const fp = await remuxMod.remux(String(raw));
      const stat = fs.statSync(fp);
      res.set({
        "Content-Type": "video/mp4",
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Content-Disposition": "inline",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
        "X-Remux-Cache": "MISS",
        "Cache-Control": "public, max-age=3600",
      });
      res.status(200);
      return fs.createReadStream(fp).pipe(res);
    } catch (e) {
      console.warn(`[proxy remux] gagal: ${e.message}, fallback stream`);
    }
  }

  let cached = moov.get(String(raw));
  if (cached && cached.promise && !cached.buf) {
    try {
      await Promise.race([
        cached.promise,
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch {}
    cached = moov.get(String(raw));
  }
  if (cached && cached.buf && cached.total) {
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      if (start < cached.buf.length) {
        let end = m && m[2] ? parseInt(m[2], 10) : cached.buf.length - 1;
        end = Math.min(end, cached.buf.length - 1);
        const slice = cached.buf.slice(start, end + 1);
        res.status(206);
        res.set({
          "Content-Type": "video/mp4",
          "Content-Length": String(slice.length),
          "Content-Range": `bytes ${start}-${end}/${cached.total}`,
          "Accept-Ranges": "bytes",
          "Content-Disposition": "inline",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
          "X-Moov-Cache": "HIT",
        });
        return res.end(slice);
      }
    }
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    "Referer": "https://animekita.org/",
    "Accept": "*/*",
  };
  if (req.headers.range) headers["Range"] = req.headers.range;

  // Pakai pixeldrain queue (single-flight + smart retry) supaya gak kena
  // max_concurrent_downloads limit. AnimeLovers-style: queue serial fetch.
  let upstream;
  try {
    const pixReq = /^https?:\/\/pixeldrain\.com\//i.test(upstreamUrl.toString());
    if (pixReq) {
      upstream = await pixeldrain.fetch(upstreamUrl.toString(), { range: req.headers.range });
    } else {
      upstream = await fetch(upstreamUrl.toString(), { headers: { ...headers, Range: req.headers.range } });
    }
  } catch (e) {
    return res.status(502).json({ error: "upstream fetch failed: " + e.message });
  }

  res.status(upstream.status);
  res.set({
    "Content-Type": upstream.headers.get("content-type") || "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  });
  const cl = upstream.headers.get("content-length");
  if (cl) res.set("Content-Length", cl);
  const cr = upstream.headers.get("content-range");
  if (cr) res.set("Content-Range", cr);

  if (!upstream.body) {
    return res.status(upstream.status || 502).end();
  }
  Readable.fromWeb(upstream.body).pipe(res);
});

app.use((err, _req, res, _next) => {
  const status = err.status || 502;
  res.status(status).json({ error: err.message });
});

// ---------- RELAY (perantara ke animekita) ----------
// Dipakai oleh instance backend di Railway (IP datacenter, terblokir
// animekita) untuk mengambil data live lewat instance yang berjalan di
// IP rumah/ISP (Termux/PC). Token wajib via header X-Relay-Token.
// Contoh: GET /relay?path=baruupload.php&page=1
app.get("/relay", async (req, res) => {
  try {
    if (!process.env.RELAY_TOKEN || req.get("x-relay-token") !== process.env.RELAY_TOKEN) {
      return res.status(403).json({ error: "token relay salah" });
    }
    const relayPath = String(req.query.path || "");
    if (!/^[a-zA-Z0-9_/.-]+\.php$/.test(relayPath)) {
      return res.status(400).json({ error: "path tidak valid" });
    }
    const api = new URL(`${adapter.API_BASE}/${relayPath}`);
    for (const [k, v] of Object.entries(req.query)) {
      if (k === "path") continue;
      if (v != null && v !== "") api.searchParams.set(k, String(v));
    }
    const up = await fetch(api.toString(), {
      headers: { "User-Agent": adapter.UA, Accept: "application/json" },
    });
    if (!up.ok) {
      return res.status(up.status).json({ error: `animekita api ${up.status}: ${relayPath}` });
    }
    let text = await up.text();
    const start = text.search(/[\[{]/);
    if (start >= 0) {
      const open = text[start];
      const close = open === "[" ? "]" : "}";
      const end = text.lastIndexOf(close);
      if (end > start) text = text.slice(start, end + 1);
    }
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(502).json({ error: "relay gagal: " + e.message });
  }
});

// ---------- FILL HOOKS (backfill metadata dari worker eksternal) ----------
// Worker eksternal (mis. Termux dgn IP rumah) tarik daftar slug yang kurang
// di sini, fetch animekita dari IP-nya sendiri, lalu push hasilnya balik.
// API server gak pernah nyentuh animekita untuk backfill ini → bebas 403.
// Auth: APP_API_KEY (header X-Api-Key atau ?apikey=).

// GET /fill-catalog → { queue: [slug...], existing: {slug: {syn_len, genres}} }
app.get("/fill-catalog", async (req, res) => {
  const key = req.get("x-api-key") || req.query.apikey;
  if (key !== process.env.APP_API_KEY) return res.status(401).json({ error: "api key salah" });
  try {
    const limit = Math.min(parseInt(String(req.query.limit || "500"), 10) || 500, 2000);
    const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);
    const catalog = await db.get("catalog");
    const items = catalog && Array.isArray(catalog.value) ? catalog.value : [];
    const slugs = [];
    for (const it of items) {
      const s = it && (it.animeId || it.url || it.endpoint || it.slug);
      if (s && !slugs.includes(s)) slugs.push(s);
    }
    const doneSet = new Set();
    try {
      const doneFile = path.join(process.cwd(), "data", "fill_done.txt");
      fs.readFileSync(doneFile, "utf8").split(/\r?\n/).forEach((s) => { if (s.trim()) doneSet.add(s.trim()); });
    } catch {}
    const existing = await db.getAllByPrefix("anime:%");
    const need = [];
    const existingMeta = {};
    for (const s of slugs) {
      const v = existing[s];
      if (!v) { if (!doneSet.has(s)) need.push(s); continue; }
      const syn = String(v.synopsis || "").trim();
      const gs = Array.isArray(v.genres) ? v.genres : [];
      existingMeta[s] = { syn: syn.length, genres: gs.length };
      if (syn.length < 20 && !doneSet.has(s)) need.push(s);
    }
    res.json({
      total: slugs.length,
      need: need.length,
      queue: need.slice(offset, offset + limit),
      existing: existingMeta,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /fill-detail { slug, detail } → simpan 1 detail anime
app.post("/fill-detail", async (req, res) => {
  const key = req.get("x-api-key") || req.query.apikey;
  if (key !== process.env.APP_API_KEY) return res.status(401).json({ error: "api key salah" });
  try {
    const { slug, detail } = req.body || {};
    if (!slug || !detail || typeof detail !== "object") {
      return res.status(400).json({ error: "butuh { slug, detail }" });
    }
    const syn = String(detail.synopsis || "").trim();
    const gs = Array.isArray(detail.genres) ? detail.genres : [];
    if (syn.length < 20 && gs.length === 0) {
      // kosong di sumber → tandai selesai biar gak diulang
      const doneFile = path.join(process.cwd(), "data", "fill_done.txt");
      fs.mkdirSync(path.dirname(doneFile), { recursive: true });
      fs.appendFileSync(doneFile, String(slug) + "\n");
      return res.json({ ok: true, saved: false, marked: true });
    }
    await db.set(`anime:${slug}`, detail);
    const doneFile = path.join(process.cwd(), "data", "fill_done.txt");
    fs.mkdirSync(path.dirname(doneFile), { recursive: true });
    fs.appendFileSync(doneFile, String(slug) + "\n");
    res.json({ ok: true, saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TsukiNime API on http://0.0.0.0:${PORT}`);
});
adapter.initBanners();

// Backfill detail SEMUA anime katalog (FILL_ALL=1): jalan di proses yang sama
// dgn app.js (share koneksi SQLite, aman dari lock). Resume-safe via
// data/fill_done.txt. Delay default 600ms — naikkan FILL_DELAY untuk lebih
// pelan. Matikan dengan FILL_ALL=0 lalu restart.
if (process.env.FILL_ALL === "1") {
  const { runFillAll } = require("./fill_all");
  runFillAll({
    delayMs: parseInt(process.env.FILL_DELAY || "600", 10),
    log: (m) => console.log(m),
  }).catch((e) => console.error("[fillall] mati:", e.message));
}
if (process.env.NO_CRAWL !== "1") {
  adapter.startCrawler();
  adapter.startPosterCrawler();
}

// Auto-sync: isi database sendiri dari animekita secara berkala.
// HANYA aktif saat AUTO_SYNC_HOURS di-set (>0) — dan hanya boleh dipakai
// saat backend berjalan di IP rumah/ISP (bukan Railway), karena animekita
// memblokir IP datacenter. Contoh: AUTO_SYNC_HOURS=6 LIGHT_SYNC_MIN=30
//
// LIGHT (sering, murah): home + schedule + detail anime yang baru di-upload
//   → bikin /watcher-feed (sumber deteksi episode baru) selalu segar, jadi
//   notif episode baru sampai ke HP dalam ≤ LIGHT_SYNC_MIN + 10 mnt.
// HEAVY (jarang, berat): catalog + semua detail ongoing + episode terbaru.
if (process.env.AUTO_SYNC_HOURS && parseFloat(process.env.AUTO_SYNC_HOURS) > 0) {
  const { runSync } = require("./db/sync_core");
  const HOURS = parseFloat(process.env.AUTO_SYNC_HOURS);
  const LIGHT_MIN = parseFloat(process.env.LIGHT_SYNC_MIN || "30");
  const LIGHT = {
    home: true,
    schedule: true,
    details: 25,
    ongoing: 0,
    // KRUSIAL: refresh detail anime yang JADWAL HARI INI (±10 judul).
    // Ini yang bikin episode baru cepat masuk DB (bukan nunggu 24 jam).
    todaySchedule: true,
    syncEpisodes: false,
    lists: 1,
    genres: true,
    genrePages: 0,
  };
  const HEAVY = {
    home: true,
    schedule: true,
    catalog: true,
    details: 0,
    ongoing: -1,
    todaySchedule: true,
    forceToday: true,
    syncEpisodes: true,
    episodesPer: 3,
    lists: 3,
    genres: true,
    genrePages: 1,
  };
  const label = (n, o) => `[auto-sync:${n}] ok: ${JSON.stringify(o.counts)}`;
  const runLight = () =>
    runSync(LIGHT)
      .then((s) => console.log(label("light", s)))
      .catch((e) => console.error("[auto-sync:light] gagal:", e.message));
  const runHeavy = () =>
    runSync(HEAVY)
      .then((s) => console.log(label("heavy", s)))
      .catch((e) => console.error("[auto-sync:heavy] gagal:", e.message));
  runHeavy();
  setTimeout(runLight, 10_000);
  setInterval(runHeavy, HOURS * 60 * 60 * 1000);
  setInterval(runLight, LIGHT_MIN * 60 * 1000);
}
