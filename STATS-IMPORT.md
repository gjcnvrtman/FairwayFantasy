# Stats Import Workflow

This is the operator-facing guide for loading golfer stat snapshots into
the **course-fit prediction system** (added 2026-06-29). Restricted to
platform admins (Greg + MJ).

## TL;DR — two data paths

| Path | Trigger | What it covers | Setup |
|---|---|---|---|
| **Datagolf cron** (preferred) | `fairway-datagolf.timer` every Mon 06:30 + on-demand from admin UI | Per-tournament win / top-N / cut probabilities. Back-fills `golfers.datagolf_id`. | `DATAGOLF_API_KEY` in `/opt/fairway-fantasy/.env.local` + install the new systemd unit |
| **CSV CLI** (manual override) | `npx tsx scripts/import-stats.ts` | SG breakdown + driving + scoring stats — anything Datagolf's General-tier doesn't supply | Documented below |

The two paths write to **different tables** and don't conflict:
* Datagolf cron writes `datagolf_tournament_predictions`.
* CSV CLI writes `golfer_stat_snapshots`.

The predictor consumes both — Datagolf preds for cut probability and
recent-form proxy, CSV stats for SG-driven course fit. Either is
optional; if both are missing for a golfer the predictor falls back to
OWGR-only and flags the row in its "missing inputs" warning.

---

## The Datagolf cron path

### What it does
1. **Player list back-fill** — populates `golfers.datagolf_id` where it's
   currently NULL using exact-name matching. Rows that already have a
   `datagolf_id` are untouched (the matcher never silently re-links).
2. **Pre-tournament predictions** — for the next upcoming PGA event,
   pulls Datagolf's `baseline_history_fit` (or `baseline` fallback)
   model output and upserts a row per golfer into
   `datagolf_tournament_predictions`.

### Setup

```bash
# 1. Drop your DATAGOLF_API_KEY into the env file:
sudo bash -c 'echo "DATAGOLF_API_KEY=<your-key>" >> /opt/fairway-fantasy/.env.local'

# 2. Install the systemd timer (idempotent — also reinstalls existing timers):
sudo /opt/fairway-fantasy/infra/systemd/install.sh

# 3. Manually fire it once to confirm:
sudo systemctl start fairway-datagolf.service
journalctl -u fairway-datagolf.service -n 30 --no-pager
```

The endpoint returns JSON with counts; check it via:
```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://127.0.0.1:3000/api/sync-scores/datagolf | jq
```

### Failure modes
* `DATAGOLF_API_KEY not set` → the env var didn't make it into the
  Next.js process. Restart the service (`systemctl restart
  fairway-fantasy`) after editing `.env.local`.
* `Datagolf .../preds/pre-tournament → HTTP 403` → your General-tier
  key doesn't unlock that endpoint. Confirm tier on
  <https://datagolf.com/api-access>.
* Partial-success response (`status: 207`) → one of the two steps
  failed; the JSON body explains which.

---

## The CSV CLI path (manual override)

Use this when you need stats Datagolf's General tier doesn't supply
(per-player SG breakdown, driving distance, etc.) or to backfill
historical snapshots for backtest events.

---

## CSV format

**One file per upload. One row per golfer. As-of date is passed as a
CLI flag, NOT a column** — all rows in one file share the same date.

### Required header row

```
golfer_name,sg_total,sg_ott,sg_app,sg_arg,sg_putt,driving_distance,driving_accuracy_pct,gir_pct,scoring_avg,birdie_avg,bogey_avg,made_cut_pct
```

### Required + optional columns

| Column | Required? | Type | Units / notes |
|---|---|---|---|
| `golfer_name` | ✅ required | string | Match to `golfers.name` — see [matching](#name-matching). |
| `sg_total` | optional | number, signed | Strokes gained: total per round vs field |
| `sg_ott` | optional | number, signed | Strokes gained: off-the-tee |
| `sg_app` | optional | number, signed | Strokes gained: approach |
| `sg_arg` | optional | number, signed | Strokes gained: around-the-green |
| `sg_putt` | optional | number, signed | Strokes gained: putting |
| `driving_distance` | optional | number | Yards (e.g. `308.1`) |
| `driving_accuracy_pct` | optional | number | Percentage 0–100 (e.g. `55.4`) |
| `gir_pct` | optional | number | Percentage 0–100 |
| `scoring_avg` | optional | number | Raw stroke avg (e.g. `69.45`, NOT `-2.55`) |
| `birdie_avg` | optional | number | Birdies per round |
| `bogey_avg` | optional | number | Bogeys per round |
| `made_cut_pct` | optional | number | Percentage 0–100 |

**Any missing column or empty cell** → that stat lands as `NULL` for
the row. The predictor handles partial data and flags the missing
inputs in its "missing inputs" admin warning. So a snapshot with only
`golfer_name` + `sg_total` + `made_cut_pct` is a legal upload.

### Example

```csv
golfer_name,sg_total,sg_ott,sg_app,sg_arg,sg_putt,driving_distance,driving_accuracy_pct,gir_pct,scoring_avg,birdie_avg,bogey_avg,made_cut_pct
Scottie Scheffler,2.34,0.65,1.12,0.18,0.39,308.1,55.4,70.2,69.45,4.92,2.15,93.8
Rory McIlroy,1.91,0.78,0.85,0.20,0.08,326.7,59.1,69.8,69.62,4.65,2.30,88.2
Xander Schauffele,1.68,0.42,0.71,0.31,0.24,304.5,62.0,71.1,69.71,4.50,2.20,90.0
Collin Morikawa,1.55,0.30,1.08,0.05,0.12,295.4,68.2,72.5,69.85,4.40,2.10,87.6
```

---

## Where to get each column

The cleanest sustainable source is the **PGA Tour's official stats**
pages — they have a "Download CSV" button on every stat page, and the
URLs are stable. Pull one CSV per stat, then merge into the master
file using `VLOOKUP` keyed on player name.

Browse to <https://www.pgatour.com/stats> and find each stat below.
For most stats, the page header and category map cleanly:

| CSV column | PGA Tour stat title |
|---|---|
| `sg_total` | "Strokes Gained: Total" |
| `sg_ott` | "Strokes Gained: Off-the-Tee" |
| `sg_app` | "Strokes Gained: Approach the Green" |
| `sg_arg` | "Strokes Gained: Around-the-Green" |
| `sg_putt` | "Strokes Gained: Putting" |
| `driving_distance` | "Driving Distance" |
| `driving_accuracy_pct` | "Driving Accuracy Percentage" |
| `gir_pct` | "Greens in Regulation Percentage" |
| `scoring_avg` | "Scoring Average" |
| `birdie_avg` | "Birdie Average" |
| `bogey_avg` | "Bogey Avoidance" (page reports bogeys per round) |
| `made_cut_pct` | Derived: `cuts_made / events_played × 100`. The "Cuts Made" page lists both for each player. |

### Backup source if PGA Tour CSV export breaks

PGA Tour's site occasionally breaks the CSV export mid-season.
<https://datagolf.com/datagolf-rankings> shows the same numbers (free
tier, current-season aggregate) in a table that you can copy-paste
into Excel — same column mapping.

### Assembly tips

1. Each PGA Tour stat page downloads as its own CSV with columns like
   `Player Name`, `Rank`, the stat itself, `Rounds Played`. Keep only
   `Player Name` and the stat column.
2. In Excel/Sheets, build a master sheet with the canonical header row
   above, then `VLOOKUP` each stat column keyed on `golfer_name`.
3. Save the master as `golfer_stats_YYYY-MM-DD.csv` for archive
   discipline (date in the filename).

---

## Name matching

The CSV `golfer_name` strings are matched against the `golfers.name`
column in the DB. The matcher normalizes both sides before comparison:

- lowercase
- strip diacritics (`Joaquín Niemann` → `joaquin niemann`)
- drop suffixes (`Jr.`, `Sr.`, `II`, `III`, `IV`)
- collapse punctuation to single spaces

Three outcomes per row:

1. **Exact normalized match** → auto-linked to the golfer.
2. **Levenshtein distance ≤ 2** (typo / abbreviation) → presented as a
   `y/n` prompt during the CLI run.
3. **No match** → row inserted with `golfer_id NULL`. These show up in
   the future admin "unmatched stats" queue. You can fix the source
   CSV and re-upload, or wait for the UI to enable manual linking.

If a golfer is in the CSV but not in the DB at all (`golfers` table),
they won't match by any path. Run `scripts/seed-golfers.ts
--from-event <espnEventId>` first to populate the field for the
upcoming tournament.

---

## Running the CLI

### Local dev (against local Docker postgres)

```bash
DATABASE_URL='postgresql://fairway:fairway@localhost:5432/fairway' \
  npx tsx scripts/import-stats.ts \
    --csv ~/Downloads/golfer_stats_2026-06-26.csv \
    --as-of 2026-06-26
```

### Against prod (over the LAN, from your laptop)

The prod Postgres container exposes 5432 on the LAN behind
`server150`. Tunnel through SSH:

```bash
ssh -L 5433:localhost:5432 server150 -N &     # port 5433 → prod 5432
DATABASE_URL='postgresql://fairway:fairway@localhost:5433/fairway' \
  npx tsx scripts/import-stats.ts \
    --csv ~/Downloads/golfer_stats_2026-06-26.csv \
    --as-of 2026-06-26
```

(Password is in `/opt/fairway-fantasy/backend/.env` on prod — same as
the deploy script uses.)

### From the prod box directly

```bash
ssh server150
cd /opt/fairway-fantasy
DATABASE_URL=$(grep DATABASE_URL backend/.env | cut -d= -f2-) \
  npx tsx scripts/import-stats.ts \
    --csv /tmp/golfer_stats_2026-06-26.csv \
    --as-of 2026-06-26
```

### Flags

- `--csv <path>` — required. Path to the CSV.
- `--as-of YYYY-MM-DD` — required. The snapshot date all rows share.
- `--yes` — auto-accept all fuzzy matches (no prompts). Use only when
  re-running a CSV that you've already vetted interactively.
- `--dry-run` — parse + match + print the plan, do NOT write to DB.
  Run this first on any new file to sanity-check the match outcomes.

---

## Re-runs and upserts

The CLI is **safe to re-run**. The DB has a partial unique index on
`(golfer_id, as_of_date)` for matched rows — re-uploading the same
file replaces the existing snapshot with the new values (and stamps
`uploaded_at = NOW()`).

Unmatched rows (NULL `golfer_id`) accumulate — each re-run adds a new
row for the same name. The future admin UI will let you clean these
up by linking or deleting.

---

## Output to expect

A successful run prints, in order:

1. Parse summary: number of rows parsed + any warning about missing
   columns in the header.
2. Match summary: counts of exact / fuzzy / unmatched.
3. Interactive prompts for each fuzzy candidate (unless `--yes`).
4. Plan summary: counts of will-link-exact / will-link-fuzzy /
   will-insert-unmatched.
5. (If not `--dry-run`) insert/upsert summary + list of unmatched
   `golfer_name_raw` values for review.

---

## Schema reference

See [`scripts/migrations/017-golfer-stat-snapshots.sql`](scripts/migrations/017-golfer-stat-snapshots.sql)
for the canonical column list and indexes. Applied to prod
2026-06-29; verify locally with:

```bash
docker exec -i fairway-postgres psql -U fairway -d fairway -c '\d golfer_stat_snapshots'
```

---

## What's next (Phase 3 in flight)

- Course profiles table (migration 016) and FDW bootstrap (015).
- `course-fit.ts` + `lineup-optimizer.ts` services.
- Predictions API routes + UI at `/predictions`.
- Backtest engine + results page.
- Admin UI replacing the CLI for daily-driver use; CLI stays for bulk
  backfill.
