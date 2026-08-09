#!/data/data/com.termux/files/usr/bin/bash
# tunnel-url.sh — tampilkan URL tunnel cloudflared saat ini.
# Pakai URL ini sebagai RELAY_URL di Railway setiap kali perangkat boot.
TS=/data/data/com.termux/files/home/backendnime
grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TS/db/cloudflared.log" | tail -1
