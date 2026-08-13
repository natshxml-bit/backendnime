const express = require("express");
const adapter = require("./adapter");
const db = require("./db/db");
const fs = require("fs");
const path = require("path");

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
  if (req.path === "/proxy") return next();
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
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Requested-With, Range, Authorization",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const VALID_LISTS = ["all", "ongoing", "finished", "upcoming", "movie", "donghua", "anime"];

app.get("/", (_req, res) => {
  res.json({
    name: "TsukiNime Scraper API",
    version: "3.0.0",
    source: "https://apps.animekita.org/api/v1.2.5",
    endpoints: {
      "GET /home": "homepage (recent + ongoing + completed + film)",
      "GET /recommendations?limit=12": "rekomendasi acak",
      "GET /anime/{slug}": "anime detail + episodeList",
      "GET /episode/{episodeId}": "episode servers + qualities",
      "GET /schedule": "jadwal mingguan by hari",
      "GET /genres": "daftar genre",
      "GET /genre/{slug}?page=1": "anime by genre",
      "GET /search/{q}": "pencarian",
      "GET /ongoing-anime?page=1": "anime ongoing",
      "GET /complete-anime?page=1": "anime selesai",
      "GET /list/{type}?page=1": "type: ongoing|finished|upcoming|movie|donghua|anime",
      "GET /proxy?url=...": "proxy video mp4",
      "GET /watcher-status": "status watcher (heartbeat dari Firestore)",
      "GET /watcher-feed": "feed watcher: upload terbaru + jumlah episode aktual",
      "GET /db/status": "status database sendiri (counts + last sync)",
    },
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
    animeList.push({
      animeId: String(it.url || it.link || it.id || ""),
      title,
      poster: it.cover || it.thumb || "",
      score: null,
      status: null,
      type: null,
      episode: it.lastch || it.episode || null,
      quality: null,
      genres: Array.isArray(it.genre) ? it.genre : [],
      synopsis: it.sinopsis || null,
    });
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

// trigger notif tes manual: POST /push-test?key=tsukitest
app.post("/push-test", async (req, res) => {
  if (req.query.key !== "tsukitest") return res.status(403).json({ error: "key salah" });
  try {
    const { getFirestore } = require("firebase-admin/firestore");
    const { getMessaging } = require("firebase-admin/messaging");
    const adm = getAdmin();
    const users = await getFirestore(adm).collection("users").get();
    const tokens = users.docs.flatMap((d) => (Array.isArray(d.data().fcmTokens) ? d.data().fcmTokens : []));
    if (tokens.length === 0) return res.json({ sent: 0, reason: "belum ada token FCM" });
    const r = await getMessaging(adm).sendEachForMulticast({
      tokens,
      notification: {
        title: req.query.title || "TsukiNime",
        body: req.query.body || "Notifikasi push jalan! 🔔",
      },
      android: { priority: "high", notification: { channelId: "episode_rilis" } },
      data: { test: "1", type: req.query.type || "ADMIN" },
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

app.post("/upload", requireAuth, async (req, res) => {
  const { image } = req.body || {};
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "data image base64 wajib" });
  }
  const b64 = image.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
  if (b64.length > 6 * 1024 * 1024) {
    return res.status(400).json({ error: "ukuran foto terlalu besar (maks 6MB)" });
  }
  console.log(`[upload] uid=${req.uid} bytes=${Math.floor(b64.length * 0.75)}`);
  try {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append(
      "fileToUpload",
      new Blob([Buffer.from(b64, "base64")], { type: "image/png" }),
      "pfp.png"
    );
    const r = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: form,
      headers: { "User-Agent": "TsukiNime/1.0" },
    });
    const text = await r.text();
    if (!r.ok || !/^https?:\/\//.test(text.trim())) {
      console.log(`[upload] gagal: HTTP ${r.status} ${text.slice(0, 120)}`);
      return res.status(502).json({ error: "upload gagal: " + text.slice(0, 120) });
    }
    console.log(`[upload] sukses: ${text.trim().slice(0, 60)}`);
    res.json({ url: text.trim() });
  } catch (e) {
    console.log(`[upload] error: ${e.message}`);
    res.status(502).json({ error: "upload gagal: " + e.message });
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
  if (type === "ongoing") return dbFirst(`list:ongoing:${page}`, () => adapter.ongoing(page), 6 * 60 * 60 * 1000);
  if (type === "finished") return dbFirst(`list:finished:${page}`, () => adapter.complete(page), 6 * 60 * 60 * 1000);
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
  return dbFirst(`anime:${animePath}`, () => adapter.animeDetail(animePath), 6 * 60 * 60 * 1000);
}));

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
app.get("/admin/cache-bust-ep", async (_req, res) => {
  try {
    const keys = await db.keysLike("ep:%");
    for (const k of keys) await db.del(k);
    res.json({ cleared: keys.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/config", async (_req, res) => {
  try {
    res.json({
      apiBase: process.env.ANIMEKITA_API_BASE || adapter.API_BASE,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const { Readable } = require("stream");
const moov = require("./moov");
const PROXY_ALLOWED = /(^|\.)(animekita\.org|r2\.cloudflarestorage\.com|kotakanimeid\.link|pixeldrain\.com)$/i;

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

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), { headers });
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message) });
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

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TsukiNime API on http://0.0.0.0:${PORT}`);
});
adapter.initBanners();
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
