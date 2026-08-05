const BASE_URL = "https://v19.kuramanime.ing";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const cookieJar = new Map();

const TTL_RULES = [
  { re: /\/anime\/\d+/, ttl: 30 * 60 * 1000 },
  { re: /\/quick\//, ttl: 5 * 60 * 1000 },
  { re: /\/properties\//, ttl: 5 * 60 * 1000 },
  { re: /^\/$/, ttl: 5 * 60 * 1000 },
  { re: /\/schedule/, ttl: 10 * 60 * 1000 },
  { re: /\/quicksearch/, ttl: 2 * 60 * 1000 },
  { re: /\/episode\//, ttl: 30 * 60 * 1000 },
];

function ttlFor(url) {
  for (const rule of TTL_RULES) {
    if (rule.re.test(url)) return rule.ttl;
  }
  return 0;
}

function setCookies(setCookieHeaders, host) {
  if (!setCookieHeaders) return;
  const jar = cookieJar.get(host) || new Map();
  for (const line of setCookieHeaders) {
    const [pair] = String(line).split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) {
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  cookieJar.set(host, jar);
}

function cookieHeader(host) {
  const jar = cookieJar.get(host);
  if (!jar || jar.size === 0) return "";
  return [...jar.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function buildUrl(path, params) {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  return url;
}

async function doRequest(path, options = {}) {
  const {
    params,
    headers = {},
    method = "GET",
    body,
    referer,
    timeout = 20000,
  } = options;

  const url = buildUrl(path, params);

  const host = url.hostname;
  const finalHeaders = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    ...headers,
  };
  const cookies = cookieHeader(host);
  if (cookies) finalHeaders.Cookie = cookies;
  if (referer) finalHeaders.Referer = referer;

  if (body !== undefined) finalHeaders["Content-Length"] = String(body.length);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: finalHeaders,
      body,
      redirect: "follow",
      signal: ctrl.signal,
    });
    setCookies(res.headers.getSetCookie?.() || [], host);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, url: res.url };
  } finally {
    clearTimeout(timer);
  }
}

function isChallenge(res) {
  return (
    res.status === 403 &&
    (res.text.includes("Just a moment") || res.text.length < 10000)
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN_GAP_MS = 350;
let lastRequestAt = 0;
let cooldownUntil = 0;

async function pace() {
  const now = Date.now();
  const wait = Math.max(
    0,
    MIN_GAP_MS - (now - lastRequestAt),
    cooldownUntil - now
  );
  if (wait > 0) await sleep(wait + Math.random() * 60);
  lastRequestAt = Date.now();
}

const MAX_CONCURRENT = 3;
let activeCount = 0;
const waitQueue = [];

function semaphore(fn) {
  return new Promise((resolve, reject) => {
    waitQueue.push({ fn, resolve, reject });
    pump();
  });
}

function pump() {
  if (activeCount >= MAX_CONCURRENT || !waitQueue.length) return;
  activeCount++;
  const { fn, resolve, reject } = waitQueue.shift();
  Promise.resolve()
    .then(fn)
    .then(resolve, reject)
    .finally(() => {
      activeCount--;
      pump();
    });
}

const MAX_CACHE = 500;
const cache = new Map();
const inflight = new Map();

function cacheSet(key, entry) {
  cache.set(key, entry);
  if (cache.size > MAX_CACHE) {
    cache.delete(cache.keys().next().value);
  }
}

async function request(path, options = {}) {
  const { retries = 3, noCache = false } = options;
  const url = buildUrl(path, options.params);
  const host = url.hostname;
  const method = options.method || "GET";
  const key = `${method} ${url.toString()}`;

  const ttl = method === "GET" && !noCache ? ttlFor(url.pathname) : 0;

  if (ttl) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.data;
    if (inflight.has(key)) return inflight.get(key);
  }

  const run = (async () => {
    let res;
    for (let attempt = 0; ; attempt++) {
      if (!options.noPace) await pace();
      res = await semaphore(() => doRequest(path, options));
      if (attempt >= retries || !isChallenge(res)) break;
      cookieJar.delete(host);
      cooldownUntil = Date.now() + 9000 * (attempt + 1);
      await sleep(900 * (attempt + 1));
    }
    if (ttl) cacheSet(key, { expires: Date.now() + ttl, data: res });
    return res;
  })();

  if (ttl) {
    inflight.set(key, run);
    run.finally(() => inflight.delete(key)).catch(() => {});
  }
  return run;
}

function get(path, options = {}) {
  return request(path, { ...options, method: "GET" });
}

function post(path, options = {}) {
  return request(path, { ...options, method: "POST" });
}

module.exports = { BASE_URL, UA, request, get, post, pace, clearCache: () => cache.clear() };
