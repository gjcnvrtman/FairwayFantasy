#!/usr/bin/env bash
# scripts/deploy.sh — git-pull-driven deploy to the LAN prod host.
#
# Mirrors the pattern DayTrader settled on after the 2026-05-30 drift
# incident: never scp individual files (silent drift is the failure
# mode), always push to main first, then `git pull && rebuild && restart`
# on the server.
#
# Usage (from your dev machine, repo root):
#   ./scripts/deploy.sh          # standard deploy
#   ./scripts/deploy.sh --check  # show what would deploy + prod status,
#                                # do not pull or restart
#
# Pre-conditions enforced:
#   - On main branch, working tree clean
#   - origin/main up to date with HEAD (push before deploy)
#
# Steps:
#   1. ssh server150 -> /opt/fairway-fantasy
#   2. git pull --ff-only origin main
#   3. npm ci   (only when package-lock.json changed in this pull)
#   4. npm run build
#   5. sudo systemctl restart fairway-fantasy
#   6. wait briefly, then curl localhost:3000 for a sanity 200/3xx
#
# Failure modes are surfaced to stderr and exit non-zero. The script
# never proceeds past a failing step.

set -euo pipefail

REMOTE_HOST="${FF_DEPLOY_HOST:-server150}"
REMOTE_DIR="${FF_DEPLOY_DIR:-/opt/fairway-fantasy}"
SERVICE_NAME="${FF_DEPLOY_SERVICE:-fairway-fantasy}"
LOCAL_PORT="${FF_LOCAL_PORT:-3000}"

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

color_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
color_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
color_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
color_dim()    { printf '\033[2m%s\033[0m\n'  "$*"; }

step() { color_yellow "==> $*"; }
ok()   { color_green  "    ok: $*"; }
die()  { color_red    "ERROR: $*" >&2; exit 1; }

# ── 1. Local pre-flight ─────────────────────────────────────────
step "Local pre-flight"

# Must be in a git repo
git rev-parse --show-toplevel >/dev/null 2>&1 \
  || die "Not inside a git repository."

# Must be on main
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "main" ]]; then
  die "Deploy only from 'main'. Current branch: $current_branch"
fi

# Working tree must be clean. .claude/ and node_modules/ noise is OK
# if it's gitignored, but `git status --porcelain` only reports
# tracked changes, so this check stays tight.
if [[ -n "$(git status --porcelain)" ]]; then
  die "Working tree has uncommitted changes. Commit or stash first."
fi

# Local must be up to date with origin/main (deploy reads from origin)
git fetch origin main --quiet
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [[ "$local_sha" != "$remote_sha" ]]; then
  die "HEAD ($local_sha) != origin/main ($remote_sha). Push or pull first."
fi
ok "on main, clean, in sync with origin"

# ── 2. Inspect prod state ───────────────────────────────────────
step "Inspect prod ($REMOTE_HOST:$REMOTE_DIR)"

prod_sha="$(ssh "$REMOTE_HOST" "cd '$REMOTE_DIR' && git rev-parse HEAD" 2>/dev/null)" \
  || die "Could not read prod git state. Is ssh working and is $REMOTE_DIR a git checkout?"

if [[ "$prod_sha" == "$remote_sha" ]]; then
  color_dim "    prod already at $prod_sha — nothing new to deploy"
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    exit 0
  fi
  step "Prod already current. Forcing rebuild + restart anyway? (y/N)"
  read -r reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    color_green "Skipping."
    exit 0
  fi
else
  echo "    prod:   $prod_sha"
  echo "    origin: $remote_sha"
  echo
  echo "Commits prod is missing:"
  git log --oneline "$prod_sha..$remote_sha" | sed 's/^/      /'
  echo
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  color_green "(--check) Would deploy the above. Stopping here."
  exit 0
fi

# Detect whether package-lock.json changed in the incoming commits.
# If it did, `npm ci` is required to pick up the lockfile delta.
# Skipping `npm ci` on unchanged lockfile saves ~30s per deploy.
if git diff --name-only "$prod_sha..$remote_sha" 2>/dev/null | grep -qE '^(package(-lock)?\.json)$'; then
  RUN_NPM_CI=1
  color_dim "    package-lock changed — will run 'npm ci' on prod"
else
  RUN_NPM_CI=0
fi

# ── 3. Deploy ────────────────────────────────────────────────────
step "Deploy"

# Build the remote script as a single ssh call so we don't pay per-step
# round-trip latency. set -e fails the whole block on any step error.
ssh "$REMOTE_HOST" bash -se <<EOF
set -euo pipefail
cd '$REMOTE_DIR'

echo '==> git pull --ff-only origin main'
git pull --ff-only origin main

if [[ '$RUN_NPM_CI' == '1' ]]; then
  echo '==> npm ci  (lockfile changed)'
  npm ci
else
  echo '==> npm ci skipped (lockfile unchanged)'
fi

echo '==> npm run build'
npm run build

echo '==> sudo systemctl restart $SERVICE_NAME'
sudo -n systemctl restart $SERVICE_NAME

# Sanity wait — gunicorn-equivalent for Next is ~3s warm-up. Bump if
# you see HTTP 502 in the post-check.
sleep 4

echo '==> service status'
sudo -n systemctl is-active $SERVICE_NAME

echo '==> HTTP probe'
curl -fsS -o /dev/null -w 'HTTP %{http_code} (%{time_total}s)\n' \
  "http://localhost:$LOCAL_PORT/" || {
    echo 'WARNING: HTTP probe failed. Service is active but not responding.'
    exit 1
  }
EOF

color_green "Deploy complete: $remote_sha is live on $REMOTE_HOST."
