# FRONTEND.md — TsukiNime Detail Screen v2 (Frontend Side)

> Dokumen pendamping **BACKEND.md** — mendokumentasikan perubahan **frontend**
> yang harus dipakai Detail Screen v2 sekarang bahwa backend sudah menyediakan
> field-field baru. Backend **sudah live** di produksi (deploy `074a078c`,
> 2026-08-12), jadi kontrak di bawah sudah bisa langsung dikonsumsi.

---

## 1. Latar belakang

- Backend (`backendnime` / Express + Postgres) kini mengembalikan field tambahan
  di `GET /anime/:slug` (dan tersimpan juga di DB saat sync detail).
- Semua field **nullable / null-safe** — aplikasi harus menyembunyikan komponen
  kalau nilainya `null` (bukan render kosong/error).
- Base URL backend: `https://backendnime.up.railway.app`

---

## 2. Field baru yang tersedia

| Field | Tipe | Kapan tampil | Komponen di UI |
|---|---|---|---|
| `views` | `int \| null` | selalu (kalau > 0) | Counter kiri bawah CTA, format `12.3K` / `1.2M` (`formatCount`) |
| `scheduleDay` | `string \| null` | HANYA kalau `status == "Ongoing"` dan ada di jadwal | Badge `📅 Setiap <Hari>` |
| `altTitle` | `string \| null` | kalau tidak null | Judul alternatif 13sp abu-abu, 1 baris ellipsis |
| `subscribers` | `int \| null` | `null` untuk sekarang → sembunyikan counter kanan | Counter kanan bawah CTA |
| episode `thumbnail` | `string \| null` | `null` untuk sekarang → fallback poster | Still-frame 16:9 kartu Continue Watching |

---

## 3. Cara render (aturan null-safe)

1. **`views`** — selalu cek dulu:
   ```ts
   if (detail.views != null) <Text>{formatCount(detail.views)}</Text>
   ```
   `formatCount`: < 1000 → asli; < 1.000.000 → `12.3K`; ≥ 1.000.000 → `1.2M`.

2. **`scheduleDay`** — badge cuma untuk Ongoing:
   ```ts
   {detail.status === "Ongoing" && detail.scheduleDay
     ? <Badge>📅 Setiap {detail.scheduleDay}</Badge>
     : null}
   ```
   Catatan: `scheduleDay` bernilai seperti `"Rabu"` (huruf kapital) — hasil enrich
   dari `jadwal.php`; kalau anime tidak terjadwal → `null`.

3. **`altTitle`** — kalau ada, tampil 1 baris ellipsis, abu-abu 13sp, di bawah
   judul utama. Kalau `null` → jangan render baris ini sama sekali.

4. **`subscribers`** — sekarang `null`; jangan tampilkan counter kanan. Kalau
   suatu saat diisi angka, tampilkan dengan `formatCount` simetris di kanan.

5. **episode `thumbnail`** — sekarang `null`; kartu Continue Watching pakai
   `poster` anime sebagai fallback gambar (rasio 16:9 via `objectFit: "cover"`).

---

## 4. Contoh respons nyata (terverifikasi, 2026-08-12)

`GET /anime/tadaima-ojamasaremasu-sub-indo` (Ongoing, terjadwal Rabu):

```json
{
  "animeId": "tadaima-ojamasaremasu-sub-indo",
  "title": "Tadaima, Ojamasaremasu!",
  "altTitle": null,
  "score": "8.2",
  "status": "Ongoing",
  "scheduleDay": "Rabu",
  "views": 810,
  "subscribers": null,
  "episodeList": [
    { "episodeId": "...", "title": "Episode 1", "date": "…", "views": 1372, "thumbnail": null }
  ]
}
```

`GET /anime/mushoku-tensei-sub-indo` (Completed → tanpa badge):

```json
{
  "title": "Mushoku Tensei: Isekai Ittara Honki Dasu",
  "status": "Completed",
  "scheduleDay": null,
  "views": 12828,
  "subscribers": null
}
```

---

## 5. Perubahan frontend yang dilakukan

> **Belum ada perubahan kode di folder frontend (`TsukiNime/`).**
> Field-field di atas baru tersedia di sisi backend; frontend tinggal
> mengkonsumsi sesuai aturan null-safe di bagian 3. Urutan pengerjaan
> (mengikuti prioritas BACKEND.md):

1. `views` — render counter kiri bawah CTA + `formatCount`.
2. `scheduleDay` — render badge "📅 Setiap Rabu" (hanya Ongoing).
3. `altTitle` — render baris judul alternatif (13sp, ellipsis).
4. `subscribers` — sembunyikan (null), siap render kalau diisi nanti.
5. episode `thumbnail` — pakai fallback poster di Continue Watching.

## 6. Test

- Hit `GET /anime/:slug` (salah satu anime Ongoing & Completed) → pastikan field
  baru muncul tanpa error, dan UI tidak render komponen saat `null`.
- Regresi: home / list / search / episode harus tetap berjalan seperti biasa
  (kontrak lama tidak berubah — field baru hanya ditambahkan).

## 7. Changelog

- `2026-08-12` — Backend mengembalikan `views`, `scheduleDay`, `altTitle`,
  `subscribers`, episode `thumbnail` (commit `a841f8b`, deploy `074a078c`).
- Frontend: belum ada perubahan; dokumen ini adalah panduan konsumsi.
