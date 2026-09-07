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
const pixeldrain = require("./pixeldrain");

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

// Download MP4 ke local via pixeldrain queue, lalu ffmpeg remux.
function remux(url) {
  if (isCached(url)) return Promise.resolve(cachePath(url));
  if (inflight.has(url)) return inflight.get(url);

  const dst = cachePath(url);
  const tmp = dst + ".remuxing";
  const sourceMp4 = dst + ".source";

  const promise = (async () => {
    // Download source via queue
    if (!fs.existsSync(sourceMp4) || fs.statSync(sourceMp4).size < 1024) {
      const res = await pixeldrain.fetch(url);
      if (!res.ok) throw new Error(`pixeldrain HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(sourceMp4, buf);
    }

    // Remux local file
    await new Promise((resolve, reject) => {
      const args = [
        "-y", "-i", sourceMp4,
        "-c", "copy",
        "-movflags", "+faststart",
        "-f", "mp4",
        tmp,
      ];
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("ffmpeg exit " + code + ": " + stderr.slice(-500)));
      });
    });

    fs.renameSync(tmp, dst);
    try { fs.unlinkSync(sourceMp4); } catch {}
    return dst;
  })().finally(() => {
    inflight.delete(url);
  });

  inflight.set(url, promise);
  return promise;
}

module.exports = { remux, isCached, cachePath, CACHE_DIR };
