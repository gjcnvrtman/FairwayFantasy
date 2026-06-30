// ============================================================
// /api/predictions/course-profiles
//
// POST — create a new course profile and, if `tournamentId` is
//        supplied, link it onto `tournaments.course_profile_id`
//        in the same transaction.
// GET  — list profiles (used by the listing page; the page also
//        queries Kysely directly, so this endpoint is here for
//        future external/scripted callers).
//
// Admin-gated → 404 on miss to hide existence.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { db } from '@/lib/db';

interface CreatePayload {
  name?: unknown;
  tournamentId?: unknown;
  total_par?: unknown;
  total_yardage?: unknown;
  par_3_count?: unknown;
  par_4_count?: unknown;
  par_5_count?: unknown;
  grass_type?: unknown;
  scoring_difficulty?: unknown;
  driving_distance_importance?: unknown;
  driving_accuracy_importance?: unknown;
  approach_importance?: unknown;
  around_green_importance?: unknown;
  putting_importance?: unknown;
  birdie_rate?: unknown;
  bogey_rate?: unknown;
  notes?: unknown;
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}
function numOrNull(v: unknown): number | null {
  const s = strOrNull(v);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function numStrOrNull(v: unknown): string | null {
  const n = numOrNull(v);
  return n == null ? null : n.toString();
}

const ALLOWED_GRASS = new Set(['bermuda','bentgrass','poa_annua','rye','mixed','other']);

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return { ok: false as const,
      response: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  return { ok: true as const, userId: user.id };
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as CreatePayload;
  const name = strOrNull(body.name);
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  const grass = strOrNull(body.grass_type);
  if (grass != null && !ALLOWED_GRASS.has(grass)) {
    return NextResponse.json({
      error: `grass_type must be one of: ${[...ALLOWED_GRASS].join(', ')}`,
    }, { status: 400 });
  }
  const tournamentId = strOrNull(body.tournamentId);

  try {
    const profileId = await db.transaction().execute(async trx => {
      const row = await trx.insertInto('course_profiles')
        .values({
          name,
          total_par:                   numOrNull(body.total_par),
          total_yardage:               numOrNull(body.total_yardage),
          par_3_count:                 numOrNull(body.par_3_count),
          par_4_count:                 numOrNull(body.par_4_count),
          par_5_count:                 numOrNull(body.par_5_count),
          grass_type:                  grass,
          scoring_difficulty:          numStrOrNull(body.scoring_difficulty),
          driving_distance_importance: numStrOrNull(body.driving_distance_importance),
          driving_accuracy_importance: numStrOrNull(body.driving_accuracy_importance),
          approach_importance:         numStrOrNull(body.approach_importance),
          around_green_importance:     numStrOrNull(body.around_green_importance),
          putting_importance:          numStrOrNull(body.putting_importance),
          birdie_rate:                 numStrOrNull(body.birdie_rate),
          bogey_rate:                  numStrOrNull(body.bogey_rate),
          notes:                       strOrNull(body.notes),
          curated_by:                  auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (tournamentId) {
        await trx.updateTable('tournaments')
          .set({ course_profile_id: row.id })
          .where('id', '=', tournamentId)
          .execute();
      }
      return row.id;
    });
    return NextResponse.json({ ok: true, id: profileId });
  } catch (err) {
    console.error('course-profiles POST failed:', err);
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Internal error',
    }, { status: 500 });
  }
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  const rows = await db.selectFrom('course_profiles')
    .selectAll()
    .orderBy('updated_at', 'desc')
    .execute();
  return NextResponse.json({ ok: true, profiles: rows });
}
