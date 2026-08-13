// seed_banners.js — isi banner HD per slug ke DATABASE (kv, key "banner:<slug>")
// dari AniList bannerImage, mirip cara posterBySlug.json diisi poster.
//
// Sumber ID AniList: cover katalog (format "cover/large/bx<ID>-...") +
// value posterBySlug.json + pola "anilist_<ID>". Slug tanpa ID dicari lewat
// judul yang sudah dibersihkan (fallback, batch 3).
//
// Bisa jalan di Termux maupun Railway (AniList tidak memblokir IP datacenter).
// Di Railway katalog dibaca dari DB dulu, fallback fullList via proxy worker.
// Hasil langsung masuk Neon → otomatis ke-read semua instance backend.
// Re-run aman: slug yang sudah punya banner di-skip.
//
// Jalankan: node seed_banners.js

const fs = require("fs");
const path = require("path");
const db = require("./db/db");
const adapter = require("./adapter");

const ANILIST_GRAPHQL = "https://graphql.anilist.co";
const POSTER_SLUG_FILE = path.join(__dirname, "posterBySlug.json");
const ID_BATCH = 50;
const ID_DELAY_MS = 700;
const TITLE_BATCH = 3;
const TITLE_DELAY_MS = 2000;
const WRITE_CONCURRENCY = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function slugOf(url) {
  return String(url || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/,/g, "/");
}

// Dua pola ID AniList yang muncul di URL cover/poster:
//   media/anime/cover/large/bx177175-...   (CDN anilist)
//   .../anilist_177175/... atau anilist177175
function anilistIdFromUrl(url) {
  const s = String(url || "");
  let m = s.match(/media\/anime\/cover\/[^/]+\/(?:bx|nx|b|n)(\d+)-/i);
  if (m) return m[1];
  m = s.match(/anilist[_-]?(\d+)/i);
  return m ? m[1] : null;
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

async function fetchBannersByIds(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batchIds = ids.slice(i, i + ID_BATCH);
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const query = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id bannerImage}}}`;
        const res = await anilistGraphql(
          JSON.stringify({ query, variables: { ids: batchIds.map(Number) } })
        );
        if (res && res.ok) {
          const json = await res.json();
          for (const m of json?.data?.Page?.media || []) {
            if (m?.bannerImage) out.set(String(m.id), m.bannerImage);
          }
          ok = true;
        }
      } catch {}
      if (!ok && attempt === 0) await sleep(2000);
    }
    if ((i / ID_BATCH) % 20 === 0) console.log(`[banner] fetch ID batch ${i}/${ids.length}`);
    await sleep(ID_DELAY_MS);
  }
  return out;
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

// Cari banner by title dengan 1-2 percobaan: judul penuh dulu; kalau tidak ada
// kandidat yang judulnya cocok, coba judul tanpa kata terakhir (sering nambah
// hit-rate untuk judul yang kebanyakan kata). Semua hasil difilter titleMatches
// biar gak salah pasang.
async function searchBannerByTitle(title) {
  const t = cleanTitle(title);
  if (!t) return null;
  const words = t.split(" ");
  const variants = [t];
  if (words.length > 2) variants.push(words.slice(0, -1).join(" "));
  if (words.length > 3) variants.push(words.slice(0, -2).join(" "));

  let lastError = null;
  for (const v of variants) {
    try {
      const query = `query($t:String){Page(perPage:10){media(search:$t,type:ANIME){id bannerImage title{romaji english native}}}}`;
      const res = await anilistGraphql(
        JSON.stringify({ query, variables: { t: String(v).slice(0, 60) } })
      );
      if (!res || !res.ok) {
        lastError = res ? res.status : "network";
        continue;
      }
      const json = await res.json();
      for (const cand of json?.data?.Page?.media || []) {
        if (!cand?.bannerImage) continue;
        const candTitle = cand.title?.romaji || cand.title?.english || cand.title?.native || "";
        if (titleMatches(t, candTitle)) return cand.bannerImage;
      }
    } catch (e) {
      lastError = e.message;
    }
  }
  if (lastError && String(lastError).startsWith("429")) return "RATE_LIMIT";
  return null;
}

async function writeBanners(entries) {
  let done = 0;
  async function worker() {
    while (entries.length) {
      const { slug, url } = entries.shift();
      try {
        await db.set(`banner:${slug}`, url);
        done++;
        if (done % 100 === 0) console.log(`[banner] tersimpan ${done}`);
      } catch (e) {
        console.error(`[banner] simpan gagal ${slug}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: WRITE_CONCURRENCY }, worker));
  return done;
}

(async () => {
  // 1) Katalog: dari DB dulu, fallback fullList live.
  let flat = null;
  const rec = await db.get("catalog");
  if (rec && Array.isArray(rec.value)) flat = rec.value;
  else if (rec && rec.value && typeof rec.value === "object") {
    flat = Object.values(rec.value).flat().filter(Boolean);
  }
  if (!flat) {
    console.log("[banner] katalog DB kosong, fallback fullList live");
    flat = await adapter.fullList();
  }
  console.log("[banner] katalog:", flat.length);

  const slugTitle = {};
  const slugId = new Map();
  for (const it of flat) {
    const slug = slugOf(it.url || it.link || it.id);
    if (!slug) continue;
    if (!slugTitle[slug]) slugTitle[slug] = it.judul || it.anime_name || it.name || "";
    const id = anilistIdFromUrl(it.cover || it.thumb);
    if (id && !slugId.has(slug)) slugId.set(slug, id);
  }

  // 2) Tambahan ID dari posterBySlug.json (value-nya URL anilist "bx<ID>-").
  try {
    const posters = JSON.parse(fs.readFileSync(POSTER_SLUG_FILE, "utf8")) || {};
    for (const [slug, url] of Object.entries(posters)) {
      const id = anilistIdFromUrl(url);
      if (id && !slugId.has(slug)) slugId.set(slug, id);
    }
  } catch {}

  // 4) Bulk fetch bannerImage by ID. Untuk slug ber-ID banner pasti akurat,
  //    jadi SELALU ditimpa (memperbaiki data salah dari run sebelumnya).
  const ids = [...new Set(slugId.values())];
  console.log("[banner] id unik:", ids.length);
  const bannerById = await fetchBannersByIds(ids);

  const byIdEntries = [];
  for (const [slug, id] of slugId) {
    const url = bannerById.get(id);
    if (url) byIdEntries.push({ slug, url });
  }
  console.log("[banner] dapat dari ID:", byIdEntries.length);
  await writeBanners(byIdEntries);

  // 5) Fallback title search (dengan guard kecocokan judul biar akurat) utk
  //    SEMUA slug katalog tanpa ID yang BELUM punya banner. Yang sudah ada
  //    banner gak ditimpa — hanya menambal yang kosong.
  const existing = await db.getAllByPrefix("banner:%");
  console.log("[banner] sudah ada di DB:", Object.keys(existing).length);
  const done = new Set(byIdEntries.map((e) => e.slug));
  const missing = [];
  for (const [slug, title] of Object.entries(slugTitle)) {
    if (existing[slug] || done.has(slug)) continue;
    if (slugId.has(slug)) continue;
    const ct = cleanTitle(title);
    if (ct) missing.push({ slug, title: ct });
  }

  console.log("[banner] fallback title:", missing.length);
  let titleFound = 0;
  let searched = 0;
  while (missing.length) {
    const batch = [];
    while (missing.length && batch.length < TITLE_BATCH) batch.push(missing.shift());
    const results = await Promise.all(batch.map(async ({ slug, title }) => ({
      slug,
      title,
      url: await searchBannerByTitle(title),
    })));
    let rateLimited = false;
    for (const { slug, title, url } of results) {
      if (url === "RATE_LIMIT") {
        missing.push({ slug, title });
        rateLimited = true;
        continue;
      }
      if (url) {
        await db.set(`banner:${slug}`, url);
        titleFound++;
      }
    }
    searched += batch.length;
    if (searched % 50 === 0) console.log(`[banner] title searched ${searched}, found ${titleFound}, sisa ${missing.length}`);
    await sleep(rateLimited ? 15000 : TITLE_DELAY_MS);
  }

  const final = await db.getAllByPrefix("banner:%");
  const got = Object.keys(final).length;
  const total = Object.keys(slugTitle).length || got;
  const pct = total ? Math.round((got / total) * 100) : 0;
  // Simpan juga ke bannerBySlug.json biar kebaca oleh adapter meski DB kosong.
  try {
    fs.writeFileSync(path.join(__dirname, "bannerBySlug.json"), JSON.stringify(final));
  } catch (e) {
    console.error("[banner] tulis bannerBySlug.json gagal:", e.message);
  }
  console.log("SEED BANNERS DONE total:", got, "/", total, `(${pct}%)`, "(baru dari title:", titleFound + ")");
  if (process.env.PRINT_MISSING) {
    const miss = Object.keys(slugTitle).filter((s) => !final[s]).slice(0, 30);
    console.log("contoh slug tanpa banner:", miss.join(", "));
  }
  process.exit(0);
})().catch((e) => {
  console.error("SEED BANNERS ERR", e);
  process.exit(1);
});
