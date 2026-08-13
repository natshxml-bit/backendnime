// seed_hd_posters.js — upgrade poster SEMUA anime ke versi HD (extraLarge).
//
// AniList cuma punya 4 ukuran cover (small/medium/large — dan "large" itu
// nilai dari coverImage.extraLarge, ukuran terbesar standar). Poster lama
// banyak yang URL-nya animekita/MAL ukuran kecil; yang bisa di-HD-kan adalah
// yang ID AniList-nya ketemu dari URL cover (pola bx<ID>- / anilist_<ID>).
//
// Script ini:
//   1. Baca katalog dari DB (fallback posterBySlug.json kalau DB kosong).
//   2. Kumpulkan ID AniList dari cover tiap anime.
//   3. Bulk-fetch coverImage.extraLarge (batch 50, delay aman + retry 429,
//      fallback ke worker Cloudflare kalau direct ke-blokir).
//   4. Tulis posterBySlug.json (semua slug yang dapat URL HD) +
//      merge anilistPosters.json.
//
// Idempoten: re-run aman, entry yang sudah HD tetap di-keep.
//
// Jalankan: node seed_hd_posters.js
// (setelah jalan, redeploy ke Railway biar JSON barunya ikut, atau tunggu
//  runtime nge-fetch otomatis via queueAnilistFetch.)

const fs = require("fs");
const path = require("path");
const db = require("./db/db");

const ANILIST_GRAPHQL = "https://graphql.anilist.co";
const POSTER_SLUG_FILE = path.join(__dirname, "posterBySlug.json");
const ANILIST_POSTER_FILE = path.join(__dirname, "anilistPosters.json");
const ID_BATCH = 50;
const ID_DELAY_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function anilistIdFromUrl(url) {
  const s = String(url || "");
  let m = s.match(/media\/anime\/cover\/[^/]+\/(?:bx|nx|b|n)(\d+)-/i);
  if (m) return m[1];
  m = s.match(/anilist[_-]?(\d+)/i);
  return m ? m[1] : null;
}

// Sudah HD kalau path-nya cover/large (extraLarge AniList) — yang lain kecil.
function isHd(url) {
  return /media\/anime\/cover\/(?:large|extraLarge|3x)\//i.test(String(url || ""));
}

function slugOf(url) {
  return String(url || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/,/g, "/");
}

// POST GraphQL ke AniList: coba langsung, fallback lewat worker Cloudflare
// (route /anilist) kalau direct kena 429/403/5xx atau error jaringan.
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

async function fetchHdByIds(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batchIds = ids.slice(i, i + ID_BATCH);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const query = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id coverImage{extraLarge}}}}`;
        const res = await anilistGraphql(
          JSON.stringify({ query, variables: { ids: batchIds.map(Number) } })
        );
        if (res && res.ok) {
          const json = await res.json();
          for (const m of json?.data?.Page?.media || []) {
            if (m?.coverImage?.extraLarge) out.set(String(m.id), m.coverImage.extraLarge);
          }
          ok = true;
        } else if (res && res.status === 429) {
          await sleep(5000 * (attempt + 1));
        }
      } catch {}
      if (!ok && attempt < 2) await sleep(2000);
    }
    if ((i / ID_BATCH) % 10 === 0) console.log(`[hd-posters] fetch batch ${i}/${ids.length}`);
    await sleep(ID_DELAY_MS);
  }
  return out;
}

(async () => {
  let bySlug = {};
  try {
    bySlug = JSON.parse(fs.readFileSync(POSTER_SLUG_FILE, "utf8")) || {};
  } catch {}
  let posters = {};
  try {
    posters = JSON.parse(fs.readFileSync(ANILIST_POSTER_FILE, "utf8")) || {};
  } catch {}

  // 1) Katalog dari DB (Neon), fallback ke posterBySlug.json.
  let flat = null;
  try {
    const rec = await db.get("catalog");
    if (rec && Array.isArray(rec.value)) flat = rec.value;
    else if (rec && rec.value && typeof rec.value === "object") {
      flat = Object.values(rec.value).flat().filter(Boolean);
    }
  } catch {}
  const slugId = new Map();
  if (Array.isArray(flat) && flat.length) {
    for (const it of flat) {
      const slug = slugOf(it.url || it.link || it.id);
      if (!slug) continue;
      const id = anilistIdFromUrl(it.cover || it.thumb);
      if (id && !slugId.has(slug)) slugId.set(slug, id);
    }
    console.log("[hd-posters] katalog:", flat.length, "| slug ber-ID:", slugId.size);
  } else {
    for (const [slug, url] of Object.entries(bySlug)) {
      const id = anilistIdFromUrl(url);
      if (id) slugId.set(slug, id);
    }
    console.log("[hd-posters] katalog kosong, pakai posterBySlug.json:", slugId.size);
  }

  // 2) Kumpulkan ID yang perlu di-refresh: slug ber-ID + map yang masih kecil.
  const need = new Set();
  for (const id of slugId.values()) need.add(id);
  for (const [id, url] of Object.entries(posters)) {
    if (!isHd(url)) need.add(id);
  }
  for (const [slug, url] of Object.entries(bySlug)) {
    const id = anilistIdFromUrl(url);
    if (id && !isHd(url)) need.add(id);
  }
  const ids = [...need];
  console.log("[hd-posters] id perlu HD:", ids.length, "| map id:", Object.keys(posters).length, "| slug:", Object.keys(bySlug).length);

  const hd = await fetchHdByIds(ids);
  console.log("[hd-posters] dapat extraLarge:", hd.size);

  let slugUpgraded = 0;
  let mapUpgraded = 0;
  for (const [slug, id] of slugId) {
    const hdUrl = hd.get(id);
    if (hdUrl && bySlug[slug] !== hdUrl) {
      bySlug[slug] = hdUrl;
      slugUpgraded++;
    }
  }
  for (const id of hd.keys()) {
    if (posters[id] !== hd.get(id)) {
      posters[id] = hd.get(id);
      mapUpgraded++;
    }
  }

  fs.writeFileSync(POSTER_SLUG_FILE, JSON.stringify(bySlug));
  fs.writeFileSync(ANILIST_POSTER_FILE, JSON.stringify(posters));
  console.log("SEED HD POSTERS DONE — slug di-upgrade:", slugUpgraded, "| map di-upgrade:", mapUpgraded);
  process.exit(0);
})().catch((e) => {
  console.error("SEED HD POSTERS ERR", e);
  process.exit(1);
});
