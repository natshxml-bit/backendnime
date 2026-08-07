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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const keys = Object.keys(STATUS);
  const todo = keys.filter((k) => !STATUS[k].type || !STATUS[k].eps);
  console.log("entries:", keys.length, "todo:", todo.length);

  let idx = 0;
  let done = 0, filled = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= todo.length) return;
      const slug = todo[i];
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
      if (series) {
        const cur = STATUS[slug] || {};
        STATUS[slug] = {
          s: cur.s,
          t: cur.t,
          type: series.type || cur.type || null,
          eps: Array.isArray(series.chapter) ? series.chapter.length : cur.eps || null,
        };
        if (STATUS[slug].type || STATUS[slug].eps) filled++;
      }
      done++;
      if (done % 50 === 0) saveStatuses();
      if (done % 250 === 0) console.log("progress:", done, "/", todo.length, "filled:", filled);
      await sleep(DELAY);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveStatuses();
  const withType = Object.keys(STATUS).filter((k) => STATUS[k].type).length;
  const withEps = Object.keys(STATUS).filter((k) => STATUS[k].eps != null).length;
  console.log("ENRICH DONE filled:", filled, "withType:", withType, "withEps:", withEps);
  process.exit(0);
})().catch((e) => { console.error("ENRICH ERR", e); process.exit(1); });
