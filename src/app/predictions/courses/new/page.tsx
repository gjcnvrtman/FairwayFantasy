// ============================================================
// /predictions/courses/new — create a new course profile.
// Pre-fills tournament + course name from ?tournament_id=...&course_name=...
// if those query params are present (the /current page deep-links here).
// ============================================================

import { listLinkableTournaments } from '@/lib/db/predictions-views';
import CourseProfileForm, {
  type CourseProfileFormValues, type TournamentOption,
} from '../CourseProfileForm';

interface Props {
  searchParams: { tournament_id?: string; course_name?: string };
}

async function loadTournamentOptions(): Promise<TournamentOption[]> {
  // Upcoming only — past events aren't useful to attach a NEW profile
  // to (the run window is gone). Hidden events excluded.
  return await listLinkableTournaments(new Date());
}

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New Course Profile' };

export default async function NewCourseProfilePage({ searchParams }: Props) {
  const tournaments = await loadTournamentOptions();
  const initial: CourseProfileFormValues = {
    name: searchParams.course_name ?? '',
    tournamentId: searchParams.tournament_id ?? null,
    external_course_id: '',
    total_par: '',
    total_yardage: '',
    par_3_count: '',
    par_4_count: '',
    par_5_count: '',
    grass_type: '',
    scoring_difficulty: '',
    driving_distance_importance: '',
    driving_accuracy_importance: '',
    approach_importance: '',
    around_green_importance: '',
    putting_importance: '',
    birdie_rate: '',
    bogey_rate: '',
    notes: '',
  };
  return (
    <div style={{ maxWidth: '900px' }}>
      <h1 style={{ marginTop: 0 }}>New course profile</h1>
      <p style={{ color: '#666' }}>
        Fill in as much as you know. Empty fields stay NULL; the
        predictor surfaces missing inputs as warnings rather than
        refusing to run.
      </p>
      <CourseProfileForm
        mode="create"
        initial={initial}
        tournaments={tournaments}
      />
    </div>
  );
}
