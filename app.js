const express = require("express");
const adapter = require("./adapter");
const fs = require("fs");
const path = require("path");

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
    .then(() => fn(req))
    .then((data) => res.json(data))
    .catch((e) => res.status(502).json({ error: e.message }));
};

app.get("/home", wrap(() => adapter.home()));

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
      notification: { title: "TsukiNime", body: "Notifikasi push jalan! 🔔" },
      android: { priority: "high", notification: { channelId: "episode_rilis" } },
      data: { test: "1" },
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

app.get("/schedule", wrap(() => adapter.schedule()));

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

app.get("/genres", wrap(() => adapter.genres()));

app.get("/genre/:slug", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return adapter.byGenre(req.params.slug, page);
}));

app.get("/search/:query", wrap((req) => adapter.searchQuery(req.params.query)));

app.get("/ongoing-anime", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return adapter.ongoing(page);
}));

app.get("/complete-anime", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return adapter.complete(page);
}));

app.get("/list/:type", wrap((req) => {
  const type = req.params.type;
  const page = parseInt(req.query.page, 10) || 1;
  if (!VALID_LISTS.includes(type)) {
    const err = new Error(`type harus salah satu dari ${[...VALID_LISTS].sort().join(", ")}`);
    err.status = 400;
    throw err;
  }
  if (type === "ongoing") return adapter.ongoing(page);
  if (type === "finished") return adapter.complete(page);
  return adapter.listByType(type, page);
}));

app.get("/episode/*splat", wrap((req) => {
  const s = req.params.splat;
  const path = (Array.isArray(s) ? s.join("/") : String(s)).replace(/,/g, "/");
  return adapter.episode(path);
}));

app.get("/anime/*splat", wrap((req) => {
  const s = req.params.splat;
  const path = (Array.isArray(s) ? s.join("/") : String(s)).replace(/,/g, "/");
  return adapter.animeDetail(path);
}));

const { Readable } = require("stream");
const moov = require("./moov");
const PROXY_ALLOWED = /(^|\.)(animekita\.org|r2\.cloudflarestorage\.com|kotakanimeid\.link)$/i;

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

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TsukiNime API on http://0.0.0.0:${PORT}`);
});
if (process.env.NO_CRAWL !== "1") {
  adapter.startCrawler();
  adapter.startPosterCrawler();
}
