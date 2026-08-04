const cheerio = require("cheerio");
const client = require("./client");

function text(el) {
  if (!el) return "";
  return (el.text() || "").replace(/\s+/g, " ").trim();
}

function parseCard(item, $) {
  const link = item.find("a[href]").first();
  const href = link.attr("href") || "";
  const pic = item.find(".product__item__pic");
  const poster = pic.attr("data-setbg") || "";
  const ep = text(pic.find(".ep"));
  const status = text(item.find(".d-none span")) || null;
  const badges = item
    .find(".product__item__text li")
    .toArray()
    .map((li) => text($(li)))
    .filter(Boolean);
  const h5 = item.find(".product__item__text h5 a").first();
  const title = text(h5);
  return {
    title,
    url: href,
    poster,
    episode: ep,
    status,
    type: badges[0] || null,
    quality: badges[1] || null,
    is_episode: href.includes("/episode/"),
  };
}

function parseCards($, scope) {
  const items = scope ? scope.find(".product__item") : $(".product__item");
  return items.map((_, el) => parseCard($(el), $)).get();
}

async function getHome() {
  const r = await client.get("/");
  const $ = cheerio.load(r.text);
  const sections = {};
  $(".trending__product").each((_, section) => {
    const titleEl = $(section).find(".section-title h4, .section-title h5").first();
    const title = text(titleEl);
    if (title) sections[title] = parseCards($, $(section));
  });

  const hero = [];
  $(".hero__items").each((_, h) => {
    const el = $(h);
    const btn = el.find(".hero__details__button");
    const link = btn.closest("a[href]");
    const url = link.attr("href") || el.find('a[href*="/anime/"]').first().attr("href") || "";
    hero.push({
      title: text(el.find(".hero__text h2").first()),
      url,
      poster: el.attr("data-setbg") || "",
      description: text(el.find(".hero__text p").first()),
    });
  });

  return { hero, sections };
}

async function getList(listType, page = 1, orderBy = "updated") {
  const r = await client.get(`/quick/${listType}`, {
    params: { page, order_by: orderBy },
  });
  const $ = cheerio.load(r.text);
  const data = {
    type: listType,
    page,
    items: parseCards($),
  };

  const nums = [];
  $(".product__pagination a").each((_, a) => {
    const el = $(a);
    if (el.hasClass("current-page")) {
      nums.push({ page: parseInt(text(el), 10), current: true, url: null });
    } else {
      const m = (el.attr("href") || "").match(/[?&]page=(\d+)/);
      if (m) {
        nums.push({
          page: parseInt(m[1], 10),
          current: false,
          url: el.attr("href"),
        });
      }
    }
  });
  if (nums.length) {
    const last = nums[nums.length - 1];
    data.pagination = nums;
    data.has_next = !last.current;
    data.next_page = last.current ? null : last.page;
  }
  return data;
}

async function getProperties(prop, value, page = 1, orderBy = "updated") {
  const r = await client.get(`/properties/${prop}/${value}`, {
    params: { page, order_by: orderBy },
  });
  const $ = cheerio.load(r.text);
  return {
    property: prop,
    value,
    page,
    items: parseCards($),
  };
}

async function search(keyword, limit = 10) {
  const r = await client.get("/quicksearch/get", { params: { search: keyword, quicksearch: 1 } });
  let html = r.text;
  try {
    const payload = JSON.parse(r.text);
    html = payload.html || "";
  } catch (_) {
    /* plain html fallback */
  }
  const $ = cheerio.load(html);
  const results = [];
  $(".search__result__anchor").each((_, a) => {
    const el = $(a);
    const pic = el.find(".search__result__pic").first();
    results.push({
      title: text(el.find(".title").first()),
      url: el.attr("href") || "",
      poster: pic.attr("data-setbg") || "",
      meta: text(el.find(".alt__titles").first()),
    });
  });
  return limit ? results.slice(0, limit) : results;
}

function parseInfoWidget($) {
  const info = {};
  $(".anime__details__widget li").each((_, li) => {
    const el = $(li);
    const label = text(el.find("span").first()).replace(/:+$/, "");
    const vals = el
      .find(".col-9 a, .col-9 span")
      .map((_, v) => text($(v)).replace(/,$/, "").trim())
      .get()
      .filter(Boolean);
    if (label) {
      info[label] = vals.length > 1 ? vals : vals.length ? vals[0] : null;
    }
  });
  return info;
}

function parseEpisodesFromDataContent(dataContent) {
  if (!dataContent) return [];
  const pop = cheerio.load(dataContent.replace(/\\'/g, "'"));
  const episodes = [];
  pop("a[href*='/episode/']").each((_, a) => {
    episodes.push({ title: text(pop(a)), url: pop(a).attr("href") });
  });
  pop("a[href*='/batch/']").each((_, a) => {
    episodes.push({ title: text(pop(a)), url: pop(a).attr("href") });
  });
  return episodes;
}

function extractEpisodeRange(dataContent) {
  if (!dataContent) return { min: 0, max: 0, count: 0 };
  const nums = [...dataContent.matchAll(/\/episode\/(\d+)/g)].map((m) =>
    parseInt(m[1], 10)
  );
  if (!nums.length) return { min: 0, max: 0, count: 0 };
  return {
    min: Math.min(...nums),
    max: Math.max(...nums),
    count: new Set(nums).size,
  };
}

async function getDetail(animeId, slug) {
  const r = await client.get(`/anime/${animeId}/${slug}`);
  const $ = cheerio.load(r.text);

  const pic = $(".anime__details__pic").first();
  const poster = pic.attr("data-setbg") || "";
  const score = text(pic.find(".ep").first());

  const titleWrap = $(".anime__details__title").first();
  const title = text(titleWrap.find("h3").first());
  const altSpans = titleWrap.find("span");
  const altTitles = text(altSpans.last());

  const synopsis = text($("#synopsisField").first());

  const popover = $("#episodeLists").first();
  const dataContent = popover.attr("data-content");

  let episodes = parseEpisodesFromDataContent(dataContent);

  const range = extractEpisodeRange(dataContent);

  const seen = new Set();
  const deduped = [];
  for (const ep of episodes) {
    const m = (ep.url || "").match(/\/episode\/(\d+)/);
    const epNum = m ? parseInt(m[1], 10) : null;
    if (!epNum) continue;
    if (/(?:Terlama|Terbaru)/.test(ep.title || "")) continue;
    if (seen.has(epNum)) continue;
    seen.add(epNum);
    deduped.push({ title: `Ep ${epNum}`, url: ep.url });
  }
  deduped.sort((a, b) => {
    const na = parseInt((a.url || "").match(/\/episode\/(\d+)/)?.[1] || "0", 10);
    const nb = parseInt((b.url || "").match(/\/episode\/(\d+)/)?.[1] || "0", 10);
    return na - nb;
  });

  return {
    id: animeId,
    slug,
    title,
    alternative_titles: altTitles,
    poster,
    score,
    synopsis,
    info: parseInfoWidget($),
    episodes: deduped,
    minEpisode: range.min,
    maxEpisode: range.max,
  };
}

async function getEpisodePage(animeId, slug, page) {
  const r = await client.get(`/anime/${animeId}/${slug}?page=${page}`);
  const $ = cheerio.load(r.text);
  const popover = $("a#episodeLists").first();
  const dataContent = popover.attr("data-content");
  let episodes = parseEpisodesFromDataContent(dataContent);

  const seen = new Set();
  const deduped = [];
  for (const ep of episodes) {
    const m = (ep.url || "").match(/\/episode\/(\d+)/);
    const epNum = m ? parseInt(m[1], 10) : null;
    if (!epNum) continue;
    if (/(?:Terlama|Terbaru)/.test(ep.title || "")) continue;
    if (seen.has(epNum)) continue;
    seen.add(epNum);
    deduped.push({ title: `Ep ${epNum}`, url: ep.url });
  }
  deduped.sort((a, b) => {
    const na = parseInt((a.url || "").match(/\/episode\/(\d+)/)?.[1] || "0", 10);
    const nb = parseInt((b.url || "").match(/\/episode\/(\d+)/)?.[1] || "0", 10);
    return na - nb;
  });
  return deduped;
}

async function getEpisode(animeId, slug, ep) {
  const r = await client.get(`/anime/${animeId}/${slug}/episode/${ep}`);
  const $ = cheerio.load(r.text);

  const title = text($("#episodeTitle").first());
  const m = title.match(/^(.*?)\s*\(Episode\s*[\d]+\)/);
  const animeTitle = m ? m[1].trim() : title;

  const servers = $("#changeServer option")
    .map((_, o) => ({ id: $(o).attr("value"), name: text($(o)) }))
    .get();

  const episodes = [];
  $("#animeEpisodes a.ep-button[href*='/episode/']").each((_, a) => {
    episodes.push({ title: text($(a)), url: $(a).attr("href") });
  });

  return {
    id: animeId,
    slug,
    episode: ep,
    title,
    anime_title: animeTitle,
    servers,
    episodes,
  };
}

module.exports = {
  getHome,
  getList,
  getProperties,
  search,
  getDetail,
  getEpisode,
  getEpisodePage,
};
