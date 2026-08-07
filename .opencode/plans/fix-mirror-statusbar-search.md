# Plan: Fix movie mirror + status bar + double tap + search filter

## Konteks (dari tes temen user)
1. Battle of Surabaya mirror 3 (pixeldrain) gagal total; mirror 1 jalan tapi render lama.
2. Ikon baterai/status bar tidak hilang saat fullscreen horizontal.
3. Minta fitur double tap ±10s (sudah ada, perlu refine) + search dengan filter.

## Root causes (terverifikasi)
- **Mirror 3 gagal**: URL `pixeldrain.com/api/file/ID?download` tidak match `VIDEO_URL_RE` → `toProxyUrl` paksa lewat `/proxy` → Railway masih 403 (whitelist commit `a5bd746` belum di-push). Solusi: putar pixeldrain LANGSUNG (tanpa proxy) di frontend.
- **Status bar**: `applyLandscape` hanya `ScreenOrientation.lock`; tidak pernah `StatusBar.hide()`.
- **Double tap**: sudah ada di `setupTouch` (Player.tsx:138-152), zona 50/50, perlu 1/3 YouTube-style + tengah = play/pause.
- **Search filter**: backend `searchQuery` tidak support filter; tapi item punya `genres`, `type` (TV/Movie/OVA/BD/ONA/Special/Donghua), `status` (Ongoing/Completed). Filter 100% client-side.

## Perubahan

### 1. `TsukiNime/components/Player.tsx`
- `VIDEO_URL_RE` tambah `pixeldrain`; `toProxyUrl` return url langsung untuk hostname pixeldrain.com → mirror 3 jalan direct 2.3MB/s tanpa backend.
- Import `StatusBar` (@capacitor/status-bar) + `Capacitor` (@capacitor/core). Di `applyLandscape(state)` (line ~345): `if (Capacitor.isNativePlatform()) { state ? StatusBar.hide() : StatusBar.show() }` → ikon baterai hilang pas landscape, muncul lagi saat keluar fullscreen.
- Artplayer config tambah `dblclick: false` (hindari bentrok dblclick fullscreen desktop).
- `setupTouch` (line 138-152): zona double tap jadi 1/3 — kiri 1/3 = -10s, kanan 1/3 = +10s, tengah 1/3 = toggle play/pause. Indicator +10s/-10s di posisi tap.

### 2. `TsukiNime/app/search/page.tsx`
- Panel filter di bawah search bar:
  - Genre: checkbox dinamis (set unik dari hasil pencarian, sortir)
  - Type dropdown: Default / Anime / Donghua (normalisasi: `type==='Donghua'` → Donghua; lainnya → Anime)
  - Status dropdown: Default / Ongoing / Complete (normalisasi: `s.startsWith('Complet')` / `s === 'Ongoing'`)
  - Tombol Search → jalankan `doSearch(query)` dengan filter aktif
- Filter client-side murni: `results.filter(...)`; state `selectedGenres[]`, `typeFilter`, `statusFilter`; tampilkan jumlah hasil.
- Panel collapse toggle kecil (biar tidak makan layar).

### 3. `TsukiNime/app/all-anime/page.tsx` — panel filter (baru)
Item list API sudah punya `type` (TV/Movie/Donghua/...), `status` (Ongoing/Completed), `genres` — filter murni client-side.
- Tombol filter (icon `fa-filter` yang sekarang buka dropdown genre) → buka **panel filter** lengkap:
  - **Type dropdown**: Default / Anime / Donghua (normalisasi: `type==='Donghua'` → Donghua, lainnya → Anime)
  - **Status dropdown**: Default / Ongoing / Complete (`s.startsWith('Complet')` / `s==='Ongoing'`)
  - **Genre checkbox multi-select**: dari `api.genres()` (title: Action, Romance, ...)
  - Tombol **Terapkan** (tutup panel) + **Reset**
- State: `filterType`, `filterStatus`, `filterGenres:Set`; render grid memakai `animeList.filter(match)` — infinite scroll tetap jalan (hasil filter bertambah saat scroll load page baru).
- Badge angka di tombol filter = jumlah filter aktif. Dropdown genre per-endpoint lama tetap dipertahankan (byGenre server-side).

### 4. Build
`npm run build` → `npx cap sync android` → gradle assembleDebug → copy APK ke /sdcard/Download.

### 5. Backend (oleh user)
`cd ~/backendnime && git push origin main` — deploy whitelist pixeldrain `a5bd746` (cadangan; setelah fix #1 tidak wajib untuk mirror 3).

## Verifikasi
- Bundle APK: chunk streaming & Player berisi regex pixeldrain + StatusBar.hide; chunk search berisi filter panel.
- Tes: search filter "Naruto" genre Action → hasil terfilter; movie Battle pakai mirror pixeldrain direct.
