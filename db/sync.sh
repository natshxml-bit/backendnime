#!/usr/bin/env bash
# db/sync.sh — jalankan sinkronisasi database sendiri (HARUS dari IP rumah/ISP).
# Harus dijadwalkan lewat termux-job-scheduler. Bukan proses 24/7:
# jalankan → selesai → proses mati.
#
# Mode:
#   quick       (default) home + schedule + 25 detail terbaru + SEMUA ongoing.
#               Ringan (±2–5 mnt), jalankan tiap ~6 jam. Ini yang men-feed
#               watcher (jumlah episode anime ongoing) buat notif episode baru.
#   catalog     katalog penuh (4.759 judul, 1 request) + genres + lists.
#               Jalankan 1×/minggu (judul baru jarang masuk).
#   details-all detail anime yang BELUM ada di DB (skip existing, delay 350ms
#               per request biar sopan ke animekita). Jalankan 1×/bulan.
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
export PATH="$PREFIX/bin:$PATH"
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

mode="${1:-quick}"
case "$mode" in
  quick)
    args="--home --schedule --details=25 --ongoing=-1"
    ;;
  catalog)
    args="--catalog --genres --genrePages=1 --lists=1"
    ;;
  details-all)
    args="--details-all"
    ;;
  *)
    echo "mode tidak dikenal: $mode (quick|catalog|details-all)" >&2
    exit 1
    ;;
esac

echo "===== sync[$mode] $(date -Is) =====" >> data/sync.log
node db/sync.js $args >> data/sync.log 2>&1
