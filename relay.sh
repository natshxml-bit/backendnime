#!/usr/bin/env bash
# relay.sh — jalankan backend sebagai RELAY di Termux (IP rumah/ISP).
# Railway memakai ini untuk fetch data animekita saat ada yang tidak ada di DB.
# Catatan: terminal ini harus TETAP TERBUKA / Termux tidak boleh di-close.
set -e
cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
export PORT="${PORT:-8000}"
export NO_CRAWL=1
echo "Relay aktif di http://localhost:$PORT (token: ${RELAY_TOKEN:-<belum diset>})"
echo "Jalankan di terminal lain:  cloudflared tunnel --url http://localhost:$PORT"
exec node app.js
