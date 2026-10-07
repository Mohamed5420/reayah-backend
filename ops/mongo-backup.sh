#!/usr/bin/env bash
# Point-in-time backup of the Reaya+ MongoDB replica set (docs/OPERATIONS.md § Backups).
#
#   MONGO_URI=mongodb://... ./ops/mongo-backup.sh [output-dir]
#
# Writes <output-dir>/reaya-<UTC timestamp>.archive.gz (mongodump --oplog = consistent snapshot of a
# replica set). Field-encrypted values stay encrypted in the dump: the backup is useless without
# FIELD_ENCRYPTION_KEY, which is stored separately (secret manager) — never next to the dump.
# Needs MongoDB Database Tools (mongodump) on PATH.
set -euo pipefail

: "${MONGO_URI:?Set MONGO_URI}"
out_dir="${1:-./backups}"
mkdir -p "$out_dir"
file="$out_dir/reaya-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"

mongodump --uri="$MONGO_URI" --oplog --gzip --archive="$file"
echo "Backup written: $file ($(du -h "$file" | cut -f1))"
