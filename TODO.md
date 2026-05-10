# TODO — Fairway Fantasy

Source of truth for incomplete code, bugs, security gaps, and follow-up work. Items are added the moment they're discovered. When something is finished AND tested it moves to **Done** at the bottom with a date.

Cross-references like `(P1 #3.1)` point back to the Prompt 1 repo review (in-conversation, not in a file). `(P5)` etc. = surfaced during the Prompt N work.

---

## P0 — blocks LAN deployment / security / data corruption

### Deployment migration
- [ ] **Replace Supabase Cloud with self-hosted Postgres + new auth** *(P1 #1)* — entire stack assumes Supabase Cloud + Vercel; LAN deployment on `192.168.1.160` requires a different DB + auth. Options: NextAuth + email magic-link via local SMTP, OR shore-jones-style SSO matching the DayTrader/MultiDayTrader pattern.
- [ ] **Replace Vercel hosting with Node + nginx + systemd** *(P1 #2)* — `next build` + `next start` on port 3000 behind nginx. Document `multidaytrader-style` systemd unit. Bind to `0.0.0.0`, document firewall rule (`ufw allow from 192.168.1.0/24 to any port 3000`).
- [ ] **Add the missing score-sync cron** *(P1 #3)* — `/api/sync-scores` exists but `vercel.json` only schedules `/api/sync-scores/rankings` (Mondays 06:00). The headline "every 10 min during play" feature has no schedule. Replace with a systemd timer firing Thu–Sun in market hours.

### Security
- [ ] **`NEXT_PUBLIC_CRON_SECRET` exposed to client bundle** *(P1 #4.1)* — `src/app/league/[slug]/admin/AdminPanel.tsx:23` puts the cron secret in a `NEXT_PUBLIC_*` env var, which Next bundles into the client JS at build. Replace manual sync with a commissioner-authed endpoint that uses the user's session, not the cron secret.
- [ ] **Server Component onClick at `src/app/league/[slug]/page.tsx:267`** *(P1 #4.9, B-series #B4)* — file has no `'use client'` but uses `onClick={() => navigator.clipboard...}`. Build doesn't catch it but it likely 500s at runtime when the button is clicked. Fold into Prompt 7 work.

### Correctness
- [ ] **Season standings cross-tournament/season bleed** *(P1 #3.3)* — `src/app/api/sync-scores/route.ts:112-129` `recomputeResults` updates `season_standings` from `from('fantasy_results').select(...)` with NO `tournament_id`/`season` filter. Pulls ALL rows globally, so standings accumulate across seasons. Add the proper filters before the next score sync runs.
- [ ] **`best_finish = 999` garbage initialization** *(P1 #3.4)* — `sync-scores/route.ts:120`: initial branch sets `e.best = r.rank ?? 999` but the later branch only updates `best` when `r.rank` is truthy, so 999 sticks for any user whose first row has null rank.
- [ ] **Unique-foursome rule is app-only, not DB-backed** *(P1 #3.2 / P5 risks)* — `src/lib/scoring.ts:validatePick` rejects identical foursomes, but the schema's only constraint is `UNIQUE(league_id, tournament_id, user_id)`. Two users submitting identical 4-tuples concurrently both pass validation and both insert. Fix: deferred-uniqueness via a sorted-tuple hash column with `UNIQUE`, or wrap pick-insertion in a serializable transaction.

---

## P1 — broken UX / latent build issues / structural

- [ ] **Build fails on `/dashboard` and `/api/picks/setup` prerender without env vars** *(P3 / dev experience)* — `createServerSupabaseClient` is called at module level on those routes. Either mark them `dynamic = 'force-dynamic'` or extend the lazy-Proxy pattern from `supabaseAdmin` to the server client. Currently mitigated by `.env.local.example` placeholder pattern. Revisit during de-Supabase migration.
- [ ] **Mobile-broken layouts on remaining pages** *(P1 #6.1-6.10)* — picks page was fixed in P5 (flex-wrap). Still hardcoded `gridTemplateColumns: '1fr 300px'`:
  - `src/app/league/[slug]/page.tsx:93` (league dashboard)
  - `src/app/dashboard/page.tsx:52` (user dashboard)
  Same `flex-wrap` pattern from P5 should apply.
- [ ] **No withdrawal-replacement UI** *(P1 - Main user flows)* — API exists at `src/app/api/picks/route.ts:57-84` but no page calls it.
- [ ] **No demo route originally; resolved in P3** ✓ — moved to Done.
- [ ] **`pick_deadline` uses tournament `start_date - 1h`** *(P1 #3.6)* — set in `sync-scores/rankings/route.ts:31`. Real first-tee-time can differ by 6+ hours from ESPN's reported `start_date`. Either use a per-tournament tee-time source or expose a commissioner override.
- [ ] **Profile insert from browser anon client** *(P1 #3.5, #4.7)* — `src/app/auth/signup/page.tsx:38-43` uses the browser anon client to insert into `profiles`. Fragile: depends on Supabase auto-grants for anon. Standard fix is a Postgres trigger on `auth.users` insert (Supabase native pattern) or a server-side API route with the service role.
- [ ] **`profiles` table has no RLS enabled** *(P1 #3.5)* — schema enables RLS on leagues/league_members/picks/fantasy_results/season_standings but NOT profiles. Should add RLS policies for profile reads/writes.

---

## P2 — quality / monitoring / future-proofing

- [ ] **TS strict mode + lint enforcement** *(P1 #4.10, #4.11)* — `next.config.js` has `typescript.ignoreBuildErrors: true` AND `eslint.ignoreDuringBuilds: true`. Real type/lint errors land silently. Set up ESLint config (currently absent — `next lint` prompts interactively), turn on strict TS, fix what surfaces.
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
- [ ] **No CSRF protection** *(P1 #4.12)* — state-changing endpoints have no CSRF token. Mitigated by SameSite=Lax cookies + same-origin SPA. Standard hygiene to add.
- [ ] **No rate limiting** *(P1 #4.13)* — `/api/picks`, `/api/leagues/join` have no per-IP / per-user limits. LAN-only mitigates; revisit for any future public exposure.
- [ ] **Unauthenticated public endpoints** *(P1 #4.4)* — `/api/players` and `/api/leagues/verify` have no auth. LAN-only fine; if ever exposed publicly, add nginx-level basic auth or move to authed.
- [ ] **`GET /api/sync-scores` reuses `POST`** *(P1, sync-scores:133)* — works but unusual. Fine for now.
- [ ] **Schema has no `pick_locked_at` audit column** *(P1 #3.8)* — `is_locked` boolean alone doesn't capture WHEN it locked.
- [ ] **`picks.golfer_N_id` columns nullable** *(P1 #3.9)* — schema allows partial picks; should be `NOT NULL` after submission. Add CHECK constraint.
- [ ] **No co-commissioner role** *(P1 #3.10)* — `league_members.role` CHECK allows only `'commissioner'`/`'member'`. Future feature.
- [ ] **Heavy emoji use renders inconsistently** *(P1 #6.7)* — across iOS/Android/desktop. Consider SVG icons.
- [ ] **No PWA manifest, no offline fallback** *(P1 #6.8)* — "Install to home screen" experience absent.
- [ ] **`vercel.json` cleanup post-migration** — once we move off Vercel, the file is dead. Decide whether to delete or keep for future re-deploy parity.
- [ ] **`.eslintrc` setup** — `next lint` opens an interactive prompt because no config exists. `next.config.js:eslint.ignoreDuringBuilds: true` masks the absence. Pick Strict or Base, commit a config, ideally turn off the ignore.

---

## NOT doing (per scope decisions)

- Vercel-specific assumptions in any new code — explicitly removed by every prompt's deploy preamble.
- DataGolf integration — replaced by ESPN rankings inside `src/lib/datagolf.ts` (filename retained pending docs cleanup).
- Standalone `/api/sync-scores` Vercel cron config — folded into the systemd timer plan above.

---

## Done

(Newest first.)

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
