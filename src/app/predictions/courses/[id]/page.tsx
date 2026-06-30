// /predictions/courses/[id] — edit an existing course profile.

import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import CourseProfileForm, {
  type CourseProfileFormValues, type TournamentOption,
} from '../CourseProfileForm';

interface Props { params: { id: string } }

async function loadTournamentOptions(): Promise<TournamentOption[]> {
  const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const yearFromNow = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  return await db.selectFrom('tournaments')
    .select(['id', 'name', 'start_date'])
    .where('start_date', '>=', yearAgo)
    .where('start_date', '<=', yearFromNow)
    .where('type', 'in', ['regular', 'major'])
    .orderBy('start_date', 'asc')
    .execute();
}

async function loadProfile(id: string) {
  return await db.selectFrom('course_profiles')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
}

async function loadLinkedTournament(profileId: string): Promise<string | null> {
  const t = await db.selectFrom('tournaments')
    .select('id')
    .where('course_profile_id', '=', profileId)
    .executeTakeFirst();
  return t?.id ?? null;
}

export const dynamic = 'force-dynamic';

export default async function EditCourseProfilePage({ params }: Props) {
  const p = await loadProfile(params.id);
  if (!p) notFound();
  const [tournaments, linkedTournamentId] = await Promise.all([
    loadTournamentOptions(),
    loadLinkedTournament(p.id),
  ]);

  const initial: CourseProfileFormValues = {
    name: p.name,
    tournamentId: linkedTournamentId,
    external_course_id:           p.external_course_id != null ? String(p.external_course_id) : '',
    total_par:                    p.total_par?.toString() ?? '',
    total_yardage:                p.total_yardage?.toString() ?? '',
    par_3_count:                  p.par_3_count?.toString() ?? '',
    par_4_count:                  p.par_4_count?.toString() ?? '',
    par_5_count:                  p.par_5_count?.toString() ?? '',
    grass_type:                   p.grass_type ?? '',
    scoring_difficulty:           p.scoring_difficulty ?? '',
    driving_distance_importance:  p.driving_distance_importance ?? '',
    driving_accuracy_importance:  p.driving_accuracy_importance ?? '',
    approach_importance:          p.approach_importance ?? '',
    around_green_importance:      p.around_green_importance ?? '',
    putting_importance:           p.putting_importance ?? '',
    birdie_rate:                  p.birdie_rate ?? '',
    bogey_rate:                   p.bogey_rate ?? '',
    notes:                        p.notes ?? '',
  };

  return (
    <div style={{ maxWidth: '900px' }}>
      <h1 style={{ marginTop: 0 }}>Edit course profile</h1>
      <CourseProfileForm
        mode="edit"
        profileId={p.id}
        initial={initial}
        tournaments={tournaments}
      />
    </div>
  );
}
