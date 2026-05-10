#!/usr/bin/env bash
# Install ESPN-sync systemd timers + an optional one-shot to populate
# an empty DB on first run.
#
# Run on the box where Fairway Fantasy lives (.160). Requires sudo.
#
# Usage:
#   sudo ./infra/systemd/install.sh                # install timers
#   sudo ./infra/systemd/install.sh --populate     # install + run rankings once now

set -euo pipefail

POPULATE=0
for arg in "$@"; do
  case "$arg" in
    --populate) POPULATE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "FATAL: this script must run as root (use sudo)." >&2
  exit 1
fi

# ── Resolve paths ───────────────────────────────────────────
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$HERE/../.." && pwd)"

# Sanity check — make sure we're in the right repo
[[ -f "$APP_ROOT/package.json" ]] || {
  echo "FATAL: can't find package.json at $APP_ROOT — wrong path?" >&2
  exit 1
}
[[ -f "$APP_ROOT/.env.local" ]] || {
  echo "FATAL: $APP_ROOT/.env.local missing — Fairway env not set up yet." >&2
  exit 1
}

echo "▸ App root:      $APP_ROOT"
echo "▸ Unit source:   $HERE"
echo "▸ Install to:    /etc/systemd/system/"

# ── Copy unit files ─────────────────────────────────────────
for unit in fairway-rankings.service fairway-rankings.timer \
            fairway-scores.service   fairway-scores.timer; do
  src="$HERE/$unit"
  dst="/etc/systemd/system/$unit"
  cp "$src" "$dst"
  echo "  ✓ installed $unit"
done

# ── Reload + enable + start ─────────────────────────────────
systemctl daemon-reload
systemctl enable --now fairway-rankings.timer
systemctl enable --now fairway-scores.timer

echo
echo "▸ Timer status:"
systemctl list-timers --no-pager | grep -E '^NEXT|fairway-' || true

# ── Optional: populate empty DB right now ───────────────────
if [[ $POPULATE -eq 1 ]]; then
  echo
  echo "▸ Running rankings sync once now to populate empty DB…"
  systemctl start fairway-rankings.service
  sleep 2
  echo
  echo "▸ Last 30 lines of rankings service log:"
  journalctl -u fairway-rankings.service -n 30 --no-pager
fi

echo
echo "✓ Installed. Useful follow-ups:"
echo "    systemctl list-timers fairway-*"
echo "    journalctl -fu fairway-rankings"
echo "    journalctl -fu fairway-scores"
echo "    systemctl start fairway-rankings.service   # fire manually"
echo "    systemctl start fairway-scores.service     # fire manually"
