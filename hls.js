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
    // Cek minimal 1 segment
    return fs.readdirSync(d).some((f) => f.endsWith(".ts"));
  } catch { return false; }
}

const inflight = new Map();

function generate(url) {
  if (isReady(url)) return Promise.resolve(dir(url));
  if (inflight.has(url)) return inflight.get(url);

  const d = dir(url);
  fs.mkdirSync(d, { recursive: true });
  const playlist = path.join(d, "index.m3u8");
  const segmentPath = path.join(d, "seg_%03d.ts");

  const promise = new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", url,
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
    proc.on("error", (e) => {
      inflight.delete(url);
      reject(new Error("ffmpeg spawn: " + e.message));
    });
    proc.on("close", (code) => {
      if (code === 0) {
        inflight.delete(url);
        resolve(d);
      } else {
        inflight.delete(url);
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
        reject(new Error("ffmpeg exit " + code + ": " + stderr.slice(-300)));
      }
    });
  });
  inflight.set(url, promise);
  return promise;
}

module.exports = { generate, isReady, dir, CACHE_DIR };
