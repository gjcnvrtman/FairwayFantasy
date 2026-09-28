// ============================================================
// PREDICTIONS-EMAIL — orchestrates "run predictions + email
// recipients" for a single tournament.
//
// Two trigger points:
//   1. runFieldSync (src/lib/sync.ts) — fires on the NULL →
//      field_published_at flip. Auto-pilot path.
//   2. POST /api/predictions/runs/[id]/email — manual re-send
//      against the latest run, button on /predictions/current.
//
// Recipients = the platform-admin set (src/lib/platform-admin.ts).
// Currently Greg + MJ.
//
// On NO_COURSE_PROFILE the auto-path sends an alternate email
// ("field's set, curate a profile") so the admin knows what to do
// next. Other orchestrator errors are caught + logged; no email
// goes out on hard failure so we don't fill the inbox with stack
// traces, but the run row still records the error for /predictions
// debugging.
// ============================================================

import { db } from './db';
import { sendEmail } from './email';
import {
  predictionsReadyEmail, fieldPublishedNoProfileEmail,
  type PredictionsEmailFoursome,
} from './email';
import { runPredictions, OrchestratorError } from './predictions-orchestrator';
import { createProductionQueries } from './db/predictions-queries';
import { loadRunTeams } from './db/predictions-views';

const PLATFORM_ADMIN_EMAILS = [
  { name: 'Greg', email: 'gjcnvrtman@gmail.com' },
  { name: 'MJ',   email: 'jonesmg4@gmail.com' },
];

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL
      ?? process.env.NEXTAUTH_URL
      ?? 'http://localhost:3000';
}

// ── Render: load a complete run + send the top-5 email ────

/**
 * Given a fully-persisted prediction run, load the rendering data
 * (foursomes + golfer names + tournament + course profile) and
 * email all platform admins. Returns the count of emails sent.
 *
 * Used by both the auto-on-publish path (after a fresh runPredictions
 * succeeds) and the manual re-send endpoint (against an existing
 * run id).
 */
export async function emailPredictionsRun(runId: string): Promise<{
  sent: number; failed: string[];
}> {
  const run = await db.selectFrom('tournament_prediction_runs')
    .innerJoin('tournaments', 'tournaments.id', 'tournament_prediction_runs.tournament_id')
    .leftJoin('course_profiles', 'course_profiles.id', 'tournaments.course_profile_id')
    .select([
      'tournament_prediction_runs.id as run_id',
      'tournament_prediction_runs.stat_as_of_date as stat_as_of_date',
      'tournament_prediction_runs.field_size as field_size',
      'tournament_prediction_runs.golfers_with_missing_stats as golfers_with_missing_stats',
      'tournament_prediction_runs.missing_inputs as missing_inputs',
      'tournament_prediction_runs.status as status',
      'tournaments.id as tournament_id',
      'tournaments.name as tournament_name',
      'course_profiles.name as course_name',
    ])
    .where('tournament_prediction_runs.id', '=', runId)
    .executeTakeFirst();
  if (!run || run.status !== 'complete') {
    throw new Error(`Run ${runId} not found or not complete (status=${run?.status})`);
  }

  const { teams: foursomes, nameById } = await loadRunTeams(runId);
  if (foursomes.length === 0) {
    throw new Error(`Run ${runId} has no foursome rows`);
  }
  const nm = (id: string): string => nameById.get(id) ?? id;

  const emailFoursomes: PredictionsEmailFoursome[] = foursomes.map(f => ({
    rank:           f.rank,
    teamSize:       f.team_size === 6 ? 6 : 4,
    topTier1Name:   nm(f.top_tier_1_golfer_id),
    topTier2Name:   nm(f.top_tier_2_golfer_id),
    topTier3Name:   f.top_tier_3_golfer_id ? nm(f.top_tier_3_golfer_id) : null,
    darkHorse1Name: nm(f.dark_horse_1_golfer_id),
    darkHorse2Name: nm(f.dark_horse_2_golfer_id),
    darkHorse3Name: f.dark_horse_3_golfer_id ? nm(f.dark_horse_3_golfer_id) : null,
    projectedScore: Number(f.projected_fantasy_score),
    confidence:     Number(f.confidence_score),
    riskLevel:      f.risk_level,
    ownership:      f.estimated_ownership_pct != null
                      ? Number(f.estimated_ownership_pct) : null,
    explanation:    f.foursome_explanation,
    keyStrengths:   f.key_strengths ?? [],
    keyConcerns:    f.key_concerns  ?? [],
  }));

  const missingInputsByField: Record<string, number> =
    (run.missing_inputs as Record<string, number>) ?? {};

  let sent = 0;
  const failed: string[] = [];
  for (const recipient of PLATFORM_ADMIN_EMAILS) {
    const built = predictionsReadyEmail({
      recipientName:           recipient.name,
      tournamentName:          run.tournament_name,
      courseName:              run.course_name ?? null,
      asOfDate:                run.stat_as_of_date ?? 'n/a',
      foursomes:               emailFoursomes,
      fieldSize:               run.field_size ?? emailFoursomes.filter(f => f.teamSize === 4).length * 4,
      golfersWithMissingStats: run.golfers_with_missing_stats ?? 0,
      missingInputsByField,
      siteUrl:                 siteUrl(),
      runId:                   run.run_id,
    });
    const ok = await sendEmail({
      to: recipient.email,
      subject: built.subject,
      text: built.text,
      html: built.html,
    });
    if (ok) sent++;
    else failed.push(recipient.email);
  }
  return { sent, failed };
}

// ── Auto-on-publish: trigger predictions for a freshly-published field ──

/**
 * Hook called by runFieldSync immediately after stamping
 * field_published_at. Tries to run predictions; emails the top-5
 * on success, or sends the "curate a profile" reminder if the
 * course profile is missing.
 *
 * Wrapped in try/catch so any failure here CANNOT break the
 * field-sync caller — failure logs to console and returns.
 */
export async function autoPredictAndEmail(tournamentId: string): Promise<void> {
  let tournamentName: string | null = null;
  let startDate: string | null = null;
  let courseName: string | null = null;
  try {
    const t = await db.selectFrom('tournaments')
      .select(['name', 'start_date', 'course_name'])
      .where('id', '=', tournamentId)
      .executeTakeFirst();
    if (!t) {
      console.warn(`[autoPredictAndEmail] tournament ${tournamentId} not found`);
      return;
    }
    tournamentName = t.name;
    startDate = (typeof t.start_date === 'string' ? t.start_date : String(t.start_date)).slice(0, 10);
    courseName = t.course_name ?? null;

    const queries = createProductionQueries(db);
    const result = await runPredictions(
      { tournamentId, triggeredBy: null },
      queries,
    );
    await emailPredictionsRun(result.runId);
    console.log(`[autoPredictAndEmail] ${tournamentName}: emailed top-5 (run ${result.runId})`);
  } catch (err) {
    if (err instanceof OrchestratorError && err.code === 'NO_COURSE_PROFILE') {
      // Send the "curate a profile" reminder instead of going silent.
      try {
        for (const recipient of PLATFORM_ADMIN_EMAILS) {
          const built = fieldPublishedNoProfileEmail({
            recipientName:     recipient.name,
            tournamentName:    tournamentName ?? '(unknown)',
            startDate:         startDate ?? '(unknown)',
            tournamentId,
            defaultCourseName: courseName,
            siteUrl:           siteUrl(),
          });
          await sendEmail({
            to: recipient.email,
            subject: built.subject,
            text: built.text,
            html: built.html,
          });
        }
        console.log(`[autoPredictAndEmail] ${tournamentName}: course profile missing — reminder emails sent`);
      } catch (innerErr) {
        console.error(`[autoPredictAndEmail] no-profile email failed:`, innerErr);
      }
      return;
    }
    console.error(`[autoPredictAndEmail] ${tournamentName ?? tournamentId} failed:`, err);
    // Do NOT email a stack trace to recipients. They can see failed
    // runs in the /predictions UI; auto-pilot stays quiet on errors.
  }
}
