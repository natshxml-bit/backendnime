// Remux MP4 ke faststart (moov atom di awal) pakai ffmpeg. Backend /proxy
// route pakai ini supaya WebView <video> element bisa play tanpa harus
// download full file dulu (moov di akhir = stuck).
//
// AnimeLovers V3 pakai pola sama: ExoPlayer cache + probe seluruh file
// untuk dapat moov. Kita pakai ffmpeg remux sebagai one-time conversion,
// cache hasil ke Railway volume.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = process.env.REMUX_CACHE_DIR || "/app/data/remux";
const TTL_MS = 6 * 60 * 60 * 1000;

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

function key(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 16);
}

function cachePath(url) {
  return path.join(CACHE_DIR, key(url) + ".mp4");
}

function isCached(url) {
  const p = cachePath(url);
  try {
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > TTL_MS) {
      fs.unlinkSync(p);
      return false;
    }
    if (stat.size < 1024) return false;
    return true;
  } catch { return false; }
}

const inflight = new Map();

function remux(url) {
  if (isCached(url)) {
    return Promise.resolve(cachePath(url));
  }
  if (inflight.has(url)) return inflight.get(url);

  const dst = cachePath(url);
  const tmp = dst + ".remuxing";
  const promise = new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", url,
      "-c", "copy",
      "-movflags", "+faststart",
      "-f", "mp4",
      tmp,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (e) => {
      inflight.delete(url);
      reject(new Error("ffmpeg spawn: " + e.message));
    });
    proc.on("close", (code) => {
      if (code === 0) {
        try {
          fs.renameSync(tmp, dst);
          inflight.delete(url);
          resolve(dst);
        } catch (e) {
          inflight.delete(url);
          reject(e);
        }
      } else {
        try { fs.unlinkSync(tmp); } catch {}
        inflight.delete(url);
        reject(new Error("ffmpeg exit " + code + ": " + stderr.slice(-500)));
      }
    });
  });
  inflight.set(url, promise);
  return promise;
}

module.exports = { remux, isCached, cachePath, CACHE_DIR };
