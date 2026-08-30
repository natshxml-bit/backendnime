const API_BASE = "https://apps.animekita.org/api/v1.2.5";
const UA = "Dart/2.19.6 (dart:io)";

const fs = require("fs");
const path = require("path");
const db = require("./db/db");
const STATUS_FILE = path.join(__dirname, "statuses.json");
const ANILIST_POSTER_FILE = path.join(__dirname, "anilistPosters.json");
const SLUG_POSTER_FILE = path.join(__dirname, "posterBySlug.json");
const SLUG_BANNER_FILE = path.join(__dirname, "bannerBySlug.json");
const ANILIST_GRAPHQL = "https://graphql.anilist.co";
const CRAWL_DELAY_MS = 180;
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

// POST GraphQL ke AniList: coba langsung dulu; kalau kena blokir/rate-limit
// (429/403/5xx) atau error jaringan, fallback lewat worker Cloudflare kalau
// env-nya di-set (ANILIST_PROXY_URL atau ANIMEKITA_PROXY_URL + PROXY_TOKEN).
function anilistProxyBase() {
  return (process.env.ANILIST_PROXY_URL || process.env.ANIMEKITA_PROXY_URL || "").replace(/\/+$/, "");
}
function anilistProxyToken() {
  return process.env.ANILIST_PROXY_TOKEN || process.env.PROXY_TOKEN || "";
}

async function anilistGraphql(body) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  try {
    const r = await fetch(ANILIST_GRAPHQL, { method: "POST", headers, body });
    if (r.ok) return r;
    if (r.status !== 429 && r.status !== 403 && r.status < 500) return r;
  } catch {}
  const base = anilistProxyBase();
  if (base) {
    try {
      const r = await fetch(base + "/anilist/graphql", {
        method: "POST",
        headers: { ...headers, "x-proxy-token": anilistProxyToken() },
        body,
      });
      if (r.ok) return r;
    } catch {}
  }
  return null;
}

let STATUS = {};
try {
  STATUS = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")) || {};
} catch {}

let POSTERS = {};
try {
  POSTERS = JSON.parse(fs.readFileSync(ANILIST_POSTER_FILE, "utf8")) || {};
} catch {}

let POSTER_BY_SLUG = {};
try {
  POSTER_BY_SLUG = JSON.parse(fs.readFileSync(SLUG_POSTER_FILE, "utf8")) || {};
} catch {}

// BANNER_BY_SLUG adalah cache in-memory; sumber kebenaran ada di DB (kv,
// key "banner:<slug>"). Diisi via initBanners() saat boot + queueBannerSearch.
let BANNER_BY_SLUG = {};

// Load semua banner per-slug: dari file bannerBySlug.json (fallback) +
// DB (sumber kebenaran; menang kalau key-nya ada). 1 query.
async function initBanners() {
  try {
    const fileMap = {};
    try {
      Object.assign(fileMap, JSON.parse(fs.readFileSync(SLUG_BANNER_FILE, "utf8")) || {});
    } catch {}
    const dbMap = (await db.getAllByPrefix("banner:%")) || {};
    BANNER_BY_SLUG = { ...fileMap, ...dbMap };
    console.log(`[banner] cache siap: ${Object.keys(BANNER_BY_SLUG).length} banner`);
  } catch (e) {
    console.error(`[banner] init gagal: ${e.message}`);
  }
}

// Simpan satu banner ke DB (upsert) + bannerBySlug.json biar tetap kebaca
// meski DB kosong (mis. instance tanpa seed).
async function persistBanner(slug, url) {
  try {
    await db.set(`banner:${slug}`, url);
    BANNER_BY_SLUG[slug] = url;
    fs.writeFileSync(SLUG_BANNER_FILE, JSON.stringify(BANNER_BY_SLUG));
  } catch (e) {
    console.error(`[banner] simpan gagal ${slug}: ${e.message}`);
  }
}

function saveStatuses() {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(STATUS));
  } catch {}
}

function savePosters() {
  try {
    fs.writeFileSync(ANILIST_POSTER_FILE, JSON.stringify(POSTERS));
  } catch {}
}

function saveSlugPosters() {
  try {
    fs.writeFileSync(SLUG_POSTER_FILE, JSON.stringify(POSTER_BY_SLUG));
  } catch {}
}

const ONGOING_RE = /ONGOING|SEDANG TAYANG|AIRING|ONGOING_ANIME/i;
const COMPLETED_RE = /SELESAI|TAMAT|COMPLETED|FINISHED|ENDED/i;

function statusOf(slug) {
  const entry = STATUS[normalizeSlug(slug)];
  return entry ? entry.s : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fullList() {
  const d = await cached("animeList:full", 15 * 60 * 1000, () =>
    apiGet("anime-list.php")
  );
  return Array.isArray(d) ? d : Object.values(d || {}).flat().filter(Boolean);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchSeriesStatus(slug) {
  const s = normalizeSlug(slug);
  let data = null;
  try {
    data = await apiGet("series.php", { url: s });
  } catch {}
  let series = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!series || !series.series_id) {
    try {
      data = await apiGet("series.php", { url: `${s}/` });
    } catch {}
    series = data && Array.isArray(data.data) ? data.data[0] : null;
  }
  return series;
}

async function crawlWorker() {
  try {
    const flat = await fullList();
    const now = Date.now();
    const todo = flat.filter((x) => {
      const slug = normalizeSlug(x.url || x.link || x.id);
      const entry = STATUS[slug];
      return !entry || now - entry.t > STATUS_TTL_MS;
    });
    if (todo.length === 0) return;
    let saved = 0;
    for (const item of todo) {
      const slug = normalizeSlug(item.url || item.link || item.id);
      try {
        const series = await fetchSeriesStatus(slug);
        if (series && series.status) {
          STATUS[slug] = {
            s: normalizeStatus(series.status),
            t: Date.now(),
            type: series.type || STATUS[slug]?.type || null,
            eps: Array.isArray(series.chapter) ? series.chapter.length : STATUS[slug]?.eps || null,
            rating: normalizeScore(series.rating),
          };
          if (++saved % 25 === 0) saveStatuses();
        }
      } catch {}
      await sleep(CRAWL_DELAY_MS);
    }
    saveStatuses();
  } catch {}
}

function startCrawler() {
  crawlWorker().then(() => setTimeout(startCrawler, 30 * 60 * 1000));
}

function isMovieStatus(entry) {
  return entry && String(entry.type || "").toLowerCase() === "movie";
}

async function statusList(type, page = 1) {
  const flat = await fullList();
  const re = type === "ongoing" ? ONGOING_RE : COMPLETED_RE;
  const known = flat.filter((x) => {
    const slug = normalizeSlug(x.url || x.link || x.id);
    const s = statusOf(slug);
    if (!s || !re.test(s)) return false;
    if (isMovieStatus(STATUS[slug])) return false;
    return true;
  });
  const start = (page - 1) * 30;
  const items = await Promise.all(known.slice(start, start + 30).map(cardFromListAsync));
  return listOf(type, page, items, known.length);
}

const RECOMMEND_KEYWORDS = ["action", "adventure", "comedy", "drama", "fantasy", "isekai", "romance", "horror", "sci-fi", "sports", "music", "military", "school", "supernatural", "thriller"];

async function recommendationPool() {
  return cached("reco:pool", 6 * 60 * 60 * 1000, async () => {
    const pool = [];
    for (const kw of RECOMMEND_KEYWORDS) {
      try {
        const res = await apiGet("search.php", { keyword: kw });
        const groups = Array.isArray(res.data) ? res.data : [];
        for (const g of groups) {
          for (const it of (g?.result || [])) pool.push(it);
        }
      } catch {}
      await sleep(300);
    }
    return pool;
  });
}

async function recommendations(limit = 12) {
  const pool = await recommendationPool();
  const seen = new Set();
  const out = [];
  for (const it of shuffle(pool)) {
    const slug = normalizeSlug(it.url || it.link);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      animeId: slug,
      title: it.judul || it.anime_name,
      poster: hdPoster(POSTER_BY_SLUG[slug]) || upscalePoster(it.cover || it.thumb),
      score: null,
      status: null,
      episode: episodeCount(it.total_episode) || episodeCount(it.lastch) || null,
      type: it.type || null,
      genres: Array.isArray(it.genre) ? it.genre : [],
      synopsis: it.sinopsis || null,
    });
    if (out.length >= limit) break;
  }
  return { animeList: out };
}

const resultCache = new Map();
const MAX_RESULT_CACHE = 300;

function cached(key, ttlMs, fn) {
  const hit = resultCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = Promise.resolve()
    .then(fn)
    .catch((e) => {
      resultCache.delete(key);
      throw e;
    });
  resultCache.set(key, { expires: Date.now() + ttlMs, value });
  if (resultCache.size > MAX_RESULT_CACHE) {
    resultCache.delete(resultCache.keys().next().value);
  }
  return value;
}

function parseApiBody(text, path) {
  const start = text.search(/[\[{]/);
  if (start >= 0) {
    const open = text[start];
    const close = open === "[" ? "]" : "}";
    const end = text.lastIndexOf(close);
    if (end > start) text = text.slice(start, end + 1);
  }
  const json = JSON.parse(text);
  if (json && typeof json === "object" && json.error) {
    throw new Error(json.error);
  }
  return json;
}

function apiUrl(base, path, params) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/+$/, "") + "/" + path;
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function apiGet(path, params = {}) {
  // Sumber fetch:
  // 1) ANIMEKITA_PROXY_URL (Cloudflare Worker, IP CF) — jalur utama, dipakai sync di Railway.
  // 2) Direct ke apps.animekita.org — cadangan kalau worker error.
  // (Relay Termux/cloudflared sudah dipensiunkan — lihat git history cutover.)
  const headers = { "User-Agent": UA, Accept: "application/json" };

  if (process.env.ANIMEKITA_PROXY_URL) {
    try {
      if (process.env.ANIMEKITA_PROXY_TOKEN) {
        headers["x-proxy-token"] = process.env.ANIMEKITA_PROXY_TOKEN;
      }
      const url = new URL(process.env.ANIMEKITA_PROXY_URL);
      const apiPath = new URL(API_BASE).pathname;
      url.pathname = (url.pathname.replace(/\/+$/, "") + apiPath + "/" + path).replace(/\/{2,}/g, "/");
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== "") url.searchParams.set(k, String(v));
      }
      const res = await fetch(url.toString(), { headers });
      if (res.ok) return parseApiBody(await res.text(), path);
      console.warn(`[apiGet] proxy worker ${res.status}, fallback direct: ${path}`);
    } catch (e) {
      console.warn(`[apiGet] proxy worker error, fallback direct: ${e.message}`);
    }
  }

  const res = await fetch(apiUrl(API_BASE, path, params), { headers });
  if (!res.ok) throw new Error(`animekita api ${res.status}: ${path}`);
  return parseApiBody(await res.text(), path);
}

function normalizeSlug(slug) {
  return String(slug || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/,/g, "/");
}

function anilistIdFromUrl(url) {
  const s = String(url || "");
  let m = s.match(/media\/anime\/cover\/[^/]+\/(?:bx|nx|b|n)(\d+)-/i);
  if (m) return m[1];
  m = s.match(/anilist[_-]?(\d+)/i);
  return m ? m[1] : null;
}

function upscalePoster(url) {
  if (!url) return url;
  const id = anilistIdFromUrl(url);
  if (id && POSTERS[String(id)]) return POSTERS[String(id)];
  let out = String(url).replace(/^https?:\/\/i\d?\.wp\.com\//, "https://");
  out = out.replace(/[?&](?:w|resize)=\d+(?:,\d+)?/g, "");
  if (id) queueAnilistFetch(id);
  return out || url;
}

// Versi paling tajam untuk URL poster AniList: kalau ID-nya ketemu di map
// POSTERS (hasil coverImage.extraLarge), pakai itu. Kalau gak ada, URL asli
// dibiarkan (bukan rewrite path, karena ukuran lain di CDN punya hash beda).
function hdPoster(url) {
  if (!url) return url;
  const id = anilistIdFromUrl(url);
  if (!id) return url;
  const hd = POSTERS[String(id)];
  return hd && hd !== url ? hd : url;
}

const anilistQueue = [];
const anilistFetched = new Set();
let anilistRunning = false;

function queueAnilistFetch(id) {
  if (!id || anilistFetched.has(id)) return;
  anilistFetched.add(id);
  anilistQueue.push(id);
  runAnilistQueue();
}

async function fetchAnilistByIds(ids) {
  try {
    const query = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id coverImage{extraLarge}}}}`;
    const res = await anilistGraphql(
      JSON.stringify({ query, variables: { ids: ids.map(Number) } })
    );
    if (!res || !res.ok) return;
    const json = await res.json();
    const media = json?.data?.Page?.media || [];
    let changed = false;
    for (const m of media) {
      if (m?.coverImage?.extraLarge) {
        POSTERS[String(m.id)] = m.coverImage.extraLarge;
        changed = true;
      }
    }
    if (changed) savePosters();
  } catch {}
}

// Bersihkan judul biar match AniList: buang "Subtitle Indonesia", "Sub Indo",
// marker Episode/Season, dan teks dalam kurung.
function cleanTitle(t) {
  let s = String(t || "");
  s = s.replace(/subtitle\s*indonesia|sub\s*indo|subtitle|sub\s*(?:id|indo)?/gi, " ");
  s = s.replace(/\(episode[^)]*\)/gi, " ");
  s = s.replace(/episode\s*\d+/gi, " ");
  s = s.replace(/season\s*\d+/gi, " ");
  s = s.replace(/[\(\[][^)\]]*[\)\]]/g, " ");
  s = s.replace(/[-_]\s*(?:movie|special|ova|ona|part\s*\d+|full)\s*$/i, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

async function anilistSearchPoster(title) {
  const t = cleanTitle(title);
  if (!t) return null;
  try {
    const query = `query($t:String){Page(perPage:3){media(search:$t,type:ANIME){id title{romaji english} coverImage{extraLarge}}}}`;
    const res = await anilistGraphql(
      JSON.stringify({ query, variables: { t: String(t).slice(0, 60) } })
    );
    if (!res || !res.ok) return null;
    const json = await res.json();
    const m = json?.data?.Page?.media || [];
    for (const cand of m) {
      if (cand?.coverImage?.extraLarge) return cand.coverImage.extraLarge;
    }
    return null;
  } catch {
    return null;
  }
}

async function anilistSearchBanner(title) {
  const t = cleanTitle(title);
  if (!t) return null;
  try {
    const query = `query($t:String){Page(perPage:10){media(search:$t,type:ANIME){id bannerImage coverImage{extraLarge} title{romaji english native}}}}`;
    const res = await anilistGraphql(
      JSON.stringify({ query, variables: { t: String(t).slice(0, 60) } })
    );
    if (!res || !res.ok) return null;
    const json = await res.json();
    const m = json?.data?.Page?.media || [];
    for (const cand of m) {
      if (!cand?.bannerImage) continue;
      const candTitle = cand.title?.romaji || cand.title?.english || cand.title?.native || "";
      if (titleMatches(t, candTitle)) return cand.bannerImage;
    }
    return null;
  } catch {
    return null;
  }
}

// Normalisasi judul buat pembandingan (huruf kecil, tanda baca dibuang).
function normTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Cek kecocokan query vs kandidat biar banner TIDAK salah pasang ke anime lain.
function titleMatches(q, cand) {
  const a = normTitle(q);
  const b = normTitle(cand);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const qw = a.split(" ").filter(Boolean);
  const cw = b.split(" ").filter(Boolean);
  if (qw.length >= 2) {
    const same = qw.filter((w) => w.length > 2 && cw.includes(w)).length;
    if (same >= Math.min(2, qw.length)) return true;
  }
  return false;
}

const bannerSearchQueue = [];
const bannerSearched = new Set();
let bannerSearchRunning = false;

function queueBannerSearch(title, slug) {
  if (!title || !slug || bannerSearched.has(slug)) return;
  bannerSearched.add(slug);
  bannerSearchQueue.push({ title, slug });
  runBannerSearchQueue();
}

async function runBannerSearchQueue() {
  if (bannerSearchRunning) return;
  bannerSearchRunning = true;
  while (bannerSearchQueue.length) {
    const batch = [];
    while (bannerSearchQueue.length && batch.length < 3) batch.push(bannerSearchQueue.shift());
    await Promise.all(batch.map(async ({ title, slug }) => {
      const url = await anilistSearchBanner(title);
      if (url && !BANNER_BY_SLUG[slug]) {
        BANNER_BY_SLUG[slug] = url;
        await persistBanner(slug, url);
      }
    }));
    await sleep(800);
  }
  bannerSearchRunning = false;
}

function getBannerFor(slug) {
  return BANNER_BY_SLUG[normalizeSlug(slug)] || null;
}

const titleSearchQueue = [];
const titleSearched = new Set();
let titleSearchRunning = false;

function queueTitleSearch(title, slug) {
  if (!title || !slug || titleSearched.has(slug)) return;
  titleSearched.add(slug);
  titleSearchQueue.push({ title, slug });
  runTitleSearchQueue();
}

async function runTitleSearchQueue() {
  if (titleSearchRunning) return;
  titleSearchRunning = true;
  while (titleSearchQueue.length) {
    const batch = [];
    while (titleSearchQueue.length && batch.length < 3) batch.push(titleSearchQueue.shift());
    await Promise.all(batch.map(async ({ title, slug }) => {
      const url = await anilistSearchPoster(title);
      if (url && !POSTER_BY_SLUG[slug]) {
        POSTER_BY_SLUG[slug] = url;
        saveSlugPosters();
      }
    }));
    await sleep(800);
  }
  titleSearchRunning = false;
}

async function verifyCovers() {
  try {
    const flat = await fullList();
    let checked = 0;
    for (const it of flat) {
      const slug = normalizeSlug(it.url || it.link || it.id);
      const cover = it.cover || it.thumb || "";
      if (!cover) continue;
      const id = anilistIdFromUrl(cover);
      if (id && POSTERS[String(id)]) continue;
      const direct = upscalePoster(cover);
      if (!direct) continue;
      if (/myanimelist\.net|s4\.anilist\.co|anilist\.co/.test(direct)) continue;
      let alive = false;
      try {
        const res = await fetch(direct, {
          headers: { "User-Agent": UA, Range: "bytes=0-0" },
          redirect: "follow",
        });
        alive = res.ok || res.status === 206;
      } catch {}
      if (alive) {
        if (POSTER_BY_SLUG[slug]) continue;
        continue;
      }
      if (POSTER_BY_SLUG[slug]) continue;
      const url = await anilistSearchPoster(it.judul || it.anime_name || it.name);
      if (url && !POSTER_BY_SLUG[slug]) {
        POSTER_BY_SLUG[slug] = url;
        saveSlugPosters();
      }
      checked++;
      await sleep(150);
    }
    console.log(`[anilist] cover verify done (${checked} broken rescued)`);
  } catch {}
}

async function runAnilistQueue() {
  if (anilistRunning) return;
  anilistRunning = true;
  while (anilistQueue.length) {
    const batch = [];
    while (anilistQueue.length && batch.length < 40) batch.push(anilistQueue.shift());
    await fetchAnilistByIds(batch);
    await sleep(700);
  }
  anilistRunning = false;
}

async function fillPosterCache() {
  try {
    const flat = await fullList();
    const need = new Set();
    for (const it of flat) {
      const id = anilistIdFromUrl(it.cover || it.thumb);
      if (id && !POSTERS[String(id)]) need.add(String(id));
    }
    const ids = [...need];
    for (let i = 0; i < ids.length; i += 40) {
      await fetchAnilistByIds(ids.slice(i, i + 40));
      await sleep(700);
    }
    console.log(`[anilist] poster cache ready (${ids.length} fetched)`);
    verifyCovers().then(() => {});
  } catch {}
}

function startPosterCrawler() {
  fillPosterCache().then(() => setTimeout(startPosterCrawler, 6 * 60 * 60 * 1000));
}

function cardFromList(it) {
  const slug = normalizeSlug(it.url || it.link) || it.id;
  const cover = it.cover || it.thumb;
  let poster = hdPoster(POSTER_BY_SLUG[slug]) || upscalePoster(cover);
  if (!POSTER_BY_SLUG[slug] && cover && /otakudesu\.blog/i.test(cover)) {
    queueTitleSearch(it.judul || it.anime_name || it.name, slug);
  }
  const st = STATUS[slug];
  return {
    animeId: slug,
    title: it.judul || it.anime_name || it.name,
    poster,
    score: st?.rating || null,
    status: st?.s || it.status || null,
    type: st?.type || it.type || null,
    episode: episodeCount(it.total_episode) || episodeCount(it.lastch) || st?.eps || it.episode || null,
    quality: null,
    genres: Array.isArray(it.genre) ? it.genre : [],
  };
}

// Versi async: lengkapi kartu dengan metadata dari cache detail `anime:<slug>`
// (shape animeDetail: synopsis/genres/score; fallback shape raw animekita:
// sinopsis/genre/rating — dua-duanya bisa muncul). Kalau detail belum ada,
// kartu tetap normal; nanti keisi otomatis saat halaman detail dibuka.
async function cardFromListAsync(it) {
  const card = cardFromList(it);
  const slug = card.animeId;
  if (!slug) return card;
  try {
    const rec = await db.get(`anime:${slug}`);
    const d = rec && rec.value;
    if (!d) return card;
    const syn = d.synopsis || d.sinopsis;
    if (!card.synopsis && syn) {
      const s = String(syn).trim();
      card.synopsis = s.length > 500 ? s.slice(0, 500) + "…" : s || null;
    }
    const gs = Array.isArray(d.genres) ? d.genres : Array.isArray(d.genre) ? d.genre : [];
    if ((!card.genres || card.genres.length === 0) && gs.length) {
      card.genres = gs.slice(0, 8);
    }
    const sc = normalizeScore(d.score) || normalizeScore(d.rating);
    if (!card.score && sc) card.score = sc;
    if (!card.status && d.status) card.status = normalizeStatus(d.status);
    if (!card.type && d.type) card.type = d.type;
    const eps = episodeCount(d.totalEpisodes) || episodeCount(d.total_episode) || episodeCount(d.episode);
    if (!card.episode && eps) card.episode = eps;
  } catch {}
  return card;
}

// Jumlah episode sesungguhnya ada di `total_episode` (angka); `lastch` di animekita
// sering string kosong/"Episode X" dan gak ada field `episode`. Normalisasi ke Int.
function episodeCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeStatus(status) {
  if (!status) return "Ongoing";
  const s = String(status).toUpperCase();
  if (/SELESAI|TAMAT|COMPLETED|FINISHED|ENDED/.test(s)) return "Completed";
  if (/SEDANG TAYANG|ONGOING|AIRING/.test(s)) return "Ongoing";
  return status;
}

function normalizeScore(r) {
  const s = String(r || "").replace(/[^\d.]/g, "");
  return s || null;
}

async function getSeries(slug) {
  const s = normalizeSlug(slug);
  const d = await cached(`series:${s}`, 30 * 60 * 1000, async () => {
    let res = await apiGet("series.php", { url: s });
    let data = Array.isArray(res.data) ? res.data[0] : null;
    if (!data || !data.series_id) {
      res = await apiGet("series.php", { url: `${s}/` });
      data = Array.isArray(res.data) ? res.data[0] : null;
    }
    if (!data || !data.series_id) throw new Error(`series tidak ditemukan: ${slug}`);
    return data;
  });
  return d;
}

async function getEpisodeData(epUrl) {
  return cached(`epdata:${epUrl}`, 30 * 60 * 1000, async () => {
    let data = null;
    try {
      data = await apiGet("series/episode/data.php", { url: epUrl });
    } catch {}
    let ep = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!ep || !ep.episode_id) {
      try {
        data = await apiGet("series/episode/data.php", { url: `${epUrl}/` });
      } catch {}
      ep = data && Array.isArray(data.data) ? data.data[0] : null;
    }
    if (!ep || !ep.episode_id) throw new Error(`episode tidak ditemukan: ${epUrl}`);
    return ep;
  });
}

async function enrichMissingRatings(items) {
  const missing = items.filter((it) => it.score == null && it.animeId);
  if (missing.length === 0) return;
  await Promise.all(
    missing.map(async (it) => {
      try {
        const series = await fetchSeriesStatus(it.animeId);
        if (series) {
          const rating = normalizeScore(series.rating);
          if (rating) {
            it.score = rating;
            const slug = normalizeSlug(it.animeId);
            if (slug) {
              STATUS[slug] = {
                ...(STATUS[slug] || {}),
                s: normalizeStatus(series.status || STATUS[slug]?.s),
                t: Date.now(),
                type: series.type || STATUS[slug]?.type || null,
                eps: Array.isArray(series.chapter) ? series.chapter.length : STATUS[slug]?.eps || null,
                rating,
              };
            }
          }
        }
      } catch {}
    })
  );
}

function refreshHomeRatings(home) {
  const patch = (items) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      const slug = normalizeSlug(it?.animeId);
      if (!slug) continue;
      const st = STATUS[slug];
      if (st?.rating) it.score = st.rating;
      if (st?.s) it.status = st.s;
      if (st?.type) it.type = st.type;
    }
  };
  patch(home.recent);
  patch(home.ongoing?.animeList);
  patch(home.completed?.animeList);
  patch(home.film?.animeList);
}

async function home() {
  const [uploads, movie] = await Promise.all([
    cached("home:uploads", 5 * 60 * 1000, () => apiGet("baruupload.php", { page: 1 })),
    cached("home:movie", 10 * 60 * 1000, () => apiGet("movie.php")),
  ]);
  const recent = (Array.isArray(uploads) ? uploads : []).map(async (c) => {
    const item = {
      ...(await cardFromListAsync(c)),
      status: "Ongoing",
      genres: Array.isArray(c.genre) ? c.genre : [],
      synopsis: c.sinopsis || null,
    };
    const slug = item.animeId;
    const cachedBanner = BANNER_BY_SLUG[slug];
    if (cachedBanner) item.banner = cachedBanner;
    else queueBannerSearch(item.title, slug);
    return item;
  });
  const ongoingList = (await statusList("ongoing", 1)).animeList.slice(0, 10);
  const completedList = (await statusList("completed", 1)).animeList.slice(0, 10);
  const movieList = await Promise.all((Array.isArray(movie) ? movie : []).map(cardFromListAsync));

  const allItems = [...(await Promise.all(recent)), ...ongoingList, ...completedList, ...movieList];
  await enrichMissingRatings(allItems);

  return {
    recent: await Promise.all(recent),
    ongoing: { animeList: ongoingList },
    completed: { animeList: completedList },
    film: { animeList: movieList },
  };
}

// Feed khusus watcher: kartu baruupload DIENRICH dengan jumlah chapter
// AKTUAL dari series detail (cache pendek 5 mnt) — kartu baruupload sendiri
// tidak pernah berisi nomor episode, jadi tanpa ini watcher tidak bisa
// mendeteksi episode baru sama sekali.
async function recentDetailed() {
  const uploads = await cached("home:uploads", 5 * 60 * 1000, () =>
    apiGet("baruupload.php", { page: 1 })
  );
  const items = Array.isArray(uploads) ? uploads : [];
  const out = [];
  const jobs = items.map(async (c) => {
    const slug = normalizeSlug(c.url || c.link || c.id);
    if (!slug) return;
    let episode = 0;
    try {
      const d = await cached(`watchseries:${slug}`, 5 * 60 * 1000, async () => {
        let res = await apiGet("series.php", { url: slug });
        let data = Array.isArray(res.data) ? res.data[0] : null;
        if (!data || !data.series_id) {
          res = await apiGet("series.php", { url: `${slug}/` });
          data = Array.isArray(res.data) ? res.data[0] : null;
        }
        if (!data || !data.series_id) throw new Error("series tidak ditemukan");
        return data;
      });
      const chapters = Array.isArray(d.chapter) ? d.chapter : [];
      for (const ch of chapters) {
        const m = String(ch.ch || "").match(/\d+/);
        if (m) episode = Math.max(episode, parseInt(m[0], 10));
      }
    } catch {}
    out.push({
      animeId: slug,
      title: c.judul || c.anime_name || c.name || slug,
      poster: c.cover || c.thumb || "",
      episode,
    });
  });
  await Promise.allSettled(jobs);
  return out;
}

async function scheduleDayFor(slug) {
  try {
    const days = await schedule();
    for (const day of days) {
      for (const a of day.anime_list || []) {
        if (normalizeSlug(a.animeId) === slug) {
          const d = String(day.day || "");
          return d ? d.charAt(0).toUpperCase() + d.slice(1) : null;
        }
      }
    }
  } catch {}
  return null;
}

async function animeDetail(ref) {
  const slug = normalizeSlug(ref);
  const d = await getSeries(slug);
  let chapters = Array.isArray(d.chapter) ? d.chapter : [];
  if (slug === "mushoku-ni-tensei-s3-sub-indo" && chapters.length === 9) {
    const last = chapters[chapters.length - 1];
    const base = String(last.url || "").replace(/-9\/?$/, "-10");
    const url10 = base.includes("-10") ? base : `${slug}-episode-10`;
    chapters = [...chapters, { url: url10, ch: "10", date: null, views: null }];
  }
  const episodeList = chapters
    .map((c) => ({
      episodeId: c.url,
      endpoint: c.url,
      title: `Episode ${String(c.ch).split(" ")[0]}`,
      date: c.date || null,
      views: c.views || null,
      thumbnail: null,
    }))
    .reverse();
  const basePoster = upscalePoster(d.cover);
  const views = chapters.reduce((s, c) => s + (Number(c.views) || 0), 0) || null;
  const status = normalizeStatus(d.status);
  return {
    animeId: d.series_id || slug,
    title: d.judul,
    altTitle: null,
    poster: hdPoster(POSTER_BY_SLUG[slug]) || basePoster,
    banner: BANNER_BY_SLUG[slug] || hdPoster(POSTER_BY_SLUG[slug]) || basePoster,
    score: normalizeScore(d.rating),
    status,
    scheduleDay: status === "Ongoing" ? await scheduleDayFor(slug) : null,
    views,
    subscribers: null,
    type: d.type || null,
    synopsis: d.sinopsis || "",
    genres: Array.isArray(d.genre) ? d.genre : [],
    released: d.published || null,
    author: d.author || null,
    totalEpisodes: episodeList.length,
    episodeList,
    minEpisode: 0,
    maxEpisode: episodeList.length,
  };
}

async function schedule() {
  const d = await cached("schedule", 10 * 60 * 1000, () => apiGet("jadwal.php"));
  const days = Array.isArray(d.data) ? d.data : [];
  return days.map((day) => ({
    day: String(day.day || "").toLowerCase(),
    date: day.date || null,
    date_ts: day.date_ts || null,
    anime_list: (Array.isArray(day.animeList) ? day.animeList : []).map((a) => ({
      animeId: normalizeSlug(a.link) || a.id,
      title: a.anime_name,
      poster: a.cover || "",
      episode: null,
      day: String(day.day || "").toLowerCase(),
      status: null,
      updated: a.updated || null,
      genres: [],
    })),
  }));
}

const GENRES = [
  ["Action", "action"], ["Adventure", "adventure"], ["Comedy", "comedy"],
  ["Dementia", "dementia"], ["Demons", "demons"], ["Drama", "drama"], ["Ecchi", "ecchi"],
  ["Fantasy", "fantasy"], ["Game", "game"], ["Harem", "harem"],
  ["Historical", "historical"], ["Horror", "horror"], ["Isekai", "isekai"], ["Josei", "josei"],
  ["Kids", "kids"], ["Magic", "magic"], ["Martial Arts", "martial-arts"], ["Mecha", "mecha"],
  ["Military", "military"], ["Music", "music"], ["Mystery", "mystery"], ["Psychological", "psychological"],
  ["Romance", "romance"], ["Samurai", "samurai"], ["School", "school"], ["Sci-Fi", "sci-fi"],
  ["Seinen", "seinen"], ["Shoujo", "shoujo"], ["Shounen", "shounen"],
  ["Space", "space"], ["Sports", "sports"], ["Supernatural", "supernatural"],
  ["Thriller", "thriller"], ["Vampire", "vampire"],
];

async function genres() {
  return GENRES.map(([title, endpoint]) => ({ title, endpoint }));
}

function listOf(type, page, items, total) {
  return {
    type,
    page,
    animeList: items,
    pagination: null,
    has_next: total > page * 30,
    next_page: total > page * 30 ? page + 1 : null,
  };
}

async function ongoing(page = 1) {
  return statusList("ongoing", page);
}

async function complete(page = 1) {
  return statusList("completed", page);
}

async function listByType(type, page = 1) {
  if (type === "movie") {
    const d = await cached("movie", 10 * 60 * 1000, () => apiGet("movie.php"));
    const items = await Promise.all((Array.isArray(d) ? d : []).map(cardFromListAsync));
    return listOf("movie", page, items, items.length);
  }
  const d = await cached(`animeList:${page}`, 15 * 60 * 1000, () =>
    apiGet("anime-list.php", { page })
  );
  const flat = Array.isArray(d)
    ? d
    : Object.values(d || {}).flat().filter(Boolean);
  const start = (page - 1) * 30;

  if (type === "donghua") {
    const items = await Promise.all(
      flat
        .filter((x) => {
          const slug = normalizeSlug(x.url || x.link || x.id);
          return String(STATUS[slug]?.type || "").toLowerCase() === "donghua";
        })
        .map(cardFromListAsync)
    );
    return listOf("donghua", page, items.slice(start, start + 30), items.length);
  }

  if (type === "upcoming") {
    const items = await Promise.all(
      flat
        .filter((x) => {
          const slug = normalizeSlug(x.url || x.link || x.id);
          const s = STATUS[slug]?.s || "";
          if (/UPCOMING|PENGUMUMAN/i.test(s)) {
            const title = String(x.title || x.judul || x.anime_name || x.name || "");
            if (/takedown|\[info\]/i.test(title)) return false;
            return true;
          }
          return false;
        })
        .map(cardFromListAsync)
    );
    return listOf("upcoming", page, items.slice(start, start + 30), items.length);
  }

  if (type === "all") {
    // Gabungan ongoing + completed + movie + donghua (buang None/Pengumuman),
    // diacak deterministik biar tiap halaman campur rata.
    const items = await Promise.all(
      flat
        .filter((x) => {
          const slug = normalizeSlug(x.url || x.link || x.id);
          const t = String(STATUS[slug]?.type || "").toLowerCase();
          const s = String(STATUS[slug]?.s || "");
          return t && t !== "none" && !/PENGUMUMAN/i.test(s);
        })
        .sort((a, b) => {
          const ha = hash32(normalizeSlug(a.url || a.link || a.id));
          const hb = hash32(normalizeSlug(b.url || b.link || b.id));
          return ha - hb;
        })
        .map(cardFromListAsync)
    );
    return listOf("all", page, items.slice(start, start + 30), items.length);
  }

  return listOf(type, page, (await Promise.all(flat.slice(start, start + 30).map(cardFromListAsync))), flat.length);
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function byGenre(slug, page = 1) {
  const d = await cached(`genre:${slug}:${page}`, 10 * 60 * 1000, () =>
    apiGet("genreseries.php", { url: slug, page })
  );
  const items = await Promise.all(
    (Array.isArray(d) ? d : []).map(async (c) => ({
      ...(await cardFromListAsync(c)),
      genres: Array.isArray(c.genre) ? c.genre : [],
    }))
  );
  return {
    genre: slug,
    page,
    genreList: items,
    animeList: items,
    has_next: items.length >= 25,
    next_page: items.length >= 25 ? page + 1 : null,
  };
}

async function searchQuery(q) {
  const d = await cached(`search:${q}`, 10 * 60 * 1000, () =>
    apiGet("search.php", { keyword: q })
  );
  const result = Array.isArray(d.data) ? d.data[0] : null;
  const items = await Promise.all(
    ((result && result.result) || []).map(async (c) => ({
      ...(await cardFromListAsync(c)),
      genres: Array.isArray(c.genre) ? c.genre : [],
      synopsis: c.sinopsis || null,
    }))
  );
  return { query: q, animeList: items, results: items };
}

function formatSize(kb) {
  const n = Number(kb);
  if (!n || n <= 0) return null;
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} GB`;
  if (n >= 1024) return `${Math.round(n / 1024)} MB`;
  return `${Math.round(n)} KB`;
}

function qualityFromStreams(streams, resoSize) {
  const groups = new Map();
  for (const reso of Object.keys(streams || {})) {
    const links = Array.isArray(streams[reso]) ? streams[reso] : [];
    for (const s of links) {
      if (!s.link) continue;
      const label = s.reso || reso;
      if (!groups.has(label)) groups.set(label, []);
      const fallback = resoSize && (resoSize[label] || resoSize[reso]);
      groups.get(label).push({
        url: s.link,
        quality: label,
        size: formatSize(s.size_kb) || (typeof fallback === "string" ? fallback : null),
      });
    }
  }
  const qualities = [];
  for (const [label, links] of groups) {
    qualities.push({
      title: label,
      serverList: links.map((l, i) => ({
        title: links.length > 1 ? `Mirror ${i + 1}` : label,
        url: l.url,
        quality: l.quality,
        size: l.size,
      })),
    });
  }
  return qualities.sort((a, b) => {
    const ra = parseInt(String(a.title), 10) || 0;
    const rb = parseInt(String(b.title), 10) || 0;
    return rb - ra;
  });
}

async function episode(slug) {
  const epUrl = normalizeSlug(slug);
  const data = await getEpisodeData(epUrl);
  if (!data || !data.streams) throw new Error(`episode tidak ditemukan: ${epUrl}`);
  const qualities = qualityFromStreams(data.streams, data.resoSize);
  // JANGan verifikasi dari server — headCheck memakai IP datacenter (Railway)
  // dan ditolak upstream. URL mentah dikembalikan; device user yang memutar
  // (IP user). Lihat BACKEND_STREAMING_FIX.md.
  const direct = qualities.length ? qualities[0].serverList[0].url : null;
  return {
    episodeId: epUrl,
    title: `Episode ${epUrl}`,
    animeTitle: null,
    defaultStreamingUrl: direct,
    streamUrl: direct,
    server: null,
    servers: qualities.map((q) => ({
      server: q.title,
      qualities: q.serverList.map((sv) => ({ quality: sv.quality, url: sv.url })),
    })),
  };
}

const HEAD_TIMEOUT = 4000;

function headCheck(url) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT);
    fetch(url, {
      method: "HEAD",
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
        Referer: "https://animekita.org/",
        Accept: "*/*",
      },
    })
      .then((res) => {
        clearTimeout(timer);
        const ct = String(res.headers.get("content-type") || "");
        const ok = res.ok && ct && !/^application\/json/i.test(ct);
        resolve(ok);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
}

async function verifyStreams(qualities) {
  const jobs = [];
  for (const q of qualities) {
    for (const sv of q.serverList) {
      jobs.push({ q, sv, done: headCheck(sv.url).then((ok) => ({ ok, sv, q })) });
    }
  }
  const results = await Promise.all(jobs.map((j) => j.done));
  const dead = new Set(results.filter((r) => !r.ok).map((r) => r.sv.url));
  const out = qualities
    .map((q) => {
      const alive = q.serverList.filter((sv) => !dead.has(sv.url));
      if (alive.length === 0) {
        // Semua mirror mati: jaga satu supaya Player tetap punya sumber untuk fallback
        return { ...q, serverList: q.serverList.slice(0, 1) };
      }
      return { ...q, serverList: alive };
    })
    .filter((q) => q.serverList.length > 0);
  return out;
}

module.exports = {
  API_BASE,
  UA,
  home,
  animeDetail,
  schedule,
  genres,
  ongoing,
  cardFromList,
  cardFromListAsync,
  complete,
  listByType,
  byGenre,
  searchQuery,
  episode,
  recommendations,
  apiGet,
  startCrawler,
  startPosterCrawler,
  fullList,
  verifyCovers,
  anilistSearchPoster,
  getBannerFor,
  queueBannerSearch,
  initBanners,
  persistBanner,
  statusCounts: () => {
    let ongoing = 0, completed = 0;
    for (const k of Object.keys(STATUS)) {
      if (ONGOING_RE.test(STATUS[k].s)) ongoing++;
      else if (COMPLETED_RE.test(STATUS[k].s)) completed++;
    }
    return { known: Object.keys(STATUS).length, ongoing, completed };
  },
  normalizeStatus,
  animePathFromUrl: (url) => url,
  parseRef: (ref) => ({ id: normalizeSlug(ref), slug: normalizeSlug(ref) }),
  parseEpisodeRef: (ref) => ({ id: null, slug: null, ep: normalizeSlug(ref) }),
  recentDetailed,
  refreshHomeRatings,
};
