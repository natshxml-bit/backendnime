const UPSTREAM = "https://apps.animekita.org";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const TOKEN = env.PROXY_TOKEN || "";

    if (url.pathname === "/__health") {
      return new Response("ok", { status: 200 });
    }

    const authed =
      TOKEN !== "" &&
      (request.headers.get("x-proxy-token") === TOKEN ||
        url.searchParams.get("token") === TOKEN);
    if (!authed) {
      return new Response("forbidden", { status: 403 });
    }

    const target = new URL(UPSTREAM + url.pathname + url.search);
    const headers = {
      "User-Agent": "Dart/2.19.6 (dart:io)",
      Accept: "application/json",
    };
    const init = { method: request.method, headers };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.headers["Content-Type"] =
        request.headers.get("Content-Type") || "application/json";
    }

    const upstream = await fetch(target, init);
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
