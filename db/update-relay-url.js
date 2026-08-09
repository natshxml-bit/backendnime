// db/update-relay-url.js — update RELAY_URL di Railway otomatis setiap kali
// URL tunnel cloudflared berubah (set-and-forget, dipanggil boot script).
//
// Konfigurasi di .env (gitignored). Bisa pakai ID langsung atau nama:
//   RAILWAY_API_TOKEN=<token>
//   RAILWAY_PROJECT_ID / RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID (opsional)
//   RAILWAY_PROJECT_NAME / RAILWAY_SERVICE_NAME (fallback auto-detect)
//
// Keluar dengan status 0 kalau tidak ada yang perlu di-update (aman dipanggil
// berulang dari loop). Upsert variable otomatis memicu redeploy di Railway.

const fs = require("fs");
const path = require("path");

const BASE = path.join(__dirname, "..");
const LOG = path.join(BASE, "db", "cloudflared.log");
const LAST = path.join(BASE, "db", "last-relay-url");

function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(BASE, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || m[1].startsWith("#")) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {}
}
loadEnv();

const TOKEN = process.env.RAILWAY_API_TOKEN;
if (!TOKEN) {
  console.error("[relay-url] RAILWAY_API_TOKEN belum di-set di .env");
  process.exit(1);
}

function currentUrl() {
  try {
    const s = fs.readFileSync(LOG, "utf8");
    const ms = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return ms ? ms[ms.length - 1] : null;
  } catch {
    return null;
  }
}

async function gql(query, variables) {
  const r = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors && j.errors.length) {
    throw new Error(j.errors.map((e) => e.message).join(" | "));
  }
  return j.data;
}

(async () => {
  const url = currentUrl();
  if (!url) {
    console.error("[relay-url] URL tunnel belum ketemu di cloudflared.log");
    process.exit(1);
  }
  let last = null;
  try {
    last = fs.readFileSync(LAST, "utf8").trim();
  } catch {}
  if (last === url) {
    console.log("[relay-url] URL sama, tidak perlu update");
    process.exit(0);
  }

  let projectId = process.env.RAILWAY_PROJECT_ID;
  let serviceId = process.env.RAILWAY_SERVICE_ID;
  let environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  if (!projectId || !serviceId || !environmentId) {
    const data = await gql(
      `{ projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } }`
    );
    const projects = (data.projects && data.projects.edges || []).map((e) => e.node);
    let project = projects.find((p) => p.name === process.env.RAILWAY_PROJECT_NAME) || (projects.length === 1 ? projects[0] : null);
    if (!project) {
      console.error("[relay-url] project tidak ditemukan. Ada:", projects.map((p) => p.name).join(", "));
      process.exit(1);
    }
    projectId = project.id;
    if (!serviceId) {
      const services = (project.services && project.services.edges || []).map((e) => e.node);
      serviceId = (services.find((s) => s.name === process.env.RAILWAY_SERVICE_NAME) || (services.length === 1 ? services[0] : null))?.id;
      if (!serviceId) {
        console.error("[relay-url] service tidak ditemukan. Ada:", services.map((s) => s.name).join(", "));
        process.exit(1);
      }
    }
    if (!environmentId) {
      const envs = (project.environments && project.environments.edges || []).map((e) => e.node);
      environmentId = (envs.find((e) => e.name === "production") || envs[0])?.id;
      if (!environmentId) {
        console.error("[relay-url] environment tidak ditemukan");
        process.exit(1);
      }
    }
  }

  await gql(
    `mutation variableUpsert($input: VariableUpsertInput!) {
       variableUpsert(input: $input)
     }`,
    {
      input: {
        environmentId,
        projectId,
        serviceId,
        name: "RELAY_URL",
        value: url,
        skipDeploys: false,
      },
    }
  );

  fs.writeFileSync(LAST, url);
  console.log(`[relay-url] RELAY_URL diupdate → ${url}`);
  process.exit(0);
})().catch((e) => {
  console.error("[relay-url] ERROR:", e.message);
  process.exit(1);
});
