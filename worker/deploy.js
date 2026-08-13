const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Auto-load .env (Termux/PC) biar gak perlu export manual dulu.
try {
  const envFile = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || m[1].startsWith("#")) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch {}

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const SECRET = process.env.PROXY_TOKEN;
const NAME = process.env.WORKER_NAME || "animekita-proxy";

if (!TOKEN || !ACCOUNT_ID || !SECRET) {
  console.error("Set CF_API_TOKEN, CF_ACCOUNT_ID, PROXY_TOKEN dulu.");
  console.error("Contoh:");
  console.error("  export CF_API_TOKEN=xxx  # token Workers Scripts:Edit (Dashboard > My Profile > API Tokens)");
  console.error("  export CF_ACCOUNT_ID=xxx  # ambil di kanan dashboard akun Cloudflare");
  console.error("  export PROXY_TOKEN=rahasia-abc123");
  process.exit(1);
}

const API = "https://api.cloudflare.com/client/v4";
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function req(method, url, body, rawHeaders) {
  const r = await fetch(url, {
    method,
    headers: rawHeaders || H,
    body,
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  if (r.status >= 400 || (j && j.success === false)) {
    throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  }
  return j;
}

function multipart(mainModule, jsContent) {
  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          body_part: mainModule,
          compatibility_date: "2025-01-01",
          compatibility_flags: ["global_fetch_strictly_public"],
        }),
      ],
      { type: "application/json" }
    )
  );
  form.append(
    mainModule,
    new Blob([jsContent], { type: "application/javascript" })
  );
  return { body: form, headers: { Authorization: H.Authorization } };
}

(async () => {
  const jsContent = fs.readFileSync(path.join(__dirname, "src", "index.js"), "utf8");

  console.log("> upload worker script...");
  await req("PUT", `${API}/accounts/${ACCOUNT_ID}/workers/scripts/${NAME}`, multipart("index.js", jsContent).body, multipart("index.js", jsContent).headers);

  console.log("> set secret PROXY_TOKEN...");
  await req("PUT", `${API}/accounts/${ACCOUNT_ID}/workers/scripts/${NAME}/secrets`, JSON.stringify({ name: "PROXY_TOKEN", type: "secret_text", text: SECRET }));

  let subdomain = "";
  try {
    const sd = await req("GET", `${API}/accounts/${ACCOUNT_ID}/workers/subdomain`);
    subdomain = sd.result.subdomain;
  } catch {}

  const url = subdomain ? `https://${NAME}.${subdomain}.workers.dev` : `https://${NAME}.<subdomain>.workers.dev`;
  console.log("\nDONE. Worker URL: " + url);
  console.log("Set di Railway env:");
  console.log(`  ANIMEKITA_PROXY_URL=${url}`);
  console.log(`  ANIMEKITA_PROXY_TOKEN=${SECRET}`);
})().catch((e) => { console.error("DEPLOY FAIL:", e.message); process.exit(1); });
