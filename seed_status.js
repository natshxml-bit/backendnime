const fs = require("fs");
const path = require("path");

const API_BASE = "https://apps.animekita.org/api/v1.2.5";
const UA = "Dart/2.19.6 (dart:io)";
const STATUS_FILE = path.join(__dirname, "statuses.json");
const DELAY = 170;
const CONCURRENCY = 4;

let STATUS = {};
try { STATUS = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")) || {}; } catch {}

function saveStatuses() {
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(STATUS)); } catch {}
}

async function apiGet(p, params = {}) {
  const url = new URL(`${API_BASE}/${p}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  let text = await res.text();
  const start = text.search(/[\[{]/);
  if (start >= 0) {
    const open = text[start];
    const close = open === "[" ? "]" : "}";
    const end = text.lastIndexOf(close);
    if (end > start) text = text.slice(start, end + 1);
  }
  const json = JSON.parse(text);
  if (json && typeof json === "object" && json.error) throw new Error(json.error);
  return json;
}

function normalizeStatus(s) {
  if (!s) return null;
  const u = String(s).toUpperCase();
  if (/SELESAI|TAMAT|COMPLETED|FINISHED|ENDED/.test(u)) return "Completed";
  if (/SEDANG TAYANG|ONGOING|AIRING/.test(u)) return "Ongoing";
  return String(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const d = await apiGet("anime-list.php");
  const flat = Array.isArray(d) ? d : Object.values(d).flat().filter(Boolean);
  console.log("full list:", flat.length);
  const todo = flat.filter((item) => {
    const slug = String(item.url || item.link || item.id || "").replace(/^\/+|\/+$/g, "");
    return !STATUS[slug];
  });
  console.log("todo:", todo.length);

  let idx = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= todo.length) return;
      const item = todo[i];
      const slug = String(item.url || item.link || item.id || "").replace(/^\/+|\/+$/g, "");
      let series = null;
      try {
        const res = await apiGet("series.php", { url: slug });
        series = Array.isArray(res.data) ? res.data[0] : null;
      } catch {}
      if (!series || !series.series_id) {
        try {
          const res = await apiGet("series.php", { url: `${slug}/` });
          series = Array.isArray(res.data) ? res.data[0] : null;
        } catch {}
      }
      if (series && series.status) STATUS[slug] = { s: normalizeStatus(series.status), t: Date.now() };
      done++;
      if (done % 50 === 0) saveStatuses();
      if (done % 200 === 0) console.log("progress:", done, "totalKnown:", Object.keys(STATUS).length);
      await sleep(DELAY);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveStatuses();
  console.log("SEED DONE, total:", Object.keys(STATUS).length);
  process.exit(0);
})().catch((e) => { console.error("SEED ERR", e); process.exit(1); });
