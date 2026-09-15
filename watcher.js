// watcher.js — pantau episode baru dari API, kirim FCM push + simpan notif in-app
// jalan: node watcher.js  (opsional: node watcher.js --test utk kirim notif tes)
// Notif HANYA dikirim untuk anime yang ada di JADWAL RILIS (/schedule) —
// feed upload terbaru TIDAK dipakai (bisa backlog/re-upload → notif akurat).
const { initializeApp, cert } = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT = path.join(__dirname, "service-account.json");
const SNAPSHOT_FILE = path.join(__dirname, "data", "lastEpisodes.json");
const LOCK_FILE = path.join(__dirname, "data", "watcher.lock");
const API_BASE = process.env.TSUKI_API || `http://127.0.0.1:${process.env.PORT || 8000}`;
// Semua fetch internal watcher wajib bawa apikey — /schedule, /watcher-feed,
// /home, dll. bukan route keyless (dari hardening backend).
const API_KEY_QS = process.env.APP_API_KEY
  ? `?apikey=${encodeURIComponent(process.env.APP_API_KEY)}`
  : "";

// Backend gate baru: jalur internal pakai header X-Internal (bukan app key).
// Wrapper global ini nambahin header ke SEMUA fetch ke API_BASE — gak perlu
// ngubah tiap call site. App key di query tetep dikirim buat kompatibilitas
// selama backend masih mode audit.
{
  const ORIG_FETCH = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    try {
      const u = typeof input === "string" ? input : (input && input.url) || "";
      if (u.startsWith(API_BASE)) {
        const opts = init && typeof init === "object" ? { ...init } : {};
        opts.headers = { ...(opts.headers || {}), "X-Internal": process.env.INTERNAL_TOKEN || "" };
        return ORIG_FETCH(input, opts);
      }
    } catch {}
    return ORIG_FETCH(input, init);
  };
}
// base URL publik buat image notif FCM — FCM ngambil gambar dari luar, jadi
// harus URL domain publik (bukan 127.0.0.1). Gambar di-proxy lewat /img
// biar gak ditolak fetcher FCM.
const PUBLIC_BASE = process.env.PUBLIC_BASE || "https://backendnime.up.railway.app";
const POLL_MS = parseInt(process.env.WATCH_INTERVAL_MIN || "15", 10) * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
// notif hanya untuk rilis yang updated-nya ≤ RECENT_HOURS jam terakhir (anti
// "rombongan": catch-up setelah watcher mati/restart cukup di-baseline diam-diam)
const RECENT_MS = parseInt(process.env.WATCH_RECENT_HOURS || "48", 10) * 3600 * 1000;
// maks episode baru yang di-broadcast per tick (sisanya di-defer ke tick berikutnya)
const MAX_NOTIF_PER_TICK = parseInt(process.env.WATCH_MAX_PER_TICK || "20", 10);
// jeda antar notif kalau 1 tick mendeteksi banyak episode sekaligus (mis. 5
// anime bareng → kirim 1, tunggu STAGGER_MS, kirim berikutnya, dst). 0 = kirim
// bareng (kembali ke perilaku lama). Default 90 detik.
const STAGGER_MS = parseInt(process.env.WATCH_STAGGER_MS || "90", 10) * 1000;
// TTL cooldown persistent (Firestore) untuk episode yang sudah di-notif.
// Cegah double-fire kalau Railway restart di tengah window.
const NOTIFIED_TTL_MS = 7 * 24 * 3600 * 1000;
// collapse_key seragam agar FCM/Android/iOS merge notif yg di-retry
// (legacy) dulu dipakai semua-anime-sama → bikin notif tabrakan. Sekarang collapse_key unik per anime+ep di notifyEpisode().
const COLLAPSE_KEY = process.env.WATCH_COLLAPSE_KEY || "weekly_digest";

function loadCredential() {
  if (fs.existsSync(SERVICE_ACCOUNT)) {
    return { credential: cert(SERVICE_ACCOUNT) };
  }
  if (process.env.FIREBASE_SA_JSON) {
    return { credential: cert(JSON.parse(process.env.FIREBASE_SA_JSON)) };
  }
  if (process.env.FIREBASE_SA_B64) {
    return { credential: cert(JSON.parse(Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8"))) };
  }
  return null;
}

// cegah watcher ganda (lock file, stale jika > 5 menit)
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      // cek PID di lock masih hidup (kalau mati, langsung ambil alih tanpa nunggu stale)
      const pid = parseInt(String(fs.readFileSync(LOCK_FILE, "utf8")).trim(), 10);
      if (pid > 0 && Number.isInteger(pid)) {
        try {
          process.kill(pid, 0);
        } catch {
          fs.writeFileSync(LOCK_FILE, String(process.pid));
          console.log("[watcher] lock dari PID mati diambil alih");
          return true;
        }
      }
    } catch {}
    try {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age > 5 * 60 * 1000) {
        fs.writeFileSync(LOCK_FILE, String(process.pid));
        console.log("[watcher] lock lama diambil alih (stale)");
        return true;
      }
    } catch {}
    console.error("[watcher] watcher lain sudah berjalan — keluar.");
    return false;
  }
}

function releaseLock() {
  try {
    if (String(fs.readFileSync(LOCK_FILE, "utf8")).trim() === String(process.pid)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

const cred = loadCredential();
if (!cred) {
  console.error("[watcher] service-account.json / FIREBASE_SA_JSON tidak ditemukan!");
  process.exit(1);
}

// mode test tidak perlu lock — biar bisa dijalankan saat watcher utama jalan
const isTestMode =
  process.argv.includes("--test") ||
  process.argv.includes("--test-eps") ||
  process.argv.includes("--test-staggered") ||
  process.argv.includes("--dry-schedule") ||
  process.argv.some((a) => a.startsWith("--test-anime=")) ||
  process.argv.some((a) => a.startsWith("--dry-schedule=")) ||
  process.argv.some((a) => a.startsWith("--test-staggered="));

if (!isTestMode) {
  if (!acquireLock()) process.exit(0);

  // bersihkan lock saat proses dimatikan supaya restart berikutnya tidak salah deteksi watcher ganda
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

initializeApp(cred);
const db = getFirestore();
const messaging = getMessaging();

// maxByAnime: animeId -> nomor episode terakhir yang pernah terlihat
let maxByAnime = {};
try {
  maxByAnime = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  console.log(`[watcher] snapshot lokal dimuat (${Object.keys(maxByAnime).length} anime)`);
} catch {}

// preferensi: snapshot Firestore (persist antar restart di Railway)
const SNAPSHOT_DOC = "watcherSnapshotDoc";
let snapshotLoadedFromRemote = false;

async function loadRemoteSnapshot() {
  try {
    const snap = await db.collection("_system").doc(SNAPSHOT_DOC).get();
    if (snap.exists && snap.data().maxByAnime) {
      const remote = snap.data().maxByAnime;
      // MERGE — JANGAN timpa lokal. Lokal (committed ke git, 131 anime) sering
      // lebih lengkap dari Firestore (68). Kalau ditimpa, baseline anime aktif
      // (mao, slime, dst) hilang → prevE=0 → ep skrng > 0 → false "episode baru"
      // → spam massal di cold start. Ambil entry dengan episode tertinggi
      // (observasi paling baru) per slug.
      const merged = { ...maxByAnime };
      let added = 0;
      for (const [slug, rv] of Object.entries(remote)) {
        const lv = merged[slug];
        if (lv === undefined) { merged[slug] = rv; added++; continue; }
        const lE = (typeof lv === "object" ? lv.e : lv) || 0;
        const rE = (typeof rv === "object" ? rv.e : rv) || 0;
        if (rE > lE) merged[slug] = rv;
      }
      maxByAnime = merged;
      snapshotLoadedFromRemote = true;
      baselineDone = true;
      console.log(`[watcher] snapshot Firestore dimuat (${Object.keys(remote).length} remote, +${added} baru, total ${Object.keys(maxByAnime).length} anime)`);
    }
  } catch {}
}

let lastNotified = {}; // animeId -> timestamp
let baselineDone = false;

// kalau snapshot lama ada, tick pertama langsung bisa deteksi episode baru
if (Object.keys(maxByAnime).length > 0) baselineDone = true;

function cleanTitle(t) {
  return String(t || "").replace(/Subtitle Indonesia/gi, "").trim();
}

function epNum(e) {
  const m = String(e || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// normalisasi judul untuk pencocokan jadwal ↔ feed (abaikan case, tanda baca,
// dan sufiks "Subtitle Indonesia"/"Sub Indo" yang bisa beda-beda sumbernya)
function normTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/sub(indonesia|)?\s*indonesia/gi, "")
    .replace(/sub\s*indo/gi, "")
    .replace(/[^a-z0-9]/gi, "")
    .trim();
}

function titlesMatch(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x));
}

// jadwal.php kadang memakai slug yang TIDAK dikenal series.php (mis.
// "youjo-senki-ii-sub-indo" vs canonical "youjo-senki-s2-sub-indo") →
// fetch episode count pasti gagal → anime itu gak pernah ke-notif.
// Resolve: cari lewat endpoint search lokal (DB dulu, fallback search.php)
// dengan mencocokkan judul, pakai hasilnya sebagai slug kanonik.
const canonicalMap = {}; // slug jadwal -> slug kanonik (di-cache per proses)
const canonicalFail = {}; // slug jadwal -> ts gagal terakhir (retry 30 mnt)

async function resolveCanonicalSlug(slug, title) {
  if (canonicalMap[slug]) return canonicalMap[slug];
  if (canonicalMap[slug] === null) return null; // sudah dicoba & gagal
  if (canonicalFail[slug] && Date.now() - canonicalFail[slug] < 30 * 60 * 1000) return null;
  try {
    const q = String(title || slug).replace(/[^a-z0-9 ]/gi, " ").trim().slice(0, 40);
    if (q.length < 3) { canonicalMap[slug] = null; return null; }
    const res = await fetch(`${API_BASE}/search/${encodeURIComponent(q)}${API_KEY_QS}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { canonicalFail[slug] = Date.now(); return null; }
    const d = await res.json();
    const items = Array.isArray(d.animeList) ? d.animeList : [];
    // HANYA terima kalau judul benar-benar cocok — jangan ambil item pertama
    // (bisa salah anime → notif sampah / baseline salah)
    const hit = items.find((it) => it && it.animeId && titlesMatch(it.title, title));
    if (!hit || !hit.animeId) { canonicalFail[slug] = Date.now(); return null; }
    canonicalMap[slug] = hit.animeId;
    console.log(`[watcher] slug ${slug} di-resolve → ${hit.animeId} (search)`);
    return hit.animeId;
  } catch {
    canonicalFail[slug] = Date.now();
    return null;
  }
}

// nama hari WIB (UTC+7) — jadwal.php pakai hari Indonesia & zona WIB,
// jadi hitung lewat getUTCDay biar konsisten di server zona apapun.
function wibDayName() {
  const names = ["minggu", "senin", "selasa", "rabu", "kamis", "jumat", "sabtu"];
  return names[new Date(Date.now() + 7 * 3600 * 1000).getUTCDay()];
}

// map animeId -> { day, title, poster, updated } dari /schedule.
// HANYA hari ini (elemen pertama response; API mengurutkan mulai hari
// berjalan) — biar tiap tick cuma cek ±10 anime, bukan semua 58.
// return null kalau gagal (biar watcher fallback ke perilaku lama).
async function getScheduleMap() {
  try {
    const res = await fetch(`${API_BASE}/schedule${API_KEY_QS}`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`schedule ${res.status}`);
    const days = await res.json();
    if (!Array.isArray(days)) throw new Error("schedule bukan array");
    const todayOnly = Array.isArray(days) && days.length > 0 ? [days[0]] : days;
    console.log(`[watcher] jadwal hari ini: ${days.length > 0 ? days[0].day : "?"} (${(days.length > 0 ? days[0].anime_list || [] : []).length} anime)`);
    const map = {};
    for (const day of todayOnly) {
      for (const a of Array.isArray(day.anime_list) ? day.anime_list : []) {
        if (a && a.animeId) {
          map[a.animeId] = {
            day: day.day,
            title: a.title,
            poster: a.poster || "",
            updated: a.updated || null,
          };
        }
      }
    }
    return map;
  } catch (e) {
    console.error("[watcher] gagal muat jadwal rilis:", e.message);
    return null;
  }
}

// Cache set animeId yang MASIH ongoing (muncul di /list/ongoing?page=1..N).
// Dipakai untuk skip notif anime finished/Completed walau secara teknis
// episode count-nya naik. Refresh tiap 6 jam, in-memory per proses.
let ongoingSlugsCache = { slugs: null, at: 0 };
const ONGOING_TTL_MS = 6 * 3600 * 1000;
const ONGOING_MAX_PAGES = 5; // biasanya ≤ 3 page; lebihkan supaya aman
async function loadOngoingSlugs() {
  if (Date.now() - ongoingSlugsCache.at < ONGOING_TTL_MS && ongoingSlugsCache.slugs) {
    return ongoingSlugsCache.slugs;
  }
  const slugs = new Set();
  for (let p = 1; p <= ONGOING_MAX_PAGES; p++) {
    try {
      const res = await fetch(`${API_BASE}/list/ongoing?page=${p}${API_KEY_QS}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) break;
      const data = await res.json();
      const list = Array.isArray(data?.animeList) ? data.animeList : Array.isArray(data) ? data : [];
      if (list.length === 0) break;
      for (const it of list) {
        if (it && it.animeId) slugs.add(String(it.animeId));
      }
      if (list.length < 20) break; // page terakhir
    } catch {
      break;
    }
  }
  if (slugs.size > 0) {
    ongoingSlugsCache = { slugs, at: Date.now() };
    console.log(`[watcher] ongoing slugs dimuat (${slugs.size} anime)`);
  }
  return slugs;
}

// Notif hanya kalau judulnya ADA di jadwal rilis DAN rilisnya cocok jadwal:
// hari rilisnya = hari ini WIB, ATAU jadwal mencatat updated < 48 jam lalu
// (antisipasi upload telat 1 hari). Kalau jadwal gagal dimuat (null) →
// fallback biar notif tetap jalan.
function isScheduledRelease(animeId, scheduleMap) {
  if (!scheduleMap) return true;
  const sched = scheduleMap[animeId];
  if (!sched) return false;
  const dayMatch = sched.day === wibDayName();
  const updatedRecent = sched.updated && Date.now() - sched.updated * 1000 < 48 * 3600 * 1000;
  return dayMatch || updatedRecent;
}

async function getRecent() {
  // /watcher-feed: upload terbaru + jumlah episode AKTUAL dari series detail
  // (kartu baruupload/`home` tidak pernah berisi nomor episode).
  try {
    const res = await fetch(`${API_BASE}/watcher-feed${API_KEY_QS}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch {}
  const res = await fetch(`${API_BASE}/home${API_KEY_QS}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return data?.recent || data?.ongoing?.animeList || [];
}

async function getAllUsers() {
  const snap = await db.collection("users").get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

// COOLDOWN PERSISTENT — kalau episode (animeId, ep) sudah pernah di-notify,
// skip di tick berikut (meskipun watcher restart). Cegah double-fire setelah
// Railway restart / redeploy. Pakai TTL 7 hari biar koleksi tidak membengkak.
const NOTIFIED_COL = "_system/notifyLog";
function notifiedDocId(animeId, ep) {
  return `${String(animeId).replace(/[^\w-]/g, "_")}:${ep}`;
}
async function isEpisodeNotified(animeId, ep) {
  try {
    const snap = await db.doc(`${NOTIFIED_COL}/${notifiedDocId(animeId, ep)}`).get();
    if (!snap.exists) return false;
    const at = snap.get("at");
    const ts = at && typeof at.toMillis === "function" ? at.toMillis() : at?.seconds * 1000;
    if (ts && Date.now() - ts > NOTIFIED_TTL_MS) return false; // TTL habis
    return true;
  } catch {
    return false;
  }
}
async function markEpisodeNotified(animeId, ep) {
  try {
    await db.doc(`${NOTIFIED_COL}/${notifiedDocId(animeId, ep)}`).set(
      { at: FieldValue.serverTimestamp(), animeId: String(animeId), ep },
      { merge: true }
    );
  } catch {}
}

// token valid = string, unik. Token berbentuk object (bug app lama) dibuang.
function collectTokens(users) {
  const set = new Set();
  for (const u of users) {
    for (const t of Array.isArray(u.data.fcmTokens) ? u.data.fcmTokens : []) {
      if (typeof t === "string" && t.length > 0) set.add(t);
    }
  }
  return [...set];
}

// sekali jalan per tick: bersihkan token sampah (object, kosong) dari Firestore
async function cleanupTokenJunk(users) {
  for (const u of users) {
    const toks = u.data.fcmTokens;
    if (!Array.isArray(toks)) continue;
    const junk = toks.filter((t) => typeof t !== "string" || t.length === 0);
    if (junk.length === 0) continue;
    try {
      await db.collection("users").doc(u.id).update({
        fcmTokens: FieldValue.arrayRemove(...junk),
      });
      console.log(`[watcher] token tidak valid dihapus dari ${u.id} (${junk.length})`);
    } catch {}
  }
}

async function saveSnapshot() {
  // simpan ke Firestore biar persist di Railway (file lokal ephemeral)
  try {
    await db.collection("_system").doc(SNAPSHOT_DOC).set({ maxByAnime, updatedAt: FieldValue.serverTimestamp() });
  } catch (e) {
    console.error("[watcher] gagal simpan snapshot Firestore:", e.message);
  }
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(maxByAnime));
  } catch {}
}

async function notifyEpisode(anime, ep, users, tokens) {
  // Per-anime broadcast (1 notif 1 pesan) — dipanggil oleh scheduleStaggered()
  // dengan jeda STAGGER_MS, atau langsung oleh mode test (--test-eps dll).
  const animeId = anime.animeId || anime.id;
  const title = cleanTitle(anime.title || anime.name);
  const poster = anime.poster || anime.thumb || "";
  const body = `Episode ${ep} rilis!`;
  const link = `/detail?id=${animeId}`;

  // 1) notif in-app (users/{uid}/notifications) — dipakai bell di Home
  const writes = [];
  for (const u of users) {
    writes.push(
      db.collection("users").doc(u.id).collection("notifications").add({
        timestamp: FieldValue.serverTimestamp(),
        type: "NEW_EPISODE",
        animeTitle: title,
        poster,
        message: body,
        link,
        read: false,
      })
    );
  }
  await Promise.allSettled(writes);

  // 2) push FCM
  if (tokens.length === 0) return;
  const CHUNK = 400;
  const key = process.env.APP_API_KEY ? `&apikey=${encodeURIComponent(process.env.APP_API_KEY)}` : "";
  const posterImg = poster
    ? `${PUBLIC_BASE}/img?url=${encodeURIComponent(poster)}${key}`
    : "";
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    try {
      const resp = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: {
          title,
          body,
          ...(posterImg ? { image: posterImg } : {}),
        },
        android: {
          priority: "high",
          // collapse_key UNIK per anime+episode. Kalau pakai key yang sama
          // buat semua anime (mis. "weekly_digest"), Android bisa nampilin
          // notif anime B beda barengan dgn anime A sebelum yang lama
          // ke-collapse → kelihatan "2 notif muncul sekaligus".
          collapse_key: `ep-${String(animeId).slice(0, 40)}-${ep}`,
          notification: { channelId: "episode_rilis" },
        },
        apns: { headers: { "apns-collapse-id": `ep-${String(animeId).slice(0, 40)}-${ep}` } },
        webpush: { headers: { Topic: `ep-${String(animeId).slice(0, 40)}-${ep}` } },
        data: { animeId: String(animeId), url: link, poster: poster || "", type: "SINGLE" },
      });
      const invalid = new Set();
      resp.responses.forEach((r, idx) => {
        if (!r.success && /registration-token-not-registered|invalid-registered-token|mismatched-credential/i.test(r.error?.code || "")) {
          invalid.add(chunk[idx]);
        }
      });
      if (invalid.size > 0) {
        await Promise.allSettled(
          users.map((u) => {
            const toks = u.data.fcmTokens;
            if (!Array.isArray(toks) || !toks.some((t) => invalid.has(t))) return Promise.resolve();
            return db.collection("users").doc(u.id).update({
              fcmTokens: FieldValue.arrayRemove(...[...invalid].filter((t) => toks.includes(t))),
            });
          })
        );
      }
      console.log(`[watcher] FCM terkirim ke ${resp.successCount}/${chunk.length} token (${title} EP ${ep})`);
    } catch (e) {
      console.error("[watcher] FCM gagal:", e.message);
    }
  }
}

// STAGGERED SEND — kirim 1 FCM per episode dengan jeda STAGGER_MS antar
// notif. Kalau ada 5 episode baru di 1 tick → notif ke-1 langsung, ke-2
// setelah STAGGER_MS, dst. Cooldown persistent (Firestore) mencegah
// re-fire kalau container restart di tengah antrian.
// items: [{ animeId, ep, title, poster, slug }]
function scheduleStaggered(items, users, tokens) {
  if (items.length === 0) return;
  if (STAGGER_MS <= 0) {
    // mode lama: kirim bareng (tanpa jeda)
    (async () => {
      for (const it of items) {
        try {
          await notifyEpisode({ animeId: it.animeId, title: it.title, poster: it.poster }, it.ep, users, tokens);
        } catch (e) { console.error("[watcher] FCM gagal:", e.message); }
      }
    })();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const delay = i * STAGGER_MS;
    setTimeout(async () => {
      // Set cooldown in-memory TEPAT sebelum kirim — bukan saat masuk antrian.
      // Kalau di-set di awal antrian, tick berikutnya (15 mnt) bisa nyusul
      // sebelum antrian kelar → episode sama kekirim 2x.
      lastNotified[it.animeId] = Date.now();
      console.log(`[watcher] FCM stagger kirim #${i + 1}/${items.length} (delay ${delay / 1000}s): ${cleanTitle(it.title)} EP ${it.ep}`);
      try {
        await notifyEpisode({ animeId: it.animeId, title: it.title, poster: it.poster }, it.ep, users, tokens);
      } catch (e) { console.error("[watcher] FCM gagal:", e.message); }
    }, delay);
  }
  console.log(`[watcher] FCM stagger antrian: ${items.length} notif, jeda ${STAGGER_MS / 1000}s (selesai dalam ${((items.length - 1) * STAGGER_MS) / 1000}s)`);
}

let ticking = false;
// Batas notif harian (semua anime digabung). Lampaui → skip notif, cukup
// baseline + mark Firestore biar gak nyusul pas besok (anti backlog).
const DAILY_NOTIF_CAP = parseInt(process.env.WATCH_DAILY_CAP || "12", 10);
// QUIET mode: catch-up snapshot TANPA kirim FCM (buat abis backfill/restart
// besar). Set env WATCH_QUIET=1, jalankan 1-2 tick, lalu hapus env.
const QUIET = process.env.WATCH_QUIET === "1";
let notifCount = 0;
let notifDate = new Date().toISOString().slice(0, 10);
try {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "notif_daily.json"), "utf8"));
  if (s.date === notifDate) notifCount = s.count || 0;
} catch {}
function bumpNotifCount(n = 1) {
  notifCount += n;
  try {
    fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "data", "notif_daily.json"), JSON.stringify({ date: notifDate, count: notifCount }));
  } catch {}
}
function checkDateRollover() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== notifDate) { notifDate = today; notifCount = 0; bumpNotifCount(0); }
}
async function tick() {
  if (ticking) return; // cegah tick bertumpuk (tick lama belum selesai)
  ticking = true;
  try {
    const users = await getAllUsers();
    const tokens = collectTokens(users);
    await cleanupTokenJunk(users);
    const now = Date.now();
    const scheduleMap = await getScheduleMap();
    const ongoingSlugs = await loadOngoingSlugs();
    const newEpisodes = [];

    // DETEKSI: HANYA dari jadwal rilis (/schedule), sesuai kebijakan — feed
    // upload terbaru TIDAK dipakai sebagai sumber notif (bisa backlog/re-upload).
    // Slug jadwal yang "palsu" di-resolve ke slug kanonik via search.
    if (scheduleMap) {
      await collectScheduleReleases(scheduleMap, now, newEpisodes, ongoingSlugs);
    } else {
      console.log("[watcher] jadwal gagal dimuat — deteksi dilewati tick ini");
    }

    if (newEpisodes.length > 0 && baselineDone) {
      // KUMPULKAN episode baru per tick → STAGGERED SEND (1 FCM per anime
      // dengan jeda STAGGER_MS). Bukan 1 pesan gabung (digest) — user lebih
      // suka notif terpisah, asal tidak dikirim bareng. Filter pakai cooldown
      // in-memory (10 mnt) + cooldown persistent Firestore (anti re-fire
      // setelah restart).
      // QUIET mode / cap harian → item dilewati notif tapi tetap baseline
      // + mark Firestore (supaya gak muncul lagi, dan gak numpuk jadi backlog).
      checkDateRollover();
      const remainingToday = Math.max(DAILY_NOTIF_CAP - notifCount, 0);
      const quiet = QUIET || remainingToday <= 0;
      if (quiet) {
        console.log(
          QUIET
            ? `[watcher] QUIET mode: ${newEpisodes.length} rilis di-baseline tanpa notif`
            : `[watcher] cap harian tercapai (${notifCount}/${DAILY_NOTIF_CAP}): ${newEpisodes.length} rilis di-baseline tanpa notif`
        );
      }
      const staggerItems = [];
      const deferred = [];
      for (const c of newEpisodes) {
        const animeId = c.anime.animeId || c.anime.id;
        if (quiet) {
          // QUIET / cap harian: baseline + mark Firestore, TANPA kirim FCM
          maxByAnime[animeId] = { u: c.u || 0, e: c.ep };
          await markEpisodeNotified(animeId, c.ep).catch(() => {});
          continue;
        }
        if (staggerItems.length >= MAX_NOTIF_PER_TICK) {
          // cap total tick (anti lonjakan besar) — sisanya di-defer
          deferred.push(c);
          continue;
        }
        if (now - (lastNotified[animeId] || 0) < COOLDOWN_MS) {
          // baru saja dinotifikasi tick ini — tutup baseline, jangan notif ulang
          maxByAnime[animeId] = { u: c.u || 0, e: c.ep };
          continue;
        }
        // cek cooldown persistent (Firestore) — skip kalau sudah pernah di-notify
        if (await isEpisodeNotified(animeId, c.ep)) {
          lastNotified[animeId] = now;
          maxByAnime[animeId] = { u: c.u || 0, e: c.ep };
          continue;
        }
        // JANGAN set lastNotified di sini — biar tick berikutnya (kalau antrian
        // belum kelar) tetap kenal item ini via isEpisodeNotified/antrian.
        // Cooldown di-set tepat saat FCM dikirim (lihat scheduleStaggered).
        staggerItems.push({
          animeId,
          ep: c.ep,
          title: c.anime.title || animeId,
          poster: c.anime.poster || "",
          slug: animeId,
        });
        maxByAnime[animeId] = { u: c.u || 0, e: c.ep };
      }
      if (staggerItems.length > 0) {
        for (const it of staggerItems) {
          console.log(`[watcher] Episode baru: ${cleanTitle(it.title)} EP ${it.ep}`);
        }
        if (quiet) {
          // double-check: kalau QUIET aktif setelah loop, jangan kirim
          for (const it of staggerItems) {
            await markEpisodeNotified(it.animeId, it.ep).catch(() => {});
          }
          console.log(`[watcher] QUIET: ${staggerItems.length} rilis di-baseline tanpa notif`);
        } else {
          // PENTING (anti double-notif): catat ke Firestore DULU (await),
          // baru kirim FCM. Kalau urutannya kebalik dan proses restart / tick
          // berikutnya jalan sebelum log kestore, episode yang sama bisa
          // terkirim 2x (persis bug double notif).
          await Promise.allSettled(staggerItems.map((it) => markEpisodeNotified(it.animeId, it.ep)));
          // baru kirim — staggered, fire-and-forget biar tick cepat selesai
          scheduleStaggered(staggerItems, users, tokens);
          bumpNotifCount(staggerItems.length);
          console.log(`[watcher] notif hari ini: ${notifCount}/${DAILY_NOTIF_CAP}`);
        }
      } else {
        console.log(`[watcher] tidak ada rilis baru yg perlu di-notify (${newEpisodes.length} kandidat, semua di-cooldown)`);
      }
      if (deferred.length > 0) {
        console.log(
          `[watcher] ${deferred.length} rilis di-defer ke tick berikutnya (maks ${MAX_NOTIF_PER_TICK}/tick)`
        );
        // tetap update baseline supaya tidak spam log di tick berikut (akan
        // di-skip oleh cooldown Firestore kalau ada)
        for (const c of deferred) {
          const animeId = c.anime.animeId || c.anime.id;
          maxByAnime[animeId] = { u: c.u || 0, e: c.ep };
        }
      }
    } else {
      console.log(
        `[watcher] tidak ada rilis baru terdeteksi dari jadwal (${newEpisodes.length})`
      );
    }

    baselineDone = true;
    await saveSnapshot();
    await heartbeat(null);
  } catch (e) {
    console.error("[watcher] tick error:", e.message);
    await heartbeat(String(e?.message || "error"));
    throw e;
  } finally {
    ticking = false;
  }
}

// deteksi rilis dari /schedule. Semua anime jadwal DICEK jumlah episode-nya
// tiap tick (backend/local, murah) — nggak bergantung pada perubahan field
// `updated` yang sering stale. Notif hanya kalau:
//   - episode benar-benar naik (ep > prevE), DAN
//   - rilisnya baru (updated ≤ RECENT_MS) ATAU masih dalam window 7 hari
//     dengan lompatan kecil (≤ 2 ep, antisipasi double upload / updated lama).
// Rilis lama setelah watcher mati lama → cukup di-baseline diam-diam
// (update snapshot tanpa FCM) biar nggak jadi rombongan notif.
// MAX_NOTIF_PER_TICK jadi pengaman terakhir di tick().
async function collectScheduleReleases(scheduleMap, now, newEpisodes, ongoingSlugs) {
  const FRESH_MS = 7 * 24 * 3600 * 1000;
  const MAX_JUMP = 2;
  const entries = Object.entries(scheduleMap);
  let i = 0;
  const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (i < entries.length) {
      const [slug, sched] = entries[i++];
      await checkScheduleAnime(slug, sched, now, newEpisodes, FRESH_MS, MAX_JUMP, ongoingSlugs);
    }
  });
  await Promise.all(workers);
}

async function checkScheduleAnime(slug, sched, now, newEpisodes, FRESH_MS, MAX_JUMP, ongoingSlugs) {
  try {
    let s = sched.canonical || slug;
    let schedUpdated = Number(sched.updated || 0);
    if (!Number.isFinite(schedUpdated) || schedUpdated <= 0) schedUpdated = Math.floor(now / 1000);

    let ep = await fetchEpisodeCount(s);
    if (!(ep > 0) && !sched.canonical) {
      // slug jadwal mungkin bukan slug yang dikenal series.php → resolve dulu
      const r = await resolveCanonicalSlug(slug, sched.title);
      if (r && r !== s) {
        sched.canonical = r;
        s = r;
        ep = await fetchEpisodeCount(r);
      }
    }
    if (!(ep > 0)) return;

    // FILTER ONGOING: skip anime yang sudah finished/Completed. Kalau daftar
    // ongoing kosong (cache belum ready) → fallback allow (tidak skip).
    if (ongoingSlugs && ongoingSlugs.size > 0 && !ongoingSlugs.has(s)) {
      // update baseline supaya tidak di-cek lagi (selama tidak ongoing)
      maxByAnime[s] = { u: schedUpdated, e: ep };
      return;
    }

    const prev = maxByAnime[s];
    const prevE = (prev && typeof prev === "object" ? prev.e : prev) || 0;
    const isFresh = now - schedUpdated * 1000 < FRESH_MS;
    const releasedRecently = now - schedUpdated * 1000 <= RECENT_MS;

    // anime baru (belum punya baseline sama sekali) → catat dulu, jangan notif
    if (prev === undefined) {
      maxByAnime[s] = { u: schedUpdated, e: ep };
      return;
    }

    if (ep > prevE) {
      const jump = ep - prevE;
      if (releasedRecently || (isFresh && jump <= MAX_JUMP)) {
        // kirim ke tick() — baseline di-update di sana setelah notif/defer
        newEpisodes.push({
          anime: { animeId: s, title: sched.title || s, poster: sched.poster || "" },
          ep,
          u: schedUpdated,
        });
        return;
      }
      console.log(
        `[watcher] baseline tanpa notif: ${s} EP ${prevE}→${ep} (catch-up lama, di-skip)`
      );
    }
    maxByAnime[s] = { u: schedUpdated, e: ep };
  } catch (e) {
    console.error(`[watcher] cek ${slug} gagal:`, e.message);
  }
}

// fallback deteksi dihapus: notif HANYA bersumber dari jadwal rilis
// (kebijakan: feed upload terbaru bisa berisi backlog/re-upload).

// ambil jumlah episode aktual dari detail series (backend cache 30 menit)
async function fetchEpisodeCount(slug) {
  try {
    const res = await fetch(`${API_BASE}/anime/${slug}${API_KEY_QS}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return 0;
    const d = await res.json();
    return Number(d.maxEpisode || d.totalEpisodes || 0);
  } catch {
    return 0;
  }
}

async function heartbeat(err) {
  try {
    await db.collection("_system").doc("watcher").set({
      lastTick: FieldValue.serverTimestamp(),
      lastError: err || null,
      episodeCount: Object.keys(maxByAnime).length,
    }, { merge: true });
  } catch {}
}

async function sendTest() {
  const users = await getAllUsers();
  const tokens = collectTokens(users);
  console.log(`[watcher] --test: ${users.length} user, ${tokens.length} token`);
  if (tokens.length === 0) return console.log("[watcher] belum ada token FCM terdaftar");
  const resp = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: "TsukiNime", body: "Notifikasi push berhasil dikirim." },
    android: { priority: "high", notification: { channelId: "episode_rilis" } },
    data: { test: "1" },
  });
  console.log(`[watcher] test terkirim: ${resp.successCount}/${resp.failureCount}`);
}

// test notif episode terakhir ASLI: ambil item teratas dari /watcher-feed
// (dengan poster + episode aktual), kirim lewat jalur notifyEpisode penuh.
async function sendTestLastEps() {
  const users = await getAllUsers();
  const tokens = collectTokens(users);
  let feed = [];
  try {
    const res = await fetch(`${API_BASE}/watcher-feed${API_KEY_QS}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) feed = await res.json();
  } catch {}
  const item = (Array.isArray(feed) ? feed : []).find((x) => x && x.animeId && Number(x.episode) > 0);
  if (!item) return console.log("[watcher] --test-eps gagal: feed kosong/tanpa episode");
  console.log(`[watcher] --test-eps: ${cleanTitle(item.title)} EP ${item.episode} (${users.length} user, ${tokens.length} token)`);
  await notifyEpisode(item, item.episode, users, tokens);
  console.log("[watcher] --test-eps selesai (FCM + notif in-app terkirim)");
}

// tes notif anime spesifik: ambil detail dari API, cek gate jadwal, lalu
// kirim lewat jalur notifyEpisode penuh. Nggak butuh lock, jadi bisa
// dijalankan walau watcher utama sedang jalan.
async function sendTestAnime(slug) {
  const users = await getAllUsers();
  const tokens = collectTokens(users);
  const scheduleMap = await getScheduleMap();
  const sched = scheduleMap?.[slug];
  let detail = {};
  try {
    const res = await fetch(`${API_BASE}/anime/${slug}${API_KEY_QS}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) detail = await res.json();
  } catch {}
  const title = cleanTitle(detail.title || sched?.title || slug);
  const poster = detail.poster || sched?.poster || "";
  const ep = Number(detail.totalEpisodes || 0);

  console.log(`[watcher] --test-anime=${slug}`);
  console.log(`  judul    : ${title}`);
  console.log(`  episode  : ${ep}`);
  console.log(`  jadwal   : ${sched ? sched.day + " (hari ini: " + wibDayName() + ")" : "TIDAK ADA di jadwal"}`);

  if (!sched) {
    return console.log("  → DILEWATI: tidak ada di jadwal rilis (sama seperti watcher biasa)");
  }
  if (!isScheduledRelease(slug, scheduleMap)) {
    return console.log("  → DILEWATI: rilis tidak sesuai jadwal (hari beda / updated lama)");
  }
  console.log(`  gate     : PASS → kirim notif (${users.length} user, ${tokens.length} token)`);
  await notifyEpisode({ animeId: slug, title, poster }, ep || 1, users, tokens);
  console.log("  selesai (FCM + notif in-app terkirim)");
}

// dry-run deteksi jadwal: jalankan logika deteksi TANPA kirim FCM & TANPA
// menulis snapshot. Opsional "poke:<slug>" utk mensimulasikan rilis baru
// (snapshot slug tsb di-turunkan di memori) biar bisa lihat notif bakal nyala.
async function sendTestScheduleDry(pokeSlug) {
  await loadRemoteSnapshot();
  const scheduleMap = await getScheduleMap();
  if (!scheduleMap) return console.log("[watcher] --dry-schedule gagal: jadwal tidak dimuat");
  if (pokeSlug) {
    const cur = await fetchEpisodeCount(pokeSlug);
    maxByAnime[pokeSlug] = { u: 0, e: Math.max(0, cur - 1) };
    console.log(`[watcher] --dry-schedule poke: ${pokeSlug} snapshot di-set ke EP ${Math.max(0, cur - 1)} (simulasi rilis baru)`);
  }
  const newEpisodes = [];
  const ongoingSlugs = await loadOngoingSlugs();
  await collectScheduleReleases(scheduleMap, Date.now(), newEpisodes, ongoingSlugs);
  if (newEpisodes.length === 0) {
    console.log("[watcher] dry-run: TIDAK ADA rilis baru dari jadwal");
  } else {
    for (const { anime, ep } of newEpisodes) {
      console.log(`[watcher] dry-run: AKAN NOTIF → ${cleanTitle(anime.title)} EP ${ep}`);
    }
  }
  console.log(`[watcher] dry-run selesai (${newEpisodes.length} notif, snapshot TIDAK diubah)`);
}

// helper: filter users ke 1 user spesifik. Untuk test mode supaya tidak
// ganggu user lain. Priority (yang pertama match dipakai):
//   1. toDoc  = Firestore docId (paling stabil & precise)
//   2. toEmail= exact email match
//   3. toUid  = users.uid field
//   4. toToken= cari user doc yang punya token FCM itu (exact match)
// toTokens = kalau true, return hanya token yg match toToken (bukan semua
// token user). Penting supaya kalau natshxml & iznatshi punya token sama,
// FCM tidak double-fire.
async function getTestUser({ toDoc, toEmail, toUid, toToken } = {}) {
  const all = await getAllUsers();
  if (!toDoc && !toEmail && !toUid && !toToken) return all;

  const match = (u) => {
    const d = u.data || {};
    if (toDoc && u.id === toDoc) return true;
    if (toEmail && String(d.email || "").toLowerCase() === toEmail.toLowerCase()) return true;
    if (toUid && (d.uid === toUid || u.id === toUid)) return true;
    if (toToken && Array.isArray(d.fcmTokens) && d.fcmTokens.includes(toToken)) return true;
    return false;
  };
  const found = all.find(match);
  if (!found) {
    console.log(`[watcher] --to-*: user TIDAK ditemukan (${all.length} user terdaftar, filter: doc=${toDoc || "-"} email=${toEmail || "-"} uid=${toUid || "-"} token=${toToken ? toToken.slice(0, 20) + "..." : "-"})`);
    return [];
  }
  const label = found.data?.email || found.id;
  console.log(`[watcher] --to-*: kirim HANYA ke ${found.id} (${label})`);
  if (toToken && Array.isArray(found.data.fcmTokens) && found.data.fcmTokens.includes(toToken)) {
    // restrict user object ke 1 token saja (no double-fire kalau token
    // juga tersimpan di user doc lain)
    return [{ id: found.id, data: { ...found.data, fcmTokens: [toToken] } }];
  }
  return [found];
}

// test mode STAGGERED: ambil N item dari /watcher-feed, kirim via
// scheduleStaggered — verifikasi flow notif per-anime dgn jeda STAGGER_MS.
// Optional: kirim HANYA ke 1 user (--to-me=email|uid) supaya tidak spam user lain.
async function sendTestStaggered(count = 3, opts = {}) {
  // Default ke TEST_TO_DOC / TEST_TO_EMAIL / TEST_TO_TOKEN env. Prioritas:
  // DOC > EMAIL > TOKEN (semua opt-in; kalau env set, otomatis scope test).
  const toDoc = opts.toDoc || process.env.TEST_TO_DOC || null;
  const toEmail = opts.toEmail || process.env.TEST_TO_EMAIL || null;
  const toToken = opts.toToken || process.env.TEST_TO_TOKEN || null;
  const users = await getTestUser({ toDoc, toEmail, toToken });
  if (users.length === 0) return console.log("[watcher] --test-staggered: tidak ada user target");
  const tokens = collectTokens(users);
  let feed = [];
  try {
    const res = await fetch(`${API_BASE}/watcher-feed${API_KEY_QS}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) feed = await res.json();
  } catch {}
  const items = (Array.isArray(feed) ? feed : [])
    .filter((x) => x && x.animeId && Number(x.episode) > 0 && x.title)
    .slice(0, count)
    .map((x) => ({
      animeId: x.animeId,
      ep: Number(x.episode),
      title: x.title,
      poster: x.poster || "",
      slug: x.animeId,
    }));
  if (items.length === 0) return console.log("[watcher] --test-staggered: feed kosong/tanpa episode");
  console.log(`[watcher] --test-staggered: ${items.length} item (${users.length} user, ${tokens.length} token)`);
  for (const it of items) console.log(`  - ${cleanTitle(it.title)} EP ${it.ep}`);
  scheduleStaggered(items, users, tokens);
  // tunggu supaya setTimeout fire & log tercetak
  const waitMs = (items.length * STAGGER_MS) + 5000;
  await new Promise((r) => setTimeout(r, waitMs));
  console.log(`[watcher] --test-staggered selesai (antrian ${items.length} notif, total ${waitMs / 1000}s)`);
}

const testAnimeArg = process.argv.find((a) => a.startsWith("--test-anime="));
const dryScheduleArg = process.argv.find((a) => a.startsWith("--dry-schedule="));
const testStaggeredArg = process.argv.find((a) => a.startsWith("--test-staggered"));
if (dryScheduleArg) {
  const pokeSlug = dryScheduleArg.split("=")[1].replace(/^poke:/, "");
  sendTestScheduleDry(dryScheduleArg.split("=")[1].startsWith("poke:") ? pokeSlug : undefined)
    .then(() => process.exit(0));
} else if (process.argv.includes("--dry-schedule")) {
  sendTestScheduleDry().then(() => process.exit(0));
} else if (testAnimeArg) {
  const slug = testAnimeArg.split("=")[1];
  if (!slug) {
    console.log("[watcher] pakai: node watcher.js --test-anime=<slug> (contoh: --test-anime=mao-sub-indo)");
    process.exit(1);
  }
  sendTestAnime(slug).then(() => process.exit(0));
} else if (process.argv.includes("--test-eps")) {
  sendTestLastEps().then(() => process.exit(0));
} else if (testStaggeredArg) {
  const n = parseInt(testStaggeredArg.split("=")[1] || "3", 10) || 3;
  // support beberapa flag scoping: --to-doc=UID, --to-email=ADDR, --to-token=TOKEN
  // (CLI override ENV). ENV default: TEST_TO_DOC, TEST_TO_EMAIL, TEST_TO_TOKEN.
  const getArg = (k) => {
    const a = process.argv.find((x) => x.startsWith(`${k}=`));
    return a ? a.split("=").slice(1).join("=") : null;
  };
  const opts = {
    toDoc: getArg("--to-doc"),
    toEmail: getArg("--to-email"),
    toToken: getArg("--to-token"),
  };
  sendTestStaggered(n, opts).then(() => process.exit(0));
} else if (process.argv.includes("--test")) {
  sendTest().then(() => process.exit(0));
} else {
  console.log(`[watcher] mulai. Polling tiap ${POLL_MS / 60000} menit`);
  // Retry tick awal dengan backoff — di Railway app.js & watcher.js start barengan,
  // jadi API bisa belum siap saat tick pertama
  async function startWithRetry(attempt = 1) {
    try {
      await loadRemoteSnapshot();
      await tick();
      setInterval(tick, POLL_MS);
      console.log("[watcher] tick pertama sukses, interval terjadwal");
    } catch (e) {
      const wait = Math.min(5000 * attempt, 30000);
      console.log(`[watcher] tick awal gagal (${e.message}), retry dalam ${wait / 1000}s (${attempt}/6)`);
      if (attempt >= 6) {
        console.log("[watcher] terlalu banyak gagal, lanjut polling tiap 30 detik");
        setInterval(tick, 30000);
        return;
      }
      setTimeout(() => startWithRetry(attempt + 1), wait);
    }
  }
  startWithRetry();
}
