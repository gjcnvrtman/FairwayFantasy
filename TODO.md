# TODO — Fairway Fantasy

Source of truth for incomplete code, bugs, security gaps, and follow-up work. Items are added the moment they're discovered. When something is finished AND tested it moves to **Done** at the bottom with a date.

Cross-references like `(P1 #3.1)` point back to the Prompt 1 repo review (in-conversation, not in a file). `(P5)` etc. = surfaced during the Prompt N work.

---

## P0 — blocks production / security / data corruption

- [x] **ESPN rankings dead → balldontlie integration landed.** ESPN's `/pga/rankings` returned 500 (`{"code":2404,"detail":"http error: not found"}`) in May 2026. Swapped rankings source to balldontlie's `/pga/v1/players` endpoint (free tier, 5 req/min). New file `src/lib/balldontlie.ts`. `src/lib/datagolf.ts` refactored — keeps the name + `syncRankingsToDatabase()` signature, now UPDATE-only (balldontlie has no ESPN ID, so we can't insert new golfers; ESPN's leaderboard / `scripts/seed-golfers.ts --from-event` is the source for new rows). Hand-maintained `data/owgr-top.json` + the `--apply-ranks` flag of seed-golfers remain as emergency fallback. ✓
- [ ] **(P2) Rename `src/lib/datagolf.ts` → `src/lib/rankings.ts`** — has been misleading since the DataGolf days; balldontlie is the third source. Cosmetic.

### Live-scoring risk for PGA Championship (Thu May 14) — high P0
- [ ] **`fetchLiveLeaderboard` in `src/lib/espn.ts` has the SAME bugs as the old `seed-golfers.ts`** — uses the broken `/pga/leaderboard?event=` endpoint (404s) AND reads `c.displayName` which ESPN now returns null. Apply the same fixes: fall back to `/pga/scoreboard?event=`, read name from `c.athlete?.displayName ?? c.athlete?.fullName`. Without this, the score-sync timer fires faithfully every 10 min Thu-Sun starting May 14 but updates no live scores. Verify Thursday morning by manually triggering `sudo systemctl start fairway-scores.service` and watching journalctl.

### ESPN data + sync timers (action: run install.sh on .160)
- [ ] **Install + run the ESPN sync timers.** Unit files + helper script shipped at `infra/systemd/`. One command on .160:
  ```bash
  cd /opt/fairway-fantasy
  git pull origin main
  sudo ./infra/systemd/install.sh --populate
  ```
  - `--populate` runs the rankings sync once immediately to fill the empty DB (~200 golfers + ~40 tournaments).
  - Without `--populate` it just installs the timers; you can populate later with `sudo systemctl start fairway-rankings.service`.
  - Timers installed: `fairway-rankings.timer` (Mondays 06:00 — keeps OWGR + schedule current) + `fairway-scores.timer` (every 10 min Thu–Sun — pulls live scores during play).
  - Verify after install: `systemctl list-timers fairway-*` and `psql -c 'SELECT COUNT(*) FROM golfers'`.
- [x] **Bug fix bundled in:** runScoreSync now queries by `start_date <= now AND end_date >= now-1d AND status != 'complete'` instead of the previous `status IN ('active', 'cut_made')`. The old version had a chicken-and-egg bug: rankings sync inserts new tournaments with default status `upcoming`, but nothing flipped them to `active` when start_date arrived, so the score sync skipped them forever. Now any tournament whose start_date has passed gets a sync; syncTournament() updates the status field from ESPN's response.

### Open signup since deployment went public
- [ ] **Public-internet exposure now real, not LAN** — these were P3 ("LAN-only mitigates") but the mitigation no longer applies:
  - Anyone with the URL can register at `/auth/signup`. Lock down with invite-only signup (require an `inviteCode` in the register POST body that maps to a real league).
  - No rate limiting on `/api/auth/register` or `/api/picks`. Mitigated by SameSite cookies, not eliminated. Add per-IP throttle.
  - No password complexity beyond 8-char min — anyone could pick "12345678".
  - Email verification non-blocking — anyone can register with someone else's email.

### Backups
- [ ] **Daily `pg_dump` cron + off-machine copy** — no automated backup. The moment real picks land, the data is irreplaceable. One-line cron ships ~5 minutes of work.

### Security
- [x] **`NEXT_PUBLIC_CRON_SECRET` exposed to client bundle** *(P1 #4.1)* — fixed in P8. New `/api/admin/sync-scores` endpoint is commissioner-authed via session cookie (no shared secret). Sync engine extracted to `src/lib/sync.ts`; the cron-secret-authed `/api/sync-scores` still exists for the systemd timer but no client code references it. ✓
- [x] **Server Component onClick at `src/app/league/[slug]/page.tsx:267`** *(P1 #4.9, B-series #B4)* — fixed in P7. Extracted to `<InviteCard>` client component with proper `'use client'` + `navigator.clipboard.writeText` + `execCommand('copy')` fallback for non-HTTPS LAN. ✓

### Correctness
- [ ] **Season standings cross-tournament/season bleed** *(P1 #3.3)* — `src/app/api/sync-scores/route.ts:112-129` `recomputeResults` updates `season_standings` from `from('fantasy_results').select(...)` with NO `tournament_id`/`season` filter. Pulls ALL rows globally, so standings accumulate across seasons. Add the proper filters before the next score sync runs.
- [ ] **`best_finish = 999` garbage initialization** *(P1 #3.4)* — `sync-scores/route.ts:120`: initial branch sets `e.best = r.rank ?? 999` but the later branch only updates `best` when `r.rank` is truthy, so 999 sticks for any user whose first row has null rank.
- [ ] **Unique-foursome rule is app-only, not DB-backed** *(P1 #3.2 / P5 risks)* — `src/lib/scoring.ts:validatePick` rejects identical foursomes, but the schema's only constraint is `UNIQUE(league_id, tournament_id, user_id)`. Two users submitting identical 4-tuples concurrently both pass validation and both insert. Fix: deferred-uniqueness via a sorted-tuple hash column with `UNIQUE`, or wrap pick-insertion in a serializable transaction.

---

## P1 — broken UX / latent build issues / structural

- [x] **Build fails on `/dashboard` and `/api/picks/setup` prerender without env vars** *(P3 / dev experience)* — fixed in P10. Added `export const dynamic = 'force-dynamic'` to `/dashboard`, `/settings`, `/api/picks/setup`, `/api/me/notification-prefs`. `npm run build` now succeeds with empty env. ✓
- [x] **Mobile-broken layouts on remaining pages** *(P1 #6.1-6.10)* — fixed in P7. Both `src/app/league/[slug]/page.tsx` and `src/app/dashboard/page.tsx` now use the same flex-wrap pattern as the picks page (P5). ✓
- [ ] **No withdrawal-replacement UI** *(P1 - Main user flows)* — API exists at `src/app/api/picks/route.ts:57-84` but no page calls it.
- [ ] **No demo route originally; resolved in P3** ✓ — moved to Done.
- [ ] **`pick_deadline` uses tournament `start_date - 1h`** *(P1 #3.6)* — set in `sync-scores/rankings/route.ts:31`. Real first-tee-time can differ by 6+ hours from ESPN's reported `start_date`. Either use a per-tournament tee-time source or expose a commissioner override.
- [x] **Profile insert from browser anon client** *(P1 #3.5, #4.7)* — obsolete in P4. Signup now goes through `/api/auth/register` (server-side), which inserts profile + auth_credentials atomically in a kysely transaction. No browser-side DB writes anywhere. ✓
- [x] **`profiles` table has no RLS enabled** *(P1 #3.5)* — obsolete in self-host. We explicitly dropped RLS in `infra/postgres/init/00-schema.sql` because `auth.uid()` doesn't exist outside Supabase. App-level enforcement via `requireCommissioner` etc. is the model. Adding RLS back later is fine; would be belt-and-suspenders, not a primary defense. ✓

---

## P2 — quality / monitoring / future-proofing

- [ ] **TS strict mode + flip `next.config.js` ignore flags** *(P1 #4.10, #4.11)* — P10 added `.eslintrc.json` (`next/core-web-vitals`) + pinned ESLint v8 + fixed all 5 surfaced lint errors. Lint + tsc both clean now. Remaining work: flip `typescript.ignoreBuildErrors` / `eslint.ignoreDuringBuilds` off in `next.config.js` and turn on `tsconfig.json` strict mode. Was kept on for safety; can flip once a baseline is comfortable.
- [ ] **`calculateTop3` partial-data semantics ambiguous** *(P1 #5.3, pinned in `tests/picks.test.ts`)* — when fewer than 3 golfers have scored, returns sum of remaining. A user with 2 scored at -5 outranks a user with 3 scored at -4. Documented in `scoring.ts` JSDoc + locked by test. Decide between (a) keep current, (b) penalize with a high number per missing slot, (c) pro-rate. P5/P6 left as-is pending product decision.
- [ ] **`isReplacementEligible` vs in-route inline check are different** *(P1 #5.6)* — `scoring.ts:isReplacementEligible` checks `!golfer.teed_off && golfer.status === 'active'`. The actual usage at `picks/route.ts:73-77` checks `repScore?.round_1 !== null`. Two truths. Pick one and delete the other.
- [ ] **`mapESPNStatus` MDF case** *(P1 #5.10 partial)* — P6 fixed `STATUS_FINAL` mapping, but `MDF` (made cut, did not finish) still falls through to `active`. Pinned by test so behavior is deliberate. Decide whether MDF → `complete` (final, score frozen) or stay `active`.
- [ ] **Score-sync recomputeResults is O(N×M) per league per cycle** *(P1 #5.7)* — runs on every score update for every active tournament. Fine at small scale, would hit Vercel timeout at scale. Consider incremental updates or batch.
- [ ] **`MAX_PLAYERS` not editable from UI after creation** *(P4 risks)* — schema supports it; commissioner admin should grow that field. Hint on create form notes it's not editable yet.
- [ ] **Demo leaderboard sample data could collide with real PGA results** *(P3 risks)* — if a real Masters happens to produce identical names + scores, the demo will look stale. Low probability.
- [ ] **Relative-time label not live-updating** *(P5 risks)* — `formatRelativeTime` in picks page is computed at render, not live. "in 2d 4h" stays static if user sits on the page. Acceptable for now since saves reload the page.

---

## P3 — research / tuning / docs

- [ ] **Stale README / SETUP** *(P1 #20)* — README references DataGolf (now ESPN), `DATAGOLF_API_KEY` env var (unused), Vercel Quick Start (replacing). SETUP.md likely similar. Rewrite for LAN deployment + actual stack.
- [ ] **No CSRF protection** *(P1 #4.12)* — state-changing endpoints have no CSRF token. NextAuth mitigates `/api/auth/*` automatically; other POST endpoints rely on SameSite=Lax cookies + same-origin checks. Standard hygiene to add.
- [ ] *(moved to P0)* — rate limiting now real since public-internet exposure.
- [ ] **Unauthenticated public endpoints** *(P1 #4.4)* — `/api/players` and `/api/leagues/verify` have no auth. Public exposure now real; consider rate-limiting at minimum.
- [ ] **`GET /api/sync-scores` reuses `POST`** *(P1, sync-scores:133)* — works but unusual. Fine for now.
- [ ] **Schema has no `pick_locked_at` audit column** *(P1 #3.8)* — `is_locked` boolean alone doesn't capture WHEN it locked.
- [ ] **`picks.golfer_N_id` columns nullable** *(P1 #3.9)* — schema allows partial picks; should be `NOT NULL` after submission. Add CHECK constraint.
- [ ] **No co-commissioner role** *(P1 #3.10)* — `league_members.role` CHECK allows only `'commissioner'`/`'member'`. Future feature.
- [ ] **Heavy emoji use renders inconsistently** *(P1 #6.7)* — across iOS/Android/desktop. Consider SVG icons.
- [ ] **No PWA manifest, no offline fallback** *(P1 #6.8)* — "Install to home screen" experience absent.
- [ ] **`vercel.json` cleanup post-migration** — once we move off Vercel, the file is dead. Decide whether to delete or keep for future re-deploy parity.
- [x] **`.eslintrc` setup** — done in P10. Added `.eslintrc.json` extending `next/core-web-vitals`, pinned `eslint@^8.57.0` + `eslint-config-next@^14.2.35`. ✓

---

## NOT doing (per scope decisions)

- Vercel-specific assumptions in any new code — explicitly removed by every prompt's deploy preamble.
- DataGolf integration — replaced by ESPN rankings inside `src/lib/datagolf.ts` (filename retained pending docs cleanup).
- Standalone `/api/sync-scores` Vercel cron config — folded into the systemd timer plan above.

---

## Done

(Newest first.)

### 2026-05-10 — Data plumbing complete: 48 tournaments + 195 golfers + 155 ranked
End-to-end ESPN + balldontlie integration shipped. Picks page is functional. Currently showing Truist Championship (in final round) as "current event."

**API source map after today:**
| Source | Endpoint | Status |
|---|---|---|
| Tournament schedule | ESPN `/pga/scoreboard` calendar | ✓ works, 48 events Jan-Dec 2026 |
| Player field | ESPN `/pga/scoreboard?event=` (with athlete.displayName parsing) | ✓ works, 195 unique players landed today |
| OWGR rankings | balldontlie `/pga/v1/players` (free tier, 5 req/min) | ✓ works, 155 ranked |
| Live scores | ESPN `/pga/leaderboard?event=` | ⚠ NOT verified — likely needs same fixes as seed-golfers (see below) |

**Patches landed today (in order):**
- `e2b1496` — sync-scores/rankings route partial-success (rankings + schedule independent)
- `c3949c7` — seed-golfers.ts + owgr-top.json fallback
- `d70d836` — balldontlie integration replaces ESPN /pga/rankings (dead)
- `61850d9` — seed-golfers falls back from leaderboard to scoreboard endpoint on 404
- `32a1c18` — seed-golfers parses `c.athlete.displayName` (scoreboard's null `c.displayName`)
- `65f78f9` — rankings route self-heals stale tournament statuses (was showing The Sentry as "next")

**Final state confirmed:**
- 48 tournaments, status correctly distributed (past = complete, current = active, future = upcoming)
- 195 golfers in DB, 155 ranked from balldontlie, 20 top-tier (rank 1-24)
- Dashboard + picks page show Truist Championship (correct)
- Self-healing: weekly rankings cron + status maintenance keeps things fresh

### 2026-05-10 — Production deployment: Fairway live at https://fairway.golf-czar.com
End-to-end deployment finished. App running with HTTPS, signed in successfully, all routes work.

**Topology (recorded for failover reference):**
- `192.168.1.150` (production face) — nginx + Let's Encrypt SAN cert covering all `*.golf-czar.com` subdomains. Hosts golf-czar app + a server-block proxy for fairway.
- `192.168.1.160` (mirror box, hosts Fairway) — Fairway Next.js process under systemd on port 3000, local Postgres in Docker on port 5434 (loopback only), ufw allows port 3000 from `.150` only.
- Public traffic flow: `https://fairway.golf-czar.com` → nginx on .150 → cross-LAN to `192.168.1.160:3000` → Fairway → `127.0.0.1:5434` Postgres on .160.

**Setup performed (in order):**
- [x] Started fresh — no Supabase data migration needed.
- [x] `infra/postgres/docker-compose.yml` brought up on .160 with hex POSTGRES_PASSWORD. Schema auto-applied on first init (`init/00-schema.sql`).
- [x] `seed-user.ts` ran once on .160 to create the first user (bcrypt hash + email_verified=true).
- [x] `.env.local` on .160 set: DATABASE_URL → loopback Postgres on :5434, NEXTAUTH_SECRET (openssl rand -base64 32), CRON_SECRET (openssl rand -hex 32), NEXTAUTH_URL + NEXT_PUBLIC_SITE_URL → https://fairway.golf-czar.com.
- [x] nginx server-block on .150 at `/etc/nginx/sites-{available,enabled}/fairway-subdomain` proxying to `192.168.1.160:3000`. SAN cert at `/etc/letsencrypt/live/golf-czar.com/` reused (cert covers fairway).
- [x] HTTP→HTTPS 301 redirect block + `listen 443 ssl;` block (matches existing `weekend.golf-czar.com` style).
- [x] systemd unit `fairway-fantasy.service` on .160 with `EnvironmentFile=/opt/fairway-fantasy/.env.local`, `Restart=on-failure`. Enabled + active.
- [x] ufw on .160: removed broad LAN allow on :3000, replaced with `allow from 192.168.1.150 to any port 3000` so only the nginx box can reach Fairway.
- [x] End-to-end browser test: landing → /auth/signin → sign in with seeded creds → /dashboard. Cookies scoped to fairway.golf-czar.com.

**Patches landed during deployment** (each its own commit):
- `5be6a4d` — DEPLOYMENT.md fix: NodeSource vs Debian npm conflict.
- `e16c848` — DEPLOYMENT.md fix: `curl get.docker.com | sh` instead of nonexistent `docker-compose-v2` apt package.
- `0505668` — DEPLOYMENT.md + .env.example: PGPASSWORD env-var psql, hex (not base64) for POSTGRES_PASSWORD (URI-safe).
- `dda0866` — Drop `deploy.resources.limits.memory` from postgres compose (cgroup v2 unavailable on Greg's kernel).
- `a18f712` — `scripts/seed-user.ts` + "starting fresh" deploy path in DEPLOYMENT.md (no Supabase migration).
- `80a6fa7` — **NextAuth split-config**: `auth.config.ts` (edge-safe) + `auth.ts` (Node-runtime) + `middleware.ts` rewrite. Fixed runtime crash on first request: `Error: The edge runtime does not support Node.js 'crypto' module.`

### 2026-05-10 — golf-czar migration Phase 5: cutover tooling + runbook
The actual cutover requires running commands on the LAN box (Docker compose, real migration, prod env flip) and isn't something I can execute from a dev box. What I shipped: the operational tooling around the cutover so it's safe and rollback-able when Greg runs it.

- [x] **`scripts/preflight-check.ts`** — runs BEFORE migration. Validates source + target reachable, source has Supabase auth schema, source has expected app tables, source row counts non-zero (catches "wrong cloud project" mistakes), target schema applied, target empty-or-known, `auth.users` has password hashes. Exit 0 = good to migrate.
- [x] **`scripts/post-migration-check.ts`** — runs AFTER migration, BEFORE flipping prod's `DATABASE_URL`. Validates row-count parity (source vs target), every profile has matching `auth_credentials` (so users can sign in), bcrypt hash format looks right, no orphan FKs across `league_members`, `picks`, `scores`, `fantasy_results`. Exit 0 = safe to flip prod env.
- [x] **`infra/postgres/docker-compose.yml`** — host port now configurable via `POSTGRES_HOST_PORT` env var (default 5432). Lets you stand it up locally on a different port without colliding with another Postgres.
- [x] **`DEPLOYMENT.md` Phase-5 runbook** — 9-step walkthrough from Docker standup through end-to-end browser smoke test through Supabase decommission. Plus a "Rollback plan" section (just flip `DATABASE_URL` back, restart) and "Common issues" (NEXTAUTH_SECRET guard, cookie-domain mismatches, bcrypt shape).

WHAT DIDN'T HAPPEN HERE
- The actual data migration. That has to happen on the LAN box where Docker is running and where the prod systemd unit lives.
- Local end-to-end test against a real Postgres. Tried — Docker daemon isn't running on the dev box. The runbook is the substitute; the scripts will fail loud with clear messages if anything's wrong.

### 2026-05-10 — golf-czar migration Phase 4: NextAuth + Credentials
Replaces Supabase Auth with NextAuth v5 (Auth.js) using a Credentials provider against the local `auth_credentials` table. Bcrypt cost 10 — compatible with Supabase's hashes so existing users keep their passwords after Phase 5 migration.

- [x] **`next-auth@^5.0.0-beta.20`** + **`bcryptjs`** installed.
- [x] **`@supabase/ssr` and `@supabase/supabase-js` uninstalled**. The dependency is gone — Fairway no longer imports any Supabase code.
- [x] **`src/auth.ts`** — NextAuth config. Credentials provider with bcrypt, JWT session strategy, `authorize()` joins `profiles` × `auth_credentials`. Updates `last_login_at` best-effort. Strong-secret guard at module load (mirrors golf-czar's pattern).
- [x] **`src/app/api/auth/[...nextauth]/route.ts`** — exports NextAuth handlers.
- [x] **`src/app/api/auth/register/route.ts`** — public POST. Validates input via shared `validateRegistration`, checks email uniqueness, hashes password, inserts profile + auth_credentials atomically in a kysely transaction.
- [x] **`src/lib/auth-validation.ts`** — pure registration validator (used by both client and server). 14 tests.
- [x] **`src/lib/current-user.ts`** body swapped — calls `auth()` from NextAuth instead of Supabase. Same return shape, all 12 callsites unchanged.
- [x] **`src/lib/auth-decisions.ts`** (new) — pure decision helpers split out so unit tests can import without pulling NextAuth into Vitest. `auth-league.ts` re-exports them.
- [x] **`src/middleware.ts`** rewritten — uses NextAuth's `auth()` middleware export. Same protected-route logic, no cookie-refresh dance.
- [x] **`src/app/auth/signin/page.tsx`** — `signIn('credentials', {...})` from `next-auth/react`.
- [x] **`src/app/auth/signup/page.tsx`** — POST `/api/auth/register`, then auto-login via `signIn`. Field-level error rendering. Uses `AUTH_LIMITS` constants.
- [x] **`src/app/auth/callback/route.ts`** deleted (was Supabase email-confirmation handler).
- [x] **`src/components/layout/Nav.tsx`** — `signOut` from `next-auth/react`.
- [x] **`src/app/join/[slug]/[code]/page.tsx`** — `useSession()` from `next-auth/react`.
- [x] **`src/components/providers/AuthProvider.tsx`** + `layout.tsx` — `<SessionProvider>` wraps the app so `useSession()` works in client components.
- [x] **`src/lib/supabase.ts`** + **`src/lib/supabase-server.ts`** deleted. Zero references remain.
- [x] **`tests/auth-validation.test.ts`** — 14 tests covering email regex, display-name boundaries, password length boundaries, multi-field error reporting.
- [x] **`.env.local.example`** updated — Supabase vars removed, `NEXTAUTH_SECRET` + `NEXTAUTH_URL` documented.

VERIFICATION
- npm run lint: 0 errors, 1 doc'd warning (custom fonts in layout)
- npm test: 181 / 181 (was 167; +14 new auth-validation tests)
- npx tsc --noEmit: clean
- npm run build: 24 routes, 0 errors

WHAT'S LEFT FOR ACTUAL CUTOVER (Phase 5)
1. Stand up local Postgres on 192.168.1.160 via `infra/postgres/docker compose up -d`.
2. Run `npx tsx scripts/migrate-from-supabase.ts --dry-run` to count, then real run.
3. Flip `DATABASE_URL` on prod Fairway to point at local Postgres.
4. Restart. Existing users sign in with their existing passwords (bcrypt hashes flowed through migration).

### 2026-05-10 — golf-czar migration Phase 3: local Postgres standup
Architecture decision (recorded in conversation): Fairway is **not** integrating with golf-czar's SSO. `fairway.golf-czar.com` is just a DNS subdomain — nginx host-routes it to a fully independent Fairway instance. Phase 4 will use NextAuth + Credentials + bcrypt for Fairway's own auth.

- [x] **`infra/postgres/docker-compose.yml`** — Postgres 16-alpine, bound to `127.0.0.1:5432` (LAN access via SSH tunnel only). Named volume `fairway-pgdata`. Healthcheck. Auto-applies init scripts on first start.
- [x] **`infra/postgres/init/00-schema.sql`** — self-host schema. Differences from `supabase/schema.sql`:
  - Drop `REFERENCES auth.users(id)` from `profiles.id`
  - Drop all 8 RLS policies (app-level auth via `requireCommissioner` is the source of truth)
  - Add `auth_credentials` table (Phase-4 NextAuth Credentials writes here; Phase-5 cutover bulk-imports bcrypt hashes from Supabase's `auth.users`)
  - Add `email`/`UNIQUE` constraint on `profiles.email` (auth flow needs it)
  - Indexes on `auth_credentials.verify_token` / `reset_token`
- [x] **`src/lib/db/schema.ts` updated** to include `AuthCredentialsTable` (matches the SQL file).
- [x] **`scripts/migrate-from-supabase.ts`** — one-shot data migration. Connects to BOTH source (Supabase Cloud direct pg) and target (local Postgres). Copies 12 tables in dependency order with `ON CONFLICT DO NOTHING` (idempotent). Pulls bcrypt hashes from `auth.users.encrypted_password` into `auth_credentials.password_hash` so existing users keep their current passwords (no forced reset). Has a `--dry-run` flag. Run ONCE at Phase-5 cutover.
- [x] **`tsx` added as dev dep** so `npx tsx scripts/...` works.
- [x] **`.env.local.example`** updated — `DATABASE_URL` documented with both Supabase-direct-pg and local-Postgres connection-string forms. `SUPABASE_SERVICE_ROLE_KEY` removed (no longer used post-Phase-2).
- [x] **`DEPLOYMENT.md`** — new "Postgres details (Phase 3)" + "Data migration (Phase 5 cutover)" sections. Updated env-var checklist.

VERIFICATION
- npm run lint: 0 errors
- npm test: 167 / 167
- npx tsc --noEmit: clean
- npm run build: 24 routes, 0 errors

NEXT (Phase 4): NextAuth + Credentials + bcrypt. Adds `app/api/auth/[...nextauth]/route.ts`, rewrites `current-user.ts` to call NextAuth's `auth()` helper, replaces `signin/signup/callback` flows. Email verification non-blocking (banner only) until SMTP is wired.

### 2026-05-10 — golf-czar migration Phase 2: data-access boundary (kysely)
Replaced every `supabaseAdmin.from(...)` callsite (~50 ops across 15 files) with kysely. Pure mechanical translation; behavior unchanged. App still talks to Supabase Cloud today via direct pg connection — Phase 3 stands up local Postgres and just flips `DATABASE_URL`.
- [x] **`kysely` + `pg` + `@types/pg`** installed and pinned.
- [x] **Hand-written schema types** at `src/lib/db/schema.ts` mirror `supabase/schema.sql` exactly. 11 tables. Single source of truth — when you change the SQL, change the TS.
- [x] **Lazy `db` proxy** at `src/lib/db/index.ts` — same pattern as `supabaseAdmin`. Pool created on first query, never at module load. Build/tests pass without `DATABASE_URL` set; runtime queries throw a clear error until configured.
- [x] **`src/lib/db/queries.ts`** — replaces the helpers that lived in `lib/supabase.ts`. Joins via `jsonObjectFrom` from `kysely/helpers/postgres` so the response shape stays compatible with what supabase-js produced.
- [x] **15 callsites migrated**: all API routes (`leagues/*`, `picks/*`, `players`, `me/notification-prefs`, `sync-scores/rankings`), all server-rendered pages (`dashboard`, `settings`, `league/[slug]`, `league/[slug]/admin`, `league/[slug]/history`), and library code (`auth-league.ts`, `sync.ts`, `reminder-job.ts`, `datagolf.ts`).
- [x] **`strictNullChecks: true`** added to `tsconfig.json`. kysely's `Generated<T>` type relies on it; without it, `string | undefined` collapses to `string` and inserts demand all columns. Surfaced 4 type errors elsewhere in the codebase (now fixed): `scoring.ts:226` rank assignment, `history/page.tsx:134` null score guard, `admin/page.tsx:54` member shape, `AdminPanel` member type.
- [x] **Build leak fix**: removing the `db/queries` re-export from `lib/supabase.ts` prevents `pg` (Node-only driver: tls, dns) from being bundled into client components like `<Nav>` that import `createBrowserSupabaseClient`.
- [x] **`lib/supabase.ts` slimmed** to just `createBrowserSupabaseClient` (Phase 4 will delete this file when client-side Supabase auth goes away).
- [x] **`supabaseAdmin` removed** entirely. Gone from imports, exports, and call graph.

VERIFICATION
- npm run lint: 0 errors, 1 doc'd warning
- npm test: 167 / 167
- npx tsc --noEmit: clean (with strictNullChecks now on)
- npm run build: 24 routes, 0 errors

NEXT (Phase 3): stand up local Postgres on `192.168.1.160` via Docker, apply `supabase/schema.sql` (with the noted modifications: drop `auth.users` FK, add `golf_czar_user_id`), point `DATABASE_URL` at it. Phase 4: golf-czar JWT in the auth boundary. Phase 5: data migration cutover.

### 2026-05-10 — golf-czar migration Phase 1: auth boundary
- [x] See commit `39ec9c0`. Single boundary file `src/lib/current-user.ts`. 12 server-side callsites rewired. Implementation still Supabase Auth under the hood; Phase 4 swaps it to golf-czar JWT.

### 2026-05-10 — Prompt 10: full QA + LAN deployment readiness review
- [x] **`DEPLOYMENT.md`** — pass/fail table for every prompt-10 check, bug list (fixed + deferred), full systemd unit + nginx + ufw walkthrough, env var reference, firewall checklist, recommended next-PR priority list. **First clean `npm run build`** in the project's history.
- [x] **`next build` fixed** — added `export const dynamic = 'force-dynamic'` to `/dashboard`, `/settings`, `/api/picks/setup`, `/api/me/notification-prefs`. Auth-gated routes never made sense to prerender; were silently failing without Supabase env. Build now produces 24 routes with 0 errors.
- [x] **`.eslintrc.json`** + ESLint v8 pinned — closes long-standing TODO. `npm run lint`: 0 errors, 1 warning (custom-fonts in layout — documented).
- [x] **5 lint errors fixed** — unescaped `'` in `signup/page.tsx`, `dashboard/page.tsx`, `join/[slug]/[code]/page.tsx`. `&rsquo;` swap.
- [x] **`.env.local.example` updated** for P9 (`REMINDERS_LIVE`, future SMTP/Twilio placeholders). Comments now describe all three modes (preview / dev / LAN prod).

### 2026-05-10 — Prompt 9: pick-reminders foundation + 30 new tests
- [x] **Schema** — `reminder_preferences` (per-user opt-in: email/sms/push booleans, hours_before, per-channel destinations) + `reminder_log` (audit + idempotency via `UNIQUE(user_id, tournament_id, channel)`). RLS on prefs so users only see their own row. Appended to `supabase/schema.sql` as additive `IF NOT EXISTS`.
- [x] **Pure eligibility logic** at `src/lib/reminders.ts` — `findUsersDueForReminder({ tournament, members, picksByUserLeague, prefsByUser, profileEmailByUser, alreadySent, now })` returns `ReminderTask[]`. Pure function, no I/O, fully deterministic. Helpers: `enabledChannels`, `isInsideReminderWindow`, `destinationFor`, `buildPicksByUserLeague`, `buildAlreadySentSet`.
- [x] **Notifier placeholder** at `src/lib/notifier.ts` — `dispatchReminder(task, buildMessage)` routes per channel. Default: console-only driver (always safe, never sends real messages). Real drivers register via `registerDriver(channel, driver)` and only fire when `REMINDERS_LIVE=true` AND `driver.isConfigured()`. Default reminder message template is channel-aware (SMS bodies are short).
- [x] **Job runner** at `src/lib/reminder-job.ts` — wires DB I/O around the pure logic. Logs every attempt to `reminder_log` (status='console' when in dry-run mode).
- [x] **Endpoints**:
  - `POST /api/admin/reminders` — accepts EITHER Bearer CRON_SECRET (systemd timer) or commissioner session (manual button). Calls `runReminderJob()`, returns summary.
  - `GET /api/me/notification-prefs` — returns current user's prefs, falls through to defaults if no row.
  - `PUT /api/me/notification-prefs` — upserts; validates SMS-without-phone, push-without-token, hours_before bounds (1..168). Server uses session user.id, ignores any user_id in the body.
- [x] **`/settings` page** + `NotificationPrefsForm` client component — per-channel toggles (default OFF), email/phone/push fields, hours_before number input, save feedback. Sidebar entry on `/dashboard`.
- [x] **`tests/reminders.test.ts`** — 30 unit tests covering: `enabledChannels`, `isInsideReminderWindow` (window boundaries, per-user hours_before), `destinationFor` (override + fallback + null), `findUsersDueForReminder` (happy path, missing-prefs, all-off, already-picked, multi-league per user, non-upcoming tournament status, no-deadline, outside-window, idempotency via alreadySent, missing-destination still emits a task for audit, full-off-roster privacy invariant).
- [x] **Acceptance criteria met**:
  - "No accidental real messages sent" — notifier defaults to console; real send requires `REMINDERS_LIVE=true` AND a driver registered.
  - "Code is structured so email/SMS/push can be added later" — `ChannelDriver` interface + `registerDriver` + per-channel destination fields.
  - "Reminder logic is testable" — eligibility logic is a pure function with 30 tests.

### 2026-05-10 — Prompt 8: commissioner tools + #4.1 fix + 18 new tests
- [x] **`NEXT_PUBLIC_CRON_SECRET` exposed to client (P0 #4.1)** — fixed. AdminPanel "Sync Now" button now POSTs to a new `/api/admin/sync-scores` endpoint that authenticates via session cookie + commissioner role check. Sync engine extracted to `src/lib/sync.ts`. Cron-secret-authed `/api/sync-scores` still exists for systemd timer; no client code references the secret anymore.
- [x] **Centralized auth helper** at `src/lib/auth-league.ts` — `requireCommissioner({slug?, leagueId?})` returns a tagged-union `{ ok, user, league, role }` or `{ ok: false, response }`. Status code matrix: 400 missing-id / 401 no-session / 403 not-commissioner / 404 not-found-or-not-member (collapsed for privacy). All commissioner endpoints now use the same helper.
- [x] **Last-commissioner guard** — `wouldOrphanLeague` blocks DELETE that would leave the league with zero commissioners. The DB schema only allows one commissioner today, but the guard is future-proof for co-commissioners.
- [x] **Hardened `DELETE /api/leagues/members`** — explicit 400 on missing userId, last-commissioner guard, error surfacing on caller side.
- [x] **Hardened `POST /api/leagues/invite`** — uses `requireCommissioner`, surfaces DB errors, no silent failures.
- [x] **AdminPanel rewrite** — uses shared `<InviteCard>` (P7) for clipboard with execCommand fallback. New "League Settings" read-only summary card (name, slug, max players, created date, "league full" warning). Confirm dialog before regenerating invite + before removing member. Per-row + global error surfaces for failed actions. Loading states on all buttons via `aria-busy`.
- [x] **Mobile responsiveness on members table** — email + joined columns are `hide-mobile`; email folds inline under the name on phones via new `.show-mobile` utility. Removed dead `nth-child(n+5)` CSS rule that was hiding the Remove-button column on mobile (silent admin breakage).
- [x] **Loading + error boundaries** for `/league/[slug]/admin` — Next 14 App Router pattern, skeleton matches the panel's section layout.
- [x] **`tests/auth-league.test.ts`** — 18 unit tests covering `decideCommissionerAuth` (every status code branch), `decideMemberAuth` (member acceptance, non-member rejection), `wouldOrphanLeague` (last-commissioner, multi-commissioner future-proofing, stale-userId no-op).

### 2026-05-10 — Prompt 7: league dashboard improvements + #4.9 fix + 23 new tests
- [x] **`<InviteCard>` client component** at `src/components/league/InviteCard.tsx` — fixes P0 bug #4.9 (server-component `onClick` would 500 at runtime). `navigator.clipboard.writeText` with `document.execCommand('copy')` fallback for non-HTTPS LAN deployment. Flashes "Copied!" feedback for 2.5s.
- [x] **Mobile-first layout fix** for `/league/[slug]` and `/dashboard` — replaced `gridTemplateColumns: '1fr 300px'` with flex-wrap (`flex: 1 1 480px` main column + `flex: 0 1 300px` sidebar). Sidebar now wraps below on phones. Closes TODO P1 #6.1.
- [x] **Lock-status banner** at top of league dashboard — directly answers "are picks open?" with deadline countdown when known. Hidden when no tournament data so the empty-state messaging takes priority.
- [x] **Post-lock pick reveal** — leaderboard rows expand to show each user's foursome via native `<details>`/`<summary>` (no JS dependency). Privacy gate: `shouldRevealOtherPicks` returns false unless the tournament status is locked. Current user always sees their own pick. Trailing reminder line "🔒 Other players' foursomes will appear once picks lock" when reveal is gated.
- [x] **Smarter empty states** — `deriveLeagueEmptyState` returns one of `solo-commissioner`, `no-tournament-no-upcoming`, `no-tournament-but-upcoming`, or `null` (real content). Page picks copy + CTA per state. Solo-commissioner case nudges to share invite link.
- [x] **Hero CTA labels match state** — `deriveHeroCTA` picks between `submit-picks`, `edit-picks`, `view-picks`, `submit-next`, or hides the button. No more "View My Picks" pre-pick.
- [x] **`loading.tsx` + `error.tsx` boundaries** for `/league/[slug]` and `/dashboard` — proper Next 14 App Router patterns. Skeletons mirror real layout to avoid jump on hydration; error boundaries surface a `digest` reference + try-again + back-out CTAs.
- [x] **`tests/league-dashboard.test.ts`** — 23 unit tests covering all four pure helpers. Pinned: 1-member league always wins solo-commissioner regardless of tournament state; locked-state + unsubmitted-pick still shows view-picks CTA (defensive); reveal gate stays false on every non-locked state.
- [x] **`.sr-only` utility** added to `globals.css` for screen-reader-only loading announcements.

### 2026-05-10 — Prompt 6: scoring engine review + 2 bug fixes + 27 new tests
- [x] **Named constants** in `src/lib/scoring.ts` — `MISSED_CUT_PENALTY_STROKES`, `MISSED_CUT_FALLBACK_SCORE`, `PICK_GOLFER_COUNT`, `COUNTING_GOLFER_COUNT`, `TOP_TIER_MAX_OWGR_RANK`. Hoisted from magic numbers; surfaced through tests.
- [x] **Top-of-file canonical rules block** — every fantasy rule is documented in plain English at the top of `scoring.ts` with bug-reference back to TODO.
- [x] **Bug #5.1 fixed** — `applyFantasyRules` now takes a `cutMade: boolean` param. Made-cut cap only fires during active play when the cut has officially been made (caller signal). `complete` always caps. `sync-scores/route.ts` passes `cutMade = newStatus !== 'active'`.
- [x] **Bug #5.2 fixed** — missed-cut with null cutScore now returns `MISSED_CUT_FALLBACK_SCORE` (99) instead of `rawScore + 1`. A -3 missed-cut golfer no longer beats legitimate cut survivors.
- [x] **`mapESPNStatus` `STATUS_FINAL` mapping** — `'final'` substring now correctly maps to `complete`. Was being routed to `active`, two truths between `sync-scores/route.ts:37` (knew final) and the central mapper. Fixed in `espn.ts`.
- [x] **27 new tests** in `tests/picks.test.ts` (now 60 total, 96 across both test files). Cover: round-in-progress (#5.1), null-cutScore-missed-cut (#5.2), constants surfaces, `computeLeagueResults` end-to-end (all-completed, partial, none, replacement handling), tied users (1-2-2 and 1-1-1-4 patterns), unrankable users (all WD/DQ → null rank), ESPN status edge cases (MC, F, unknown→active).

### 2026-05-10 — Prompt 5: picks page mobile-first + unranked-tier bug fix + 33 tests
- [x] **Picks page mobile-first rewrite** — replaced fixed `1fr 380px` grid with `flex-wrap` layout. Lock-deadline status row, "X of 4 selected" counter with progress bar, post-save confirmation panel, loading skeleton. Commit `ce91fb5`.
- [x] **Unranked-golfer tier bug** *(P1 #5.4)* — `validatePick` now treats `is_dark_horse === null` as eligible-for-DH-only, not eligible-for-top-tier. New `isTopTierEligible` / `isDarkHorseEligible` helpers with explicit `=== false` / `=== true || === null` checks. Aligns with `datagolf.ts:isDarkHorse`. Commit `ce91fb5`.
- [x] **`tests/picks.test.ts`** — 33 tests covering `validatePick` (happy path, completeness, duplicates, tier rules including the unranked-regression for #5.4, no-copycats), plus adjacent `calculateTop3` and `applyFantasyRules` coverage. Pinned-bug tests for P1 #5.2 (null cutScore + missed cut) so the next fix surfaces deliberately. Commit `ce91fb5`.

### 2026-05-10 — Prompt 4: create-league flow + Vitest setup + 36 tests
- [x] **Shared validation lib** at `src/lib/validation.ts` — `validateCreateLeague` + `deriveSlugFromName` are pure functions used by both client and server. Single source of truth. Commit `2375a72`.
- [x] **Improved create form** — added `maxPlayers` field (4–50), real-time validation with field-level errors, post-create success panel showing absolute invite URL with copy-to-clipboard, "Go to League Dashboard" / "Create Another" buttons (replaces immediate redirect). Commit `2375a72`.
- [x] **API route uses shared validator** — returns `fieldErrors` payload mapped per-input; slug-uniqueness 409 now lands as a field error. Commit `2375a72`.
- [x] **Vitest set up** — config + `test`/`test:watch` scripts + 36 tests covering happy path on every boundary, every validation-failure case, and `deriveSlugFromName`. Commit `2375a72`.

### 2026-05-10 — Prompt 3: public `/demo` league
- [x] **`/demo` route** — read-only sample league (8 players, Masters Round 3) demonstrating all rule cases (top-3 selection, missed-cut +1, made-cut cap, legal WD replacement, illegal WD replacement, no-copycats). Native `<details>`/`<summary>` for expandable picks per row, no JS dependency. Commit `c830793`.
- [x] **Landing-page demo CTAs** updated from `#demo-preview` anchor to `/demo` route. Commit `c830793`.

### 2026-05-10 — Prompt 2 ground-truth: env-tolerant dev mode
- [x] **Middleware no-ops without env** so the public landing page renders during dev without `.env.local`. `createBrowserSupabaseClient` and `createServerSupabaseClient` throw clear, actionable errors instead of the SDK's opaque "Your project's URL and Key are required". Commit `2d0b83e`.
- [x] **`.env.local.example`** documents the two paths (preview-only vs. full dev with real Supabase) and notes the broader plan to migrate off Supabase Cloud. Commit `2d0b83e`.

### 2026-05-10 — Prompt 2: landing page redesign + B1/B2/B3 build fixes
- [x] **Landing page** — stronger hero ("Pick Your Foursome. Beat Your Buddies."), inline demo leaderboard preview, How-It-Works 4-step section, product screenshot placeholders, social proof placeholders, mobile-first responsive grids. Commit `9e6c418`.
- [x] **B1 — Lazy `supabaseAdmin`** *(P1 build #1)* — module-load-time `createClient` was crashing `next build` "Collecting page data" without env vars. Replaced with a Proxy that defers construction until first property access. All 20+ existing call sites work unchanged. Commit `9e6c418`.
- [x] **B2 — Suspense for `useSearchParams`** *(P1 build #2)* — `auth/signin/page.tsx` was failing static prerender. Split into outer `SignInPage` (Suspense wrapper) + inner `SignInForm` (consumes the hook). Commit `9e6c418`.
- [x] **B3 — `next` 14.2.5 → 14.2.35** *(P1 #npm advisory)* — clears the 2025-12-11 security advisory; latest 14.2.x patch, no breaking changes. Commit `9e6c418`.
- [x] **`.gitignore` and `package-lock.json`** — repo had neither. Added both. Commit `9e6c418`.

### 2026-05-10 — Repo setup
- [x] **Forked `luccan91/FairwayFantasy` → `gjcnvrtman/FairwayFantasy`** with triangle remote (`origin` = fork, `upstream` = luccan91). Local `main` tracks `origin/main`.
- [x] **Repo cloned to** `C:\Projects\FairwayFantasy\repo\` (prompts retained at `C:\Projects\FairwayFantasy\*.txt`).
- [x] **Prompt 1 review** — full architectural / security / scoring / mobile / testing review with file:line references. Top 20 prioritized improvements + MVP roadmap.
