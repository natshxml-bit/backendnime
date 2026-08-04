#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export PORT="${PORT:-8000}"
export HOST="${HOST:-0.0.0.0}"
node app.js
