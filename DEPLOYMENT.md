# Fairway Fantasy — LAN Deployment Readiness

**Target:** `http://192.168.1.160:<PORT>` on the local Linux server.
LAN-only, no public internet exposure.

This document is the output of Prompt 10's QA / deployment review. It
is intentionally specific: every piece of advice is tied to a file or
TODO item.

---

## 1. Pass/fail summary

| Check                              | Status   | Notes |
|------------------------------------|----------|-------|
| `npm run lint`                     | **PASS** (0 errors, 1 warning) | Custom-fonts warning in `layout.tsx` documented in TODO. ESLint config (`.eslintrc.json` + `eslint`/`eslint-config-next` v8) added in P10. |
| `npm test` (vitest)                | **PASS** | 167 tests, 5 files. |
| `npx tsc --noEmit`                 | **PASS** | 0 errors. |
| `npm run build`                    | **PASS** | First clean build — fixed in P10 by marking auth-gated routes `dynamic = 'force-dynamic'`. |
| Mobile layout                      | **PASS** | All flex-wrap; `lb-table` columns explicitly tag `.hide-mobile`. P5 / P7 / P8 fixes. |
| Auth-protected routes              | **PASS** | Every server component reads `createServerSupabaseClient` and redirects to `/auth/signin` on no-session. |
| Server-side authorization          | **PASS** | All commissioner-only endpoints route through `requireCommissioner` (P8). 18 unit tests pin every status-code branch. |
| Scoring edge cases                 | **PASS** | 60 tests in `picks.test.ts`. P6 pinned the round-in-progress, null-cutScore, and partial-data behaviors. |
| Empty states                       | **PASS** | League dashboard branches on `deriveLeagueEmptyState`; user dashboard has its own; tests in `league-dashboard.test.ts`. |
| Error states                       | **PASS** | `loading.tsx` + `error.tsx` boundaries on `/league/[slug]`, `/league/[slug]/admin`, `/dashboard`. |
| Env var requirements               | **PASS** | Documented in `.env.local.example` + section §5 below. |
| Local DB setup                     | **DEFERRED** | Currently Supabase Cloud only. TODO P0 for self-hosted Postgres + new auth. |
| Node startup process               | **PASS** | `next start -p 3000` works post-build. systemd unit template in §4. |
| Firewall / LAN-only access         | **NEEDS APPLY** | App binds to `0.0.0.0` by default; firewall rule must be added. Checklist in §6. |
| Vercel-specific assumptions        | **DOCUMENTED** | `vercel.json` cron is dead code under LAN deploy; left in tree pending TODO P3 cleanup. README mentions Vercel — TODO P3. |

**Bottom line:** no blocking bugs; the app builds clean, tests pass,
auth is properly gated. Two structural follow-ups (Supabase Cloud →
self-host migration, firewall) are required before public-LAN cutover.

---

## 2. Bugs found and fixed during P10

| # | Bug | File(s) | Fix |
|---|-----|---------|-----|
| 1 | `next build` failed with prerender errors on `/dashboard`, `/settings`, `/api/picks/setup`, `/api/me/notification-prefs` whenever Supabase env was missing. | All four files | Added `export const dynamic = 'force-dynamic'`. Build now succeeds with empty env. |
| 2 | No ESLint config — `npm run lint` opened an interactive prompt. | `.eslintrc.json` (new), `package.json` | Added `extends: next/core-web-vitals`. Pinned `eslint@^8.57.0` (ESLint 9 isn't compatible with Next 14's CLI). |
| 3 | 5 unescaped-entity lint errors. | `signup/page.tsx`, `dashboard/page.tsx`, `join/[slug]/[code]/page.tsx` | Replaced with `&rsquo;` / `&apos;`. |

---

## 3. Bugs / risks NOT fixed (documented in TODO.md)

These are larger than the prompt's "fix only small obvious bugs" rule.
All are tracked in `TODO.md` with priorities.

### P0 — blocks LAN deploy

* **Supabase Cloud lock-in.** Schema, auth, and `supabaseAdmin` all
  point at Supabase Cloud. LAN deployment plan is to swap for
  self-hosted Postgres + a new auth provider (NextAuth or
  shore-jones-style SSO). See TODO P0.
* **Vercel hosting → Node + nginx + systemd.** Build artifact today
  is `.next/`; serve with `next start` behind nginx. Template unit
  in §4 — but the file isn't committed yet pending the migration.
* **Score-sync cron not wired.** The `/api/sync-scores` endpoint
  exists but `vercel.json` only schedules `/api/sync-scores/rankings`
  weekly. Needs systemd timer for the every-10-min flow during play.
* **Season standings cross-tournament/season bleed** in
  `sync-scores/route.ts`. Unrelated to deploy but P0 for correctness.
* **Unique-foursome rule app-only, not DB-backed.** Race condition
  on identical pick-set submissions.

### P1

* **Profile insert from browser anon client** (signup flow). Should
  be a Postgres trigger or server-side route.
* **`profiles` table has no RLS.** Schema enables RLS on every other
  user-data table.
* **`isReplacementEligible` vs in-route inline check disagree.** Two
  truths; pick one.

### P2/P3

* **TS strict mode + `next.config.js` `ignoreBuildErrors`/
  `ignoreDuringBuilds`.** Now that lint + build are clean, we can
  flip those flags off in a follow-up. Left on for now to avoid
  surprise breakage on a future change.
* **`mapESPNStatus` MDF case** (P6 partial fix).
* **Custom-font warning in `layout.tsx`** — should migrate to
  `next/font/google`. Not critical; LAN bandwidth makes it moot.
* See TODO.md for the rest (CSRF, rate-limiting, etc).

---

## 4. Local deployment steps

Assumes Linux server at `192.168.1.160`, user `greg`, app at
`/opt/fairway-fantasy`. Adjust paths to taste.

### One-time setup

```bash
# 1. Install Node 20 (or matching LTS).
#    DO NOT install Debian's `nodejs npm` packages together — Debian's
#    `npm` conflicts with NodeSource's bundled npm (you'll get
#    "Conflicts npm" / "held broken packages" errors). Pick ONE
#    of these paths:
#
#    Path A — NodeSource (recommended for production):
sudo apt-get install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs            # NOT `npm` — bundled with nodejs
node --version                            # confirm v20.x
npm --version                             # confirm 10.x (came with nodejs)
#
#    Path B — nvm (better for dev, fine for prod):
# curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# source ~/.bashrc
# nvm install 20 && nvm use 20

# 2. Clone the repo
sudo mkdir -p /opt/fairway-fantasy
sudo chown greg:greg /opt/fairway-fantasy
cd /opt/fairway-fantasy
git clone https://github.com/gjcnvrtman/FairwayFantasy.git .

# 3. Install deps
npm ci

# 4. Provision local Postgres (Phase 3 — replaces Supabase Cloud at cutover).
#    Use Docker's official convenience script — works on Debian /
#    Ubuntu / Raspberry Pi OS, handles ARM64, installs Engine +
#    Compose v2 plugin in one shot. (The Debian apt packages don't
#    ship Compose v2.)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker                              # take effect now, no re-login needed
docker --version && docker compose version # confirm both
cd /opt/fairway-fantasy/infra/postgres
cp .env.example .env
nano .env                                 # or your editor of choice                         # set POSTGRES_PASSWORD
docker compose up -d
docker compose ps                    # confirm healthy
docker compose logs -f               # watch first-time schema apply

# 5. Configure env
cd /opt/fairway-fantasy
cp .env.local.example .env.local
nano .env                                 # or your editor of choice.local                   # set:
#   DATABASE_URL=postgresql://fairway:<pgpass>@127.0.0.1:5432/fairway
#   NEXT_PUBLIC_SUPABASE_URL          (legacy, until Phase 4 — auth flow only)
#   NEXT_PUBLIC_SUPABASE_ANON_KEY     (legacy)
#   CRON_SECRET=$(openssl rand -hex 32)
#   NEXT_PUBLIC_SITE_URL=http://fairway.golf-czar.com   # nginx host-routes here

# 6. Build
npm run build
```

### Postgres details (Phase 3)

* Container: `postgres:16-alpine` named `fairway-postgres`.
* Bound to `127.0.0.1:5432` only — Postgres is NOT reachable from
  the LAN. Fairway connects over loopback. For ad-hoc psql sessions
  from your laptop:
  ```bash
  ssh -L 5432:127.0.0.1:5432 greg@192.168.1.160
  # in another terminal
  psql 'postgresql://fairway:<pgpass>@127.0.0.1:5432/fairway'
  ```
* Volume: `fairway-pgdata` (named docker volume; survives `docker
  compose down`, wiped by `docker compose down -v`).
* Schema: `infra/postgres/init/00-schema.sql` auto-applies on first
  start. To re-apply after edits: `docker compose down -v && docker
  compose up -d` (this DESTROYS DATA — only do this on a fresh
  install or after backing up).
* Backups: `pg_dump fairway | gzip > /backups/fairway-$(date +%F).sql.gz`
  on a daily cron. Off-machine copy is your call.

### Phase 5 — starting fresh (no Supabase migration)

If you don't care about preserving Supabase Cloud data and just want
a clean local install: skip the migration entirely, seed yourself a
user directly, sign in. ~10 minutes.

```bash
# 1. Stand up local Postgres (same as Step 1 of the full runbook).
cd /opt/fairway-fantasy/infra/postgres
cp .env.example .env
nano .env                                  # set POSTGRES_PASSWORD (hex)
docker compose up -d
docker compose ps                          # wait for "(healthy)"

# 2. Verify schema applied — should list 12 tables.
source .env
PGPASSWORD="$POSTGRES_PASSWORD" \
  psql -h 127.0.0.1 -p "${POSTGRES_HOST_PORT:-5432}" -U fairway -d fairway -c '\dt'

# 3. Seed yourself a user.
cd /opt/fairway-fantasy
export DATABASE_URL="postgresql://fairway:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/fairway"

DATABASE_URL="$DATABASE_URL" \
SEED_EMAIL='you@example.com' \
SEED_NAME='Your Display Name' \
SEED_PASSWORD='choose-something-strong' \
  npx tsx scripts/seed-user.ts

# 4. Configure Fairway env. nano .env.local with:
#      DATABASE_URL=postgresql://fairway:<pgpass>@127.0.0.1:<port>/fairway
#      NEXTAUTH_SECRET=$(openssl rand -base64 32)   # set ahead of time
#      NEXTAUTH_URL=http://fairway.golf-czar.com
#      CRON_SECRET=$(openssl rand -hex 32)
#      NEXT_PUBLIC_SITE_URL=http://fairway.golf-czar.com

# 5. Build + restart.
npm ci
npm run build
sudo systemctl restart fairway-fantasy

# 6. Sign in at http://fairway.golf-czar.com/auth/signin with your
#    seeded email + password. You land on /dashboard. Click
#    "Create League" — you're commissioner of every league you create.
```

Re-running step 3 with the same `SEED_EMAIL` updates the password
(useful if you forget yours). To create more users, either run
seed-user.ts again with a different email, OR sign up through the
UI normally.

---

### Phase 5 — full migration runbook (preserve Supabase data)

This is the actual flip from Supabase Cloud to local Postgres + the
new NextAuth Credentials provider. Plan for ~30 minutes of downtime
on the Fairway side; everything else (golf-czar, etc.) is unaffected.

**Before you start, on the LAN box:**
```bash
# Paste these into your shell once. Use openssl rand -base64 32 for
# the new auth secret if you don't already have one.
export SOURCE_DATABASE_URL='postgresql://postgres:CLOUDPASS@db.xxx.supabase.co:5432/postgres'
export DATABASE_URL='postgresql://fairway:LOCALPASS@127.0.0.1:5432/fairway'
export NEXTAUTH_SECRET='replace-with-output-of-openssl-rand-base64-32'
```

#### Step 1 — Stand up local Postgres

```bash
cd /opt/fairway-fantasy/infra/postgres
cp .env.example .env
nano .env                                 # or your editor of choice                              # set POSTGRES_PASSWORD (and DB port if needed)
docker compose up -d
docker compose ps                         # wait for "(healthy)"
docker compose logs postgres | tail -40   # confirm schema applied — look for
                                          # "CREATE TABLE" lines, no errors
```

Verify connectivity from the Fairway side. Use `PGPASSWORD` + flags
rather than the URI form — base64 passwords contain `/` and `+` which
break URI parsing:
```bash
source infra/postgres/.env                # exports POSTGRES_PASSWORD
PGPASSWORD="$POSTGRES_PASSWORD" \
  psql -h 127.0.0.1 -p "${POSTGRES_HOST_PORT:-5432}" -U fairway -d fairway -c '\dt'
# should list 12 tables: profiles, auth_credentials, leagues,
# league_members, tournaments, golfers, picks, scores,
# fantasy_results, season_standings, reminder_preferences,
# reminder_log
```

#### Step 2 — Pre-flight check

Run BEFORE the migration. Catches the common failures (bad creds,
missing schema, wrong project, target already populated).

```bash
cd /opt/fairway-fantasy
npx tsx scripts/preflight-check.ts
```

Expected output: every line ✓, exit 0. If any line ✗, fix it
before continuing — the migration itself won't help diagnose.

#### Step 3 — Migration dry run

```bash
npx tsx scripts/migrate-from-supabase.ts --dry-run
```

Prints "would copy N rows" per table, no writes. Sanity-check the
counts against your Supabase project's row counts.

#### Step 4 — Real migration

```bash
npx tsx scripts/migrate-from-supabase.ts
```

Idempotent. Re-running is safe but won't UPDATE existing rows
(it skips via `ON CONFLICT DO NOTHING`). For a clean re-run:
`docker compose down -v && docker compose up -d` — this DESTROYS
the local DB.

#### Step 5 — Post-migration smoke test

Run AFTER migration but BEFORE flipping prod's env. Validates row
parity, auth coverage, bcrypt hash shape, no orphan FKs.

```bash
npx tsx scripts/post-migration-check.ts
```

Every line should be ✓. A `!` is a warning (e.g. target had pre-existing
rows) — review, but it's usually fine. Any ✗ → DO NOT cutover yet.

#### Step 6 — Flip Fairway env to local Postgres

```bash
cd /opt/fairway-fantasy
nano .env                                 # or your editor of choice.local
```
Update:
```
DATABASE_URL=postgresql://fairway:LOCALPASS@127.0.0.1:5432/fairway
NEXTAUTH_SECRET=...                       # the one from above
NEXTAUTH_URL=http://fairway.golf-czar.com  # or whatever the public URL is
```
Remove (no longer used):
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

#### Step 7 — Restart Fairway

```bash
sudo systemctl restart fairway-fantasy
sudo journalctl -fu fairway-fantasy       # watch for startup errors
```
A clean start prints "▲ Next.js 14.2.35 - Local: http://0.0.0.0:3000".
If `NEXTAUTH_SECRET` is too weak, you'll see the
`FATAL: NEXTAUTH_SECRET …` guard — fix and restart.

#### Step 8 — End-to-end smoke from a browser

1. Hit `http://fairway.golf-czar.com/`. Landing page renders.
2. Click "Sign In". Use an existing account's email + password.
   - Should land on `/dashboard` with the user's leagues visible.
3. Click into a league → confirm leaderboard, season standings, roster all populate.
4. Open a private/incognito window → public landing only. No session
   leaks across browsers.
5. Try signing up with a new email → should auto-login, land on dashboard.

#### Step 9 — Decommission

Once you've used the new stack for a couple of days without incident:

* Cancel the Supabase Cloud project's pro plan (if any).
* Delete the project (or pause it — Supabase keeps backups for 7 days
  on free plans).
* Set up a `pg_dump` cron on the LAN box for backups:
  ```bash
  echo '0 3 * * * /usr/bin/docker exec fairway-postgres pg_dump -U fairway fairway | gzip > /backups/fairway-$(date +\%F).sql.gz' \
    | sudo crontab -u greg -
  ```

### Rollback plan

If anything goes wrong after Step 6:

1. **Edit `.env.local`** — change `DATABASE_URL` back to the Supabase
   Cloud connection string. Restore `NEXT_PUBLIC_SUPABASE_URL` /
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` (you removed them in Step 6 — git
   has the prior values, or pull from the Supabase dashboard).
2. **`sudo systemctl restart fairway-fantasy`**.
3. App is back on Supabase Cloud. Local Postgres remains stood-up;
   wipe with `docker compose down -v` if you want a clean slate before
   the next attempt.

The auth provider swap (Supabase → NextAuth) is harder to roll back
than the data swap because the code is now NextAuth-only. If you need
to roll back the *code* too, `git revert` the Phase-4 commit (`ca0b280`)
on a branch and deploy that — but it's much simpler to just fix
forward. The most likely failure (bad `NEXTAUTH_SECRET`) is a one-line
fix.

### Common issues

* **"FATAL: NEXTAUTH_SECRET is set but is too short"** — your secret
  is < 32 chars or matches a placeholder. Generate a new one with
  `openssl rand -base64 32`.
* **Sign-in succeeds but `/dashboard` redirects to `/auth/signin`** —
  Almost always cookie-domain mismatch. `NEXTAUTH_URL` must match the
  hostname users actually visit (cookie domain is derived from it).
* **"DATABASE_URL is required"** — Fairway tried to query before the
  env was set. Confirm the systemd unit's `EnvironmentFile=` points at
  the right `.env.local` and that the file is readable by the service
  user (`chmod 600`, owned by `greg`).
* **Sign-in always fails for everyone** — bcrypt hash mismatch.
  `npx tsx scripts/post-migration-check.ts` should have caught the
  shape, but verify by running:
  ```bash
  psql "$DATABASE_URL" -c "SELECT password_hash FROM auth_credentials LIMIT 1"
  ```
  Hash should start with `$2a$10$` or `$2b$10$`.

### Run as a service

`/etc/systemd/system/fairway-fantasy.service`:

```ini
[Unit]
Description=Fairway Fantasy (Next.js)
After=network.target

[Service]
Type=simple
User=greg
WorkingDirectory=/opt/fairway-fantasy
EnvironmentFile=/opt/fairway-fantasy/.env.local
ExecStart=/usr/bin/npm run start -- -p 3000 -H 0.0.0.0
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fairway-fantasy
sudo systemctl status fairway-fantasy
```

### Score-sync timer (P0 — wire after deploy)

`/etc/systemd/system/fairway-sync.service`:

```ini
[Unit]
Description=Fairway Fantasy score sync

[Service]
Type=oneshot
ExecStart=/usr/bin/curl -fsS -X POST \
  -H "Authorization: Bearer $(cat /opt/fairway-fantasy/.cron_secret)" \
  http://192.168.1.160:3000/api/sync-scores
```

`/etc/systemd/system/fairway-sync.timer`:

```ini
[Unit]
Description=Run Fairway score sync every 10 min Thu-Sun

[Timer]
OnCalendar=Thu,Fri,Sat,Sun *-*-* 06..23:00/10:00
Persistent=true

[Install]
WantedBy=timers.target
```

(Reminder timer is analogous — `POST /api/admin/reminders` with the
same `Bearer CRON_SECRET`.)

### Verify

```bash
# Local on the server:
curl -I http://localhost:3000

# From another LAN box:
curl -I http://192.168.1.160:3000
```

---

## 5. Required environment variables

| Variable | Required? | Where used | Notes |
|----------|-----------|------------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | **YES** | client + server | Browser bundle reads this. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **YES** | client + server | Browser bundle reads this. |
| `SUPABASE_SERVICE_ROLE_KEY` | **YES** | server only | Bypasses RLS — keep secret. |
| `CRON_SECRET` | **YES** for sync/reminders | server only | systemd timer Bearer auth. NOT prefixed `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_SITE_URL` | **YES** for invites/reminders | client + server | Used to build absolute URLs. Set to the LAN URL in prod. |
| `REMINDERS_LIVE` | NO (default unset) | server only | Set to `true` ONLY after wiring a real ChannelDriver. Without it, every reminder is logged to console + `reminder_log` with `status='console'`. **No real messages sent.** |
| `SMTP_*` / `TWILIO_*` | NO | server only | Future: real reminder drivers. Placeholder lines in `.env.local.example`. |
| `DATAGOLF_API_KEY` | NO | unused | Legacy reference — current code uses ESPN's free API. Leave blank. |

Anything starting with `NEXT_PUBLIC_` is shipped to the client — don't
put secrets there. The historical bug #4.1 (now fixed in P8) was
exactly this mistake with `NEXT_PUBLIC_CRON_SECRET`.

---

## 6. Firewall / LAN-only checklist

The Next.js dev/start command binds to `0.0.0.0` by default, which
**includes the public network interface** if the server has one.
Confirm before exposing.

```bash
# 1. Confirm the server's interfaces
ip -br addr

# 2. Block port 3000 from anything outside the LAN /24.
#    Adjust 192.168.1.0/24 to your subnet.
sudo ufw allow from 192.168.1.0/24 to any port 3000
sudo ufw deny 3000                       # Catch-all deny — must come AFTER the allow
sudo ufw enable
sudo ufw status verbose

# 3. (Optional) Front with nginx on 80/443 with the same /24 restriction:
#    location / { allow 192.168.1.0/24; deny all; proxy_pass http://127.0.0.1:3000; ... }
```

**Verification from outside the LAN:** if you have a phone on cell
data (off WiFi) or a laptop tethered to a different network, point a
browser at `http://<your public IP>:3000`. It should time out.

**Also:** the server's `EnvironmentFile=/opt/fairway-fantasy/.env.local`
must be `chmod 600 .env.local` and owned by the service user. Service
role keys leaking via permissive perms is a real risk.

---

## 7. TLS / certbot hygiene (avoid clobbering a SAN cert)

`fairway.golf-czar.com` is one of several names on a shared SAN cert
(`golf-czar.com`, `league.golf-czar.com`, `weekend.golf-czar.com`,
`fairway.golf-czar.com`). When you reissue or expand it, modern
certbot's `--cert-name X -d Y` form is a **replace**, not an add —
running

```bash
sudo certbot --nginx --cert-name golf-czar.com -d fairway.golf-czar.com
```

will hand you back a cert whose ONLY SAN entry is
`fairway.golf-czar.com`. Every other hostname on that cert starts
serving `CERT_COMMON_NAME_INVALID` in browsers immediately. This bit
us in May 2026.

**Rule:** when modifying a SAN cert, either

- **Include every existing domain in the `-d` list** —
  ```bash
  sudo certbot --nginx --cert-name golf-czar.com --force-renewal \
    -d golf-czar.com -d league.golf-czar.com \
    -d weekend.golf-czar.com -d fairway.golf-czar.com
  ```

- **Or use `--expand`** — appends to the existing SAN set instead of
  replacing it. Safer when you don't have the full list in your head.

**Pre-flight (always):**

```bash
sudo certbot certificates                  # See current SAN entries
```

**Post-check (always):**

```bash
sudo openssl x509 -in /etc/letsencrypt/live/<cert-name>/fullchain.pem \
  -noout -ext subjectAltName
```

The post-check is the only thing that catches a silent replace before
your users do.

---

## 8. Recommended next PRs (priority order)

These are the highest-leverage follow-ups based on what surfaced
during this review:

1. **(P0) Supabase Cloud → self-hosted Postgres + auth migration.**
   Single biggest unblocker for true LAN data sovereignty. Recommend
   shore-jones-style SSO matching DayTrader/MultiDayTrader.
2. **(P0) Score-sync systemd timer** (the every-10-min flow). Concrete
   unit shown in §4; not committed yet.
3. **(P0) `season_standings` cross-season bleed fix.** One filter on
   `from('fantasy_results').select(...)` — see TODO and
   `sync-scores/route.ts:112-129`.
4. **(P0) Unique-foursome DB constraint.** Add a sorted-tuple hash
   column with `UNIQUE` to close the race in `validatePick`.
5. **(P1) Profile-insert via DB trigger.** Move `profiles` row creation
   off the browser anon client.
6. **(P1) RLS on `profiles`.**
7. **(P2) Flip `next.config.js` `ignoreBuildErrors` / `ignoreDuringBuilds`
   off.** Lint + build are clean now; lock that in.
8. **(P2) `withdrawal-replacement UI` page.** API exists, no caller.
9. **(P3) README rewrite + delete `vercel.json`** post-migration.
10. **(P3) PWA manifest + service worker** so the push-reminder
    channel can actually subscribe.

---

## 9. Quick verification — run this exact sequence

```bash
cd /opt/fairway-fantasy
git pull
npm ci
cp .env.local.example .env.local       # then fill in real values
npm run lint                            # 0 errors expected
npm test                                # 167 passing (or whatever the current count is)
npm run build                           # success expected
sudo systemctl restart fairway-fantasy
curl -fsS http://localhost:3000/        # landing page
curl -fsS http://localhost:3000/demo    # public demo league
```

If any step fails, that's the start of your debugging trail.
