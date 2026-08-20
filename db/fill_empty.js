const db = require("./db");
const adapter = require("../adapter");

(async () => {
  const catalog = await db.get("catalog");
  const items = catalog && Array.isArray(catalog.value) ? catalog.value : [];
  const slugs = [];
  for (const it of items) {
    const s = it && (it.animeId || it.url || it.endpoint || it.slug);
    if (s && !slugs.includes(s)) slugs.push(s);
  }

  const all = await db.getAllByPrefix("anime:%");
  const todo = [];
  for (const s of slugs) {
    const v = all[s];
    if (!v) { todo.push(s); continue; }
    const syn = String(v.synopsis || v.sinopsis || "").trim();
    const gs = Array.isArray(v.genres) ? v.genres : Array.isArray(v.genre) ? v.genre : [];
    if (syn.length < 20 || gs.length === 0) todo.push(s);
  }

  console.log(`[fill] katalog ${items.length} | sudah ada ${Object.keys(all).length} | perlu refetch ${todo.length}`);

  let ok = 0, gagal = 0, kosong = 0;
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    const t0 = Date.now();
    try {
      const detail = await adapter.animeDetail(s);
      const syn = String(detail.synopsis || detail.sinopsis || "").trim();
      const gs = Array.isArray(detail.genres) ? detail.genres : Array.isArray(detail.genre) ? detail.genre : [];
      if (syn.length < 20 && gs.length === 0) {
        kosong++;
        console.log(`[fill] ${s}: MASIH KOSONG di sumber (${(Date.now() - t0).toFixed(0)}ms)`);
      } else {
        await db.set(`anime:${s}`, detail);
        ok++;
        if (i % 20 === 0 || syn.length < 20) {
          console.log(`[fill] ${i + 1}/${todo.length} OK ${s} (${(Date.now() - t0).toFixed(0)}ms)${syn.length < 20 ? " [sinopsis pendek]" : ""}`);
        }
      }
    } catch (e) {
      gagal++;
      console.log(`[fill] ${i + 1}/${todo.length} GAGAL ${s}: ${String(e.message).slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(`[fill] SELESAI: ok ${ok} | gagal ${gagal} | kosong-di-sumber ${kosong} | dari ${todo.length}`);
  process.exit(0);
})().catch((e) => {
  console.error("[fill] ERR:", e.message);
  process.exit(1);
});
