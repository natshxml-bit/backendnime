const UPSTREAM = "https://apps.animekita.org";
const ANILIST_UPSTREAM = "https://graphql.anilist.co";

async function handleRequest(request) {
  const url = new URL(request.url);
  const TOKEN = (typeof PROXY_TOKEN !== "undefined" && PROXY_TOKEN) || "";

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

  // /anilist/* diteruskan ke GraphQL AniList, selain itu ke animekita.
  const isAnilist = url.pathname.startsWith("/anilist");
  const pathname = isAnilist ? url.pathname.replace(/^\/anilist/, "") : url.pathname;
  const target = new URL((isAnilist ? ANILIST_UPSTREAM : UPSTREAM) + pathname + url.search);
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
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
