'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface Golfer {
  id:            string;
  espn_id:       string;
  name:          string;
  owgr_rank:     number | null;
  is_dark_horse: boolean | null;   // null = unranked (treated as dark horse per scoring lib)
  headshot_url:  string | null;
  country:       string | null;
}

interface Tournament {
  id:           string;
  name:         string;
  type:         string;
  start_date:   string;
  pick_deadline:          string | null;
  pick_deadline_override: string | null;
  status:       string;
  cut_score:    number | null;
  course_name?: string | null;
}

interface ExistingPick {
  id?:          string;
  golfer_1_id:  string;
  golfer_2_id:  string;
  golfer_3_id:  string;
  golfer_4_id:  string;
  is_locked:    boolean;
  submitted_at: string;
}

interface ScoreRow {
  golfer_id:    string;
  status:       string;
  round_1:      number | null;
  score_to_par: number | null;
}

type Slot = 0 | 1 | 2 | 3;
const SLOT_LABELS = ['Top Tier #1', 'Top Tier #2', 'Dark Horse #1', 'Dark Horse #2'];
const SLOT_HELP   = ['OWGR ranked 1–24', 'OWGR ranked 1–24', 'OWGR ranked 25+ or unranked', 'OWGR ranked 25+ or unranked'];

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
export default function PicksPage() {
  const { slug } = useParams();
  const router = useRouter();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [golfers, setGolfers]       = useState<Golfer[]>([]);
  const [selected, setSelected]     = useState<(Golfer | null)[]>([null, null, null, null]);
  const [activeSlot, setActiveSlot] = useState<Slot | null>(null);
  const [search, setSearch]         = useState('');
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState('');
  const [saving, setSaving]         = useState(false);
  const [errors, setErrors]         = useState<string[]>([]);
  const [savedAt, setSavedAt]       = useState<Date | null>(null);
  const [savedGolfers, setSavedGolfers] = useState<Golfer[]>([]);
  const [leagueId, setLeagueId]     = useState('');
  const [alreadyPicked, setAlreadyPicked] = useState<string[]>([]);
  const [existingPickId, setExistingPickId] = useState<string | null>(null);
  const [scores, setScores]         = useState<ScoreRow[]>([]);
  // Withdrawal-replacement state. `replaceTarget` = the WD'd golfer the
  // user clicked Replace on; `replaceSearch` filters the candidate
  // panel; `replacing` blocks double-submit while PUT is in flight.
  const [replaceTarget, setReplaceTarget] = useState<Golfer | null>(null);
  const [replaceSearch, setReplaceSearch] = useState('');
  const [replacing,     setReplacing]     = useState(false);
  const [replaceError,  setReplaceError]  = useState('');

  // ── Initial data load ─────────────────────────────────────
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(`/api/picks/setup?slug=${slug}`);
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          if (alive) {
            setLoadError(d.error ?? `Failed to load (HTTP ${res.status})`);
            setLoading(false);
          }
          return;
        }
        const data = await res.json();
        if (!alive) return;
        setTournament(data.tournament);
        setGolfers(data.golfers ?? []);
        setLeagueId(data.leagueId);
        setAlreadyPicked(data.alreadyPickedIds ?? []);
        setScores(data.scores ?? []);

        if (data.existingPick) {
          const ep: ExistingPick = data.existingPick;
          setExistingPickId(ep.id ?? null);
          const findG = (id: string) =>
            (data.golfers ?? []).find((g: Golfer) => g.id === id) ?? null;
          setSelected([
            findG(ep.golfer_1_id), findG(ep.golfer_2_id),
            findG(ep.golfer_3_id), findG(ep.golfer_4_id),
          ]);
        }
        setLoading(false);
      } catch (err) {
        if (alive) {
          setLoadError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
          setLoading(false);
        }
      }
    }
    load();
    return () => { alive = false; };
  }, [slug]);

  // ── Filter golfers shown in the search panel ──────────────
  const filteredGolfers = useCallback((): Golfer[] => {
    const q = search.toLowerCase().trim();
    return golfers.filter(g => {
      if (q && !g.name.toLowerCase().includes(q)) return false;
      if (activeSlot !== null) {
        // Top-tier slots (0,1) accept only is_dark_horse === false
        if (activeSlot < 2 && g.is_dark_horse !== false) return false;
        // Dark-horse slots (2,3) accept is_dark_horse === true OR null (unranked)
        if (activeSlot >= 2 && g.is_dark_horse === false) return false;
      }
      return true;
    });
  }, [golfers, search, activeSlot]);

  // ── Derived state ─────────────────────────────────────────
  const selectedCount = selected.filter(Boolean).length;
  const allSelected   = selectedCount === 4;
  const isLocked      = tournament?.status !== 'upcoming';
  const lockDeadline  = useMemo(
    () => {
      if (!tournament) return null;
      // Override takes precedence (commissioner-set) over the
      // auto-computed pick_deadline (start_date - 1h).
      const raw = tournament.pick_deadline_override ?? tournament.pick_deadline;
      return raw ? new Date(raw) : null;
    },
    [tournament],
  );

  // ── Handlers ──────────────────────────────────────────────
  function selectGolfer(g: Golfer) {
    if (activeSlot === null) return;
    setSelected(prev => prev.map((cur, i) => {
      if (i === activeSlot) return g;
      if (cur?.id === g.id) return null; // remove from any other slot first
      return cur;
    }));
    setActiveSlot(null);
    setSearch('');
    setErrors([]);
  }

  function removeGolfer(slot: Slot) {
    setSelected(prev => {
      const next = [...prev];
      next[slot] = null;
      return next;
    });
    setErrors([]);
  }

  function openSlot(slot: Slot) {
    if (isLocked) return;
    setActiveSlot(slot);
    setSearch('');
  }

  async function handleSubmit() {
    if (!allSelected || !tournament) return;
    setErrors([]); setSaving(true);
    try {
      const res = await fetch('/api/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leagueId,
          tournamentId: tournament.id,
          golferIds:    selected.map(g => g?.id ?? null),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors(data.errors ?? [data.error ?? 'Failed to save picks.']);
        return;
      }
      setSavedAt(new Date());
      setSavedGolfers(selected.filter(Boolean) as Golfer[]);
    } catch (err) {
      setErrors([`Network error: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setSaving(false);
    }
  }

  // ── Withdrawal-replacement helpers ────────────────────────
  // Read each picked golfer's status from the scores rows the
  // `/api/picks/setup` endpoint includes post-lock. Defaults to
  // 'active' if no row exists yet (early in the tournament before
  // scores have been written).
  function getStatusFor(golferId: string): string {
    return scores.find(s => s.golfer_id === golferId)?.status ?? 'active';
  }

  // Eligible replacements: golfers in the field who haven't teed
  // off yet (round_1 still null) AND aren't already in this user's
  // foursome. The PUT /api/picks endpoint re-validates this on
  // submit, so this is purely UX filtering.
  const eligibleReplacements: Golfer[] = useMemo(() => {
    if (!replaceTarget) return [];
    const inFieldNotTeedOff = new Set(
      scores.filter(s => s.round_1 === null).map(s => s.golfer_id),
    );
    const pickedIds = new Set(selected.map(g => g?.id).filter(Boolean) as string[]);
    const q = replaceSearch.toLowerCase().trim();
    return golfers.filter(g =>
      inFieldNotTeedOff.has(g.id) &&
      !pickedIds.has(g.id) &&
      (q === '' || g.name.toLowerCase().includes(q)),
    );
  }, [replaceTarget, scores, selected, golfers, replaceSearch]);

  async function handleReplace(replacementGolferId: string) {
    if (!replaceTarget || !existingPickId) return;
    setReplaceError(''); setReplacing(true);
    try {
      const res = await fetch('/api/picks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickId:              existingPickId,
          withdrawnGolferId:   replaceTarget.id,
          replacementGolferId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReplaceError(data.error || `Replacement failed (HTTP ${res.status}).`);
        return;
      }
      // Success — close modal and refresh so the new substitution
      // shows. PUT marks the withdrawn golfer's score row as replaced;
      // a re-fetch picks up the new state.
      setReplaceTarget(null);
      setReplaceSearch('');
      router.refresh();
      window.location.reload();
    } catch (err) {
      setReplaceError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplacing(false);
    }
  }

  // ── Early-return states ───────────────────────────────────
  if (loading)   return <PageShell><LoadingState /></PageShell>;
  if (loadError) return <PageShell><ErrorState slug={String(slug)} message={loadError} /></PageShell>;
  if (!tournament) return <PageShell><NoTournamentState slug={String(slug)} /></PageShell>;
  if (savedAt) {
    return (
      <PageShell>
        <SavedConfirmation
          tournament={tournament}
          golfers={savedGolfers}
          slug={String(slug)}
          savedAt={savedAt}
          onEdit={() => { setSavedAt(null); setSavedGolfers([]); }}
        />
      </PageShell>
    );
  }

  const shown = filteredGolfers();

  // ── Main interactive layout ────────────────────────────────
  return (
    <PageShell>
      <TournamentHeader tournament={tournament} lockDeadline={lockDeadline} isLocked={isLocked} slug={String(slug)} />

      <div className="page-content">
        <div className="container" style={{ maxWidth: 1080 }}>
          {/* ── Lock deadline status row ───────────────────── */}
          <LockStatusRow isLocked={isLocked} lockDeadline={lockDeadline} />

          {/* Layout uses flex-wrap so on narrow viewports the search panel
              wraps below the slots column. No media queries needed. */}
          <div style={{ display: 'flex', flexFlow: 'row wrap', gap: '1.5rem',
                         alignItems: 'flex-start', marginTop: '1rem' }}>

            {/* ── Slots column ─────────────────────────────── */}
            <div style={{ flex: '1 1 380px', minWidth: 0 }}>
              <PickCounter selectedCount={selectedCount} />

              {errors.length > 0 && (
                <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
                  {errors.map((e, i) => <p key={i} style={{ marginBottom: i < errors.length - 1 ? '0.3rem' : 0 }}>{e}</p>)}
                </div>
              )}

              {/* If any picked golfer has withdrawn, surface the
                  action at the top of the slot list so the user sees
                  it before scrolling. */}
              {isLocked && existingPickId &&
                selected.some(g => g && getStatusFor(g.id) === 'withdrawn') && (
                  <div className="alert alert-warn" style={{ marginBottom: '1rem' }}>
                    <strong>⚠ Withdrawal detected.</strong>{' '}
                    One or more of your golfers has withdrawn from the tournament.
                    Use the <em>Replace</em> button below to substitute a golfer
                    who hasn&rsquo;t teed off yet.
                  </div>
                )}

              <div style={{ display: 'flex', flexDirection: 'column',
                             gap: '0.75rem', marginBottom: '1.25rem' }}>
                {selected.map((g, i) => {
                  const status = g && isLocked ? getStatusFor(g.id) : null;
                  return (
                    <div key={i}>
                      <PickSlot
                        slot={i as Slot}
                        golfer={g}
                        isActive={activeSlot === i}
                        locked={isLocked}
                        onOpen={() => openSlot(i as Slot)}
                        onRemove={() => removeGolfer(i as Slot)}
                      />
                      {g && isLocked && status && status !== 'active' && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: '0.5rem',
                          padding: '0.4rem 0.75rem', marginTop: '0.25rem',
                          fontSize: '0.78rem',
                        }}>
                          <StatusBadge status={status} />
                          {status === 'withdrawn' && existingPickId && (
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              onClick={() => { setReplaceTarget(g); setReplaceSearch(''); setReplaceError(''); }}
                            >
                              Replace →
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {!isLocked && (
                <button
                  className="btn btn-primary btn-full btn-lg"
                  onClick={handleSubmit}
                  disabled={saving || !allSelected}
                  aria-disabled={saving || !allSelected}
                >
                  {saving      ? 'Saving picks…'
                  : !allSelected ? `Select all 4 golfers (${selectedCount}/4 done)`
                  :                  'Submit picks ✓'}
                </button>
              )}

              <ScoringRulesCard />
            </div>

            {/* ── Search panel — only when a slot is active ─ */}
            {activeSlot !== null && !isLocked && (
              <div style={{ flex: '1 1 320px', minWidth: 0,
                             position: 'sticky', top: 84,
                             alignSelf: 'flex-start' }}
                   className="picks-search-panel">
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div style={{ padding: '0.9rem 1rem',
                                 borderBottom: '1px solid var(--cream-dark)' }}>
                    <div style={{ display: 'flex', alignItems: 'center',
                                  justifyContent: 'space-between',
                                  marginBottom: '0.7rem' }}>
                      <p style={{ fontWeight: 700, fontSize: '0.85rem', minWidth: 0 }}>
                        Select {SLOT_LABELS[activeSlot]}
                        <span className={activeSlot >= 2 ? 'badge badge-brass' : 'badge badge-green'}
                              style={{ marginLeft: '0.5rem', fontSize: '0.62rem' }}>
                          {activeSlot >= 2 ? 'Dark Horse' : 'Top Tier'}
                        </span>
                      </p>
                      <button className="btn btn-ghost btn-sm"
                              onClick={() => setActiveSlot(null)}
                              aria-label="Close search panel">
                        ✕
                      </button>
                    </div>
                    <input
                      className="input"
                      type="text"
                      placeholder="Search by name…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      autoFocus
                      aria-label="Search golfers"
                    />
                  </div>

                  <div className="player-list" style={{ maxHeight: 480, border: 'none', borderRadius: 0 }}>
                    {shown.length === 0 ? (
                      <div style={{ padding: '2rem', textAlign: 'center',
                                     color: 'var(--slate-mid)', fontSize: '0.875rem' }}>
                        No players match. Try a different search.
                      </div>
                    ) : shown.slice(0, 50).map(g => {
                      const isSelected     = selected.some(s => s?.id === g.id);
                      const isTakenByOther = alreadyPicked.includes(g.id);
                      const disabled       = isTakenByOther;
                      return (
                        <div
                          key={g.id}
                          className={`player-item ${disabled ? 'disabled' : ''}`}
                          onClick={() => !disabled && selectGolfer(g)}
                          style={{ background: isSelected ? 'var(--green-pale)' : undefined }}
                        >
                          {g.headshot_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={g.headshot_url} alt={g.name} width={36} height={36}
                                 style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                          ) : (
                            <div style={{
                              width: 36, height: 36, borderRadius: '50%',
                              background: 'var(--cream-dark)', flexShrink: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: '0.8rem', fontWeight: 700, color: 'var(--slate-mid)',
                            }}>
                              {g.name[0]}
                            </div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="player-name"
                                 style={{ color: isSelected ? 'var(--green-deep)' : undefined,
                                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {g.name}
                              {isSelected && (
                                <span style={{ marginLeft: '0.3rem', color: 'var(--green-mid)',
                                                fontSize: '0.72rem' }}>
                                  ✓ Selected
                                </span>
                              )}
                            </div>
                            <div className="player-country">
                              {g.country}
                              {isTakenByOther && (
                                <span style={{ color: 'var(--red)', marginLeft: '0.3rem' }}>· Taken</span>
                              )}
                            </div>
                          </div>
                          <div className="player-rank">
                            {g.owgr_rank ? `#${g.owgr_rank}` : '—'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* When no slot is active on desktop, show a help hint
                where the search panel would be. On mobile this is below
                the slots so it's secondary anyway. */}
            {activeSlot === null && (
              <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                <div className="card" style={{ textAlign: 'center',
                                                 color: 'var(--slate-mid)', padding: '2rem' }}>
                  <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>👆</div>
                  <p style={{ fontSize: '0.875rem', marginBottom: '0.4rem' }}>
                    {isLocked
                      ? 'Picks are locked — view-only mode.'
                      : `Tap a slot ${selectedCount === 0 ? 'on the left' : 'above'} to search for a golfer.`}
                  </p>
                  {!isLocked && selectedCount > 0 && selectedCount < 4 && (
                    <p style={{ fontSize: '0.78rem', color: 'var(--slate-light)' }}>
                      {4 - selectedCount} more to go.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Replacement modal — rendered at the page root so its overlay
          covers everything. Only shows while replaceTarget is set. */}
      {replaceTarget && (
        <ReplacementModal
          target={replaceTarget}
          candidates={eligibleReplacements}
          search={replaceSearch}
          onSearch={setReplaceSearch}
          onClose={() => { setReplaceTarget(null); setReplaceSearch(''); setReplaceError(''); }}
          onSelect={handleReplace}
          busy={replacing}
          error={replaceError}
        />
      )}
    </PageShell>
  );
}

// ─────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  // We can't reuse the league Nav (it requires a userName etc.). Local
  // top bar matches the rest of the app's nav styling.
  const { slug } = useParams();
  return (
    <div className="page-shell">
      <nav className="nav">
        <div className="nav-inner">
          <Link href={slug ? `/league/${slug}` : '/dashboard'} className="nav-logo">
            Fairway <span>Fantasy</span>
          </Link>
          <ul className="nav-links">
            {slug && <li><Link href={`/league/${slug}`}>← Leaderboard</Link></li>}
          </ul>
        </div>
      </nav>
      {children}
    </div>
  );
}

function TournamentHeader({ tournament, lockDeadline, isLocked, slug }: {
  tournament: Tournament;
  lockDeadline: Date | null;
  isLocked: boolean;
  slug: string;
}) {
  return (
    <div className="t-hero" style={{ padding: 'clamp(1.5rem,4vw,2rem) 1.5rem' }}>
      <div className="container">
        {tournament.type === 'major' && <div className="major-badge">🏆 Major Championship</div>}
        <h1 style={{ fontFamily: "'Playfair Display', serif",
                     fontSize: 'clamp(1.5rem,4vw,2.4rem)', fontWeight: 900,
                     marginBottom: '0.3rem' }}>
          {tournament.name}
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.875rem' }}>
          {lockDeadline
            ? `Pick deadline: ${formatDateTime(lockDeadline)}`
            : `Starts ${new Date(tournament.start_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`}
        </p>
      </div>
    </div>
  );
}

function LockStatusRow({ isLocked, lockDeadline }: {
  isLocked: boolean;
  lockDeadline: Date | null;
}) {
  if (isLocked) {
    return (
      <div className="alert alert-warn"
           style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        🔒 <strong>Picks are locked.</strong>
        <span style={{ color: 'var(--slate-mid)', fontSize: '0.85rem' }}>
          The tournament has started — your foursome is set.
        </span>
      </div>
    );
  }
  if (!lockDeadline) {
    return (
      <div className="alert alert-info">
        🔓 Picks open · Deadline TBD — check back closer to tournament week.
      </div>
    );
  }
  const rel = formatRelativeTime(lockDeadline);
  return (
    <div className="alert alert-info"
         style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
                   flexWrap: 'wrap' }}>
      <span>🔓</span>
      <strong>Picks open</strong>
      <span style={{ color: 'var(--slate-mid)' }}>·</span>
      <span style={{ color: 'var(--slate-mid)' }}>
        Locks {formatDateTime(lockDeadline)}
      </span>
      <span style={{ color: 'var(--green-deep)', fontWeight: 700, marginLeft: 'auto' }}>
        {rel}
      </span>
    </div>
  );
}

function PickCounter({ selectedCount }: { selectedCount: number }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                     gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.25rem', fontWeight: 700 }}>
          Your Foursome
        </h2>
        <span style={{ fontSize: '0.85rem', fontWeight: 700,
                        color: selectedCount === 4 ? 'var(--green-mid)' : 'var(--slate-mid)' }}>
          {selectedCount} of 4 selected
        </span>
      </div>
      {/* progress dots — 4 circles, filled = picked */}
      <div style={{ display: 'flex', gap: '0.4rem' }} aria-hidden="true">
        {[0, 1, 2, 3].map(i => (
          <span key={i}
                style={{
                  flex: 1, height: 6, borderRadius: 3,
                  background: i < selectedCount ? 'var(--green-mid)' : 'var(--cream-dark)',
                  transition: 'background 0.18s',
                }} />
        ))}
      </div>
    </div>
  );
}

function PickSlot({ slot, golfer, isActive, locked, onOpen, onRemove }: {
  slot: Slot;
  golfer: Golfer | null;
  isActive: boolean;
  locked: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const isDH = slot >= 2;
  return (
    <div
      className={`golfer-slot ${golfer ? 'slot-filled' : ''} ${isDH && golfer ? 'slot-dark-horse' : ''}`}
      style={{
        outline: isActive ? '2px solid var(--green-mid)' : 'none',
        outlineOffset: 2,
        cursor: locked ? 'default' : 'pointer',
      }}
      onClick={() => { if (!golfer) onOpen(); }}
      role={golfer ? undefined : 'button'}
      tabIndex={golfer ? undefined : 0}
      onKeyDown={e => {
        if (!golfer && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault(); onOpen();
        }
      }}
    >
      <div className="slot-num">{slot + 1}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {golfer ? (
          <div style={{ display: 'flex', alignItems: 'center',
                         justifyContent: 'space-between', gap: '0.5rem' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: '0.95rem',
                             overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {golfer.name}
              </div>
              <div className="slot-meta">
                <span className={`badge ${isDH ? 'badge-brass' : 'badge-green'}`}
                      style={{ marginRight: '0.4rem', fontSize: '0.62rem' }}>
                  {isDH ? '🐴 Dark Horse' : '⭐ Top Tier'}
                </span>
                {golfer.owgr_rank ? `Ranked #${golfer.owgr_rank}` : 'Unranked'}
                {golfer.country && ` · ${golfer.country}`}
              </div>
            </div>
            {!locked && (
              <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); onOpen(); }}
                  style={{ padding: '0.3rem 0.6rem' }}
                  aria-label={`Change ${SLOT_LABELS[slot]}`}
                >
                  Edit
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={e => { e.stopPropagation(); onRemove(); }}
                  style={{ color: 'var(--red)', padding: '0.3rem 0.6rem' }}
                  aria-label={`Remove ${golfer.name}`}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ) : (
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem',
                           color: isActive ? 'var(--green-mid)' : 'var(--slate-mid)' }}>
              {isActive ? '🔍 Searching…' : `Tap to select ${SLOT_LABELS[slot]}`}
            </div>
            <div className="slot-meta">{SLOT_HELP[slot]}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ScoringRulesCard() {
  return (
    <div className="card" style={{ marginTop: '1.25rem',
                                     background: 'var(--green-pale)',
                                     border: 'none' }}>
      <p style={{ fontSize: '0.75rem', fontWeight: 700,
                   textTransform: 'uppercase', letterSpacing: '0.08em',
                   color: 'var(--green-deep)', marginBottom: '0.5rem' }}>
        Scoring rules
      </p>
      <ul style={{ fontSize: '0.82rem', color: 'var(--slate)', lineHeight: 1.75,
                    paddingLeft: '1rem' }}>
        <li>Top 3 of your 4 golfers count toward your score</li>
        <li>Missed cut = cut score + 1 stroke penalty</li>
        <li>Made cut = score capped at the cut line</li>
        <li>Withdrawal = swap with any golfer who hasn&rsquo;t teed off</li>
        <li>No two players in the league may pick the same exact 4</li>
      </ul>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="page-content">
      <div className="container" style={{ maxWidth: 1080 }}>
        <div className="skeleton" style={{ height: 90, borderRadius: 'var(--radius-lg)', marginBottom: '1rem' }} />
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 380px', minWidth: 0 }}>
            <div className="skeleton" style={{ height: 36, marginBottom: '1rem' }} />
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="skeleton"
                   style={{ height: 72, borderRadius: 'var(--radius)', marginBottom: '0.75rem' }} />
            ))}
          </div>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div className="skeleton" style={{ height: 360, borderRadius: 'var(--radius-lg)' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorState({ slug, message }: { slug: string; message: string }) {
  return (
    <div className="page-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="container-sm" style={{ textAlign: 'center', padding: '2rem 1.5rem' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.4rem',
                      marginBottom: '0.5rem' }}>
          Couldn&rsquo;t load the picks page
        </h2>
        <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
          {message}
        </p>
        <Link href={`/league/${slug}`} className="btn btn-primary">← Back to League</Link>
      </div>
    </div>
  );
}

function NoTournamentState({ slug }: { slug: string }) {
  return (
    <div className="page-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="container-sm" style={{ textAlign: 'center', padding: '2rem 1.5rem' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🗓️</div>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.4rem',
                      marginBottom: '0.5rem' }}>
          No upcoming tournament
        </h2>
        <p style={{ color: 'var(--slate-mid)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
          Check back when the next event is scheduled.
        </p>
        <Link href={`/league/${slug}`} className="btn btn-primary">← Back to League</Link>
      </div>
    </div>
  );
}

function SavedConfirmation({ tournament, golfers, slug, savedAt, onEdit }: {
  tournament: Tournament;
  golfers: Golfer[];
  slug: string;
  savedAt: Date;
  onEdit: () => void;
}) {
  return (
    <div className="page-content">
      <div className="container-sm" style={{ paddingTop: '1.5rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.25rem' }}>✅</div>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 'clamp(1.6rem,5vw,2.1rem)',
                        fontWeight: 900, marginBottom: '0.25rem' }}>
            Picks saved!
          </h2>
          <p style={{ color: 'var(--slate-mid)', fontSize: '0.9rem' }}>
            Submitted at {savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ·{' '}
            {tournament.name}
          </p>
        </div>

        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <p className="label" style={{ marginBottom: '0.75rem' }}>Your foursome</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {golfers.map((g, i) => {
              const isDH = i >= 2;
              return (
                <div key={g.id} style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.6rem 0.75rem',
                  background: 'var(--cream)',
                  borderRadius: 'var(--radius-sm)',
                }}>
                  <span style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: isDH ? 'var(--brass)' : 'var(--green-mid)',
                    color: 'white', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: '0.78rem', fontWeight: 700,
                    flexShrink: 0,
                  }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.92rem',
                                   overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {g.name}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--slate-mid)' }}>
                      <span className={`badge ${isDH ? 'badge-brass' : 'badge-green'}`}
                            style={{ fontSize: '0.6rem', marginRight: '0.4rem' }}>
                        {isDH ? '🐴 DH' : '⭐ Top'}
                      </span>
                      {g.owgr_rank ? `#${g.owgr_rank}` : 'Unranked'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Link href={`/league/${slug}`} className="btn btn-brass btn-lg" style={{ flex: '1 1 220px' }}>
            Go to Leaderboard →
          </Link>
          <button onClick={onEdit} className="btn btn-outline btn-lg" style={{ flex: '1 1 160px' }}>
            Edit picks
          </button>
        </div>

        <p style={{ marginTop: '1.5rem', fontSize: '0.78rem', color: 'var(--slate-light)',
                     textAlign: 'center' }}>
          You can edit until picks lock {tournament.pick_deadline
            ? `at ${formatDateTime(new Date(tournament.pick_deadline))}`
            : 'when the tournament starts'}.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Date formatters — local & relative
// ─────────────────────────────────────────────────────────────
function formatDateTime(d: Date): string {
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function formatRelativeTime(d: Date): string {
  const ms = d.getTime() - Date.now();
  const past = ms < 0;
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);
  let label: string;
  if (days   >= 2) label = `${days}d ${hours % 24}h`;
  else if (days >= 1) label = `${days}d ${hours % 24}h`;
  else if (hours >= 1) label = `${hours}h ${minutes % 60}m`;
  else if (minutes >= 1) label = `${minutes}m`;
  else label = '<1m';
  return past ? `${label} ago` : `in ${label}`;
}

// ─────────────────────────────────────────────────────────────
// Withdrawal-replacement UI — small + focused
// ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const label =
    status === 'missed_cut'   ? 'MC — Missed Cut'
  : status === 'withdrawn'    ? 'WD — Withdrew'
  : status === 'disqualified' ? 'DQ — Disqualified'
  : status === 'complete'     ? 'Complete'
  : status;
  return (
    <span className="badge" style={{
      background: '#fef3c7',  // --brass-pale
      color:      '#92400e',
      border:     '1px solid #fcd34d',
      fontSize:   '0.65rem',
      flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

function ReplacementModal({
  target, candidates, search, onSearch, onClose, onSelect, busy, error,
}: {
  target:      Golfer;
  candidates:  Golfer[];
  search:      string;
  onSearch:    (s: string) => void;
  onClose:     () => void;
  onSelect:    (golferId: string) => void;
  busy:        boolean;
  error:       string;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Replace withdrawn golfer"
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{
        width: '100%', maxWidth: 520, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
        padding: 0, overflow: 'hidden',
      }}>
        <div style={{
          padding: '1rem 1.25rem',
          borderBottom: '1px solid var(--cream-dark)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '0.75rem',
        }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '0.15rem' }}>
              Replace {target.name}
            </p>
            <p style={{ fontSize: '0.78rem', color: 'var(--slate-mid)' }}>
              Pick a golfer who hasn&rsquo;t teed off yet.
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}
                  aria-label="Close replacement dialog">
            ✕
          </button>
        </div>

        <div style={{ padding: '0.75rem 1.25rem',
                       borderBottom: '1px solid var(--cream-dark)' }}>
          <input
            className="input"
            type="text"
            placeholder="Search candidates by name…"
            value={search}
            onChange={e => onSearch(e.target.value)}
            autoFocus
            aria-label="Search replacement candidates"
          />
        </div>

        {error && (
          <div className="alert alert-error" style={{ margin: '0.75rem 1.25rem 0' }}>
            {error}
          </div>
        )}

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {candidates.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center',
                           color: 'var(--slate-mid)', fontSize: '0.875rem' }}>
              No eligible replacements found.
              {search && <><br/>Try a different search term.</>}
            </div>
          ) : candidates.slice(0, 50).map(g => (
            <button
              key={g.id}
              type="button"
              disabled={busy}
              onClick={() => onSelect(g.id)}
              style={{
                width: '100%', textAlign: 'left',
                padding: '0.75rem 1.25rem',
                borderBottom: '1px solid var(--cream-dark)',
                background: 'transparent', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '0.75rem',
              }}
            >
              {g.headshot_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={g.headshot_url} alt={g.name} width={36} height={36}
                     style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{
                  width: 36, height: 36, borderRadius: '50%',
                  background: 'var(--cream-dark)', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.75rem', color: 'var(--slate-mid)',
                }}>{g.name.substring(0, 2).toUpperCase()}</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.name}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--slate-mid)' }}>
                  {g.country || '—'}{' · '}{g.owgr_rank ? `#${g.owgr_rank}` : 'Unranked'}
                </div>
              </div>
              <span style={{ fontSize: '0.78rem', color: 'var(--green-mid)', fontWeight: 700, flexShrink: 0 }}>
                Pick →
              </span>
            </button>
          ))}
        </div>

        {busy && (
          <div style={{ padding: '0.75rem 1.25rem', textAlign: 'center',
                         fontSize: '0.85rem', color: 'var(--slate-mid)',
                         borderTop: '1px solid var(--cream-dark)' }}>
            Submitting replacement…
          </div>
        )}
      </div>
    </div>
  );
}
