#!/usr/bin/env bash
# Backup for the self-hosted MongoDB in this stack (docs/OPERATIONS.md § Backups). Run from deploy/:
#   ./backup.sh [output-dir]        e.g. nightly from cron: 0 2 * * * cd /opt/reaya/deploy && ./backup.sh /var/backups/reaya
# With managed MongoDB use the provider's backups, or ops/mongo-backup.sh with its connection string.
# Copy the archives off this server (another region), encrypted. FIELD_ENCRYPTION_KEY is NOT in them.
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a

out_dir="${1:-./backups}"
mkdir -p "$out_dir"
file="$out_dir/reaya-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
docker compose exec -T mongo mongodump \
  --username "$MONGO_ROOT_USER" --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --oplog --gzip --archive > "$file"
echo "Backup written: $file ($(du -h "$file" | cut -f1))"
# Keep 14 days locally; long-term copies live off-server.
find "$out_dir" -name 'reaya-*.archive.gz' -mtime +14 -delete
