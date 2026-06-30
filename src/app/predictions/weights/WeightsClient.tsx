'use client';

// Single client component for the weights page — list + edit-inline
// + create-new + activate + delete. Inline because the list is short
// (typically 1-5 rows) and a single component keeps state simple.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ConfigRow {
  id: string;
  name: string;
  description: string | null;
  course_fit_weight: string;
  recent_form_weight: string;
  long_term_weight: string;
  course_history_weight: string;
  cut_probability_weight: string;
  upside_weight: string;
  is_active: boolean;
  created_at: string;
}

interface DraftWeights {
  course_fit_weight: string;
  recent_form_weight: string;
  long_term_weight: string;
  course_history_weight: string;
  cut_probability_weight: string;
  upside_weight: string;
}

const WEIGHT_KEYS = [
  ['course_fit_weight',      'Course fit'],
  ['recent_form_weight',     'Recent form'],
  ['long_term_weight',       'Long term'],
  ['course_history_weight',  'Course history'],
  ['cut_probability_weight', 'Cut probability'],
  ['upside_weight',          'Upside'],
] as const;

function sum(d: DraftWeights): number {
  return WEIGHT_KEYS.reduce((acc, [k]) => acc + (Number(d[k]) || 0), 0);
}

export default function WeightsClient({ configs }: { configs: ConfigRow[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftWeights>(emptyDraft());
  const [editDesc, setEditDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDraft, setCreateDraft] = useState<DraftWeights>(emptyDraft());
  const [createDesc, setCreateDesc] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function emptyDraft(): DraftWeights {
    return {
      course_fit_weight: '', recent_form_weight: '', long_term_weight: '',
      course_history_weight: '', cut_probability_weight: '', upside_weight: '',
    };
  }

  function startEdit(c: ConfigRow) {
    setEditingId(c.id);
    setEditDraft({
      course_fit_weight:      c.course_fit_weight,
      recent_form_weight:     c.recent_form_weight,
      long_term_weight:       c.long_term_weight,
      course_history_weight:  c.course_history_weight,
      cut_probability_weight: c.cut_probability_weight,
      upside_weight:          c.upside_weight,
    });
    setEditDesc(c.description ?? '');
    setError(null);
  }

  async function activate(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/predictions/weights/${id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) setError(body?.error ?? `HTTP ${res.status}`);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    if (Math.abs(sum(editDraft) - 1) > 0.005) {
      setError(`Weights must sum to 1.0 (got ${sum(editDraft).toFixed(4)})`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/predictions/weights/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editDraft, description: editDesc }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        setError(body?.error ?? `HTTP ${res.status}`);
      } else {
        setEditingId(null);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteConfig(id: string) {
    if (!confirm('Delete this weight config?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/predictions/weights/${id}`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) setError(body?.error ?? `HTTP ${res.status}`);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createNew() {
    if (!createName.trim()) {
      setError('Name required');
      return;
    }
    if (Math.abs(sum(createDraft) - 1) > 0.005) {
      setError(`Weights must sum to 1.0 (got ${sum(createDraft).toFixed(4)})`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/predictions/weights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName,
          description: createDesc,
          ...createDraft,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        setError(body?.error ?? `HTTP ${res.status}`);
      } else {
        setCreating(false);
        setCreateName('');
        setCreateDraft(emptyDraft());
        setCreateDesc('');
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  function prefill(template: 'balanced' | 'upside-heavy' | 'form-heavy') {
    if (template === 'balanced') {
      setCreateDraft({
        course_fit_weight: '0.30', recent_form_weight: '0.20',
        long_term_weight: '0.15', course_history_weight: '0.15',
        cut_probability_weight: '0.10', upside_weight: '0.10',
      });
    } else if (template === 'upside-heavy') {
      setCreateDraft({
        course_fit_weight: '0.25', recent_form_weight: '0.15',
        long_term_weight: '0.10', course_history_weight: '0.10',
        cut_probability_weight: '0.15', upside_weight: '0.25',
      });
    } else if (template === 'form-heavy') {
      setCreateDraft({
        course_fit_weight: '0.20', recent_form_weight: '0.40',
        long_term_weight: '0.10', course_history_weight: '0.10',
        cut_probability_weight: '0.10', upside_weight: '0.10',
      });
    }
  }

  return (
    <div>
      {error && (
        <div style={{
          padding: '8px 12px', backgroundColor: '#fee', color: '#c33',
          border: '1px solid #f3c', borderRadius: '4px',
          fontSize: '13px', marginBottom: '12px',
        }}>{error}</div>
      )}

      <table style={tableStyle}>
        <thead style={{ backgroundColor: '#f4f4f1' }}>
          <tr>
            <th style={thStyle}>Name</th>
            {WEIGHT_KEYS.map(([, label]) => (
              <th key={label} style={thStyle}>{label}</th>
            ))}
            <th style={thStyle}>Sum</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {configs.map(c => {
            const isEditing = editingId === c.id;
            const currentDraft: DraftWeights = isEditing ? editDraft : {
              course_fit_weight: c.course_fit_weight,
              recent_form_weight: c.recent_form_weight,
              long_term_weight: c.long_term_weight,
              course_history_weight: c.course_history_weight,
              cut_probability_weight: c.cut_probability_weight,
              upside_weight: c.upside_weight,
            };
            const s = sum(currentDraft);
            return (
              <tr key={c.id} style={{
                borderTop: '1px solid #eee',
                backgroundColor: c.is_active ? '#eef5ee' : undefined,
              }}>
                <td style={tdStyle}>
                  <strong>{c.name}</strong>
                  {c.is_active && (
                    <span style={{
                      marginLeft: '8px', fontSize: '11px',
                      backgroundColor: '#3a8e5b', color: '#fff',
                      padding: '2px 8px', borderRadius: '8px',
                    }}>ACTIVE</span>
                  )}
                  {c.description && (
                    <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#666' }}>
                      {c.description}
                    </p>
                  )}
                  {isEditing && (
                    <input
                      type="text"
                      value={editDesc}
                      onChange={e => setEditDesc(e.target.value)}
                      placeholder="description"
                      style={{ ...inputStyle, marginTop: '6px', width: '240px' }}
                    />
                  )}
                </td>
                {WEIGHT_KEYS.map(([k]) => (
                  <td key={k} style={tdStyle}>
                    {isEditing ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        value={editDraft[k]}
                        onChange={e => setEditDraft(prev => ({ ...prev, [k]: e.target.value }))}
                        style={{ ...inputStyle, width: '64px' }}
                      />
                    ) : Number(c[k]).toFixed(2)}
                  </td>
                ))}
                <td style={{
                  ...tdStyle,
                  fontWeight: 700,
                  color: Math.abs(s - 1) > 0.005 ? '#c33' : '#3a8e5b',
                }}>
                  {s.toFixed(2)}
                </td>
                <td style={tdStyle}>
                  {isEditing ? (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button type="button" onClick={() => saveEdit(c.id)} disabled={busy}
                              style={primaryButton}>Save</button>
                      <button type="button" onClick={() => { setEditingId(null); setError(null); }}
                              style={secondaryButton}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button type="button" onClick={() => startEdit(c)} disabled={busy}
                              style={secondaryButton}>Edit</button>
                      {!c.is_active && (
                        <button type="button" onClick={() => activate(c.id)} disabled={busy}
                                style={primaryButton}>Activate</button>
                      )}
                      {!c.is_active && (
                        <button type="button" onClick={() => deleteConfig(c.id)} disabled={busy}
                                style={dangerButton}>Delete</button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Create-new */}
      <div style={{ marginTop: '20px' }}>
        {!creating ? (
          <button type="button" onClick={() => setCreating(true)} style={primaryButton}>
            + New config
          </button>
        ) : (
          <div style={{
            backgroundColor: '#fff',
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '20px',
            display: 'flex', flexDirection: 'column', gap: '12px',
          }}>
            <strong>New weight config</strong>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={labelStyle}>Name</span>
                <input
                  type="text" value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  style={{ ...inputStyle, width: '200px' }}
                  placeholder="e.g. upside-heavy"
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                <span style={labelStyle}>Description (optional)</span>
                <input
                  type="text" value={createDesc}
                  onChange={e => setCreateDesc(e.target.value)}
                  style={inputStyle}
                />
              </label>
            </div>
            <div>
              <span style={labelStyle}>Templates</span>
              <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                <button type="button" onClick={() => prefill('balanced')} style={secondaryButton}>Balanced (30/20/15/15/10/10)</button>
                <button type="button" onClick={() => prefill('upside-heavy')} style={secondaryButton}>Upside-heavy (25/15/10/10/15/25)</button>
                <button type="button" onClick={() => prefill('form-heavy')} style={secondaryButton}>Form-heavy (20/40/10/10/10/10)</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '8px' }}>
              {WEIGHT_KEYS.map(([k, label]) => (
                <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ ...labelStyle, fontSize: '12px' }}>{label}</span>
                  <input
                    type="text" inputMode="decimal"
                    value={createDraft[k]}
                    onChange={e => setCreateDraft(prev => ({ ...prev, [k]: e.target.value }))}
                    style={inputStyle}
                  />
                </label>
              ))}
            </div>
            <p style={{
              fontSize: '12px',
              color: Math.abs(sum(createDraft) - 1) > 0.005 ? '#c33' : '#3a8e5b',
              margin: 0,
            }}>
              Sum: {sum(createDraft).toFixed(2)} (must equal 1.00)
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={createNew} disabled={busy} style={primaryButton}>
                Create
              </button>
              <button type="button" onClick={() => {
                setCreating(false); setCreateName(''); setCreateDraft(emptyDraft());
                setCreateDesc(''); setError(null);
              }} style={secondaryButton}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  backgroundColor: '#fff',
  border: '1px solid #ddd',
  borderRadius: '8px',
  overflow: 'hidden',
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 8px',
  fontSize: '12px',
  fontWeight: 600,
  color: '#555',
};
const tdStyle: React.CSSProperties = { padding: '10px 8px', fontSize: '13px' };
const labelStyle: React.CSSProperties = { fontSize: '13px', color: '#555', fontWeight: 600 };
const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #ccc',
  borderRadius: '4px',
  fontSize: '13px',
  boxSizing: 'border-box',
};
const primaryButton: React.CSSProperties = {
  padding: '6px 12px', backgroundColor: '#1a3a2e', color: '#fff',
  border: 'none', borderRadius: '4px', cursor: 'pointer',
  fontSize: '12px', fontWeight: 600,
};
const secondaryButton: React.CSSProperties = {
  padding: '6px 10px', backgroundColor: '#fff', border: '1px solid #ccc',
  borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
};
const dangerButton: React.CSSProperties = {
  padding: '6px 10px', backgroundColor: '#fff', border: '1px solid #c33',
  color: '#c33', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
};
