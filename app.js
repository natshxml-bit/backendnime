const express = require("express");
const scraper = require("./scraper");
const stream = require("./stream");
const adapter = require("./adapter");

const app = express();

app.set("trust proxy", true);

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 90;
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  while (bucket.length && bucket[0] <= now - RATE_WINDOW_MS) bucket.shift();
  if (bucket.length >= RATE_MAX) {
    return res.status(429).json({ error: "terlalu banyak request, coba lagi nanti" });
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  next();
}

setInterval(() => {
  for (const [ip, bucket] of rateBuckets) {
    if (!bucket.length) rateBuckets.delete(ip);
  }
}, 60 * 1000);

app.use(rateLimit);

app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Requested-With",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const VALID_LISTS = ["ongoing", "finished", "upcoming", "movie", "donghua", "anime"];

app.get("/", (_req, res) => {
  res.json({
    name: "Kuramanime Scraper API (Node.js) - TsukiNime compatible",
    version: "2.0.0",
    tsukinime_endpoints: {
      "GET /home": "homepage (recent + ongoing + completed)",
      "GET /anime/{animeId}": "anime detail + episodeList",
      "GET /episode/{episodeId}": "episode servers + qualities",
      "GET /server/{serverId}": "resolve stream url mp4",
      "GET /schedule": "jadwal mingguan by hari",
      "GET /genres": "daftar genre",
      "GET /genre/{slug}?page=1": "anime by genre",
      "GET /search/{q}": "pencarian",
      "GET /ongoing-anime?page=1": "anime ongoing",
      "GET /complete-anime?page=1": "anime selesai",
    },
    legacy_endpoints: {
      "GET /list?type=ongoing&page=1": "anime list",
      "GET /properties/{property}/{value}?page=1": "filter by genre/season/type/quality",
      "GET /search?q=one+piece": "quick search",
      "GET /anime/{id}/{slug}": "anime detail raw",
      "GET /episode/{id}/{slug}/{ep}": "episode page raw",
      "GET /stream/{id}/{slug}/{ep}?server=kuramadrive&block_non_mp4=false": "stream url",
    },
  });
});

const wrap = (fn) => (req, res) => {
  Promise.resolve()
    .then(() => fn(req))
    .then((data) => res.json(data))
    .catch((e) => res.status(502).json({ error: e.message }));
};

app.get("/home", wrap(() => adapter.home()));

app.get("/schedule", wrap(() => adapter.schedule()));

app.get("/genres", wrap(() => adapter.genres()));

app.get("/genre/:slug", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return adapter.byGenre(req.params.slug, page);
}));

app.get("/search/:query", wrap((req) => adapter.searchQuery(req.params.query)));

app.get("/ongoing-anime", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return adapter.ongoing(page);
}));

app.get("/complete-anime", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  return adapter.complete(page);
}));

app.get("/list/:type", wrap((req) => {
  const type = req.params.type;
  const page = parseInt(req.query.page, 10) || 1;
  if (!VALID_LISTS.includes(type)) {
    const err = new Error(`type harus salah satu dari ${[...VALID_LISTS].sort().join(", ")}`);
    err.status = 400;
    throw err;
  }
  return adapter.listByType(type, page);
}));

app.get("/server/:serverId", wrap((req) => adapter.server(req.params.serverId)));

app.get("/episode/:animeId/:slug/:ep", wrap((req) =>
  scraper.getEpisode(req.params.animeId, req.params.slug, req.params.ep)
));

app.get("/episode/*splat", wrap((req) => {
  const s = req.params.splat;
  const path = (Array.isArray(s) ? s.join("/") : String(s)).replace(/,/g, "/");
  return adapter.episode(path);
}));

app.get("/list", wrap((req) => {
  const type = req.query.type || "ongoing";
  const page = parseInt(req.query.page, 10) || 1;
  const orderBy = req.query.order_by || "updated";
  if (!VALID_LISTS.includes(type)) {
    const err = new Error(`type harus salah satu dari ${[...VALID_LISTS].sort().join(", ")}`);
    err.status = 400;
    throw err;
  }
  return scraper.getList(type, page, orderBy);
}));

app.get("/properties/:prop/:value", wrap((req) => {
  const page = parseInt(req.query.page, 10) || 1;
  const orderBy = req.query.order_by || "updated";
  return scraper.getProperties(req.params.prop, req.params.value, page, orderBy);
}));

app.get("/search", wrap((req) => {
  const q = req.query.q || req.query.keyword;
  if (!q) {
    const err = new Error("parameter q wajib diisi");
    err.status = 400;
    throw err;
  }
  return scraper.search(q).then((results) => ({ keyword: q, results }));
}));

app.get("/episodes/*splat", wrap((req) => {
  const s = req.params.splat;
  const path = (Array.isArray(s) ? s.join("/") : String(s)).replace(/,/g, "/");
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  return adapter.animeEpisodePage(path, page);
}));

app.get("/anime/:animeId/:slug", wrap((req) =>
  scraper.getDetail(req.params.animeId, req.params.slug)
));

app.get("/anime/*splat", wrap((req) => {
  const s = req.params.splat;
  const path = (Array.isArray(s) ? s.join("/") : String(s)).replace(/,/g, "/");
  return adapter.animeDetail(path);
}));

app.get("/stream/:animeId/:slug/:ep", wrap((req) => {
  const server = req.query.server || "kuramadrive";
  const blockNonMp4 = !["0", "false", "no"].includes(
    String(req.query.block_non_mp4 || "true").toLowerCase()
  );
  return stream.getStream(
    req.params.animeId,
    req.params.slug,
    req.params.ep,
    server,
    blockNonMp4
  );
}));

app.use((err, _req, res, _next) => {
  const status = err.status || 502;
  res.status(status).json({ error: err.message });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kuramanime API on http://0.0.0.0:${PORT}`);
});
