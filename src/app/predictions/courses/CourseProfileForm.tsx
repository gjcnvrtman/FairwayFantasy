'use client';

// Shared form used by both /predictions/courses/new and
// /predictions/courses/[id]. The parent server-component decides
// whether we POST (create) or PUT (update) by passing `mode`.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface CourseProfileFormValues {
  name: string;
  tournamentId: string | null;
  /** Link back to bw_courses_cache.id (the source-of-truth physical
   *  course row). Set by the search-and-autofill flow; manually-entered
   *  profiles stay NULL. */
  external_course_id: string;
  total_par: string;
  total_yardage: string;
  par_3_count: string;
  par_4_count: string;
  par_5_count: string;
  grass_type: string;
  scoring_difficulty: string;
  driving_distance_importance: string;
  driving_accuracy_importance: string;
  approach_importance: string;
  around_green_importance: string;
  putting_importance: string;
  birdie_rate: string;
  bogey_rate: string;
  notes: string;
}

interface BwCourseSearchResult {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
  total_par: number | null;
  total_yardage: number | null;
  par_3_count: number | null;
  par_4_count: number | null;
  par_5_count: number | null;
}

export interface TournamentOption {
  id: string;
  name: string;
  start_date: string;
}

interface Props {
  mode: 'create' | 'edit';
  initial: CourseProfileFormValues;
  profileId?: string;
  tournaments: TournamentOption[];
}

export default function CourseProfileForm({
  mode, initial, profileId, tournaments,
}: Props) {
  const router = useRouter();
  const [values, setValues] = useState<CourseProfileFormValues>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Boys-weekend course search + autofill.
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<BwCourseSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  function setField<K extends keyof CourseProfileFormValues>(k: K, v: CourseProfileFormValues[K]) {
    setValues(prev => ({ ...prev, [k]: v }));
  }

  // Debounced search effect.
  useEffect(() => {
    if (searchTerm.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/predictions/bw-courses/search?q=${encodeURIComponent(searchTerm)}`,
        );
        const body = await res.json().catch(() => ({}));
        setSearchResults(Array.isArray(body?.results) ? body.results : []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [searchTerm]);

  // Apply one search hit. Only overwrites fields whose autofill data
  // is present — manual edits to other fields aren't clobbered.
  async function applyBwCourse(courseId: number) {
    setSearching(true);
    try {
      const res = await fetch(`/api/predictions/bw-courses/${courseId}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.course) return;
      const c = body.course;
      setValues(prev => ({
        ...prev,
        // Only overwrite name if blank to avoid clobbering a manual edit.
        name:                prev.name ? prev.name : c.name ?? prev.name,
        external_course_id:  String(c.id),
        total_par:           c.total_par != null ? String(c.total_par) : prev.total_par,
        total_yardage:       c.total_yardage != null ? String(c.total_yardage) : prev.total_yardage,
        par_3_count:         c.par_3_count != null ? String(c.par_3_count) : prev.par_3_count,
        par_4_count:         c.par_4_count != null ? String(c.par_4_count) : prev.par_4_count,
        par_5_count:         c.par_5_count != null ? String(c.par_5_count) : prev.par_5_count,
      }));
      setSearchTerm('');
      setSearchOpen(false);
    } finally {
      setSearching(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const url = mode === 'create'
      ? '/api/predictions/course-profiles'
      : `/api/predictions/course-profiles/${profileId}`;
    const method = mode === 'create' ? 'POST' : 'PUT';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        setError(body?.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      router.push('/predictions/courses');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ── Boys-weekend course search ──────────────────── */}
      <div style={{
        backgroundColor: '#eef5ee',
        border: '1px solid #b9d4b9',
        borderRadius: '8px',
        padding: '14px 16px',
      }}>
        <strong style={{ fontSize: '14px' }}>Search boys-weekend (15k courses)</strong>
        <p style={{ margin: '4px 0 10px', fontSize: '12px', color: '#456' }}>
          Type a course name. Selecting one autofills par, yardage, and par counts.
        </p>
        <input
          type="text"
          placeholder="e.g. tpc deere, pebble, augusta"
          value={searchTerm}
          onChange={e => { setSearchTerm(e.target.value); setSearchOpen(true); }}
          onFocus={() => setSearchOpen(true)}
          style={inputStyle}
        />
        {searchOpen && searchResults.length > 0 && (
          <div style={{
            marginTop: '6px',
            maxHeight: '220px',
            overflowY: 'auto',
            backgroundColor: '#fff',
            border: '1px solid #ccc',
            borderRadius: '4px',
          }}>
            {searchResults.map(r => (
              <button
                key={r.id}
                type="button"
                onClick={() => applyBwCourse(r.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  backgroundColor: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid #eee',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                <strong>{r.name}</strong>
                {' '}
                <span style={{ color: '#666' }}>
                  {[r.city, r.state].filter(Boolean).join(', ')}
                </span>
                {r.total_par != null && (
                  <span style={{ color: '#888', marginLeft: '8px', fontSize: '12px' }}>
                    par {r.total_par}{r.total_yardage ? ` · ${r.total_yardage} yd` : ''}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {searching && (
          <p style={{ fontSize: '12px', color: '#666', marginTop: '6px' }}>Searching...</p>
        )}
        {values.external_course_id && (
          <p style={{ fontSize: '12px', color: '#3a8e5b', marginTop: '6px' }}>
            ✓ Linked to boys-weekend course #{values.external_course_id}
          </p>
        )}
      </div>

      <Field label="Course name (required)">
        <input
          type="text"
          required
          value={values.name}
          onChange={e => setField('name', e.target.value)}
          style={inputStyle}
        />
      </Field>

      <Field label="Tournament">
        <select
          value={values.tournamentId ?? ''}
          onChange={e => setField('tournamentId', e.target.value || null)}
          style={inputStyle}
        >
          <option value="">— unlinked (link later) —</option>
          {tournaments.map(t => (
            <option key={t.id} value={t.id}>
              {t.name} ({new Date(t.start_date).toLocaleDateString()})
            </option>
          ))}
        </select>
      </Field>

      <SectionHeading>Physical</SectionHeading>
      <Row>
        <Field label="Par (total)"><NumInput v={values.total_par} on={v => setField('total_par', v)} /></Field>
        <Field label="Yardage"><NumInput v={values.total_yardage} on={v => setField('total_yardage', v)} /></Field>
        <Field label="Par 3s"><NumInput v={values.par_3_count} on={v => setField('par_3_count', v)} /></Field>
        <Field label="Par 4s"><NumInput v={values.par_4_count} on={v => setField('par_4_count', v)} /></Field>
        <Field label="Par 5s"><NumInput v={values.par_5_count} on={v => setField('par_5_count', v)} /></Field>
      </Row>

      <SectionHeading>Surface</SectionHeading>
      <Row>
        <Field label="Grass type">
          <select
            value={values.grass_type}
            onChange={e => setField('grass_type', e.target.value)}
            style={inputStyle}
          >
            <option value="">— unknown —</option>
            <option value="bermuda">bermuda</option>
            <option value="bentgrass">bentgrass</option>
            <option value="poa_annua">poa annua</option>
            <option value="rye">rye</option>
            <option value="mixed">mixed</option>
            <option value="other">other</option>
          </select>
        </Field>
        <Field label="Scoring difficulty (vs par)">
          <NumInput v={values.scoring_difficulty} on={v => setField('scoring_difficulty', v)} hint="e.g. 1.5" />
        </Field>
      </Row>

      <SectionHeading>Course-fit importances (0..1)</SectionHeading>
      <Row>
        <Field label="Driving distance"><NumInput v={values.driving_distance_importance} on={v => setField('driving_distance_importance', v)} /></Field>
        <Field label="Driving accuracy"><NumInput v={values.driving_accuracy_importance} on={v => setField('driving_accuracy_importance', v)} /></Field>
        <Field label="Approach"><NumInput v={values.approach_importance} on={v => setField('approach_importance', v)} /></Field>
        <Field label="Around-green"><NumInput v={values.around_green_importance} on={v => setField('around_green_importance', v)} /></Field>
        <Field label="Putting"><NumInput v={values.putting_importance} on={v => setField('putting_importance', v)} /></Field>
      </Row>

      <SectionHeading>Field-level rates (0..1)</SectionHeading>
      <Row>
        <Field label="Birdie rate"><NumInput v={values.birdie_rate} on={v => setField('birdie_rate', v)} /></Field>
        <Field label="Bogey rate"><NumInput v={values.bogey_rate} on={v => setField('bogey_rate', v)} /></Field>
      </Row>

      <Field label="Notes">
        <textarea
          rows={3}
          value={values.notes}
          onChange={e => setField('notes', e.target.value)}
          style={{ ...inputStyle, fontFamily: 'inherit' }}
        />
      </Field>

      {error && (
        <div style={{ color: '#c33', fontSize: '14px' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
        <button
          type="submit"
          disabled={submitting || !values.name}
          style={{
            padding: '10px 20px',
            backgroundColor: submitting ? '#888' : '#1a3a2e',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: submitting ? 'wait' : 'pointer',
            fontSize: '14px',
            fontWeight: 600,
          }}
        >
          {submitting ? 'Saving...' : (mode === 'create' ? 'Create profile' : 'Save changes')}
        </button>
        <button
          type="button"
          onClick={() => router.push('/predictions/courses')}
          style={{
            padding: '10px 20px',
            backgroundColor: '#fff',
            color: '#333',
            border: '1px solid #ccc',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Atoms ─────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '13px', color: '#555', fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: '12px',
    }}>
      {children}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      margin: '8px 0 0',
      fontSize: '14px',
      fontWeight: 700,
      color: '#1a3a2e',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
    }}>{children}</h3>
  );
}

function NumInput({ v, on, hint }: { v: string; on: (s: string) => void; hint?: string }) {
  return (
    <input
      type="text"
      inputMode="decimal"
      placeholder={hint}
      value={v}
      onChange={e => on(e.target.value)}
      style={inputStyle}
    />
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #ccc',
  borderRadius: '4px',
  fontSize: '14px',
  width: '100%',
  boxSizing: 'border-box',
};
