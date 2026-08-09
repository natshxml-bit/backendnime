const { spawn } = require("child_process");
const PORT = 8181;
const child = spawn(process.execPath, ["app.js"], {
  env: { ...process.env, PORT: String(PORT), NO_CRAWL: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
child.stderr.on("data", (d) => process.stdout.write("[srv-err] " + d));

function waitListen() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tryConn() {
      fetch(`http://localhost:${PORT}/db/status`)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() - t0 > 15000) reject(new Error("server tak kunjung listen"));
          else setTimeout(tryConn, 300);
        });
    })();
  });
}

(async () => {
  try {
    await waitListen();
    const cases = [
      ["db/status", `/db/status`],
      ["home", `/home`],
      ["schedule", `/schedule`],
      ["anime/sakura-taisen", `/anime/sakura-taisen`],
      ["episode/al-152997-1", `/episode/al-152997-1`],
      ["genres", `/genres`],
      ["genre/action", `/genre/action`],
      ["ongoing-anime", `/ongoing-anime`],
      ["complete-anime", `/complete-anime`],
      ["list/movie", `/list/movie`],
      ["list/donghua", `/list/donghua`],
      ["list/all", `/list/all?page=2`],
    ];
    const results = {};
    for (const [name, url] of cases) {
      const t = Date.now();
      const r = await fetch(`http://localhost:${PORT}${url}`);
      const j = await r.json();
      results[name] = { status: r.status, ms: Date.now() - t, topKeys: Object.keys(j).slice(0, 5) };
    }
    console.log(JSON.stringify(results, null, 2));
  } finally {
    child.kill();
  }
})().catch((e) => {
  console.error("ERR", e.message);
  child.kill();
  process.exit(1);
});
