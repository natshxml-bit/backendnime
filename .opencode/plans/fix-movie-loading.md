# Fix: Movie loading lama (auto 720p + pixeldrain priority)

## Root cause (sudah diverifikasi)
- `storage.animekita.org` & `sjkt.animekita.org` rate-limit ~120–250 KB/s per koneksi (semua IP, termasuk Railway proxy 72KB/s).
- `autoSelectServer` selalu pilih kualitas tertinggi (1080p, bitrate ~152 KB/s) — mepet/melampaui bandwidth nyata → buffering terus.
- Pixeldrain 2.3 MB/s (10x cepat) tapi jarang muncul & tidak didahulukan.
- Series aman karena bitrate rendah; movie besar selalu kena.

## Perubahan

### 1. `TsukiNime/app/streaming/page.tsx` — `autoSelectServer` (line ~329)
- Deteksi movie: `animeData.type === 'movie'` ATAU `episodeId` berakhiran `-movie`.
- Urutan kualitas movie: **720p → 480p → 1080p** (bukan desc biasa).
- Dalam tiap group, sortir item: **pixeldrain.com duluan**.
- Toast sekali per session (`sessionStorage tn_movie_q720_notice`): "Movie: auto 720p (server lambat) · 1080p tersedia di menu kualitas".
- User tetap bisa pilih 1080p manual via pill kualitas (sudah ada).

### 2. `backendnime/app.js` — PROXY_ALLOWED (line ~39)
- Tambah `pixeldrain\.com` ke whitelist proxy + moov prefetch biar mirror pixeldrain bisa dipakai via proxy juga (kasus non-mp4).
- Push ke origin/main → Railway auto-deploy.

### 3. Build
- `npm run build` → `npx cap sync android` → gradle assembleDebug → copy APK ke /sdcard/Download.

## Verifikasi
- Re-test `autoSelectServer` behavior via bundle: cek chunk streaming berisi urutan 720p & pixeldrain.
- Tes stream movie 720p live (Vampire Hunter D) dari device.
