#!/usr/bin/env bash
# Restore drill (docs/OPERATIONS.md § Backups): restores a backup into a SEPARATE scratch MongoDB and
# compares document counts per collection with the source, so a backup is proven restorable without
# touching the live database.
#
#   SOURCE_URI=mongodb://live... TARGET_URI=mongodb://scratch... ./ops/mongo-restore-drill.sh backups/reaya-....archive.gz
#
# Refuses to run when SOURCE_URI and TARGET_URI are the same. Needs mongorestore and mongosh on PATH.
set -euo pipefail

archive="${1:?Usage: $0 <backup.archive.gz>}"
: "${SOURCE_URI:?Set SOURCE_URI (the database the backup came from)}"
: "${TARGET_URI:?Set TARGET_URI (an empty scratch database)}"
if [ "$SOURCE_URI" = "$TARGET_URI" ]; then
  echo "TARGET_URI must not be the source database." >&2
  exit 1
fi

started=$(date +%s)
mongorestore --uri="$TARGET_URI" --gzip --archive="$archive" --oplogReplay --drop
echo "Restore took $(( $(date +%s) - started )) s"

count_script='db.getCollectionNames().sort().forEach(c => print(c + " " + db.getCollection(c).countDocuments({})))'
diff <(mongosh "$SOURCE_URI" --quiet --eval "$count_script") <(mongosh "$TARGET_URI" --quiet --eval "$count_script") \
  && echo "Drill OK: every collection has the same document count (writes after the backup will show as differences)." \
  || { echo "Counts differ — see above. Expected only for collections written to after the backup."; exit 2; }
