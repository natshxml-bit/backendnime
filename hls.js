// HLS conversion: ambil MP4 dari pixeldrain (sekali), convert ke HLS
// (segmented .ts + .m3u8 playlist) pakai ffmpeg, simpan di Railway volume.
// Tiap segment adalah independent file kecil yang bisa di-stream dari disk
// (no upstream re-fetch, no moov-at-end issue, no CORS issue — file lokal).
//
// AnimeLovers V3 pakai ExoPlayer + HLS (Media3 HlsMediaSource). Backend
// sediakan HLS playlist dengan multiple variant (kualitas 360p/480p/720p/1080p),
// player pilih otomatis berdasarkan bandwidth.
//
// Catatan: implementation ini HLS untuk SATU URL (satu resolusi). Multi
// variant playlist (multi-res) = gabung playlist dari 4 cache entries.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pixeldrain = require("./pixeldrain");

const CACHE_DIR = process.env.HLS_CACHE_DIR || "/app/data/hls";
const SEGMENT_TIME = 6; // detik per segment
const TTL_MS = 6 * 60 * 60 * 1000;

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

function key(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 16);
}

function dir(url) {
  return path.join(CACHE_DIR, key(url));
}

function isReady(url) {
  const d = dir(url);
  const playlist = path.join(d, "index.m3u8");
  try {
    const stat = fs.statSync(playlist);
    if (Date.now() - stat.mtimeMs > TTL_MS) return false;
    return fs.readdirSync(d).some((f) => f.endsWith(".ts"));
  } catch { return false; }
}

const inflight = new Map();

// Step 1: download MP4 ke local file via pixeldrain queue (single-flight)
// Step 2: ffmpeg convert local file → HLS segments
function generate(url) {
  if (isReady(url)) return Promise.resolve(dir(url));
  if (inflight.has(url)) return inflight.get(url);

  const promise = (async () => {
    const d = dir(url);
    fs.mkdirSync(d, { recursive: true });
    const localMp4 = path.join(d, "_source.mp4");
    const playlist = path.join(d, "index.m3u8");
    const segmentPath = path.join(d, "seg_%03d.ts");

    // Download MP4 dulu (via queue — single concurrent ke pixeldrain)
    if (!fs.existsSync(localMp4) || fs.statSync(localMp4).size < 1024) {
      const res = await pixeldrain.fetch(url);
      if (!res.ok) {
        throw new Error(`pixeldrain HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(localMp4, buf);
      // Clear partial segments kalau ada
      try {
        for (const f of fs.readdirSync(d)) {
          if (f.endsWith(".ts") || f === "index.m3u8") fs.unlinkSync(path.join(d, f));
        }
      } catch {}
    }

    // Convert local MP4 → HLS pakai ffmpeg (no upstream network)
    await new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-i", localMp4,
        "-c", "copy",
        "-f", "hls",
        "-hls_time", String(SEGMENT_TIME),
        "-hls_list_size", "0",
        "-hls_segment_filename", segmentPath,
        "-hls_flags", "independent_segments",
        playlist,
      ];
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("ffmpeg exit " + code + ": " + stderr.slice(-300)));
      });
    });

    return d;
  })().finally(() => {
    inflight.delete(url);
  });

  inflight.set(url, promise);
  return promise;
}

module.exports = { generate, isReady, dir, CACHE_DIR, stats: pixeldrain.stats };
