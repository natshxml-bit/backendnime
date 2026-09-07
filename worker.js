// Animekita API proxy — universal Worker untuk multi-account rotation.
// Deploy ini di beberapa akun Cloudflare (beda email), masing-masing jadi
// URL *.workers.dev berbeda. Backend Railway round-robin ke worker pool
// via lib/workers.js. AnimeLovers V3 & NanimeID Merdeka pakai pola
// multi-source fallback untuk hindari CF IP block.
//
// Env vars (Cloudflare dashboard → Worker → Settings → Variables):
//   PROXY_TOKEN: shared secret sama dengan ANIMEKITA_PROXY_TOKEN di Railway

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Token",
        },
      });
    }

    // Auth
    const token = request.headers.get("x-proxy-token");
    if (env.PROXY_TOKEN && token !== env.PROXY_TOKEN) {
      return new Response(JSON.stringify({ error: "proxy token salah" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Mode 1: forward animekita API path
    // GET /<path>?<params> → https://apps.animekita.org/<path>?<params>
    if (url.pathname !== "/" && !url.pathname.startsWith("/scrape")) {
      const target = new URL("https://apps.animekita.org" + url.pathname + url.search);
      return proxyFetch(target.toString(), request, env);
    }

    // Mode 2: relay to user-supplied Termux/local server (jika diset)
    // GET /relay?url=<upstream>  → fetch upstream, return body
    if (url.pathname === "/relay" || url.pathname.startsWith("/relay/")) {
      const upstream = url.searchParams.get("url");
      if (!upstream) return new Response(JSON.stringify({ error: "url param wajib" }), { status: 400, headers: { "Content-Type": "application/json" } });
      return proxyFetch(upstream, request, env);
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, worker: "animekita-proxy" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify({ error: "path tidak dikenal" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  },
};

async function proxyFetch(target, request, env) {
  // Random User-Agent per request supaya animekita sees different "browser"
  const UA_LIST = [
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  ];
  const ua = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

  // Random delay 100-400ms supaya gak burst pattern
  await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 300)));

  const headers = {
    "User-Agent": ua,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: "https://animekita.org/",
    Origin: "https://animekita.org",
  };

  try {
    const res = await fetch(target, {
      method: "GET",
      headers,
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const text = await res.text();
    // Sanitize JSON (animekita kadang punya garbage prefix/suffix)
    const start = text.search(/[\[{]/);
    let body = text;
    if (start >= 0 && start > 0) {
      const open = text[start];
      const close = open === "[" ? "]" : "}";
      const end = text.lastIndexOf(close);
      if (end > start) body = text.slice(start, end + 1);
    }

    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Token",
        "X-Worker-Zone": request.cf?.colo || "unknown",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
