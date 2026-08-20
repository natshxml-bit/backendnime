const db = require("./db");
const adapter = require("../adapter");

(async () => {
  const key = "88b4681c4b2f1dca3b772f1914ab59fa2621b4a617e5093db997573e83af2c81";
  const U = "https://010522yzhsdhq.up.railway.app";
  const get = async (p) => (await fetch(U + p, { headers: { "X-Api-Key": key } })).json();

  const types = ["finished", "ongoing", "movie", "donghua", "upcoming", "anime", "all"];
  const listSlugs = new Set();
  for (const type of types) {
    for (let page = 1; page <= 35; page++) {
      try {
        const d = await get(`/list/${type}?page=${page}`);
        const a = d.animeList || [];
        if (!a.length) break;
        for (const x of a) if (x.animeId) listSlugs.add(x.animeId);
        if (!d.has_next) break;
      } catch (e) {
        console.log(`[scan] ${type} p${page} gagal: ${e.message}`);
        break;
      }
    }
    console.log(`[scan] ${type} -> slug unik ${listSlugs.size} (total kumulatif)`);
  }

  const all = await db.getAllByPrefix("anime:%");
  const todo = [];
  for (const s of listSlugs) {
    const v = all[s];
    if (!v) { todo.push(s); continue; }
    const syn = String(v.synopsis || v.sinopsis || "").trim();
    if (syn.length < 20) todo.push(s);
  }

  console.log(`[fill2] slug di semua list: ${listSlugs.size} | perlu refetch: ${todo.length}`);

  let ok = 0, gagal = 0, kosong = 0;
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    const t0 = Date.now();
    try {
      const detail = await adapter.animeDetail(s);
      const syn = String(detail.synopsis || detail.sinopsis || "").trim();
      if (syn.length < 20) {
        kosong++;
        console.log(`[fill2] ${i + 1}/${todo.length} KOSONG-di-sumber ${s}`);
      } else {
        await db.set(`anime:${s}`, detail);
        ok++;
        if (i % 20 === 0) console.log(`[fill2] ${i + 1}/${todo.length} OK ${s} (${Date.now() - t0}ms)`);
      }
    } catch (e) {
      gagal++;
      console.log(`[fill2] ${i + 1}/${todo.length} GAGAL ${s}: ${String(e.message).slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(`[fill2] SELESAI: ok ${ok} | gagal ${gagal} | kosong-di-sumber ${kosong}`);
  process.exit(0);
})().catch((e) => {
  console.error("[fill2] ERR:", e.message);
  process.exit(1);
});