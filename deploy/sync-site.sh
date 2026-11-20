#!/usr/bin/env bash
# Rebuilds deploy/public from the source of truth in files/hapassage.
# Run it before every deploy:  deploy/sync-site.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=files/hapassage
OUT=deploy/public
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SRC"/. "$OUT"/
echo "synced $(find "$OUT" -type f | wc -l) files from $SRC to $OUT"
