// Pixeldrain upstream client dengan single-flight + queue + smart backoff.
//
// Masalah: pixeldrain batasi `max_concurrent_downloads` (~5 concurrent) untuk
// anonymous per-IP. Railway share IP dengan banyak backend process, jadi
// backend kena 403 max_concurrent_downloads saat concurrent fetch.
//
// Solusi: single-flight queue — semua request ke pixeldrain lewat 1 antrian,
// satu per satu. Tiap request:
//   1. Random jitter 200-800ms (avoid burst pattern)
//   2. Fetch dari upstream
//   3. Kalau 403/429 → exponential backoff (1s, 2s, 4s, 8s) sampai 4 attempt
//   4. Kalau network error → retry 2x
//
// Bonus: User-Agent random (real browser list) supaya request kelihatan dari
// "different clients" untuk pixeldrain counter.

const UA_LIST = [
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
];

const queue = [];
let active = null;
let blockedUntil = 0; // timestamp: skip until this time after rate-limit

function pickUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function next() {
  if (active || queue.length === 0) return;
  const { url, options, resolve, reject, attempts } = queue.shift();
  active = { url, attempts };
  runFetch(url, options, attempts)
    .then((result) => {
      active = null;
      resolve(result);
      setImmediate(next);
    })
    .catch((err) => {
      active = null;
      reject(err);
      setImmediate(next);
    });
}

async function runFetch(url, options, attemptsLeft) {
  // Tunggu sampai blockedUntil kalau kena rate-limit
  const now = Date.now();
  if (now < blockedUntil) {
    await sleep(blockedUntil - now);
  }

  // Random jitter 200-800ms supaya gak burst pattern
  await sleep(200 + Math.floor(Math.random() * 600));

  const headers = {
    "User-Agent": pickUA(),
    "Referer": "https://animekita.org/",
    "Accept": "*/*",
    ...(options?.headers || {}),
  };

  if (options?.range) headers["Range"] = options.range;

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers, redirect: "follow" });
      if (res.status === 403 || res.status === 429) {
        const wait = 1000 * Math.pow(2, attempt - 1);
        console.warn(`[pixeldrain] ${url} got ${res.status}, retry in ${wait}ms (attempt ${attempt}/4)`);
        if (res.status === 429) blockedUntil = Date.now() + wait * 2;
        await sleep(wait);
        continue;
      }
      if (!res.ok && res.status >= 500) {
        const wait = 800 * attempt;
        console.warn(`[pixeldrain] ${url} got ${res.status}, retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      console.warn(`[pixeldrain] ${url} network err: ${e.message}`);
      await sleep(500 * attempt);
    }
  }
  throw lastErr || new Error("pixeldrain fetch failed after retries");
}

// Enqueue fetch. Returns Response.
function fetch(url, options) {
  if (!/^https?:\/\/pixeldrain\.com\//i.test(url)) {
    // Non-pixeldrain: skip queue, direct fetch
    return runFetch(url, options, 4);
  }
  return new Promise((resolve, reject) => {
    queue.push({ url, options, resolve, reject, attempts: 0 });
    next();
  });
}

function stats() {
  return {
    queueSize: queue.length,
    active: active ? active.url : null,
    blockedUntil: blockedUntil > Date.now() ? blockedUntil - Date.now() : 0,
  };
}

module.exports = { fetch, stats };
