# SETUP.md — Local development

For production deployment, see **[DEPLOYMENT.md](DEPLOYMENT.md)** (the LAN
systemd + nginx runbook). This file is just for getting a working dev
loop on your laptop.

---

## Prerequisites

- Node.js 20 LTS
- Docker (for local Postgres) — or any Postgres 16 connection you can point at
- A Gmail App Password if you want to test the email-verification / invite-by-email flows; otherwise the SMTP-touching paths will log "console" sends and you can copy the link out of the server logs

---

## 1. Install

```bash
git clone https://github.com/gjcnvrtman/FairwayFantasy.git repo
cd repo
npm ci
```

## 2. Bring up local Postgres

```bash
cd infra/postgres
cp .env.example .env       # set POSTGRES_PASSWORD to anything
docker compose up -d
docker compose ps          # confirm healthy
cd ../..
```

The schema in `infra/postgres/init/00-schema.sql` auto-applies on first
container start. To rebuild from scratch later:
`docker compose down -v && docker compose up -d` (this DESTROYS DATA).

## 3. Configure env

```bash
cp .env.local.example .env.local
```

Required values:

| Variable | What |
|---|---|
| `DATABASE_URL` | `postgresql://fairway:<pgpass>@127.0.0.1:5432/fairway` |
| `NEXTAUTH_URL` | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` |
| `CRON_SECRET` | Any 32+ char random string (only needed if you'll trigger `/api/sync-scores`) |

Optional (SMTP — for testing email flows):

| Variable | What |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | Your Gmail address |
| `SMTP_PASSWORD` | Gmail App Password (16 chars, no spaces) |
| `SMTP_FROM` | `Fairway Fantasy <your-email@gmail.com>` |

## 4. Run

```bash
npm run dev            # http://localhost:3000
npm test               # 259 tests (vitest)
npx tsc --noEmit       # type-check
npm run lint           # next lint
npm run build          # production build (run before deploy)
```

## 5. Seed a user + league

After running `npm run dev`, visit `http://localhost:3000/auth/signup`.
Signup is invite-only on prod (requires slug + invite code), but for a
fresh local DB you'll need to create the first league directly in the
DB before signup works.

The simplest path: connect with `psql 'postgresql://fairway:<pgpass>@127.0.0.1:5432/fairway'`
and insert a seed league + invite code yourself, then sign up via
`/join/<slug>/<code>`.

For loading real tournament data + golfer rankings into a local DB, see
`scripts/seed-golfers.ts` and the `/api/sync-scores/rankings` endpoint
(callable with `Authorization: Bearer $CRON_SECRET`).

---

## Common issues

- **`MissingSecret` from NextAuth** — `NEXTAUTH_SECRET` is unset or < 32 chars
- **`DATABASE_URL is required`** — `.env.local` didn't load; restart `npm run dev`
- **Sign-in always fails** — bcrypt hash mismatch; verify via psql that
  `auth_credentials.password_hash` starts with `$2a$10$` or `$2b$10$`
- **Email never arrives in dev** — without SMTP env, `sendEmail` falls back
  to logging "Email skipped (no SMTP)…" — the verification link is in the
  server's stdout so you can paste it into the browser manually
