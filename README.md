# ⛳ Fairway Fantasy

A self-hosted PGA-Tour fantasy league app: pick 4 golfers per event, top-3 scores count, the loser pays the table.

Production deployment: https://fairway.golf-czar.com (LAN-only behind nginx).

---

## Features

- **Multi-tenant** — unlimited leagues, each with its own invite code + slug URL
- **Live scoring** via ESPN's undocumented public scoreboard API (no key)
- **OWGR rankings** via balldontlie's `/pga/v1/players` (free tier, no key)
- **Custom rules** — top-3 scoring, missed-cut penalty, withdrawal replacements
- **Pick deadline** — auto-derived from ESPN start time, commissioner override per tournament
- **Commissioner controls** — invite-by-email, member removal, manual sync, delete-league
- **Per-tournament money math** — losers pay the bet, ties at #1 split the pot
- **Email verification + invite-only signup** (rate-limited, public-internet safe)

---

## Tech Stack

| Layer | Tool |
|---|---|
| Framework | Next.js 14 (App Router) |
| Database | PostgreSQL 16 (self-hosted via Docker) |
| Auth | NextAuth (Credentials provider, bcrypt) |
| Query builder | Kysely (over node-postgres) |
| Hosting | LAN systemd service behind nginx + Let's Encrypt |
| Score / schedule sync | systemd timers (every 10 min Thu–Sun + weekly Mon 06:00) |
| Live Scores | ESPN public scoreboard API |
| World Rankings | balldontlie + hand-maintained `data/owgr-top.json` fallback |
| Email (signup verify, invites, reminders) | nodemailer via Gmail SMTP |

**Monthly cost: $0** (LAN deploy on existing hardware; SMTP via personal Gmail app password).

---

## Quick start (dev)

```bash
git clone <repo>
cd repo
npm ci

# Bring up a local Postgres in Docker (schema auto-applies):
cd infra/postgres && cp .env.example .env && docker compose up -d
cd ../..

# Configure env:
cp .env.local.example .env.local
# Edit DATABASE_URL, NEXTAUTH_SECRET (32+ chars), NEXTAUTH_URL=http://localhost:3000

npm run dev
# http://localhost:3000
```

To preview the marketing site without a DB, leave the Supabase / DATABASE_URL vars blank and visit `/` — auth-gated routes will redirect but the landing page renders.

For full deploy instructions (LAN systemd unit, nginx config, certbot, score-sync timer, backup cron), see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Creating a League

1. Sign up at `/auth/signup` (invite-only — needs slug+code from an existing league).
2. From `/dashboard`, click **Create league**. Pick name, slug (e.g. `the-boys`), tournament date range, weekly bet amount.
3. Share `https://fairway.golf-czar.com/join/<slug>/<INVITE_CODE>` with your friends.
4. League home: `/league/<slug>`. Tabs: Leaderboard · My Picks · Schedule · History · Stats.

---

## Scoring Rules

1. **Pick 4 golfers**: 2 top tier (OWGR ≤ 24), 2 dark horses (OWGR > 24 or unranked).
2. **No two members may submit the same 4-golfer set** — enforced by DB unique index on a sorted-tuple hash.
3. **Top 3 scores count** — the worst of your 4 is dropped.
4. **Missed cut** → that golfer's contribution = cut score + 1.
5. **Made cut** → final score capped at cut score (can't go worse than the cut line).
6. **Withdrawal** → replacement allowed with any in-field golfer who hasn't teed off yet.

---

## Project Structure

```
repo/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── admin/             # Commissioner-gated actions
│   │   │   ├── auth/              # NextAuth + custom register/verify
│   │   │   ├── leagues/           # Create / join / invite / verify
│   │   │   ├── picks/             # Pick submission + replacement
│   │   │   ├── players/           # Golfer-picker data
│   │   │   ├── sync-scores/       # Bearer-CRON-SECRET cron entry
│   │   │   └── me/                # User-scoped (notification prefs)
│   │   ├── auth/                  # /auth/signin /auth/signup /auth/verify
│   │   ├── league/[slug]/         # Leaderboard, picks, schedule, history, stats, admin
│   │   ├── dashboard/             # User's leagues list
│   │   ├── create/                # League-create form
│   │   └── demo/                  # Public marketing demo (no auth)
│   ├── components/
│   │   ├── layout/Nav.tsx
│   │   └── league/InviteCard.tsx
│   ├── lib/
│   │   ├── espn.ts                # ESPN scoreboard / leaderboard client
│   │   ├── sync.ts                # Score sync shared engine (cron + admin)
│   │   ├── scoring.ts             # Top-3 rules + replacement eligibility
│   │   ├── money.ts               # Per-tournament money math
│   │   ├── rankings.ts            # balldontlie + OWGR fallback
│   │   ├── db/                    # Kysely connection + schema types + queries
│   │   ├── rate-limit.ts          # Postgres-backed fixed-window limiter
│   │   ├── same-origin.ts         # Belt-and-suspenders CSRF defense
│   │   └── pick-deadline.ts       # Single source of "when do picks lock?"
│   ├── auth.ts                    # NextAuth config (Node-only)
│   └── auth.config.ts             # Edge-safe subset for middleware
├── infra/
│   ├── postgres/                  # Docker compose + init schema
│   └── systemd/                   # fairway-fantasy.service + score/rankings timers
├── scripts/
│   ├── migrations/                # Numbered SQL migrations
│   ├── backup-db.sh               # Daily pg_dump + gzip rotation
│   └── seed-golfers.ts            # OWGR initial-load + per-tournament field
├── supabase/schema.sql            # Legacy reference (kept for migration history)
├── tests/                         # Vitest suite (259 tests)
├── DEPLOYMENT.md                  # Production deploy runbook (LAN)
└── TODO.md                        # Open work + Done log
```
