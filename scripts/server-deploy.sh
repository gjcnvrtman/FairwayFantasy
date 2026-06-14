#!/usr/bin/env bash
# scripts/server-deploy.sh — runs ON THE PROD HOST. Mirrors the
# server-side half of scripts/deploy.sh (no dev-machine pre-flight,
# no ssh hop). Used by the scheduled one-shot fairway-deploy-oneshot
# unit on the box.
#
# Logs every step + outcome to a timestamped file under
# /opt/fairway-fantasy/logs/deploy/ so a missed live-tail can still
# be reconstructed after the fact. Final status line ("SUCCESS"
# vs "FAIL: …") lands at the bottom of that log.
#
# Run manually as `greg`:
#   bash /opt/fairway-fantasy/scripts/server-deploy.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fairway-fantasy}"
SERVICE="${SERVICE:-fairway-fantasy}"
PORT="${PORT:-3000}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-gjcnvrtman@gmail.com}"
LOG_DIR="$APP_DIR/logs/deploy"
TS="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/deploy-$TS.log"

mkdir -p "$LOG_DIR"

# All stdout/stderr from here on goes to BOTH the live console (so
# `systemctl status` / `journalctl` shows progress) and the log file.
exec > >(tee -a "$LOG") 2>&1

# Email Greg the outcome regardless of pass/fail. Uses the already-
# configured msmtp on .150 (same Gmail relay the app uses). Body is
# the last 100 lines of the log so a failure is diagnosable from the
# inbox without SSHing in.
notify() {
  local status="$1"
  local subject="[Fairway deploy] $status — $(hostname) $(date +'%Y-%m-%d %H:%M %Z')"
  {
    echo "Scheduled deploy outcome: $status"
    echo
    echo "Log file: $LOG"
    echo
    echo "── Last 100 lines ──"
    tail -n 100 "$LOG" 2>/dev/null || echo "(log not readable)"
  } | mail -s "$subject" "$NOTIFY_EMAIL" || true
}

trap '
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "FAIL: aborted with exit $rc at line $LINENO"
    notify "FAIL (exit $rc)"
  else
    notify "SUCCESS"
  fi
' EXIT

echo "==> Fairway server-side deploy starting at $TS"
echo "    APP_DIR=$APP_DIR  SERVICE=$SERVICE  PORT=$PORT"
echo "    HEAD before: $(cd "$APP_DIR" && git rev-parse --short HEAD)  ($(cd "$APP_DIR" && git log -1 --pretty=%s))"

cd "$APP_DIR"

# ── 1. Pull ────────────────────────────────────────────────────
echo "==> git pull --ff-only origin main"
git pull --ff-only origin main

NEW_HEAD="$(git rev-parse --short HEAD)"
echo "    HEAD after:  $NEW_HEAD  ($(git log -1 --pretty=%s))"

# ── 2. npm ci only if package-lock.json changed in this pull ──
if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q '^package-lock\.json$'; then
  echo "==> package-lock.json changed; running npm ci"
  npm ci
else
  echo "==> package-lock.json unchanged; skipping npm ci"
fi

# ── 3. Build ───────────────────────────────────────────────────
echo "==> npm run build"
npm run build

# ── 4. Restart service ─────────────────────────────────────────
echo "==> sudo systemctl restart $SERVICE"
sudo -n systemctl restart "$SERVICE"

# Brief settle window so the next-up port-200 probe isn't racing
# the worker startup.
sleep 5

# ── 5. HTTP probe ──────────────────────────────────────────────
echo "==> curl health probe on :$PORT"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT" || echo 000)"
echo "    HTTP $HTTP_CODE"
case "$HTTP_CODE" in
  2*|3*) ;;
  *) echo "FAIL: health probe returned HTTP $HTTP_CODE"; exit 1 ;;
esac

echo "SUCCESS: $NEW_HEAD live on $(hostname) at $(date +'%Y-%m-%d %H:%M:%S %Z')"
