const db = require("./db");
const adapter = require("../adapter");

async function anilistSynopsis(title) {
  const t = String(title || "").trim();
  if (!t) return null;
  try {
    const query = `query($t:String){Page(perPage:3){media(search:$t,type:ANIME){title{romaji english} description(asHtml:false)}}}`;
    const res = await adapter.apiGet("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { t: t.slice(0, 60) } }),
    });
    const json = await res.json();
    const m = json?.data?.Page?.media || [];
    for (const cand of m) {
      const d = String(cand?.description || "").trim();
      if (d.length > 20) return d;
    }
  } catch {}
  return null;
}

(async () => {
  const key = "88b4681c4b2f1dca3b772f1914ab59fa2621b4a617e5093db997573e83af2c81";
  const U = "https://010522yzhsdhq.up.railway.app";
  const get = async (p, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(U + p, { headers: { "X-Api-Key": key } });
        if (r.ok) return await r.json();
      } catch {}
      await new Promise((r2) => setTimeout(r2, 2000));
    }
    return null;
  };

  const listSlugs = new Map();
  for (const type of ["ongoing", "anime", "all", "finished"]) {
    for (let page = 1; page <= 35; page++) {
      const d = await get(`/list/${type}?page=${page}`);
      if (!d || !(d.animeList || []).length) break;
      for (const x of d.animeList) {
        if (!x.synopsis && x.animeId && !listSlugs.has(x.animeId)) {
          listSlugs.set(x.animeId, x.title || "");
        }
      }
      if (!d.has_next) break;
    }
  }

  console.log(`[fallback] slug tanpa sinopsis di list: ${listSlugs.size}`);
  let ok = 0, still = 0;
  for (const [slug, title] of listSlugs) {
    let detail = null;
    try { detail = await adapter.animeDetail(slug); } catch {}
    const syn = String(detail?.synopsis || detail?.sinopsis || "").trim();
    if (syn.length >= 20) {
      await db.set(`anime:${slug}`, detail);
      ok++;
      continue;
    }
    const fal = await anilistSynopsis(title || slug);
    if (fal) {
      const base = detail || { animeId: slug, title: title || slug, poster: "", status: null, type: null, genres: [] };
      await db.set(`anime:${slug}`, { ...base, synopsis: fal.length > 500 ? fal.slice(0, 500) + "…" : fal });
      ok++;
      console.log(`[fallback] OK ${slug} <- AniList (${(fal.length > 500 ? 500 : fal.length)}+ char)`);
    } else {
      still++;
      console.log(`[fallback] MASIH KOSONG ${slug} (${title})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`[fallback] SELESAI: terisi ${ok} | masih kosong ${still}`);
  process.exit(0);
})().catch((e) => {
  console.error("[fallback] ERR:", e.message);
  process.exit(1);
});