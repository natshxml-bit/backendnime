// Disk cache untuk /proxy — supaya 1 file dari pixeldrain di-download
// sekali lalu serve dari Railway volume untuk user lain. Tanpa ini, tiap
// user buka episode bikin Railway IP buka connection baru ke pixeldrain;
// pixeldrain batasi 'max_concurrent_downloads' untuk anonymous per-IP
// (sekitar 5 concurrent), jadi backend kena 403 max_concurrent_downloads.
//
// File disimpan di /app/data/proxy/<sha1(url)>.mp4 dengan TTL.
// Cuma 1MB partial buffer (bukan full file) — cukup untuk head seek
// metadata + early play. Sisanya di-stream from upstream langsung
// (coalescing: 1 upstream per file di-share banyak user).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = process.env.PROXY_CACHE_DIR || "/app/data/proxy";
const PARTIAL_BYTES = 1 * 1024 * 1024; // 1MB head cache untuk seek moov
const TTL_MS = 6 * 60 * 60 * 1000; // 6 jam

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

function key(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex");
}

function pathFor(url) {
  return path.join(CACHE_DIR, key(url) + ".bin");
}

function metaPathFor(url) {
  return path.join(CACHE_DIR, key(url) + ".json");
}

function readMeta(url) {
  try {
    const raw = fs.readFileSync(metaPathFor(url), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

function writeMeta(url, meta) {
  try { fs.writeFileSync(metaPathFor(url), JSON.stringify(meta)); } catch {}
}

// Cek apakah cached head masih valid. Return {path, total} atau null.
function getHead(url) {
  const meta = readMeta(url);
  if (!meta || !meta.total) return null;
  if (Date.now() - meta.cachedAt > TTL_MS) {
    try { fs.unlinkSync(pathFor(url)); } catch {}
    try { fs.unlinkSync(metaPathFor(url)); } catch {}
    return null;
  }
  const p = pathFor(url);
  if (!fs.existsSync(p)) return null;
  const stat = fs.statSync(p);
  if (stat.size < Math.min(PARTIAL_BYTES, meta.total)) return null;
  return { path: p, total: meta.total, size: stat.size };
}

// Tulis sebagian head (0..n) ke disk. Async fire-and-forget.
function writeHead(url, buf, total) {
  const p = pathFor(url);
  try {
    fs.writeFileSync(p, buf);
    writeMeta(url, { total, cachedAt: Date.now() });
  } catch (e) {
    console.warn(`[proxyCache] writeHead failed: ${e.message}`);
  }
}

module.exports = { getHead, writeHead, CACHE_DIR, PARTIAL_BYTES };
