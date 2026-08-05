const MOOV_PRELOAD = 2 * 1024 * 1024;
const TTL = 30 * 60 * 1000;
const MAX = 200;

const map = new Map();

const UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

function prefetch(url) {
  if (!url || map.has(url)) return;
  const entry = { promise: null };
  entry.promise = (async () => {
    const res = await fetch(url, {
      headers: {
        Range: `bytes=0-${MOOV_PRELOAD - 1}`,
        "User-Agent": UA,
        Referer: "https://v17.kuramanime.ink/",
        Accept: "*/*",
      },
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const total = parseInt(res.headers.get("content-range").split("/")[1], 10) || 0;
    map.set(url, {
      buf,
      total,
      expires: Date.now() + TTL,
      updated: Date.now(),
    });
  })().catch(() => {
    map.delete(url);
  });
  map.set(url, entry);
  if (map.size > MAX) map.delete(map.keys().next().value);
}

function get(url) {
  const e = map.get(url);
  return e || null;
}

function sweep() {
  const now = Date.now();
  for (const [k, e] of map) {
    if (e.expires && e.expires < now) map.delete(k);
  }
}

setInterval(sweep, 60 * 1000);

module.exports = { prefetch, get, MOOV_PRELOAD };
