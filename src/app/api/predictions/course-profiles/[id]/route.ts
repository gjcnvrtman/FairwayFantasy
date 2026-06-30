// /api/predictions/course-profiles/[id] — PUT updates a profile.
// Optionally re-links it to a different tournament in the same TX.

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { isPlatformAdmin } from '@/lib/platform-admin';
import { requireSameOrigin } from '@/lib/same-origin';
import { db } from '@/lib/db';

interface UpdatePayload {
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

interface Props { params: { id: string } }

export async function PUT(req: NextRequest, { params }: Props) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !user.email || !isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as UpdatePayload;
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
    await db.transaction().execute(async trx => {
      await trx.updateTable('course_profiles')
        .set({
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
          updated_at:                  new Date().toISOString(),
        })
        .where('id', '=', params.id)
        .execute();

      // Re-link tournament. We clear any other tournament currently
      // pointing at this profile so the per-tournament-uniqueness rule
      // holds (one tournament per profile in v1).
      if (tournamentId) {
        await trx.updateTable('tournaments')
          .set({ course_profile_id: null })
          .where('course_profile_id', '=', params.id)
          .execute();
        await trx.updateTable('tournaments')
          .set({ course_profile_id: params.id })
          .where('id', '=', tournamentId)
          .execute();
      } else {
        // Caller cleared the link → unset any tournament currently
        // pointing at this profile.
        await trx.updateTable('tournaments')
          .set({ course_profile_id: null })
          .where('course_profile_id', '=', params.id)
          .execute();
      }
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('course-profiles PUT failed:', err);
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Internal error',
    }, { status: 500 });
  }
}
