// db/sync.js — CLI untuk mengisi database sendiri dari animekita.
// HANYA jalankan dari IP rumah/ISP (Termux/PC), bukan dari Railway.
//
// Penggunaan:
//   node db/sync.js --all            (full: catalog + home + schedule +
//                                     detail semua ongoing + episode terbaru)
//   node db/sync.js --catalog        (full catalog 4.759 judul, 1 request)
//   node db/sync.js --details-all    (detail SEMUA anime dari katalog,
//                                     skip yang sudah ada, ±2 jam)
//   node db/sync.js --details-all --chunk=500     (bertahap 500 biar aman)
//   node db/sync.js --details-all --force         (re-sync semua, bukan skip)
//   node db/sync.js --ongoing=50 --episodesPer=3
//   node db/sync.js --lists=5
//   node db/sync.js --genres --genrePages=2

const { runSync } = require("./sync_core");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const num = (flag, def) => {
  const i = args.findIndex((a) => a.startsWith(flag));
  if (i < 0) return def;
  const v = args[i].split("=")[1];
  return v === undefined ? def : parseInt(v, 10);
};

const OPTS = {
  home: has("--all") || has("--home"),
  schedule: has("--all") || has("--schedule"),
  catalog: has("--all") || has("--catalog"),
  details: has("--all") ? 0 : num("--details", 0),
  allDetails: has("--details-all")
    ? { delayMs: num("--delay", 350), chunk: num("--chunk", 0), force: has("--force") }
    : 0,
  ongoing: has("--all") ? -1 : num("--ongoing", 0),
  syncEpisodes: has("--all") || has("--episodes") || args.some((a) => a.startsWith("--episodesPer")),
  episodesPer: num("--episodesPer", has("--all") ? 3 : 0),
  lists: has("--all") ? 3 : num("--lists", 0),
  genres: has("--all") || has("--genres"),
  genrePages: has("--all") ? 1 : num("--genrePages", 0),
};

runSync(OPTS).catch((e) => {
  console.error("[sync] ERROR:", e);
  process.exit(1);
});
