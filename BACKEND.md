# BACKEND.md — TsukiNime v2 Detail Spec (Backend Side)

> Dokumen ini berisi **pekerjaan backend yang dibutuhkan** supaya Detail Screen v2
> (dan beberapa bagian Home Screen v2) bisa menampilkan data yang sekarang belum
> disediakan. Aplikasi sudah dibangun null-safe: kalau field di bawah belum ada,
> UI akan menyembunyikan komponen terkait (tidak render kosong). Jadi backend
> boleh dikerjakan bertahap tanpa merusak aplikasi.

---

## 1. Latar belakang arsitektur (ringkas)

- `backendnime` = Express 5 + Postgres (Neon) / SQLite. DB-first (`db/db.js` kv store).
- Sumber data: animekita via Cloudflare Worker proxy (`adapter.js` → `apiGet`).
- Route detail: `GET /anime/*splat` → `dbFirst("anime:<slug>", () => adapter.animeDetail(slug), TTL 6 jam)`.
- `adapter.animeDetail()` saat ini (`adapter.js:566`) mengembalikan:
  `animeId, title, poster, banner, score, status, type, synopsis, genres, released, author, totalEpisodes, episodeList[{episodeId, endpoint, title, date, views}], minEpisode, maxEpisode`.

## 2. Field yang dibutuhkan Detail Screen v2

### 2.1 `altTitle` — judul alternatif (opsional)
- Tampil di Detail: judul alternatif 13sp abu-abu, 1 baris ellipsis.
- **Sumber di animekita**: tidak ada field `judul_alt`/`judul_alternatif` di
  `series.php` (data mentah: `judul, type, status, rating, published, author, genre, sinopsis, chapter`).
- **Opsi implementasi**:
  1. cek field `judul` aneh (mis. mengandung `Sub Indo`) → strip seperti `cleanTitle` di app;
  2. jika tidak tersedia, **kembalikan `null`** → app sembunyikan baris ini.
- Tambahkan di respons: `altTitle: <string | null>`.

### 2.2 `scheduleDay` — hari rilis per-anime (untuk badge "📅 Setiap Rabu")
- Tampil HANYA kalau `status == Ongoing`.
- **Sumber**: endpoint `jadwal.php` (sudah dipakai `adapter.schedule()`, lihat `adapter.js:598`).
  Struktur: `data[] = { day: "Rabu", date, date_ts, animeList: [{ anime_name, id, link, cover, updated }] }`.
  `link` = slug anime. Jadi bisa di-*map*: `slug -> day`.
- **Opsi implementasi**:
  1. Saat `animeDetail()` di-*sync*/di-serve, ikut membaca cache `schedule` dan cari slug di `animeList[].link` → dapatkan `day`;
  2. simpan sebagai field baru di DB & respons: `scheduleDay: "Rabu"` (huruf kapital sesuai `jadwal.php`);
  3. kalau anime tidak ketemu di jadwal → `null` (app sembunyikan badge).
- Perhatikan: schedule di-sync tiap 10 mnt (light) — pastikan enrich `scheduleDay` ikut update tanpa memicu full re-sync anime.

### 2.3 anime-level `views` (counter kiri bawah CTA)
- Tampil diformat `12.3K` / `1.2M` (`formatCount` di app). Skip kalau null.
- **Sumber**: animekita `series.php` **tidak punya** views tingkat anime.
  Yang ada: `chapter[].views` per episode.
- **Opsi implementasi**:
  1. `views = sum(chapter[].views)` dari series detail (sudah di-fetch di `animeDetail()`);
  2. atau `null` kalau mau akurat-tanpa-invent. **Rekomendasi: SUM views semua episode** — angka wajar & ada datanya.
- Tambahkan: `views: <int | null>`.

### 2.4 anime-level `subscribers` (counter kanan bawah CTA)
- **Sumber**: tidak ada data subscriber/follower di animekita.
- **Opsi implementasi**:
  1. `subscribers: null` untuk sekarang → app sembunyikan counter kanan;
  2. kalau nanti mau angka: bisa derivasi dari views (mis. `round(views * 0.06)`) — TAPI ini angka bohongan, jangan dulu; cukup `null`.
- Tambahkan: `subscribers: <int | null>`.

### 2.5 episode `thumbnail` (still-frame) — untuk Continue Watching card 16:9
- **Sumber**: animekita `episode/data.php` (`getEpisodeData`) **tidak menyediakan** thumbnail/still-frame. Hanya `streams` + `resoSize`.
- **Opsi implementasi**:
  1. `thumbnail: null` untuk sekarang → app pakai poster sebagai fallback gambar card Continue Watching;
  2. kalau mau real still-frame: generate client-side (MediaMetadataRetriever) — bukan tugas backend, dicatat di app.
- Tambahkan (opsional, nullable): `thumbnail` di objek episode atau di `animeDetail`.

## 3. Cara menambahkan field (pola yang disarankan)

Semua field di atas **nullable** — jangan break kontrak yang sudah ada.

1. `adapter.animeDetail()`: tambahkan `altTitle`, `scheduleDay`, `views`, `subscribers`.
   - `scheduleDay`: cari dari hasil `schedule()` (cache) per slug. Bungkus dalam try/catch, fallback `null`.
   - `views`: `d.chapter.reduce((s, c) => s + (Number(c.views) || 0), 0)`.
2. **Tidak perlu migrate DB** — data kv menyimpan JSON penuh; key lama akan ke-overwrite saat sync berikutnya (TTL detail 6 jam). Tapi kalau mau cepat tampil tanpa nunggu TTL, jalankan `node db/sync.js --details-all` atau hapus key `anime:<slug>`.
3. Update `db/sync_core.js` bila ada *enrichment* khusus di jalur sync (bukan cuma `adapter`).
4. Tambahkan route baru bila perlu: `GET /anime/:slug` cukup; tidak perlu endpoint baru.

## 4. Contoh bentuk respons target

```json
{
  "animeId": "mushoku-tensei-sub-indo",
  "title": "Mushoku Tensei: Isekai Ittara Honki Dasu",
  "altTitle": "Jobless Reincarnation",
  "score": "8.2",
  "status": "Ongoing",
  "scheduleDay": "Rabu",
  "views": 12345,
  "subscribers": null,
  "episodeList": [
    { "episodeId": "...", "title": "Episode 1", "date": "13 Mei, 2026", "views": 1372 }
  ]
}
```

## 5. Urutan prioritas

1. `views` (sum episode) — mudah, data ada.
2. `scheduleDay` — enrich dari cache schedule.
3. `altTitle` — optional, bisa null.
4. `subscribers` — null dulu.
5. episode `thumbnail` — null dulu; kalau mau real, diskusi dulu sumbernya.

## 6. Test

- `node db/test_routes.js` (uji 14 route) — pastikan tidak ada yang error.
- Manual: `GET /anime/:slug` → field baru muncul, null-safe.
- Jangan lupa: commit ke `main` → Railway auto-deploy dari GitHub.
