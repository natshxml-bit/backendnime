// db/update-relay-url.js — update RELAY_URL di Railway otomatis setiap kali
// URL tunnel cloudflared berubah (set-and-forget, dipanggil boot script).
//
// Butuh di .env (gitignored):
//   RAILWAY_API_TOKEN=<token dari Railway dashboard>
//   RAILWAY_PROJECT_NAME=<opsional, auto-deteksi kalau 1 project>
//   RAILWAY_SERVICE_NAME=<opsional, auto-deteksi kalau 1 service>
//
// Keluar dengan status 0 kalau tidak ada yang perlu di-update (supaya aman
// dipanggil berulang dari loop).

const fs = require("fs");
const path = require("path");

const BASE = path.join(__dirname, "..");
const LOG = path.join(BASE, "db", "cloudflared.log");
const LAST = path.join(BASE, "db", "last-relay-url");

const TOKEN = process.env.RAILWAY_API_TOKEN;
if (!TOKEN) {
  console.error("[relay-url] RAILWAY_API_TOKEN belum di-set di .env");
  process.exit(1);
}

function currentUrl() {
  try {
    const s = fs.readFileSync(LOG, "utf8");
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    return m ? m[0] : null;
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
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
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

  const data = await gql(
    `{ me { projects { id name services { id name } } } }`
  );
  const projects = (data.me && data.me.projects) || [];
  let project = null;
  if (process.env.RAILWAY_PROJECT_NAME) {
    project = projects.find((p) => p.name === process.env.RAILWAY_PROJECT_NAME);
  }
  if (!project && projects.length === 1) project = projects[0];
  if (!project) {
    console.error("[relay-url] project tidak ditemukan. Ada:", projects.map((p) => p.name).join(", "));
    process.exit(1);
  }

  const services = (project.services && project.services) || [];
  let service = null;
  if (process.env.RAILWAY_SERVICE_NAME) {
    service = services.find((s) => s.name === process.env.RAILWAY_SERVICE_NAME);
  }
  if (!service && services.length === 1) service = services[0];
  if (!service) {
    console.error("[relay-url] service tidak ditemukan. Ada:", services.map((s) => s.name).join(", "));
    process.exit(1);
  }

  await gql(
    `mutation variableUpsert($projectId: String!, $serviceId: String!, $name: String!, $value: String!) {
       variableUpsert(projectId: $projectId, serviceId: $serviceId, name: $name, value: $value) { name }
     }`,
    { projectId: project.id, serviceId: service.id, name: "RELAY_URL", value: url }
  );

  // trigger redeploy biar env baru langsung terpakai (non-fatal kalau gagal)
  try {
    await gql(
      `mutation serviceInstanceRedeploy($serviceId: ID!) {
         serviceInstanceRedeploy(serviceId: $serviceId)
       }`,
      { serviceId: service.id }
    );
    console.log("[relay-url] redeploy Railway dipicu");
  } catch (e) {
    console.warn("[relay-url] redeploy gagal (env tetap ter-update):", e.message);
  }

  fs.writeFileSync(LAST, url);
  console.log(`[relay-url] RELAY_URL diupdate → ${url}`);
  process.exit(0);
})().catch((e) => {
  console.error("[relay-url] ERROR:", e.message);
  process.exit(1);
});
