const cheerio = require("cheerio");
const crypto = require("crypto");
const client = require("./client");

// Token leviathan: hardcoded di leviathan.js (kunci "bedql"). Jika berubah,
// ambil ulang dari https://v19.kuramanime.ing/storage/leviathan.js
const LEVI_TOKEN = "kJuHHkaqcBFXiGMHQf6bJw8YAyDcwGD8Ur";

const randId = (n = 6) =>
  crypto.randomBytes(n).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, n);

const JS_VARS_TTL = 30 * 60 * 1000;
let jsVarsCache = { env: null, expires: 0 };

async function getJsVars(noPace = false) {
  if (jsVarsCache.env && jsVarsCache.expires > Date.now()) return jsVarsCache.env;
  const opt = noPace ? { noPace: true } : {};
  const r = await client.get("/assets/js/arc-signal.min.js", opt);
  const m = r.text.match(/f\s*=\s*"([A-Za-z0-9]+)"/);
  if (!m) return {};
  const js = await client.get(`/assets/js/${m[1]}.js`, opt);
  const env = {};
  for (const match of js.text.matchAll(/(MIX_[A-Z_]+):\s*'([^']+)'/g)) {
    env[match[1]] = match[2];
  }
  const need = [
    "MIX_PAGE_TOKEN_KEY",
    "MIX_STREAM_SERVER_KEY",
    "MIX_PREFIX_AUTH_ROUTE_PARAM",
    "MIX_AUTH_ROUTE_PARAM",
    "MIX_AUTH_KEY",
    "MIX_AUTH_TOKEN",
  ];
  if (need.every((k) => env[k])) {
    jsVarsCache = { env, expires: Date.now() + JS_VARS_TTL };
  }
  return env;
}

const QUALITY_ORDER = [2160, 1080, 720, 480, 360];

async function getStream(
  animeId,
  slug,
  ep,
  server = "kuramadrive",
  blockNonMp4 = true
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await resolveStream(animeId, slug, ep, server, blockNonMp4);
    if (
      result.error === "player kosong (token/session rejected)" &&
      jsVarsCache.env
    ) {
      jsVarsCache = { env: null, expires: 0 };
      continue;
    }
    return result;
  }
  return { error: "player kosong (token/session rejected)" };
}

async function resolveStream(
  animeId,
  slug,
  ep,
  server = "kuramadrive",
  blockNonMp4 = true
) {
  const url = `/anime/${animeId}/${slug}/episode/${ep}`;
  const result = {
    url: `${client.BASE_URL}${url}`,
    anime_id: animeId,
    slug,
    episode: ep,
    server,
  };

  try {
    await client.pace();
    const [page, env] = await Promise.all([
      client.get(url, { noPace: true }),
      getJsVars(true),
    ]);
    const $ = cheerio.load(page.text);

    const csrf = $('meta[name="csrf-token"]').attr("content") || "";
    const checkEp = $("#checkEp").attr("value") || "";
    const appUrl = $("#appUrl").attr("value") || client.BASE_URL;

    if (!csrf || !checkEp) {
      result.error = "csrf/checkEp route not found";
      return result;
    }

    const tokenKey = env.MIX_PAGE_TOKEN_KEY;
    const serverKey = env.MIX_STREAM_SERVER_KEY;
    const prefix = env.MIX_PREFIX_AUTH_ROUTE_PARAM;
    const authRoute = env.MIX_AUTH_ROUTE_PARAM;
    const authKey = env.MIX_AUTH_KEY;
    const authToken = env.MIX_AUTH_TOKEN;

    if (!(tokenKey && serverKey && prefix && authRoute)) {
      result.error = "auth js vars not found";
      return result;
    }

    const ajaxHeaders = {
      "X-CSRF-TOKEN": csrf,
      "X-Requested-With": "XMLHttpRequest",
    };

    await client.pace();
    const [checkRes, authRes] = await Promise.all([
      client.get(checkEp, { headers: ajaxHeaders, noPace: true }),
      client.get(`/${prefix}${authRoute}`, {
        headers: {
          ...ajaxHeaders,
          "X-Fuck-ID": `${authKey}:${authToken}`,
          "X-Request-ID": randId(),
          "X-Request-Index": "0",
        },
        noPace: true,
      }),
    ]);
    const pageNum = checkRes.text.trim() || "1";
    const queryToken = authRes.text.trim();

    const pr = await client.post(url, {
      params: { [tokenKey]: queryToken, [serverKey]: server, page: pageNum },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Referer: `${client.BASE_URL}${url}`,
        ...ajaxHeaders,
      },
      body: `authorization=${encodeURIComponent(LEVI_TOKEN)}`,
    });
    const psoup = cheerio.load(pr.text);

    const sources = [];
    psoup('#player source[src]').each((_, s) => {
      const el = psoup(s);
      sources.push({
        size: el.attr("size") || "",
        type: el.attr("type") || "",
        src: el.attr("src") || "",
      });
    });

    const mp4Sources = sources.filter((s) => s.src && s.src.includes(".mp4"));
    const hlsSrc = psoup("#player").attr("data-hls-src") || "";

    if (mp4Sources.length) {
      mp4Sources.sort((a, b) => {
        const qa = parseInt(a.size, 10) || 0;
        const qb = parseInt(b.size, 10) || 0;
        return qb - qa;
      });
      const best = mp4Sources[0];
      result.stream_url = best.src;
      result.type = "mp4";
      result.quality = best.size ? `${best.size}p` : undefined;
      result.sources = mp4Sources.map((s) => ({
        quality: s.size ? `${s.size}p` : null,
        url: s.src,
      }));
      return result;
    }

    if (hlsSrc) {
      result.stream_url = hlsSrc;
      result.type = "m3u8";
      if (blockNonMp4) {
        result.error =
          "hanya tersedia stream m3u8 (HLS); sesuai block_non_mp4=true, m3u8 tidak dikembalikan";
      }
      return result;
    }

    const embedUrl =
      psoup('iframe[src]').first().attr("src") ||
      (pr.text.match(/https:\/\/[a-z.]*mega\.nz\/embed\/[A-Za-z0-9!_-]+/) || [])[0] ||
      "";

    if (embedUrl) {
      result.stream_url = embedUrl;
      result.type = "embed";
      return result;
    }

    result.error = "player kosong (token/session rejected)";
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

module.exports = { getStream, LEVI_TOKEN };
