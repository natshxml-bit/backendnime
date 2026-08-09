#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
bash db/sync.sh details-all
