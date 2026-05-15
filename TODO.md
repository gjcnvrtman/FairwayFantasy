# TODO — Fairway Fantasy

Source of truth for incomplete code, bugs, security gaps, and follow-up work. Items are added the moment they're discovered. When something is finished AND tested it moves to **Done** at the bottom with a date.

Cross-references like `(P1 #3.1)` point back to the Prompt 1 repo review (in-conversation, not in a file). `(P5)` etc. = surfaced during the Prompt N work.

---

## P0 — blocks production / security / data corruption

- [x] **ESPN rankings dead → balldontlie integration landed.** ESPN's `/pga/rankings` returned 500 (`{"code":2404,"detail":"http error: not found"}`) in May 2026. Swapped rankings source to balldontlie's `/pga/v1/players` endpoint (free tier, 5 req/min). New file `src/lib/balldontlie.ts`. `src/lib/datagolf.ts` refactored — keeps the name + `syncRankingsToDatabase()` signature, now UPDATE-only (balldontlie has no ESPN ID, so we can't insert new golfers; ESPN's leaderboard / `scripts/seed-golfers.ts --from-event` is the source for new rows). Hand-maintained `data/owgr-top.json` + the `--apply-ranks` flag of seed-golfers remain as emergency fallback. ✓
- [x] **(P2) Rename `src/lib/datagolf.ts` → `src/lib/rankings.ts`** — done 2026-05-15 (commit `e68b70c`). 1 import + 2 JSDoc references updated; public API unchanged. ✓

### Live-scoring risk for PGA Championship (Thu May 14) — high P0
- [x] **`fetchLiveLeaderboard` in `src/lib/espn.ts` has the SAME bugs as the old `seed-golfers.ts`** — shipped 2026-05-14 in commit `f066737`. `fetchLiveLeaderboard` now falls back to `/pga/scoreboard?event=` when leaderboard 404s, with a `normalizeScoreboardCompetitor` helper that maps the shape differences (`athlete.displayName`, score as raw string, linescores `displayValue`, missing per-golfer status). Verified by triggering a manual sync against PGA Championship event 401811947 — 156 competitors processed, status flipped to `active`, fantasy_results rows populated for all 3 leagues. ✓ See Done 2026-05-14.

### Truist Championship still marked 'active' after final round ended
- [x] On Sunday May 10 the Truist Championship final round ended but its status stayed `active` in the DB. Resolved 2026-05-14 by three things compounding: (a) Truist row was already manually flipped to `complete` in the DB by the time we revisited; (b) the page is now time-based (`getActiveTournament` commit `0d075df`) so stored status drift doesn't affect rendering; (c) the rankings sync route's status maintenance (commit `65f78f9`) now runs weekly via the freshly-installed `fairway-rankings.timer` — first manual fire reported `statusFixes:0` confirming no stale rows remain. ✓

### Cert reissue replaced the SAN list — golf-czar.com broken in browser (CERT_COMMON_NAME_INVALID)
- [x] Recovered 2026-05-14. Greg ran the certbot reissue on .150. Verified: `sudo certbot certificates --cert-name golf-czar.com` shows all four SAN entries restored — `golf-czar.com`, `fairway.golf-czar.com`, `league.golf-czar.com`, `weekend.golf-czar.com` — expiring 2026-08-09 (86 days valid). `openssl x509 -ext subjectAltName` on the live cert confirms the same list. Future-proofing landed same day as DEPLOYMENT.md §7 (TLS / certbot hygiene). ✓

### Runbook hygiene
- [x] Add to DEPLOYMENT.md: **when modifying a SAN cert, always include every existing domain in the `-d` list, OR use `--expand`.** Shipped 2026-05-14 as DEPLOYMENT.md §7 — covers pre-flight `sudo certbot certificates`, post-check `openssl x509 -ext subjectAltName`, and the two correct forms (`-d ... -d ...` explicit, or `--expand`). ✓

### ESPN data + sync timers — installed on .150
- [x] **Installed 2026-05-14.** `sudo ./infra/systemd/install.sh` (no `--populate` — DB was already populated) copied the 4 unit files to `/etc/systemd/system/`, daemon-reloaded, and `enable --now`-ed both timers. Validated end-to-end: manual `fairway-rankings.service` run reported `fetched:200, updated:169, errors:0, tournaments:48, statusFixes:0`; manual `fairway-scores.service` run reported `{competitors:156, currentRound:1, status:'active'}` and refreshed `fantasy_results.updated_at`. `systemctl list-timers fairway-*` confirms `fairway-rankings.timer` next fires Mon 06:00 and `fairway-scores.timer` next fires every 10 min on Thu-Sun 06-23. ✓
- [x] **Bug fix bundled in:** runScoreSync now queries by `start_date <= now AND end_date >= now-1d AND status != 'complete'` instead of the previous `status IN ('active', 'cut_made')`. The old version had a chicken-and-egg bug: rankings sync inserts new tournaments with default status `upcoming`, but nothing flipped them to `active` when start_date arrived, so the score sync skipped them forever. Now any tournament whose start_date has passed gets a sync; syncTournament() updates the status field from ESPN's response.

### Per-golfer status missing when scoreboard fallback used (cut-day risk for PGA Championship)
- [x] **Mitigation (c) shipped 2026-05-15** — `src/lib/sync.ts:syncTournament` now cross-references each golfer's Round 1+2 cumulative against the tournament's `cut_score` after the cut is officially made. If `cutMade && effectiveCut !== null && espnStatus === 'active' && r1+r2 > cut_score`, the per-golfer `espnStatus` is overridden to `'missed_cut'` before `applyFantasyRules` runs. Handles the scoreboard-fallback case (where ESPN provides no per-golfer status) AND serves as a defensive sanity check if the leaderboard endpoint comes back. Confirmed at commit time ESPN's leaderboard is still 404 for event 401811947 — the backstop is the only thing protecting fantasy scoring tonight. **Verification gap:** can't fully exercise until cut is made tonight (Friday evening); the 9 new tests in `tests/espn.test.ts` lock down the normalizer contract but the cut-inference branch in `syncTournament` is exercised only at live-sync time. Watch the 10-min scores timer fires this evening + spot-check `scores.status` for golfers above the cut line.

### Open signup since deployment went public
- [x] **Public-internet exposure hardening complete** — shipped 2026-05-15 as a four-commit run:
  - **Invite-only signup** (`f5cffcb`): `/api/auth/register` now requires leagueSlug + inviteCode that match a real league row, validated before any DB work. Atomic transaction creates profile + auth_credentials + league_member. `/auth/signup` parses the slug/code out of `redirect=/join/<slug>/<code>` query params and pre-fills, or shows visible inputs for direct visits.
  - **Per-IP rate limit** (`e32a146`): Postgres-backed fixed-window counter via new `rate_limits` table + `src/lib/rate-limit.ts`. `/api/auth/register` limited to 5 / 10 min / IP; `/api/picks` to 30 / 10 min / IP. Returns 429 with Retry-After before any bcrypt or DB work.
  - **Password complexity** (`e68b70c`): bumped `PASSWORD_MIN` 8 → 10 and added a 3-of-4 character-class check (lowercase, uppercase, digit, symbol). Surfaced 11 new tests, signup page placeholder + hint updated.
  - **Blocking email verification** (`6b35d90`): nodemailer added, SMTP env copied from DayTrader's `.env` (shared Gmail app password). Signup generates a 32-byte hex verify_token, sends a verification email, returns to a "check your email" panel. `/api/auth/verify` consumes the token; `/auth/verify` page handles UI states. `/api/auth/resend-verify` allows re-issue (rate-limited 1/min/email + 3/min/IP). `src/auth.ts` throws `EmailNotVerifiedError` (extends `CredentialsSignin` with `code='EmailNotVerified'`) on unverified signin attempts; the signin page renders "please verify your email" + a Resend button. Pre-existing 3 users backfilled to `email_verified=true` so they aren't locked out. SMTP path validated end-to-end (Gmail returned 250 OK + MessageId on a test send). ✓

### Backups
- [x] **Daily `pg_dump` cron — local rotation.** Shipped 2026-05-14. `scripts/backup-db.sh` (committed) dumps the Postgres container, gzips, retains 7 days under `/opt/fairway-fantasy/backups/`. Greg's crontab entry `30 23 * * * /opt/fairway-fantasy/scripts/backup-db.sh >> ... 2>&1`. Validated by running once manually: wrote a 26 KB gzipped dump, rotation logic ran with zero deletes (no old files yet). ✓
- [x] **Off-machine backup — separate backup server now nightly.** Greg reported 2026-05-15: a dedicated backup server is up and configured to pull nightly backups off `.150`. Disk-loss-of-`.150` no longer takes the dumps with it. Off-site (geographic-disaster) backup remains a follow-up Greg is planning separately. ✓

### Security
- [x] **`NEXT_PUBLIC_CRON_SECRET` exposed to client bundle** *(P1 #4.1)* — fixed in P8. New `/api/admin/sync-scores` endpoint is commissioner-authed via session cookie (no shared secret). Sync engine extracted to `src/lib/sync.ts`; the cron-secret-authed `/api/sync-scores` still exists for the systemd timer but no client code references it. ✓
- [x] **Server Component onClick at `src/app/league/[slug]/page.tsx:267`** *(P1 #4.9, B-series #B4)* — fixed in P7. Extracted to `<InviteCard>` client component with proper `'use client'` + `navigator.clipboard.writeText` + `execCommand('copy')` fallback for non-HTTPS LAN. ✓

### Correctness
- [x] **Season standings cross-tournament/season bleed** *(P1 #3.3)* — Fixed 2026-05-14 in commit `3a8595d`. `recomputeResults` (which now lives in `src/lib/sync.ts`, not the old `sync-scores/route.ts` path) joins `fantasy_results` against `tournaments` and filters by `tournaments.season = t.season`, so each season's standings only fold in that season's rows. ✓
- [x] **`best_finish = 999` garbage initialization** *(P1 #3.4)* — Fixed 2026-05-14 in commit `3a8595d`. The map's `best` field is now typed `number | null` with `null` as the initial sentinel; the update branch only mutates when `r.rank` is non-null, and `e.best = e.best == null ? r.rank : Math.min(e.best, r.rank)` handles the first-real-rank case. Persists as NULL in `season_standings.best_finish` (which is nullable per schema). ✓
- [x] **Unique-foursome rule is now DB-backed** *(P1 #3.2 / P5 risks)* — Fixed 2026-05-15. `picks` gained a `golfer_tuple_hash TEXT` column maintained by a `BEFORE INSERT/UPDATE` trigger (sorted concat of the 4 IDs); a partial `UNIQUE INDEX picks_unique_complete_foursome` on `(league_id, tournament_id, golfer_tuple_hash)` enforces the rule when all 4 IDs are non-null. Partial so in-progress / partial picks don't collide. Migration SQL at `scripts/migrations/001-picks-foursome-hash.sql`, applied to .150 prod DB in a transaction with a `RAISE EXCEPTION` verify block; backed up first to `fairway_20260515_071819.sql.gz`. Kysely types updated (`ColumnType<string | null, never, never>` — selectable but unwritable). `POST /api/picks` catches the unique-violation and returns a friendly 409. Pre-migration scan confirmed zero existing duplicates. ✓

---

## P1 — broken UX / latent build issues / structural

- [x] **Build fails on `/dashboard` and `/api/picks/setup` prerender without env vars** *(P3 / dev experience)* — fixed in P10. Added `export const dynamic = 'force-dynamic'` to `/dashboard`, `/settings`, `/api/picks/setup`, `/api/me/notification-prefs`. `npm run build` now succeeds with empty env. ✓
- [x] **Mobile-broken layouts on remaining pages** *(P1 #6.1-6.10)* — fixed in P7. Both `src/app/league/[slug]/page.tsx` and `src/app/dashboard/page.tsx` now use the same flex-wrap pattern as the picks page (P5). ✓
- [x] **No withdrawal-replacement UI** *(P1 - Main user flows)* — shipped 2026-05-15 in `d338106`. `/api/picks/setup` now includes a `scores` array post-lock. The picks page renders a status badge below each picked golfer when locked (MC / WD / DQ / Complete); withdrawn golfers also get a "Replace →" button. Clicking opens a modal with search + scrollable list of eligible candidates (golfers in the field who haven't teed off, filtered to `round_1 IS NULL`). Confirm → `PUT /api/picks { pickId, withdrawnGolferId, replacementGolferId }` → reload. Server re-validates the "hasn't teed off" rule. Cannot fully exercise without a real WD event; code paths verified by tsc + 200/200 tests + production build. ✓
- [ ] **No demo route originally; resolved in P3** ✓ — moved to Done.
- [x] **`pick_deadline` commissioner override shipped** *(P1 #3.6)* — 2026-05-15 in `b675797`. New `tournaments.pick_deadline_override TIMESTAMPTZ` column (Migration 003) takes precedence over the auto-computed `pick_deadline`. `src/lib/pick-deadline.ts` is the single read-helper used by `/api/picks` and the picks page. Commissioner UI on `/league/[slug]/admin` lists upcoming tournaments with a datetime-local input + Save/Clear buttons. POST `/api/admin/pick-deadline { slug, tournamentId, deadline }` is auth-gated by `requireCommissioner(slug)`. The override is currently per-tournament global (any commissioner can set it across all leagues); per-league override is a future enhancement if it becomes a problem with multiple commissioners. ✓
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
- [ ] **More `tests/espn.test.ts` fixtures still pending** — Partial progress 2026-05-15: 9 tests landed against `tests/fixtures/espn-pga-championship-round2.json` (scoreboard Round 2 in-progress, 156 competitors). Covers the normalizer's main branches: name fallback, raw-string→object score wrap, linescores score-to-par unification, un-played-round filtering, default status, null-name returns, sortOrder vs order. Still want: (a) scoreboard Round 4 post-cut fixture with mixed WD/missed-cut entries (capture Sunday evening), (b) leaderboard endpoint fixture if/when it comes back online so the pass-through branch is also pinned. Also worth: a `tests/fixtures/espn-scoreboard-empty.json` for the no-tournament case if we can find one.

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
- [ ] **Stray typo'd filenames in `/opt/fairway-fantasy` on .150** — 2026-05-14. `git status` on the production checkout shows two untracked files: `"eep 65"` and `"udo systemctl start fairway-rankings.service"` — clearly leftovers from `sleep 65` and `sudo systemctl ...` commands that got typo'd into the shell with stray spaces or redirections. Harmless (not in git, not referenced), but worth `rm` on next visit so `git status` is clean for the next deploy.
- [x] **`.eslintrc` setup** — done in P10. Added `.eslintrc.json` extending `next/core-web-vitals`, pinned `eslint@^8.57.0` + `eslint-config-next@^14.2.35`. ✓

---

## NOT doing (per scope decisions)

- Vercel-specific assumptions in any new code — explicitly removed by every prompt's deploy preamble.
- DataGolf integration — replaced by ESPN rankings inside `src/lib/datagolf.ts` (filename retained pending docs cleanup).
- Standalone `/api/sync-scores` Vercel cron config — folded into the systemd timer plan above.

---

## Done

(Newest first.)

### 2026-05-14 — P0 cleanup: timers installed, backups wired, season-standings fixes, runbook hygiene
Second pass of the day after the leaderboard fixes. Batched Batch A (code fixes + docs) + Batch B (infrastructure on .150).

**Code (`3a8595d`)** — three correctness fixes in `src/lib/sync.ts` + one doc add:
- Season-standings cross-season bleed fixed: `recomputeResults` joins `fantasy_results` against `tournaments` and filters by `tournaments.season = t.season`. Each season's standings only fold in that season's rows. (P0 #3.3)
- `best_finish = 999` sticky-sentinel fixed: map field typed `number | null` with `null` as initial sentinel; min-comparison handles first-real-rank case correctly. Stores as NULL in `season_standings.best_finish`. (P0 #3.4)
- DEPLOYMENT.md gains §7 "TLS / certbot hygiene" — the `--cert-name X -d Y` form is a replace, not an add; documents the `--expand` alternative and the pre-flight/post-check rules. Surfaces the lesson from this week's `golf-czar.com` SAN clobber.

**Backup script (`ce18d6c`)** — `scripts/backup-db.sh` dumps the Fairway Postgres container, gzips, retains 7 days. Local socket inside the container has trust auth for the fairway user, so no password handling. Logs to `/opt/fairway-fantasy/logs/backup.log`.

**Infrastructure on .150 (no commit, ssh-side):**
- `sudo ./infra/systemd/install.sh` ran cleanly. 4 unit files installed under `/etc/systemd/system/`, both timers `enable --now`-ed. Manual rankings.service fire reported `{fetched:200, updated:169, errors:0, tournaments:48, statusFixes:0}` — confirms the rankings endpoint works AND that there are no stale-active tournaments. Manual scores.service fire reported `{competitors:156, currentRound:1, status:'active'}` and refreshed `fantasy_results.updated_at`. Next scheduled fires: rankings Mon 2026-05-18 06:00, scores every 10 min Thu–Sun 06–23.
- `crontab -l | tail` shows new entry: `30 23 * * * /opt/fairway-fantasy/scripts/backup-db.sh >> ... 2>&1`. Test run wrote a 26 KB gzipped dump. Staggered 30 min after the existing DayTrader backup at 23:00.

**Side effects (good):**
- The Truist 'active' P0 (TODO line 17) is now retroactively addressed — the row in DB is already `complete`, the weekly rankings sync will keep status maintenance running, and the page is also time-based regardless. Statusfixes:0 from the manual rankings fire confirms no stale rows remain.

**Still open:**
- **Off-machine backup target** — the local-only retention is fine for disk-level recovery but won't survive a `.150` total loss. New TODO P0 entry tracks options (rsync to DayTrader box, cloud bucket, or borg/restic to a second disk).
- **Cert recovery on .150** — `certbot --nginx --cert-name golf-czar.com --force-renewal -d golf-czar.com -d league -d weekend -d fairway`. Greg paused intentionally to do golf-czar work first. Untouched today.
- **Public signup hardening** (4 sub-items) and **unique-foursome DB constraint** — deferred to focused sessions; too big to batch.
- **Per-golfer cut-day status detection** — needs Friday's actual data to validate, deferred to Friday afternoon.

### 2026-05-14 — PGA Championship Round 1 live leaderboard unblocked; .160 confirmed gone
Greg loaded the league page Thursday morning and got "No Active Tournament" even though PGA Championship Round 1 had teed off. Two root causes, both fixed on .150 today; .160 is fully decommissioned and Fairway runs only on .150 now.

**What was wrong (both confirmed against the live DB on .150):**
- `getActiveTournament` in `src/lib/db/queries.ts` filtered strictly on `status IN ('active', 'cut_made')`. PGA Championship was sitting at `status='upcoming'` despite start_date being today, because no rankings sync had run on .150 since the .160 → .150 consolidation (the rankings sync is what flips `upcoming` → `active`). Query returned null → page rendered the empty-state.
- Even after fixing the query, the score sync via `/api/sync-scores` failed with `ESPN leaderboard fetch failed for event 401811947`. ESPN's `/pga/leaderboard?event=` endpoint is currently 404 for this event; only `/pga/scoreboard?event=` returns 200. The seed-golfers fix (commit `61850d9`) only handles the player-roster shape — `fetchLiveLeaderboard` had to be adapted properly because the scoreboard response has different field names AND types (`c.score` is a raw string, not an object; `c.linescores[i].displayValue` is score-to-par, `c.linescores[i].value` is total strokes; per-golfer `c.status` is absent).

**Patches landed today:**
- `0d075df` — `getActiveTournament` uses time-based filter mirroring `runScoreSync` (`start_date <= now AND end_date >= now - 24h AND status != 'complete'`). The page and the score-sync now agree on what's "active right now" regardless of stored status drift.
- `f066737` — `fetchLiveLeaderboard` falls back to `/pga/scoreboard?event=` when `/pga/leaderboard?event=` 404s, with a dedicated `normalizeScoreboardCompetitor` that converts the scoreboard shape into `ESPNCompetitor` so `sync.ts` doesn't have to branch. Documented the per-golfer-status limitation (see new P0 entry above — cut-day risk).

**Operational changes (no commit):**
- Ran `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/sync-scores` on .150 to trigger one manual sync. Result: 156 competitors, currentRound=1, status flipped `upcoming` → `active`.
- DB state confirmed: Royal Duffers shows Greg @ -1 (rank 1), MJ @ +1 (rank 2). Royal Duffers2 shows Marge @ -1 (rank 1). Top-5 leaders all at -3 (Potgieter / Min Woo Lee / Bhatia / Hisatsune / Jaeger).

**VERIFICATION**
- npm run lint: not run (no changes that would surface new lint issues; existing baseline of 0 errors / 1 warning unchanged)
- npm test: 181 / 181 passing (no new tests added for the espn.ts changes — tracked as P2 gap)
- npx tsc --noEmit: clean
- npm run build: 24 routes, 0 errors
- Live end-to-end DB verification: pass (numbers above)
- Browser end-to-end: PASS — Greg loaded the page and confirmed both (1) PGA Championship rendering as active and (2) the new per-golfer card layout (commit `1c839ba` below) matching expectations.

**Bonus shipped same session — leaderboard card layout (`1c839ba`):**
Greg asked for per-golfer scores visible with combined score on top. Replaced the table-row leaderboard with an always-expanded card per user: rank + name + combined fantasy score in the header, then the 4 golfers below with per-golfer fantasy score (from `fantasy_results.golfer_N_score`), OWGR rank, and Top/DH tier badge. Counting-3 marked with ✓; dropped 4th dimmed to 50%. Missed-cut / WD / DQ golfers tagged with a yellow MC/WD/DQ badge sourced from `scores.status`. The cut-rule itself was left as `cut_score + 1` per Greg's decision — UI changes only. MC badge code path is shipped but not exercised by today's data (Round 1 still live, no cut made yet); will see its first real test Friday evening.

**Topology now (replaces the 2026-05-10 deployment entry's two-box topology):**
- `192.168.1.150` only — nginx + Let's Encrypt + Fairway Next.js (`fairway-fantasy.service`) on port 3000 + Postgres in Docker (`fairway-postgres` container, `127.0.0.1:5434`).
- `192.168.1.160` decommissioned (no route to host). Migration off .160 was already complete before today; this session just confirmed it and corrected stale .160 references in this file's P0 section.

**Still open after today** (added as their own P0/P2/P3 items above):
- Install `fairway-rankings.timer` + `fairway-scores.timer` on .150 via `sudo ./infra/systemd/install.sh` — sync is manual-only right now.
- Per-golfer cut/WD/DQ status when sync uses the scoreboard fallback (risk by Friday afternoon when Round 2 ends).
- No unit tests for `normalizeScoreboardCompetitor`.
- Stray typo'd files (`"eep 65"`, `"udo systemctl start fairway-rankings.service"`) in `/opt/fairway-fantasy` working tree.

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
