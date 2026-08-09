// db/db.js — penyimpanan kunci-nilai (kv) untuk katalog + cache.
//
// Dua mode:
//   - Postgres: bila DATABASE_URL di-set (Railway/produksi). Persisten.
//   - SQLite  : fallback lokal (Termux/PC) lewat node:sqlite bawaan.
//
// API sama untuk kedua mode: get/set/del/keysLike/counts.

const fs = require("fs");
const path = require("path");

const SQLITE_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "catalog.db");

let _mode = null;
let _pg = null;
let _sqlite = null;

function mode() {
  if (_mode) return _mode;
  _mode = process.env.DATABASE_URL ? "pg" : "sqlite";
  return _mode;
}

async function initPg() {
  if (_pg) return _pg;
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PG_SSL === "false" ? false : { rejectUnauthorized: false },
  });
  // Jangan biarkan error koneksi (mis. ECONNABORTED / pool idle timeout) nge-crash
  // proses. Pool akan membuat koneksi baru otomatis.
  pool.on("error", (err) => {
    console.error("[db:pg] pool error (diabaikan):", err.message);
  });
  await pool.query(
    `CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at BIGINT
    )`
  );
  _pg = pool;
  return pool;
}

function initSqlite() {
  if (_sqlite) return _sqlite;
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  _sqlite = new DatabaseSync(SQLITE_PATH);
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at INTEGER
    );
  `);
  return _sqlite;
}

async function get(key) {
  if (mode() === "pg") {
    const pool = await initPg();
    const { rows } = await pool.query(
      "SELECT value_json, updated_at FROM kv WHERE key = $1",
      [key]
    );
    if (!rows.length) return null;
    return { value: JSON.parse(rows[0].value_json), updatedAt: Number(rows[0].updated_at) };
  }
  const row = initSqlite()
    .prepare("SELECT value_json, updated_at FROM kv WHERE key = ?")
    .get(key);
  if (!row) return null;
  return { value: JSON.parse(row.value_json), updatedAt: row.updated_at };
}

async function set(key, value) {
  const now = Date.now();
  const json = JSON.stringify(value);
  if (mode() === "pg") {
    const pool = await initPg();
    await pool.query(
      `INSERT INTO kv (key, value_json, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         updated_at = EXCLUDED.updated_at`,
      [key, json, now]
    );
    return;
  }
  initSqlite()
    .prepare(
      `INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    )
    .run(key, json, now);
}

async function del(key) {
  if (mode() === "pg") {
    const pool = await initPg();
    await pool.query("DELETE FROM kv WHERE key = $1", [key]);
    return;
  }
  initSqlite().prepare("DELETE FROM kv WHERE key = ?").run(key);
}

async function keysLike(pattern) {
  if (mode() === "pg") {
    const pool = await initPg();
    const { rows } = await pool.query(
      "SELECT key FROM kv WHERE key LIKE $1 ORDER BY updated_at DESC",
      [pattern]
    );
    return rows.map((r) => r.key);
  }
  const rows = initSqlite()
    .prepare("SELECT key FROM kv WHERE key LIKE ? ORDER BY updated_at DESC")
    .all(pattern);
  return rows.map((r) => r.key);
}

async function counts() {
  const c = { catalog: 0, anime: 0, episodes: 0, lists: 0, home: false, schedule: false, genres: false };
  if (mode() === "pg") {
    const pool = await initPg();
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE key = 'catalog')     AS catalog,
         COUNT(*) FILTER (WHERE key LIKE 'anime:%')  AS anime,
         COUNT(*) FILTER (WHERE key LIKE 'ep:%')     AS episodes,
         COUNT(*) FILTER (WHERE key LIKE 'list:%')   AS lists,
         COUNT(*) FILTER (WHERE key = 'home')        AS home,
         COUNT(*) FILTER (WHERE key = 'schedule')    AS schedule,
         COUNT(*) FILTER (WHERE key = 'genres')      AS genres
       FROM kv`
    );
    const r = rows[0];
    c.catalog = Number(r.catalog) > 0;
    c.anime = Number(r.anime);
    c.episodes = Number(r.episodes);
    c.lists = Number(r.lists);
    c.home = Number(r.home) > 0;
    c.schedule = Number(r.schedule) > 0;
    c.genres = Number(r.genres) > 0;
    return c;
  }
  const db = initSqlite();
  c.catalog = !!(await get("catalog"));
  c.anime = db.prepare("SELECT COUNT(*) c FROM kv WHERE key LIKE 'anime:%'").get().c;
  c.episodes = db.prepare("SELECT COUNT(*) c FROM kv WHERE key LIKE 'ep:%'").get().c;
  c.lists = db.prepare("SELECT COUNT(*) c FROM kv WHERE key LIKE 'list:%'").get().c;
  c.home = !!(await get("home"));
  c.schedule = !!(await get("schedule"));
  c.genres = !!(await get("genres"));
  return c;
}

module.exports = { get, set, del, keysLike, counts, mode, DB_PATH: SQLITE_PATH };
