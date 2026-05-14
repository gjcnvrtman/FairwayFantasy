#!/usr/bin/env bash
# Daily pg_dump of the Fairway Postgres (in Docker). Rotates to 7 days
# of local copies. Triggered by greg's crontab at 23:30 CT.
#
# Why local-only retention: as of 2026-05-14 .160 is decommissioned —
# the historical "off-machine copy" target no longer exists. A future
# follow-up should add an off-machine destination (cloud bucket, the
# DayTrader box, etc.).
#
# Run manually:
#   /opt/fairway-fantasy/scripts/backup-db.sh

set -euo pipefail

APP_ROOT="/opt/fairway-fantasy"
BACKUP_DIR="$APP_ROOT/backups"
LOG_FILE="$APP_ROOT/logs/backup.log"
TS="$(date +%Y%m%d_%H%M%S)"
RETAIN_DAYS=7

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG_FILE")"

OUT="$BACKUP_DIR/fairway_$TS.sql.gz"

# Local socket inside the container has trust auth for the fairway
# superuser, so no PGPASSWORD needed. pg_dump runs inside the
# container; gzip runs on the host so the binary never lands on disk
# uncompressed.
docker exec fairway-postgres pg_dump -U fairway -d fairway | gzip > "$OUT"

SIZE=$(stat -c%s "$OUT")
echo "[$(date -Iseconds)] wrote $OUT ($SIZE bytes)"

# Rotate
DELETED=$(find "$BACKUP_DIR" -name 'fairway_*.sql.gz' -mtime +$RETAIN_DAYS -print -delete | wc -l)
echo "[$(date -Iseconds)] rotated $DELETED file(s) older than $RETAIN_DAYS days"
