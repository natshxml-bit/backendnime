// db/sync.js — CLI untuk mengisi database sendiri dari animekita.
// HANYA jalankan dari IP rumah/ISP (Termux/PC), bukan dari Railway.
//
// Penggunaan:
//   node db/sync.js --all
//   node db/sync.js --home --schedule --details=15 --episodesPer=3
//   node db/sync.js --details=20 --episodes   (semua episode per anime)
//   node db/sync.js --lists=5                 (list per jenis, 5 halaman)
//   node db/sync.js --genres --genrePages=2   (daftar + halaman genre)

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
  details: has("--all") ? 15 : num("--details", 0),
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
