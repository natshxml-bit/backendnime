const scraper = require("./scraper");
const stream = require("./stream");
const client = require("./client");
const moov = require("./moov");

const resultCache = new Map();
const MAX_RESULT_CACHE = 300;

function cached(key, ttlMs, fn) {
  const hit = resultCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = Promise.resolve()
    .then(fn)
    .catch((e) => {
      resultCache.delete(key);
      throw e;
    });
  resultCache.set(key, { expires: Date.now() + ttlMs, value });
  if (resultCache.size > MAX_RESULT_CACHE) {
    resultCache.delete(resultCache.keys().next().value);
  }
  return value;
}

const DAY_ORDER = ["senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu"];
const DAY_EN = {
  senin: "monday", selasa: "tuesday", rabu: "wednesday", kamis: "thursday",
  jumat: "friday", sabtu: "saturday", minggu: "sunday",
};

function normalizeStatus(status) {
  if (!status) return "Ongoing";
  const s = String(status).toUpperCase();
  if (/SELESAI|TAMAT|COMPLETED|FINISHED|ENDED/.test(s)) return "Completed";
  if (/SEDANG TAYANG|ONGOING|AIRING/.test(s)) return "Ongoing";
  return status;
}

function pathFromUrl(url) {
  if (!url) return null;
  return String(url).replace(/^https?:\/\/[^/]+/, "");
}

function animePathFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/anime\/(\d+)(\/[^?#]*)?/);
  if (!m) return null;
  let rest = m[2] || "";
  rest = rest.replace(/\/episode\/.*$/, "").replace(/\/batch\/.*$/, "");
  return `/anime/${m[1]}${rest}`;
}

function idFromAnimeUrl(url) {
  const m = String(url || "").match(/\/anime\/(\d+)/);
  return m ? m[1] : null;
}

function parseRef(ref) {
  const m = String(ref || "").match(/(\d+)(?:\/([^/?#]+))?/);
  if (!m) return null;
  return { id: m[1], slug: m[2] || null };
}

function parseEpisodeRef(ref) {
  const m = String(ref || "").match(/\/(\d+)\/([^/?#]+)\/episode\/([0-9]+)(?:\?.*)?$/);
  if (!m) return null;
  return { id: m[1], slug: m[2], ep: m[3] };
}

function cardToTsuki(card) {
  return {
    animeId: idFromAnimeUrl(card.url) || card.url,
    title: card.title,
    poster: card.poster,
    score: null,
    status: normalizeStatus(card.status),
    episode: card.episode,
    type: card.type,
    quality: card.quality,
    genres: [],
  };
}

async function home() {
  const data = await scraper.getHome();
  const recent = (data.hero || []).map((h) => ({
    animeId: idFromAnimeUrl(h.url) || h.url,
    title: h.title,
    poster: h.poster,
    synopsis: h.description,
    banner: h.poster,
    status: "Ongoing",
    genres: [],
  }));
  const section = (name) => ((data.sections || {})[name] || []).map(cardToTsuki);
  return {
    recent,
    ongoing: { animeList: section("Sedang Tayang") },
    completed: { animeList: section("Selesai Tayang") },
    film: { animeList: section("Film Layar Lebar") },
  };
}

async function animeDetail(ref) {
  let parsed = parseRef(ref);
  if (!parsed) throw new Error(`referensi anime tidak valid: ${ref}`);
  let { id, slug } = parsed;
  if (!slug) {
    const r = await client.get(`/anime/${id}`);
    const m = r.url.match(/\/anime\/(\d+)\/([^/?#]+)/);
    if (m) {
      id = m[1];
      slug = m[2];
    }
  }
  const d = await scraper.getDetail(id, slug);
  const info = d.info || {};
  const infoList = (k) => {
    const v = info[k];
    if (!v) return [];
    return (Array.isArray(v) ? v : [v]).map(String);
  };
  const animeId = id;
  const episodeList = (d.episodes || [])
    .filter((ep) => (ep.url || "").includes("/episode/"))
    .map((ep, i) => {
      const epNum = (String(ep.url).match(/\/episode\/(\d+)/) || [])[1];
      const eid = `${animeId}-${epNum || i + 1}`;
      return { episodeId: eid, endpoint: eid, title: ep.title };
    });
  return {
    animeId,
    title: d.title,
    poster: d.poster,
    banner: d.poster,
    score: String(d.score || "").replace(/[^\d.]/g, "") || null,
    status: normalizeStatus(infoList("Status")[0]),
    type: infoList("Tipe")[0] || null,
    synopsis: d.synopsis,
    genres: infoList("Genre"),
    episodeList,
    minEpisode: d.minEpisode || 0,
    maxEpisode: d.maxEpisode || 0,
  };
}

async function animeEpisodePage(ref, page) {
  let parsed = parseRef(ref);
  if (!parsed) throw new Error(`referensi anime tidak valid: ${ref}`);
  let { id, slug } = parsed;
  if (!slug) {
    const r = await client.get(`/anime/${id}`);
    const m = r.url.match(/\/anime\/(\d+)\/([^/?#]+)/);
    if (m) { id = m[1]; slug = m[2]; }
  }
  const eps = await scraper.getEpisodePage(id, slug, page);
  return eps
    .filter((ep) => (ep.url || "").includes("/episode/"))
    .map((ep) => {
      const epNum = (String(ep.url).match(/\/episode\/(\d+)/) || [])[1];
      const eid = `${id}-${epNum}`;
      return { episodeId: eid, endpoint: eid, title: ep.title };
    });
}

async function schedule() {
  const cheerio = require("cheerio");
  const groups = {};

  await Promise.all(
    DAY_ORDER.map(async (day) => {
      let html = "";
      try {
        const r = await client.get(`/schedule?scheduled_day=${DAY_EN[day]}`);
        html = r.text;
      } catch (e) {
        html = "";
      }
      const $ = cheerio.load(html || "<html></html>");
      const list = [];
      $(".product__item").each((_, el) => {
        const item = $(el);
        const href = item.find("a[href]").first().attr("href") || "";
        const epText = (item.find("span[class^=actual-schedule-ep]").text() || "")
          .replace(/selanjutnya:\s*/i, "")
          .replace(/\s+/g, " ")
          .trim();
        const card = {
          animeId: idFromAnimeUrl(href) || href,
          title: item.find(".product__item__text h5 a").first().text().trim(),
          poster: item.find(".product__item__pic").attr("data-setbg") || "",
          episode: epText || (item.find(".ep").text() || "").replace(/\s+/g, " ").trim(),
          day,
          status: normalizeStatus(item.find(".d-none span").first().text().trim()),
          genres: [],
        };
        if (card.title) list.push(card);
      });
      groups[day] = list;
    })
  );

  return DAY_ORDER.filter((d) => groups[d] && groups[d].length).map((day) => ({
    day,
    anime_list: groups[day],
  }));
}

async function genres() {
  const r = await client.get("/");
  const $ = require("cheerio").load(r.text);
  const seen = new Set();
  const out = [];
  $('a[href*="/properties/genre/"]').each((_, a) => {
    const el = $(a);
    const title = el.text().trim();
    const href = el.attr("href") || "";
    const endpoint = href.split("/").filter(Boolean).pop();
    if (title && endpoint && !seen.has(endpoint)) {
      seen.add(endpoint);
      out.push({ title, endpoint });
    }
  });
  return out;
}

function listOf(d) {
  return {
    type: d.type,
    page: d.page,
    animeList: (d.items || []).map(cardToTsuki),
    pagination: d.pagination,
    has_next: d.has_next,
    next_page: d.next_page,
  };
}

async function ongoing(page = 1) {
  return listOf(await scraper.getList("ongoing", page));
}

async function complete(page = 1) {
  return listOf(await scraper.getList("finished", page));
}

async function listByType(type, page = 1) {
  return listOf(await scraper.getList(type, page));
}

async function byGenre(slug, page = 1) {
  const d = await scraper.getProperties("genre", slug, page);
  return {
    genre: slug,
    page,
    genreList: (d.items || []).map(cardToTsuki),
    animeList: (d.items || []).map(cardToTsuki),
  };
}

async function searchQuery(q) {
  const results = await scraper.search(q, 30);
  const animeList = results.map((r) => ({
    animeId: idFromAnimeUrl(r.url) || r.url,
    title: r.title,
    poster: r.poster,
    genres: [],
  }));
  return { query: q, animeList, results };
}

function serverRef(serverId, animeId, slug, ep) {
  return `${serverId}:${animeId}:${slug}:${ep}`;
}

function parseServerRef(ref) {
  const parts = String(ref || "").split(":");
  if (parts.length < 4) return null;
  const [serverId, animeId, slug, ep] = parts;
  return { serverId, animeId, slug, ep };
}

async function episode(slug) {
  let ref = parseEpisodeRef(slug);
  if (!ref) {
    const m = String(slug).match(/^(\d+)-(\d+)$/);
    if (m) ref = { id: m[1], slug: null, ep: m[2] };
  }
  if (!ref) throw new Error(`referensi episode tidak valid: ${slug}`);

  let { id, slug: eSlug, ep } = ref;
  if (!eSlug) {
    const r = await client.get(`/anime/${id}`);
    const m = r.url.match(/\/anime\/(\d+)\/([^/?#]+)/);
    if (!m) throw new Error(`slug episode tidak ditemukan untuk anime ${id}`);
    id = m[1];
    eSlug = m[2];
  }

  const key = `/anime/${id}/${eSlug}/episode/${ep}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const d = await scraper.getEpisode(id, eSlug, ep);
    const servers = d.servers || [];
    const preferred =
      servers.find((s) => /kuramadrive/i.test(s.id)) || servers[0] || null;

    const qualities = [];
    let defaultStreamingUrl;

    if (preferred) {
      try {
        const st = await stream.getStream(id, eSlug, ep, preferred.id, true);
        if (st.type === "mp4" && Array.isArray(st.sources) && st.sources.length) {
          for (const src of st.sources) {
            qualities.push({
              title: src.quality || "SD",
              serverList: [
                { title: preferred.name || preferred.id, url: src.url, quality: src.quality },
              ],
            });
            if (src.url && !/r2\.cloudflarestorage\.com/.test(src.url)) {
              moov.prefetch(src.url);
            }
          }
          defaultStreamingUrl = st.stream_url;
        } else if (st.type === "mp4" && st.stream_url) {
          qualities.push({
            title: "Default",
            serverList: [{ title: preferred.name || preferred.id, url: st.stream_url }],
          });
          defaultStreamingUrl = st.stream_url;
        }
      } catch (_) {
        /* preferred server gagal resolve; fallback ke lazy list */
      }
    }

    const lazyServers = servers
      .filter((s) => !preferred || s.id !== preferred.id)
      .map((s) => ({
        title: s.name || s.id,
        serverId: serverRef(s.id, id, eSlug, ep),
      }));

    if (lazyServers.length) {
      const dg = qualities.find((q) => q.title.toLowerCase() === "default");
      if (dg) dg.serverList.push(...lazyServers);
      else qualities.push({ title: "Default", serverList: lazyServers });
    }

    return {
      episodeId: `${id}-${ep}`,
      title: d.title,
      animeTitle: d.anime_title,
      defaultStreamingUrl,
      streamUrl: defaultStreamingUrl,
      server: { qualities },
      servers: servers.map((s) => ({
        title: s.name || s.id,
        serverId: serverRef(s.id, id, eSlug, ep),
      })),
    };
  });
}

async function server(id) {
  const ref = parseServerRef(id);
  if (!ref) throw new Error(`referensi server tidak valid: ${id}`);
  return cached(id, 10 * 60 * 1000, async () => {
    const st = await stream.getStream(
      ref.animeId,
      ref.slug,
      ref.ep,
      ref.serverId,
      true
    );
    if (st.type === "mp4" && st.stream_url) {
      return {
        url: st.stream_url,
        type: "mp4",
        quality: st.quality,
        sources: st.sources,
      };
    }
    return {
      url: null,
      error: st.error || `server ${ref.serverId} tidak menyediakan stream mp4`,
    };
  });
}

module.exports = {
  home,
  animeDetail,
  animeEpisodePage,
  schedule,
  genres,
  ongoing,
  complete,
  listByType,
  byGenre,
  searchQuery,
  episode,
  server,
  normalizeStatus,
  animePathFromUrl,
  parseRef,
  parseEpisodeRef,
};
