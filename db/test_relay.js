const { spawn } = require("child_process");
const PORT = 8282;
const child = spawn(process.execPath, ["app.js"], {
  env: { ...process.env, PORT: String(PORT), NO_CRAWL: "1", RELAY_TOKEN: "sekret" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write("[relay] " + d));
child.stderr.on("data", (d) => process.stdout.write("[relay-err] " + d));

function waitListen() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tryConn() {
      fetch(`http://localhost:${PORT}/db/status`)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() - t0 > 15000) reject(new Error("relay tak kunjung listen"));
          else setTimeout(tryConn, 300);
        });
    })();
  });
}

(async () => {
  await waitListen();
  let r = await fetch(`http://localhost:${PORT}/relay?path=baruupload.php&page=1`);
  console.log("1. relay tanpa token:", r.status, "(harus 403)");
  r = await fetch(`http://localhost:${PORT}/relay?path=baruupload.php&page=1`, {
    headers: { "X-Relay-Token": "sekret" },
  });
  const body = await r.json();
  console.log("2. relay dengan token:", r.status, "| items:", Array.isArray(body) ? body.length : typeof body);
  r = await fetch(`http://localhost:${PORT}/relay?path=series.php&url=sakura-taisen`, {
    headers: { "X-Relay-Token": "sekret" },
  });
  const sBody = await r.json();
  console.log("3. relay series.php:", r.status, "| judul:", sBody?.data?.[0]?.judul || "?");
  r = await fetch(`http://localhost:${PORT}/relay?path=../../etc/passwd`, {
    headers: { "X-Relay-Token": "sekret" },
  });
  console.log("4. relay path traversal:", r.status, "(harus 400)");

  process.env.RELAY_URL = `http://localhost:${PORT}`;
  process.env.RELAY_TOKEN = "sekret";
  const adapter = require("../adapter");
  const home = await adapter.home();
  console.log("5. adapter.home() via relay → recent:", (home.recent || []).length, "| film:", (home.film?.animeList || []).length);
  const sched = await adapter.schedule();
  console.log("6. adapter.schedule() via relay → days:", sched.length);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
}).finally(() => child.kill());
