# Alur Folder & Arsitektur TsukiNime

## Arsitektur Keseluruhan

```
┌─────────────┐     HTTPS     ┌─────────────────────┐      ┌──────────────┐
│  APK (HP)   │ ───────────▶ │  Backend Railway     │ ──▶  │  Postgres    │
│ Next.js app │ ◀─────────── │  Node/Express        │      │  (Neon)      │
└─────────────┘   JSON/API   └─────────────────────┘      └──────────────┘
                                        │  (data yang belum ada di DB)
                                        ▼
                               ┌─────────────────────┐
                               │  Relay Termux       │  (IP rumah)
                               │  → animekita API    │
                               └─────────────────────┘
                                        │
                                        ▼
                               animekita (apps.animekita.org)
```

- **Video/streaming** TIDAK lewat backend: link `.mp4` langsung dari CDN animekita (`storage.animekita.org`) ke HP.
- **Database sendiri** = penyimpanan metadata (home, katalog, detail anime, episode, jadwal, list). Bukan video.
- Kenapa ada database sendiri: animekita **memblokir IP datacenter (Railway) → 403**. Jadi Railway tidak boleh nyentuh animekita langsung. Semua data ditarik dari **IP rumah (Termux)** lalu disimpan ke Postgres, Railway tinggal baca.

---

## Folder Backend (`backendnime`)

| File/Folder | Fungsi |
|---|---|
| `app.js` | Server Express utama. Semua route **DB-first** (baca database dulu), plus `/relay`, `/db/status`, auto-sync light/heavy. |
| `adapter.js` | Pembungkus API animekita (`home`, `schedule`, `animeDetail`, `data`, `recentDetailed`, `fullList`). Dukung mode **relay** via `RELAY_URL`. |
| `watcher.js` | Pemantau episode baru → kirim **notif FCM** ke HP. Baca `/schedule` + `/anime/:slug` + `/watcher-feed` (semua DB). |
| `db/db.js` | Penyimpanan kv: **Postgres** kalau `DATABASE_URL` di-set, **SQLite** (`node:sqlite`) kalau kosong. API: `get/set/del/keysLike/counts`. |
| `db/sync_core.js` | Logika sinkronisasi: `syncHome`, `syncSchedule`, `syncCatalog`, `syncDetails`, `syncOngoing`, `syncEpisodes`, `syncLists`, `syncGenres`, `runSync(opts)`. |
| `db/sync.js` | CLI sync: `node db/sync.js --all`, `--catalog`, `--ongoing=N`, `--episodesPer=N`, `--lists=N`, `--genres`, `--genrePages=N`. |
| `db/sync.sh` | Wrapper jadwal sync (dipakai di Termux). |
| `db/test_routes.js` | Penguji 14 route backend. |
| `db/test_relay.js` | Penguji jalur relay. |
| `relay.sh` | Menjalankan relay di Termux (port 8000). |
| `data/catalog.db` | Database SQLite lokal (gitignored). |
| `.env` | Kredensial lokal: `DATABASE_URL`, `RELAY_TOKEN`, `AUTO_SYNC_HOURS`, `LIGHT_SYNC_MIN`. (gitignored, jangan di-commit) |
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
         DB basi         → coba ambil live (animekita/relay) → simpan → serve
         live gagal      → serve data lama (backend tetap jalan walau diblokir)
```

### 2. Episode baru rilis
```
animekita upload ep baru
   → LIGHT SYNC (Termux, tiap 30 mnt): home + schedule + detail 25 anime terbaru
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
     → belum ada di DB → lewat RELAY (kalau Termux hidup) → putar dari CDN
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

- **Sync HANYA dari IP rumah/ISP.** Jangan jalankan auto-sync di Railway (kena blokir 403).
- `AUTO_SYNC_HOURS` (heavy, default 6 jam) & `LIGHT_SYNC_MIN` (default 30 mnt) hanya aktif saat `AUTO_SYNC_HOURS > 0`.
- Termux **tidak wajib 24 jam**: database sudah di Postgres (cloud). Kalau Termux mati, APK tetap jalan dengan data terakhir yang tersync; hanya notif episode baru & data long-tail yang berhenti sampai Termux hidup lagi.
- Relay butuh `RELAY_TOKEN` yang sama di backend & Railway.
