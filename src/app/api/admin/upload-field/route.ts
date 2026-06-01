// /api/admin/upload-field — commissioner-driven ESPN-late-publish
// fallback (shipped 2026-05-30). When ESPN doesn't publish a
// tournament's field by Wednesday evening of tournament week,
// runFieldSync() leaves tournaments.field_published_at = NULL and
// the picks UI stays hard-blocked. This endpoint lets a commissioner
// paste names from the tournament site's player list to seed the
// scores rows + stamp field_published_at.
//
// POST { slug, tournamentId, names: string }
//   - slug authenticates the requester as a commissioner of that league
//   - tournamentId is the tournament whose field is being uploaded
//   - names is a free-text blob, newline-separated; CSV-style extra
//     columns ignored (first comma-separated cell taken)
//
// Returns 200 with:
//   { ok, matched, unmatched, totalNames, fieldPublishedAt }
// or 4xx with { error }.

import { NextRequest, NextResponse } from 'next/server';
import { requireCommissioner, isAuthFail } from '@/lib/auth-league';
import { db } from '@/lib/db';
import { requireSameOrigin } from '@/lib/same-origin';
import { parseUploadedNames, matchNamesToGolfers } from '@/lib/field-upload';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug         = typeof body.slug         === 'string' ? body.slug         : '';
  const tournamentId = typeof body.tournamentId === 'string' ? body.tournamentId : '';
  const namesText    = typeof body.names        === 'string' ? body.names        : '';

  if (!tournamentId) {
    return NextResponse.json({ error: 'tournamentId is required.' }, { status: 400 });
  }
  if (!namesText.trim()) {
    return NextResponse.json({ error: 'names body is empty.' }, { status: 400 });
  }

  // Commissioner-only — this seeds the field for ALL leagues that
  // score this tournament, so the bar is higher than the per-league
  // pick-deadline override (which co-commissioners can also do).
  const auth = await requireCommissioner({ slug });
  if (isAuthFail(auth)) return auth.response;

  const t = await db.selectFrom('tournaments')
    .select(['id', 'name', 'status', 'field_published_at'])
    .where('id', '=', tournamentId)
    .executeTakeFirst();
  if (!t) {
    return NextResponse.json({ error: 'Tournament not found.' }, { status: 404 });
  }
  // Don't reseed a completed event — that would corrupt finalized
  // fantasy_results. Active / cut_made is also rejected because the
  // scores rows for those tournaments are already authoritative;
  // the fallback is specifically for upcoming events ESPN hasn't
  // published yet.
  if (t.status !== 'upcoming') {
    return NextResponse.json(
      { error: `Cannot upload field for a ${t.status} tournament. ` +
               'Manual uploads are only allowed for upcoming events.' },
      { status: 409 },
    );
  }

  const parsed = parseUploadedNames(namesText);
  if (parsed.uniqueKeys.length === 0) {
    return NextResponse.json(
      { error: 'No parseable names found in upload.' },
      { status: 400 },
    );
  }

  // Pull all golfers once and match in memory. The golfers table is
  // small (~200 rows post-seed) so the index-once strategy beats N
  // per-name SELECTs. We pull espn_id along with id/name because
  // scores.espn_golfer_id is NOT NULL on the schema.
  const golfers = await db.selectFrom('golfers')
    .select(['id', 'espn_id', 'name'])
    .execute();
  const { matched, unmatched } = matchNamesToGolfers({
    uniqueOriginals: parsed.uniqueOriginals,
    uniqueKeys:      parsed.uniqueKeys,
    golfers,
  });

  if (matched.length === 0) {
    return NextResponse.json({
      ok: false,
      matched: 0,
      unmatched,
      totalNames: parsed.uniqueKeys.length,
      fieldPublishedAt: null,
      error: 'No uploaded names matched any golfer in the database. ' +
             'Check spellings or seed missing golfers via scripts/seed-golfers.ts.',
    }, { status: 422 });
  }

  // Seed scores rows for every matched golfer. ON CONFLICT DO NOTHING
  // is important: if this is a re-upload (commissioner correcting a
  // typo), we don't want to wipe progress on golfers already in the
  // table.
  const rows = matched.map(m => ({
    tournament_id:   tournamentId,
    golfer_id:       m.golferId,
    espn_golfer_id:  m.espnId,
    status:          'active' as const,
  }));
  await db.insertInto('scores')
    .values(rows)
    .onConflict(oc => oc.columns(['tournament_id', 'golfer_id']).doNothing())
    .execute();

  // Stamp field_published_at if not already set. The runFieldSync
  // timer might race us, but ON CONFLICT semantics + the IS NULL
  // guard make this idempotent either way.
  const now = new Date().toISOString();
  if (t.field_published_at === null) {
    await db.updateTable('tournaments')
      .set({ field_published_at: now })
      .where('id', '=', tournamentId)
      .where('field_published_at', 'is', null)
      .execute();
  }

  return NextResponse.json({
    ok: true,
    matched: matched.length,
    unmatched,
    totalNames: parsed.uniqueKeys.length,
    fieldPublishedAt: t.field_published_at ?? now,
    tournament: { id: t.id, name: t.name },
  });
}
