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
# 1. Install Node 20 (or matching LTS) via nvm or distro package
sudo apt-get install -y nodejs npm

# 2. Clone the repo
sudo mkdir -p /opt/fairway-fantasy
sudo chown greg:greg /opt/fairway-fantasy
cd /opt/fairway-fantasy
git clone https://github.com/gjcnvrtman/FairwayFantasy.git .

# 3. Install deps
npm ci

# 4. Provision Postgres
#    Until TODO P0 (Supabase migration), this app uses Supabase Cloud.
#    Two options:
#      a) Free Supabase Cloud project (no LAN data sovereignty).
#      b) Self-hosted Supabase via Docker:
#         git clone https://github.com/supabase/supabase
#         cd supabase/docker && docker compose up -d
#         Then run our supabase/schema.sql in the SQL editor.
#    Either way, copy the URL + service-role key into .env.local.

# 5. Configure env
cp .env.local.example .env.local
# Edit .env.local — set:
#   NEXT_PUBLIC_SUPABASE_URL
#   NEXT_PUBLIC_SUPABASE_ANON_KEY
#   SUPABASE_SERVICE_ROLE_KEY
#   CRON_SECRET (openssl rand -hex 32)
#   NEXT_PUBLIC_SITE_URL=http://192.168.1.160:3000

# 6. Build
npm run build
```

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

## 7. Recommended next PRs (priority order)

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

## 8. Quick verification — run this exact sequence

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
