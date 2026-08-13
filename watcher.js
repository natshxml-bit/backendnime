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
// notif hanya untuk rilis yang updated-nya ≤ RECENT_HOURS jam terakhir (anti
// "rombongan": catch-up setelah watcher mati/restart cukup di-baseline diam-diam)
const RECENT_MS = parseInt(process.env.WATCH_RECENT_HOURS || "48", 10) * 3600 * 1000;
// maks notif per tick — sisanya di-defer ke tick berikutnya (anti spam massal)
const MAX_NOTIF_PER_TICK = parseInt(process.env.WATCH_MAX_PER_TICK || "5", 10);

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
  process.argv.includes("--dry-schedule") ||
  process.argv.some((a) => a.startsWith("--test-anime=")) ||
  process.argv.some((a) => a.startsWith("--dry-schedule="));

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
        notification: {
          title,
          body,
          ...(poster ? { image: poster } : {}),
        },
        android: { priority: "high", notification: { channelId: "episode_rilis" } },
        data: { animeId: String(animeId), url: link, poster: poster || "" },
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

let ticking = false;
async function tick() {
  if (ticking) return; // cegah tick bertumpuk (tick lama belum selesai)
  ticking = true;
  try {
    const users = await getAllUsers();
    const tokens = collectTokens(users);
    await cleanupTokenJunk(users);
    const now = Date.now();
    const scheduleMap = await getScheduleMap();
    const newEpisodes = [];

    // DETEKSI: jalur utama pakai jadwal (updated + jumlah episode aktual).
    // Kalau jadwal gagal dimuat, fallback ke /watcher-feed biar notif tetap jalan.
    if (scheduleMap) await collectScheduleReleases(scheduleMap, now, newEpisodes);
    else await collectFeedReleases(now, newEpisodes);

    if (newEpisodes.length > 0 && baselineDone) {
      let sent = 0;
      let deferred = 0;
      for (const c of newEpisodes) {
        const animeId = c.anime.animeId || c.anime.id;
        if (sent >= MAX_NOTIF_PER_TICK) {
          // defer: baseline TIDAK di-update → terdeteksi lagi tick berikutnya
          deferred++;
          continue;
        }
        if (now - (lastNotified[animeId] || 0) < COOLDOWN_MS) {
          // baru saja dinotifikasi (cooldown) — tutup baseline, jangan notif ulang
          maxByAnime[animeId] = { u: c.u || 0, e: c.ep };
          continue;
        }
        lastNotified[animeId] = now;
        sent++;
        console.log(
          `[watcher] Episode baru terdeteksi: ${cleanTitle(c.anime.title)} EP ${c.ep}`
        );
        await notifyEpisode(c.anime, c.ep, users, tokens);
        maxByAnime[animeId] = { u: c.u || 0, e: c.ep };
      }
      if (deferred > 0) {
        console.log(
          `[watcher] ${deferred} rilis di-defer ke tick berikutnya (maks ${MAX_NOTIF_PER_TICK}/tick)`
        );
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
async function collectScheduleReleases(scheduleMap, now, newEpisodes) {
  const FRESH_MS = 7 * 24 * 3600 * 1000;
  const MAX_JUMP = 2;
  const entries = Object.entries(scheduleMap);
  let i = 0;
  const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (i < entries.length) {
      const [slug, sched] = entries[i++];
      await checkScheduleAnime(slug, sched, now, newEpisodes, FRESH_MS, MAX_JUMP);
    }
  });
  await Promise.all(workers);
}

async function checkScheduleAnime(slug, sched, now, newEpisodes, FRESH_MS, MAX_JUMP) {
  try {
    let schedUpdated = Number(sched.updated || 0);
    if (!Number.isFinite(schedUpdated) || schedUpdated <= 0) schedUpdated = Math.floor(now / 1000);
    const prev = maxByAnime[slug];
    const prevE = (prev && typeof prev === "object" ? prev.e : prev) || 0;
    const isFresh = now - schedUpdated * 1000 < FRESH_MS;
    const releasedRecently = now - schedUpdated * 1000 <= RECENT_MS;

    // anime baru (belum punya baseline sama sekali) → catat dulu, jangan notif
    if (prev === undefined) {
      const ep = await fetchEpisodeCount(slug);
      if (ep > 0) maxByAnime[slug] = { u: schedUpdated, e: ep };
      return;
    }

    const ep = await fetchEpisodeCount(slug);
    if (!(ep > 0)) return;

    if (ep > prevE) {
      const jump = ep - prevE;
      if (releasedRecently || (isFresh && jump <= MAX_JUMP)) {
        // kirim ke tick() — baseline di-update di sana setelah notif/defer
        newEpisodes.push({
          anime: { animeId: slug, title: sched.title || slug, poster: sched.poster || "" },
          ep,
          u: schedUpdated,
        });
        return;
      }
      console.log(
        `[watcher] baseline tanpa notif: ${slug} EP ${prevE}→${ep} (catch-up lama, di-skip)`
      );
    }
    maxByAnime[slug] = { u: schedUpdated, e: ep };
  } catch (e) {
    console.error(`[watcher] cek ${slug} gagal:`, e.message);
  }
}

// fallback kalau jadwal gagal dimuat: deteksi lewat /watcher-feed (upload
// terbaru + episode aktual). Tidak ada timestamp di feed, jadi cukup andalkan
// kenaikan episode + cap MAX_NOTIF_PER_TICK di tick().
async function collectFeedReleases(now, newEpisodes) {
  let feed = [];
  try {
    const res = await fetch(`${API_BASE}/watcher-feed`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) feed = await res.json();
  } catch {}
  if (!Array.isArray(feed) || feed.length === 0) {
    console.log("[watcher] jadwal & feed gagal dimuat — deteksi dilewati tick ini");
    return;
  }
  for (const it of feed) {
    const slug = it.animeId || it.slug;
    const ep = Number(it.episode || it.maxEpisode || 0);
    if (!slug || !(ep > 0)) continue;
    const prev = maxByAnime[slug];
    const prevE = (prev && typeof prev === "object" ? prev.e : prev) || 0;
    if (prevE === 0) {
      maxByAnime[slug] = { e: ep };
      continue;
    }
    if (ep > prevE) {
      newEpisodes.push({
        anime: { animeId: slug, title: it.title || slug, poster: it.poster || "" },
        ep,
        u: (prev && typeof prev === "object" ? prev.u : 0) || 0,
      });
    } else {
      maxByAnime[slug] = { e: ep };
    }
  }
  console.log(`[watcher] fallback feed: ${newEpisodes.length} rilis baru (jadwal tidak tersedia)`);
}

// ambil jumlah episode aktual dari detail series (backend cache 30 menit)
async function fetchEpisodeCount(slug) {
  try {
    const res = await fetch(`${API_BASE}/anime/${slug}`, { signal: AbortSignal.timeout(20000) });
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
  const tokens = collectTokens(users);
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
  const tokens = collectTokens(users);
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
  await collectScheduleReleases(scheduleMap, Date.now(), newEpisodes);
  if (newEpisodes.length === 0) {
    console.log("[watcher] dry-run: TIDAK ADA rilis baru dari jadwal");
  } else {
    for (const { anime, ep } of newEpisodes) {
      console.log(`[watcher] dry-run: AKAN NOTIF → ${cleanTitle(anime.title)} EP ${ep}`);
    }
  }
  console.log(`[watcher] dry-run selesai (${newEpisodes.length} notif, snapshot TIDAK diubah)`);
}

const testAnimeArg = process.argv.find((a) => a.startsWith("--test-anime="));
const dryScheduleArg = process.argv.find((a) => a.startsWith("--dry-schedule="));
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
