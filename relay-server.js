// Animekita relay server untuk Railway backend.
// Termux punya IP rumah (residential, gak kena Cloudflare datacenter block)
// → backend Railway scrape animekita lewat sini.
//
// Run: node relay-server.js
//   listen on port 7799
//   endpoint: GET /scrape?path=<php-path>&<params>
//   response: animekita JSON as-is
//
// Backend panggil: https://termux-ip:7799/scrape?path=baruupload.php
// (tapi karena Termux IP dinamis & gak bisa HTTPS, kita pakai cloudflared
// tunnel atau ngrok. Untuk development: Railway /relay akan forward
// scrape request ke Termux via webhook — Termux POST hasilnya balik).

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = 7799;
const TARGET = "https://apps.animekita.org/api/v1.2.5";
const UA = "Dart/2.19.6 (dart:io)";
const TOKEN = process.env.RELAY_TOKEN || "tsukinime123";

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "X-Relay-Token, Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Terima /scrape (format lama) dan /relay (format adapter backend) — sama saja.
  if (req.url.split("?")[0] !== "/scrape" && req.url.split("?")[0] !== "/relay") {
    return res.status(404).json({ error: "endpoint tidak dikenal" });
  }

  if (req.headers["x-relay-token"] !== TOKEN) {
    return res.status(403).json({ error: "token relay salah" });
  }

  const url = new URL(req.url, "http://localhost");
  const relayPath = url.searchParams.get("path");
  if (!relayPath || !/^[a-zA-Z0-9_/.-]+\.php$/.test(relayPath)) {
    return res.status(400).json({ error: "path tidak valid" });
  }

  const target = new URL(`${TARGET}/${relayPath}`);
  for (const [k, v] of url.searchParams) {
    if (k === "path") continue;
    if (v) target.searchParams.set(k, v);
  }

  console.log(`[relay] ${target.toString()}`);

  try {
    const data = await fetch(target.toString(), {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    const text = await data.text();
    const start = text.search(/[\[{]/);
    let body = text;
    if (start >= 0) {
      const open = text[start];
      const close = open === "[" ? "]" : "}";
      const end = text.lastIndexOf(close);
      if (end > start) body = text.slice(start, end + 1);
    }
    res.setHeader("Content-Type", "application/json");
    res.statusCode = data.ok ? 200 : data.status;
    res.end(body);
  } catch (e) {
    console.warn(`[relay] error: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[relay] listening on http://0.0.0.0:${PORT}`);
  console.log(`[relay] target: ${TARGET}`);
});
