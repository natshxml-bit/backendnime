// Animekita scrape via Cloudflare Workers dengan multi-account rotation.
// Animekita block beberapa Cloudflare IP pool. Solusi: deploy 3 workers di
// akun Cloudflare berbeda (beda IP pool CF), backend round-robin / random
// pilih worker per request. Kalau 1 worker dapat 403, otomatis fallback ke
// worker lain — AnimeLovers V3 & NanimeID Merdeka pakai pola serupa.
//
// Setup:
//   1. Bikin 3 akun Cloudflare (email beda)
//   2. Tiap akun: Workers → Create Worker → paste worker-animekita.js → Save
//      → Deploy → copy URL *.workers.dev
//   3. Set env WORKER_URLS = "url1,url2,url3" (comma separated, koma tanpa spasi)
//      semua worker harus pakai PROXY_TOKEN yang sama
//   4. Set WORKER_TOKEN = "tsukinime123" (sama dengan ANIMEKITA_PROXY_TOKEN)

const UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

let counter = 0;
let blockedUntil = new Map(); // worker URL → timestamp

function pickWorker() {
  const urls = (process.env.WORKER_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) return null;
  const now = Date.now();
  // Filter worker yang lagi di-block sementara
  const available = urls.filter(u => !(blockedUntil.get(u) > now));
  const pool = available.length > 0 ? available : urls; // fallback: kalau semua block, paksa coba
  // Round-robin + sedikit random
  const i = (counter++) % pool.length;
  const r = Math.floor(Math.random() * pool.length);
  return pool[r === i ? (i + 1) % pool.length : r];
}

function block(workerUrl, ms = 60000) {
  blockedUntil.set(workerUrl, Date.now() + ms);
  console.warn(`[workers] block ${workerUrl} until ${new Date(Date.now() + ms).toISOString()}`);
}

async function tryWorker(workerUrl, path, params, token) {
  const qs = new URLSearchParams(params).toString();
  const url = `${workerUrl}/${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "X-Proxy-Token": token },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 403 || res.status === 429) {
    block(workerUrl, 90000); // 1.5 menit
    return { error: true, status: res.status };
  }
  return { error: false, response: res };
}

async function scrape(path, params = {}) {
  const token = process.env.WORKER_TOKEN || process.env.ANIMEKITA_PROXY_TOKEN || "tsukinime123";
  const urls = (process.env.WORKER_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) {
    throw new Error("WORKER_URLS env belum diset — butuh minimal 1 Cloudflare Worker URL");
  }

  // Round-robin attempts — coba semua worker sampai ada yang sukses
  const tried = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < urls.length * 2; attempt++) {
    const w = pickWorker();
    if (!w || tried.has(w + "_" + attempt)) continue;
    tried.add(w + "_" + attempt);
    try {
      const r = await tryWorker(w, path, params, token);
      if (!r.error) {
        const text = await r.response.text();
        // Sanitize JSON (animekita kadang return "}{" extra)
        const start = text.search(/[\[{]/);
        let body = text;
        if (start >= 0) {
          const open = text[start];
          const close = open === "[" ? "]" : "}";
          const end = text.lastIndexOf(close);
          if (end > start) body = text.slice(start, end + 1);
        }
        return JSON.parse(body);
      }
      lastErr = `worker ${w} HTTP ${r.status}`;
    } catch (e) {
      lastErr = e.message;
      console.warn(`[workers] ${w} error: ${e.message}`);
    }
  }
  throw new Error(`all workers failed: ${lastErr}`);
}

function stats() {
  const urls = (process.env.WORKER_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  const now = Date.now();
  return {
    workers: urls.length,
    blocked: Array.from(blockedUntil.entries())
      .filter(([, t]) => t > now)
      .map(([u, t]) => ({ url: u, until: new Date(t).toISOString() })),
  };
}

module.exports = { scrape, stats };
