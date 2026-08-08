// watcher.js — pantau episode baru dari API, kirim FCM push + simpan notif in-app
// jalan: node watcher.js  (opsional: node watcher.js --test utk kirim notif tes)
// Notif HANYA dikirim untuk anime yang ada di JADWAL RILIS (/schedule) dan
// rilisnya sesuai jadwal (hari rilis / updated terbaru) — bukan asal lihat
// "latest episode" di feed (itu bisa re-upload/backlog → notif gak akurat).
const { initializeApp, cert } = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT = path.join(__dirname, "service-account.json");
const SNAPSHOT_FILE = path.join(__dirname, "data", "lastEpisodes.json");
const LOCK_FILE = path.join(__dirname, "data", "watcher.lock");
const API_BASE = process.env.TSUKI_API || `http://127.0.0.1:${process.env.PORT || 8000}`;
const POLL_MS = parseInt(process.env.WATCH_INTERVAL_MIN || "10", 10) * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;

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
  process.argv.some((a) => a.startsWith("--test-anime="));

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
      maxByAnime = snap.data().maxByAnime;
      snapshotLoadedFromRemote = true;
      baselineDone = true;
      console.log(`[watcher] snapshot Firestore dimuat (${Object.keys(maxByAnime).length} anime)`);
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

// nama hari WIB (UTC+7) — jadwal.php pakai hari Indonesia & zona WIB,
// jadi hitung lewat getUTCDay biar konsisten di server zona apapun.
function wibDayName() {
  const names = ["minggu", "senin", "selasa", "rabu", "kamis", "jumat", "sabtu"];
  return names[new Date(Date.now() + 7 * 3600 * 1000).getUTCDay()];
}

// map animeId -> { day, title, poster, updated } dari /schedule.
// return null kalau gagal (biar watcher fallback ke perilaku lama).
async function getScheduleMap() {
  try {
    const res = await fetch(`${API_BASE}/schedule`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`schedule ${res.status}`);
    const days = await res.json();
    if (!Array.isArray(days)) throw new Error("schedule bukan array");
    const map = {};
    for (const day of days) {
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
    const res = await fetch(`${API_BASE}/watcher-feed`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch {}
  const res = await fetch(`${API_BASE}/home`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return data?.recent || data?.ongoing?.animeList || [];
}

async function getAllUsers() {
  const snap = await db.collection("users").get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
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
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    try {
      const resp = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        android: { priority: "high", notification: { channelId: "episode_rilis" } },
        data: { animeId: String(animeId), url: link },
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

async function tick() {
  try {
    const recent = await getRecent();
    const users = await getAllUsers();
    const tokens = users.flatMap((u) => (Array.isArray(u.data.fcmTokens) ? u.data.fcmTokens : []));
    const now = Date.now();
    const scheduleMap = await getScheduleMap();
    const newEpisodes = [];

    for (const anime of recent) {
      const animeId = anime.animeId || anime.id;
      if (!animeId) continue;
      const ep = epNum(anime.episode || anime.episodes || anime.lastEpisode || "");
      const prevMax = maxByAnime[animeId] || 0;
      if (ep !== null && ep > prevMax) {
        if (prevMax > 0 || snapshotLoadedFromRemote) {
          if (isScheduledRelease(animeId, scheduleMap)) {
            newEpisodes.push({ anime, ep });
          } else {
            console.log(`[watcher] dilewati (tidak sesuai jadwal rilis): ${cleanTitle(anime.title)} EP ${ep}`);
          }
        }
        maxByAnime[animeId] = ep;
      } else if (ep !== null) {
        maxByAnime[animeId] = Math.max(prevMax, ep);
      }
    }

    if (newEpisodes.length > 0 && baselineDone) {
      for (const { anime, ep } of newEpisodes) {
        const animeId = anime.animeId || anime.id;
        if (now - (lastNotified[animeId] || 0) < COOLDOWN_MS) continue;
        lastNotified[animeId] = now;
        console.log(`[watcher] Episode baru terdeteksi: ${cleanTitle(anime.title)} EP ${ep}`);
        await notifyEpisode(anime, ep, users, tokens);
      }
    } else {
      console.log(`[watcher] baseline dicatat (${recent.length} item, ${newEpisodes.length} baru) — tidak ada notif`);
    }

    baselineDone = true;
    await saveSnapshot();
    await heartbeat(null);
  } catch (e) {
    console.error("[watcher] tick error:", e.message);
    await heartbeat(String(e?.message || "error"));
    throw e;
  }
}

// heartbeat: tulis status tiap tick ke Firestore biar bisa dicek dari luar
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
  const tokens = users.flatMap((u) => (Array.isArray(u.data.fcmTokens) ? u.data.fcmTokens : []));
  console.log(`[watcher] --test: ${users.length} user, ${tokens.length} token`);
  if (tokens.length === 0) return console.log("[watcher] belum ada token FCM terdaftar");
  const resp = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: "TsukiNime", body: "Notifikasi push jalan! 🔔" },
    android: { priority: "high", notification: { channelId: "episode_rilis" } },
    data: { test: "1" },
  });
  console.log(`[watcher] test terkirim: ${resp.successCount}/${resp.failureCount}`);
}

// test notif episode terakhir ASLI: ambil item teratas dari /watcher-feed
// (dengan poster + episode aktual), kirim lewat jalur notifyEpisode penuh.
async function sendTestLastEps() {
  const users = await getAllUsers();
  const tokens = users.flatMap((u) => (Array.isArray(u.data.fcmTokens) ? u.data.fcmTokens : []));
  let feed = [];
  try {
    const res = await fetch(`${API_BASE}/watcher-feed`, { signal: AbortSignal.timeout(30000) });
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
  const tokens = users.flatMap((u) => (Array.isArray(u.data.fcmTokens) ? u.data.fcmTokens : []));
  const scheduleMap = await getScheduleMap();
  const sched = scheduleMap?.[slug];
  let detail = {};
  try {
    const res = await fetch(`${API_BASE}/anime/${slug}`, { signal: AbortSignal.timeout(30000) });
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

const testAnimeArg = process.argv.find((a) => a.startsWith("--test-anime="));
if (testAnimeArg) {
  const slug = testAnimeArg.split("=")[1];
  if (!slug) {
    console.log("[watcher] pakai: node watcher.js --test-anime=<slug> (contoh: --test-anime=mao-sub-indo)");
    process.exit(1);
  }
  sendTestAnime(slug).then(() => process.exit(0));
} else if (process.argv.includes("--test-eps")) {
  sendTestLastEps().then(() => process.exit(0));
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
