# Alur Folder & Arsitektur TsukiNime

## Arsitektur Keseluruhan

```
┌─────────────┐     HTTPS     ┌─────────────────────┐      ┌──────────────┐
│  APK (HP)   │ ───────────▶ │  Backend Railway     │ ──▶  │  Postgres    │
│ Next.js app │ ◀─────────── │  Node/Express        │      │  (Neon)      │
└─────────────┘   JSON/API   └─────────────────────┘      └──────────────┘
                                        │  (data yang belum ada di DB / sync)
                                        ▼
                               ┌──────────────────────────┐
                               │ Cloudflare Worker proxy  │  (IP Cloudflare)
                               │ animekita-proxy          │
                               └──────────────────────────┘
                                        │
                                        ▼
                               animekita (apps.animekita.org)
```

- **Video/streaming** TIDAK lewat backend: link `.mp4` langsung dari CDN animekita (`storage.animekita.org`) ke HP.
- **Database sendiri** = penyimpanan metadata (home, katalog, detail anime, episode, jadwal, list). Bukan video.
- Kenapa lewat proxy: animekita **memblokir IP datacenter (Railway) → 403**, dan IP Cloudflare (Worker) tidak diblokir (animekita sendiri di balik Cloudflare). Jadi Railway → Worker → animekita, lalu hasilnya disimpan ke Postgres.
- Relay Termux + cloudflared tunnel **sudah dipensiunkan** (cutover 2026-08-11) — Worker terbukti reliable sendirian.

---

## Folder Backend (`backendnime`)

| File/Folder | Fungsi |
|---|---|
| `app.js` | Server Express utama. Semua route **DB-first** (baca database dulu), plus `/db/status`, auto-sync light/heavy. |
| `adapter.js` | Pembungkus API animekita (`home`, `schedule`, `animeDetail`, `data`, `recentDetailed`, `fullList`). Fetch lewat **Cloudflare Worker** (`ANIMEKITA_PROXY_URL`). |
| `watcher.js` | Pemantau episode baru → kirim **notif FCM** ke HP. Baca `/schedule` + `/anime/:slug` + `/watcher-feed` (semua DB). |
| `db/db.js` | Penyimpanan kv: **Postgres** kalau `DATABASE_URL` di-set, **SQLite** (`node:sqlite`) kalau kosong. API: `get/set/del/keysLike/counts`. |
| `db/sync_core.js` | Logika sinkronisasi: `syncHome`, `syncSchedule`, `syncCatalog`, `syncDetails`, `syncOngoing`, `syncEpisodes`, `syncLists`, `syncGenres`, `runSync(opts)`. Incremental: episode/detail yang masih fresh di-skip (TTL). |
| `db/sync.js` | CLI sync: `node db/sync.js --all`, `--catalog`, `--ongoing=N`, `--episodesPer=N`, `--lists=N`, `--genres`, `--genrePages=N`. |
| `db/sync.sh` | Wrapper jadwal sync (dipakai di Termux kalau mau manual). |
| `db/test_routes.js` | Penguji 14 route backend. |
| `data/catalog.db` | Database SQLite lokal (gitignored). |
| `.env` | Kredensial lokal: `DATABASE_URL`, `ANIMEKITA_PROXY_URL`, `ANIMEKITA_PROXY_TOKEN`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `AUTO_SYNC_HOURS`, `LIGHT_SYNC_MIN`. (gitignored, jangan di-commit) |
| `service-account.json` | Firebase untuk notif FCM (gitignored). |
| `package.json` | Deps: express, firebase-admin, pg, node:sqlite. |

---

## Folder Aplikasi (`TsukiNime` — APK)

| File/Folder | Fungsi |
|---|---|
| `app/page.tsx` | Halaman utama (Home). |
| `app/search/` | Pencarian anime. |
| `app/detail/` | Detail anime + daftar episode. |
| `app/watch/` | Pemutar video (streaming). |
| `app/streaming/` | Milik player / sumber stream. |
| `app/schedule/` | Jadwal rilis mingguan. |
| `app/bookmarks/`, `app/history/`, `app/offline/` | Favorit, riwayat, tonton offline. |
| `app/notifications/` | Daftar notif in-app. |
| `app/nobar/` | Mode tanpa iklan (mungkin player khusus). |
| `app/auth/`, `app/profil/`, `app/admin/` | Login, profil, admin. |
| `lib/api.ts` | Klien API backend. |
| `lib/apiBase.ts` | Base URL backend. |
| `lib/offline.ts` | Logika mode offline. |
| `lib/firebase.ts` | Init Firebase (FCM). |
| `components/` | Komponen UI. |
| `design-system/` | Sistem desain. |
| `public/`, `assets/` | Aset statis. |

---

## Alur Data

### 1. Buka aplikasi (browsing home / list / detail)
```
APK → GET /home | /anime/:slug | /list/:type
     → dbFirst(key, liveFn, maxAge):
         DB fresh        → serve langsung dari Postgres/SQLite
         DB basi         → coba ambil live via Worker (animekita) → simpan → serve
         live gagal      → serve data lama (backend tetap jalan walau diblokir)
```

### 2. Episode baru rilis
```
animekita upload ep baru
   → LIGHT SYNC (Railway, tiap 30 mnt): home + schedule + detail 25 anime terbaru
   → HEAVY SYNC (tiap 6 jam): katalog + semua anime ongoing + episode terbaru
   → Postgres update
   → WATCHER (Railway, tiap 10 mnt): baca /schedule + /anime/:slug dari DB
     → jumlah episode naik vs snapshot → kirim NOTIF FCM
   → user buka notif → /episode/:id → putar dari CDN
```
Notif normal ≤ 40 menit setelah rilis (30 mnt sync + 10 mnt poll).

### 3. Tonton episode
```
APK → GET /episode/:id
     → stream tersedia (di-cache saat sync) → langsung putar
     → belum ada di DB → fetch live via Worker → putar dari CDN
```

### 4. Pencarian
```
APK → GET /search/:q → localSearch dari `catalog` (4.759 judul) di database
     → tanpa harus nyentuh animekita
```

---

## Mode Database

| Kondisi | Mode |
|---|---|
| `DATABASE_URL` di-set (Railway/Neon) | **Postgres** (persisten, produksi) |
| `DATABASE_URL` kosong (lokal) | **SQLite** (`data/catalog.db`) |

Bentuk data = key-value:
`home`, `schedule`, `catalog`, `anime:<slug>`, `ep:<url>`, `list:<type>:<page>`, `genre:<slug>:<page>`, `genres`, `sync:last`.

---

## Aturan Penting

- **Sync jalan di Railway** lewat Cloudflare Worker (bukan lagi dari IP rumah). Blokir IP datacenter tidak berlaku karena egress = IP Cloudflare.
- `AUTO_SYNC_HOURS` (heavy, default 6 jam) & `LIGHT_SYNC_MIN` (default 30 mnt) aktif selama `AUTO_SYNC_HOURS > 0`. Sync incremental (TTL) bikin heavy tetap ringan: episode/detail yang masih fresh di-skip.
- Termux **tidak wajib nyala**: database sudah di Postgres (cloud), sync juga jalan di Railway. Termux hanya dipakai kalau mau menjalankan `db/sync.sh` manual.
