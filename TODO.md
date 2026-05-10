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
- [ ] **Profile insert from browser anon client** *(P1 #3.5, #4.7)* — `src/app/auth/signup/page.tsx:38-43` uses the browser anon client to insert into `profiles`. Fragile: depends on Supabase auto-grants for anon. Standard fix is a Postgres trigger on `auth.users` insert (Supabase native pattern) or a server-side API route with the service role.
- [ ] **`profiles` table has no RLS enabled** *(P1 #3.5)* — schema enables RLS on leagues/league_members/picks/fantasy_results/season_standings but NOT profiles. Should add RLS policies for profile reads/writes.

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
- [x] **`.eslintrc` setup** — done in P10. Added `.eslintrc.json` extending `next/core-web-vitals`, pinned `eslint@^8.57.0` + `eslint-config-next@^14.2.35`. ✓

---

## NOT doing (per scope decisions)

- Vercel-specific assumptions in any new code — explicitly removed by every prompt's deploy preamble.
- DataGolf integration — replaced by ESPN rankings inside `src/lib/datagolf.ts` (filename retained pending docs cleanup).
- Standalone `/api/sync-scores` Vercel cron config — folded into the systemd timer plan above.

---

## Done

(Newest first.)

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
