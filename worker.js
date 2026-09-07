export default {
  async fetch(request, env) {
    const token = request.headers.get("x-proxy-token");
    if (env.PROXY_TOKEN && token !== env.PROXY_TOKEN) {
      return new Response(JSON.stringify({ error: "proxy token salah" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    const url = new URL(request.url);
    const target = new URL("https://apps.animekita.org" + url.pathname + url.search);
    const headers = {
      "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
      Referer: "https://animekita.org/",
    };
    try {
      const res = await fetch(target.toString(), { headers });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Token",
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  },
};
