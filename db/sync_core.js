// db/sync_core.js — logika sinkronisasi data dari animekita ke database
// sendiri (SQLite). HANYA boleh dijalankan dari IP rumah/ISP karena
// animekita memblokir IP datacenter (Railway, proxy, dll).
//
// Dipakai oleh:
//   - db/sync.js  (CLI: node db/sync.js --all)
//   - app.js      (auto-sync berkala saat AUTO_SYNC_HOURS di-set)

const adapter = require("../adapter");
const db = require("./db");

const LIST_TYPES = ["ongoing", "finished", "movie", "all", "upcoming", "donghua", "anime"];

async function syncHome() {
  console.time("[sync] home");
  const data = await adapter.home();
  await db.set("home", data);
  console.timeEnd("[sync] home");
  return { recent: (data.recent || []).length };
}

async function syncCatalog() {
  console.time("[sync] catalog");
  const items = await adapter.fullList();
  await db.set("catalog", items);
  console.timeEnd("[sync] catalog");
  return { count: Array.isArray(items) ? items.length : 0 };
}

async function syncSchedule() {
  console.time("[sync] schedule");
  const data = await adapter.schedule();
  await db.set("schedule", data);
  console.timeEnd("[sync] schedule");
  return { days: Array.isArray(data) ? data.length : 0 };
}

function recentSlugs(home) {
  const out = [];
  for (const sec of ["recent", "ongoing", "completed", "film"]) {
    const list =
      home && home[sec]
        ? Array.isArray(home[sec])
          ? home[sec]
          : home[sec].animeList || []
        : [];
    for (const it of list) {
      if (it && it.animeId && !out.includes(it.animeId)) out.push(it.animeId);
    }
  }
  return out;
}

async function syncDetails(count) {
  const home = await db.get("home");
  if (!home) {
    console.log("[sync] home kosong, sync home dulu sebelum --details");
    return { ok: 0 };
  }
  const slugs = recentSlugs(home.value).slice(0, count);
  let ok = 0;
  for (const slug of slugs) {
    try {
      console.time(`[sync] anime:${slug}`);
      const detail = await adapter.animeDetail(slug);
      await db.set(`anime:${slug}`, detail);
      console.timeEnd(`[sync] anime:${slug}`);
      ok++;
    } catch (e) {
      console.log(`[sync] anime:${slug} GAGAL: ${e.message}`);
    }
  }
  return { ok, total: slugs.length };
}

// Sync detail anime yang statusnya ongoing (sedang tayang).
// cap = jumlah maksimal (0 = semua).
async function syncOngoing(cap) {
  const slugs = [];
  let page = 1;
  while (page <= 50) {
    const r = await adapter.ongoing(page);
    const list = (r && r.animeList) || [];
    for (const it of list) {
      if (it && it.animeId && !slugs.includes(it.animeId)) slugs.push(it.animeId);
    }
    if (!r || !r.has_next) break;
    page++;
  }
  if (cap > 0) slugs.length = Math.min(slugs.length, cap);
  let ok = 0;
  for (const slug of slugs) {
    try {
      console.time(`[sync] anime:${slug}`);
      const detail = await adapter.animeDetail(slug);
      await db.set(`anime:${slug}`, detail);
      console.timeEnd(`[sync] anime:${slug}`);
      ok++;
    } catch (e) {
      console.log(`[sync] anime:${slug} GAGAL: ${e.message}`);
    }
  }
  return { ok, total: slugs.length };
}

async function syncEpisodes(per) {
  const rows = await db.keysLike("anime:%");
  const episodes = [];
  for (const key of rows) {
    const rec = await db.get(key);
    const list = rec && rec.value && Array.isArray(rec.value.episodeList) ? rec.value.episodeList : [];
    // episodeList berurutan lama→baru, ambil yang TERBARU dari belakang
    const take = per === 0 ? list : list.slice(-per);
    for (const ep of take) {
      if (ep && ep.endpoint && !episodes.includes(ep.endpoint)) episodes.push(ep.endpoint);
    }
  }
  let ok = 0;
  for (const epUrl of episodes) {
    try {
      console.time(`[sync] ep:${epUrl}`);
      const data = await adapter.episode(epUrl);
      await db.set(`ep:${epUrl}`, data);
      console.timeEnd(`[sync] ep:${epUrl}`);
      ok++;
    } catch (e) {
      console.log(`[sync] ep:${epUrl} GAGAL: ${e.message}`);
    }
  }
  return { ok, total: episodes.length };
}

async function syncGenres(pages) {
  const data = await adapter.genres();
  await db.set("genres", data);
  const list = Array.isArray(data) ? data : [];
  let genreOk = 0;
  let genreTotal = 0;
  for (const g of list) {
    const slug = g && (g.endpoint || g.slug || g.title);
    if (!slug) continue;
    for (let p = 1; p <= pages; p++) {
      genreTotal++;
      try {
        console.time(`[sync] genre:${slug}:${p}`);
        const pageData = await adapter.byGenre(slug, p);
        await db.set(`genre:${slug}:${p}`, pageData);
        console.timeEnd(`[sync] genre:${slug}:${p}`);
        genreOk++;
      } catch (e) {
        console.log(`[sync] genre:${slug}:${p} GAGAL: ${e.message}`);
      }
    }
  }
  return { count: list.length, pages: genreOk, total: genreTotal };
}

async function syncLists(pages) {
  let ok = 0;
  let total = 0;
  for (const type of LIST_TYPES) {
    for (let p = 1; p <= pages; p++) {
      total++;
      try {
        console.time(`[sync] list:${type}:${p}`);
        const data =
          type === "ongoing"
            ? await adapter.ongoing(p)
            : type === "finished"
              ? await adapter.complete(p)
              : await adapter.listByType(type, p);
        await db.set(`list:${type}:${p}`, data);
        console.timeEnd(`[sync] list:${type}:${p}`);
        ok++;
      } catch (e) {
        console.log(`[sync] list:${type}:${p} GAGAL: ${e.message}`);
      }
    }
  }
  return { ok, total };
}

// Jalankan sinkronisasi sesuai opsi; kembalikan ringkasan.
async function runSync(opts) {
  const O = opts || {};
  console.log(`[sync] DB: ${db.DB_PATH}`);
  const summary = { startedAt: new Date().toISOString() };
  if (O.home) summary.home = await syncHome();
  if (O.schedule) summary.schedule = await syncSchedule();
  if (O.catalog) summary.catalog = await syncCatalog();
  if (O.details > 0) summary.details = await syncDetails(O.details);
  if (O.ongoing) summary.ongoing = await syncOngoing(O.ongoing < 0 ? 0 : O.ongoing);
  if (O.syncEpisodes && (O.details > 0 || O.ongoing)) {
    summary.episodes = await syncEpisodes(O.episodesPer);
  }
  if (O.lists > 0) summary.lists = await syncLists(O.lists);
  if (O.genres) summary.genres = await syncGenres(O.genrePages);
  summary.finishedAt = new Date().toISOString();
  summary.counts = await db.counts();
  await db.set("sync:last", summary);
  console.log("[sync] selesai:", JSON.stringify(summary));
  return summary;
}

module.exports = { runSync, syncHome, syncSchedule, syncCatalog, syncDetails, syncOngoing, syncEpisodes, syncLists, syncGenres };
