# BACKEND.md — Fix Streaming "Video Tidak Ditemukan"

> Dokumen ini berisi **satu perbaikan kritis** di sisi backend. Penyebab bug
> "video tidak ditemukan" di app Android sudah teridentifikasi: verifikasi URL
> stream dilakukan dari server (IP datacenter) dan ditolak upstream. Perbaikan
> ini menghapus verifikasi server-side sehingga URL stream langsung diputar oleh
> device user (IP user), sesuai desain.
>
> Status: **menunggu persetujuan tim agent** — jangan di-apply sebelum disetujui.

---

## 1. Gejala & root cause

- **Gejala**: setiap klik episode di app → "Video tidak ditemukan".
- **Root cause**: `adapter.episode()` (`adapter.js:831`) memanggil
  `verifyStreams(qualities)` → `headCheck(url)` melakukan HTTP HEAD ke tiap URL
  stream **dari server Railway** (`adapter.js:851`). Upstream (animekita CDN)
  menolak request dari IP datacenter/server → `res.ok=false` untuk semua mirror
  → `verified` kosong → `direct = null` → respons `streamUrl: null`,
  `defaultStreamingUrl: null`.
- App Android mengambil `bestStreamUrl = streamUrl ?: defaultStreamingUrl` →
  `null` → ExoPlayer gagal → error.

## 2. Kenapa dulu (Next.js Capacitor) berfungsi

Versi web memutar video langsung dari browser user → request keluar dari **IP
user**, upstream menerima. Di arsitektur Kotlin sekarang, URL diverifikasi
dulu oleh server (IP datacenter) sebelum diserahkan ke app — di sinilah ia
ditolak.

## 3. Perbaikan (skip verifikasi server)

Ubah `adapter.episode()` agar **tidak** memanggil `verifyStreams`. Langsung
pakai `qualities` mentah dari `qualityFromStreams`:

```js
async function episode(slug) {
  const epUrl = normalizeSlug(slug);
  const data = await getEpisodeData(epUrl);
  if (!data || !data.streams) throw new Error(`episode tidak ditemukan: ${epUrl}`);
  const qualities = qualityFromStreams(data.streams, data.resoSize);
  // JANGAN verifikasi dari server — headCheck memakai IP datacenter dan
  // ditolak upstream. Biarkan device user yang memutar URL (IP user).
  const direct = qualities.length ? qualities[0].serverList[0].url : null;
  return {
    episodeId: epUrl,
    title: `Episode ${epUrl}`,
    animeTitle: null,
    defaultStreamingUrl: direct,
    streamUrl: direct,
    server: { qualities },
    servers: [],
  };
}
```

- `verifyStreams()`/`headCheck()` boleh tetap ada di file (tidak dipakai di
  jalur episode) atau dihapus — pilihan tim.
- Kontrak respons **tidak berubah** (field sama) → app tidak perlu diubah.

## 4. Dampak

- `streamUrl` kini berisi URL nyata → app langsung memutar dari device user.
- Tidak ada lagi filter mirror berdasarkan reachability dari server; mirror
  yang mati akan terdeteksi saat playback di device (ExoPlayer error) — bisa
  ditangani app dengan mencoba kualitas/server lain bila perlu (iterasi
  berikutnya).

## 5. Test

- `GET /episode/:id` → `streamUrl` terisi URL valid (bukan null).
- Putar di app → video jalan.
- `node db/test_routes.js` — pastikan tidak ada route yang error.
- Commit ke `main` → Railway auto-deploy.
