#!/usr/bin/env bash
# db/sync.sh — jalankan sinkronisasi database sendiri (harus dari IP rumah/ISP).
# Bisa dijadwalkan lewat termux-job-scheduler, misalnya tiap 12 jam:
#   termux-job-scheduler --script ~/backendnime/db/sync.sh --persisted true --interval 43200000
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
export PATH="$PREFIX/bin:$PATH"
echo "===== sync $(date -Is) =====" >> data/sync.log
node db/sync.js --all >> data/sync.log 2>&1
