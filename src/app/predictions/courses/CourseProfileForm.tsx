'use client';

// Shared form used by both /predictions/courses/new and
// /predictions/courses/[id]. The parent server-component decides
// whether we POST (create) or PUT (update) by passing `mode`.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface CourseProfileFormValues {
  name: string;
  tournamentId: string | null;
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

  function setField<K extends keyof CourseProfileFormValues>(k: K, v: CourseProfileFormValues[K]) {
    setValues(prev => ({ ...prev, [k]: v }));
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
