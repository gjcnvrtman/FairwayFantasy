import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Demo League — Fairway Fantasy',
  description: 'See a sample league mid-tournament. No sign-up required. Read-only preview of the full Fairway Fantasy experience.',
};

// ─────────────────────────────────────────────────────────────
// DEMO DATA — completely static. No DB calls. No writes possible.
// Designed to demonstrate ALL 5 rules in one view:
//   1. Pick 4 golfers (2 top tier, 2 dark horse)
//   2. Top 3 of 4 count toward total
//   3. Missed cut → cut score + 1 stroke penalty
//   4. Made cut → score capped at cut score
//   5. Withdrawal → replacement allowed (not teed off)
//   6. No copycats: no two players in a league have the identical 4
// ─────────────────────────────────────────────────────────────

type GolferStatus = 'active' | 'made_cut' | 'missed_cut' | 'withdrawn';

interface DemoGolfer {
  name: string;
  rank: number | null;        // OWGR rank
  score: number | null;       // strokes to par; null = no score yet
  status: GolferStatus;
  replacedBy?: string;        // golfer name if WD + replaced
  replacementScore?: number;
  notes?: string;             // explainer text shown in the card
}

interface DemoUser {
  name: string;
  rank: number;
  picks: DemoGolfer[];        // exactly 4: [top, top, dark, dark]
  countingIdx: number[];      // 0-indexed slots that contributed to total
  total: number | null;
  flavor?: string;            // optional caption explaining what this row demonstrates
}

const DEMO_LEAGUE = {
  name: 'The Boys Golf Club',
  tournament: 'The Masters',
  round: 'Round 3',
  course: 'Augusta National',
  cutScore: 3,                // +3 to par
  status: 'cut_made' as const,
  lastSyncedMinutesAgo: 2,
};

// ── User-by-user lineups ──
// Built so each illustrates a different rule case. All scores are
// strokes-to-par (negative = under par, positive = over). "Counting"
// arrays mark which 3 of the 4 picks contributed to the total.
const DEMO_USERS: DemoUser[] = [
  {
    name: 'Tyler M.', rank: 1, total: -14, countingIdx: [0, 1, 2],
    flavor: 'Three of four under par. Best dark-horse call (+1 cut penalty on Eckroat barely matters when the top three are firing).',
    picks: [
      { name: 'Scottie Scheffler', rank:  1, score:  -7, status: 'active' },
      { name: 'Xander Schauffele', rank:  3, score:  -4, status: 'active' },
      { name: 'J.J. Spaun',        rank: 35, score:  -3, status: 'active' },
      { name: 'Austin Eckroat',    rank: 58, score:   4, status: 'missed_cut',
        notes: 'Missed cut → score = cut (+3) + 1 = +4. Locked out for the weekend.' },
    ],
  },
  {
    name: 'Greg C.', rank: 2, total: -11, countingIdx: [0, 1, 2],
    flavor: 'Solid lineup, no penalties. McCarthy chipped in the 4th-counting slot but Henley\'s round 3 was the difference.',
    picks: [
      { name: 'Rory McIlroy',  rank:  2, score: -5, status: 'active' },
      { name: 'Viktor Hovland', rank: 13, score: -3, status: 'active' },
      { name: 'Russell Henley', rank: 32, score: -3, status: 'active' },
      { name: 'Denny McCarthy', rank: 42, score:  0, status: 'active' },
    ],
  },
  {
    name: 'Jon P.', rank: 3, total: -9, countingIdx: [0, 1, 2],
    flavor: 'Replaced his withdrawn pick mid-tournament — replacement Bhatia hadn\'t teed off, so the swap was legal.',
    picks: [
      { name: 'Ludvig Aberg',     rank:  6, score: -5, status: 'active' },
      { name: 'Collin Morikawa',  rank:  9, score: -2, status: 'active' },
      { name: 'Akshay Bhatia',    rank: 28, score: -2, status: 'active',
        notes: 'Replacement: Jon\'s original DH#1 (Tom Kim) withdrew Friday morning — Bhatia hadn\'t teed off, so the swap was eligible.' },
      { name: 'Si Woo Kim',       rank: 71, score:  3, status: 'made_cut',
        notes: 'Made cut at exactly +3 → score capped at cut (+3). Even if he plays poorly the rest of the way, he can\'t hurt the team further.' },
    ],
  },
  {
    name: 'Marge K.', rank: 4, total: -7, countingIdx: [0, 1, 3],
    flavor: 'Pat Cantlay had a bad Friday — but Theegala\'s strong third round leapfrogs the slot 3 underperformer.',
    picks: [
      { name: 'Patrick Cantlay',     rank:  8, score: -4, status: 'active' },
      { name: 'Sam Burns',           rank: 18, score: -1, status: 'active' },
      { name: 'Luke List',           rank: 47, score:  3, status: 'made_cut',
        notes: 'Made cut, capped at +3. Doesn\'t count today — Theegala beat him.' },
      { name: 'Sahith Theegala',     rank: 39, score: -2, status: 'active' },
    ],
  },
  {
    name: 'Osm L.', rank: 5, total: -3, countingIdx: [1, 2, 3],
    flavor: 'Justin Thomas missed cut — his +4 is the dropped score. Other three all in the red.',
    picks: [
      { name: 'Justin Thomas',  rank: 11, score:  4, status: 'missed_cut',
        notes: 'Missed cut → cut (+3) + 1 = +4. Dropped from team total.' },
      { name: 'Tommy Fleetwood', rank: 14, score: -2, status: 'active' },
      { name: 'Taylor Pendrith', rank: 26, score: -1, status: 'active' },
      { name: 'Greyson Sigg',    rank: 89, score:  0, status: 'active' },
    ],
  },
  {
    name: 'MJ T.', rank: 6, total: 2, countingIdx: [0, 1, 3],
    flavor: 'Both top-tier picks playing okay; missed cut on Conners hurts. Davis finds the team total.',
    picks: [
      { name: 'Tony Finau',     rank: 15, score:  0, status: 'active' },
      { name: 'Corey Conners',  rank: 20, score: -1, status: 'active' },
      { name: 'Brian Harman',   rank: 31, score:  4, status: 'missed_cut',
        notes: 'Missed cut → cut (+3) + 1 = +4. Dropped.' },
      { name: 'Cam Davis',      rank: 60, score:  3, status: 'made_cut' },
    ],
  },
  {
    name: 'Cnvrtman', rank: 7, total: null, countingIdx: [],
    flavor: 'Pending: original WD has been replaced but the new golfer hasn\'t finished round 1 yet — total holds until scores fill in.',
    picks: [
      { name: 'Wyndham Clark',  rank:  7, score: -2, status: 'active' },
      { name: 'Joaquin Niemann', rank: 16, score:  1, status: 'active' },
      { name: 'Tom Kim',         rank: 22, score: null, status: 'withdrawn',
        replacedBy: 'Akshay Bhatia (already taken — see Jon P.)',
        notes: 'WD Friday morning. Tried to replace with Bhatia, but Bhatia was already in another team\'s lineup AND had teed off. Replacement window closed; this slot is locked at WD with no points.' },
      { name: 'Sungjae Im',      rank: 24, score: null, status: 'active',
        notes: 'Round 1 still in progress at sync time — no score yet.' },
    ],
  },
  {
    name: 'Hambone L.', rank: 8, total: 5, countingIdx: [0, 1, 3],
    flavor: 'Bottom of the standings — two missed cuts, but the rules cap his damage at "cut + 1" each instead of letting them spiral into +12 / +15.',
    picks: [
      { name: 'Hideki Matsuyama', rank:  4, score:  3, status: 'made_cut' },
      { name: 'Will Zalatoris',   rank: 19, score:  0, status: 'active' },
      { name: 'Davis Thompson',   rank: 33, score:  4, status: 'missed_cut',
        notes: 'Missed cut → cut (+3) + 1 = +4.' },
      { name: 'Eric Cole',        rank: 56, score:  4, status: 'missed_cut',
        notes: 'Also missed cut → +4. Cap rule is the only thing keeping Hambone in single digits.' },
    ],
  },
];

// ── Display helpers ──
function fmt(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

function statusBadge(s: GolferStatus): { label: string; className: string } {
  switch (s) {
    case 'missed_cut': return { label: 'Missed Cut', className: 'badge-red' };
    case 'made_cut':   return { label: 'Made Cut',   className: 'badge-blue' };
    case 'withdrawn':  return { label: 'WD',         className: 'badge-gray' };
    case 'active':
    default:           return { label: 'Active',     className: 'badge-green' };
  }
}

// ─────────────────────────────────────────────────────────────
export default function DemoPage() {
  const totalCounting = DEMO_USERS.filter(u => u.total !== null).length;

  return (
    <div className="page-shell">
      {/* ── Top bar — minimal, no Nav (no auth) ───────────── */}
      <nav className="nav">
        <div className="nav-inner">
          <Link href="/" className="nav-logo">Fairway <span>Fantasy</span></Link>
          <div className="nav-actions">
            <Link href="/" className="btn btn-ghost btn-sm" style={{ color: 'rgba(255,255,255,0.7)' }}>
              ← Home
            </Link>
            <Link href="/auth/signup" className="btn btn-brass btn-sm">
              Create Your League
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ───────────────────────────────────────────── */}
      <div className="t-hero" style={{ padding: 'clamp(2rem,6vw,3rem) 1.25rem' }}>
        <div className="container">
          <div style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: '1rem',
          }}>
            <div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
                <span className="badge badge-brass">★ Demo League</span>
                <span className="badge badge-live">🔴 Sample data</span>
              </div>
              <h1 style={{
                fontFamily: "'Playfair Display', serif",
                fontSize: 'clamp(1.8rem,5vw,2.6rem)', fontWeight: 900,
                marginBottom: '0.3rem',
              }}>
                {DEMO_LEAGUE.name}
              </h1>
              <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.92rem' }}>
                {DEMO_USERS.length} players · 2026 season · No sign-up required
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <Link href="/auth/signup" className="btn btn-brass">
                Build Your Own →
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="container" style={{ maxWidth: 1080 }}>

          {/* ── Tournament card ───────────────────────────── */}
          <div className="card" style={{ marginBottom: '1.5rem',
                                          borderLeft: '4px solid var(--brass)' }}>
            <div style={{
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
              flexWrap: 'wrap', gap: '0.75rem',
            }}>
              <div>
                <div className="major-badge">🏆 Major Championship</div>
                <h2 style={{ fontFamily: "'Playfair Display', serif",
                             fontSize: '1.5rem', fontWeight: 700,
                             marginTop: '0.5rem', marginBottom: '0.3rem' }}>
                  {DEMO_LEAGUE.tournament} · {DEMO_LEAGUE.round}
                </h2>
                <p style={{ color: 'var(--slate-mid)', fontSize: '0.92rem' }}>
                  {DEMO_LEAGUE.course} · Cut: +{DEMO_LEAGUE.cutScore} · Last sync: {DEMO_LEAGUE.lastSyncedMinutesAgo} min ago
                </p>
              </div>
              <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(110px,1fr))', minWidth: 240 }}>
                <div className="stat-box">
                  <div className="stat-val">{totalCounting}/{DEMO_USERS.length}</div>
                  <div className="stat-lbl">Scoring</div>
                </div>
                <div className="stat-box">
                  <div className="stat-val">+{DEMO_LEAGUE.cutScore}</div>
                  <div className="stat-lbl">Cut line</div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Leaderboard with expandable picks per user ── */}
          {/* Native <details>/<summary> — no JS needed, mobile-friendly,
              and the first-place row is open by default so visitors see
              what a winning lineup looks like immediately. */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: '1.5rem' }}>
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--cream-dark)',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontFamily: "'Playfair Display', serif",
                           fontSize: '1.2rem', fontWeight: 700 }}>
                Leaderboard
              </h2>
              <span style={{ color: 'var(--slate-mid)', fontSize: '0.78rem' }}>
                Tap any row to see picks
              </span>
            </div>

            {DEMO_USERS.map((u, i) => (
              <details key={u.name}
                       open={u.rank <= 3}
                       style={{ borderBottom: i === DEMO_USERS.length - 1
                                ? 'none'
                                : '1px solid var(--cream-dark)' }}>
                <summary style={{
                  listStyle: 'none', cursor: 'pointer',
                  padding: '1rem 1.25rem',
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  transition: 'background 0.12s',
                }}>
                  <span className="rank-num" style={{ width: 36, flexShrink: 0 }}>{u.rank}</span>
                  <strong style={{ flex: 1, fontSize: '0.98rem' }}>{u.name}</strong>
                  <span style={{ color: 'var(--slate-mid)', fontSize: '0.78rem' }} className="hide-mobile">
                    {u.countingIdx.length} of 4 counting
                  </span>
                  <strong className={
                    u.total === null ? 'score-even'
                      : u.total < 0 ? 'score-under'
                      : u.total > 0 ? 'score-over'
                      : 'score-even'
                  } style={{ fontSize: '1.05rem', minWidth: 64, textAlign: 'right' }}>
                    {fmt(u.total)}
                  </strong>
                </summary>

                <div style={{ padding: '0 1.25rem 1.25rem',
                              background: 'var(--cream)',
                              borderTop: '1px solid var(--cream-dark)' }}>
                  {u.flavor && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--slate)',
                                fontStyle: 'italic', padding: '0.85rem 0 0.5rem',
                                lineHeight: 1.55 }}>
                      {u.flavor}
                    </p>
                  )}

                  <div style={{ display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                                gap: '0.75rem', paddingTop: '0.5rem' }}>
                    {u.picks.map((g, idx) => {
                      const isCounting = u.countingIdx.includes(idx);
                      const tier = idx < 2 ? 'top' : 'dark';
                      const sb = statusBadge(g.status);
                      return (
                        <div key={idx} style={{
                          background: 'white',
                          border: isCounting ? '2px solid var(--green-mid)'
                                              : '1px solid var(--cream-dark)',
                          borderRadius: 'var(--radius)',
                          padding: '0.85rem 1rem', position: 'relative',
                        }}>
                          {isCounting && (
                            <span className="badge badge-green"
                                  style={{ position: 'absolute', top: '0.5rem', right: '0.5rem',
                                           fontSize: '0.6rem' }}>
                              ✓ Counting
                            </span>
                          )}
                          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap',
                                        marginBottom: '0.4rem' }}>
                            <span className={tier === 'top' ? 'badge badge-green'
                                                            : 'badge badge-brass'}
                                  style={{ fontSize: '0.6rem' }}>
                              {tier === 'top' ? '⭐ Top Tier' : '🐴 Dark Horse'}
                            </span>
                            <span className={`badge ${sb.className}`}
                                  style={{ fontSize: '0.6rem' }}>
                              {sb.label}
                            </span>
                          </div>
                          <div style={{ fontWeight: 700, fontSize: '0.92rem',
                                        marginBottom: '0.15rem' }}>
                            {g.name}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center',
                                        justifyContent: 'space-between',
                                        fontSize: '0.78rem', color: 'var(--slate-mid)' }}>
                            <span>{g.rank ? `#${g.rank}` : 'Unranked'}</span>
                            <strong className={
                              g.score === null ? 'score-even'
                                : g.score < 0 ? 'score-under'
                                : g.score > 0 ? 'score-over'
                                : 'score-even'
                            } style={{ fontSize: '0.95rem' }}>
                              {fmt(g.score)}
                            </strong>
                          </div>
                          {g.notes && (
                            <p style={{ marginTop: '0.5rem',
                                        padding: '0.45rem 0.6rem',
                                        background: 'var(--cream)',
                                        borderRadius: 'var(--radius-sm)',
                                        fontSize: '0.75rem',
                                        color: 'var(--slate)',
                                        lineHeight: 1.5 }}>
                              {g.notes}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </details>
            ))}
          </div>

          {/* ── Scoring rules — quick reference ───────────── */}
          <div style={{ display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                        gap: '1rem', marginBottom: '1.5rem' }}>
            <div className="card">
              <h3 style={{ fontFamily: "'Playfair Display', serif",
                           fontSize: '1.05rem', fontWeight: 700,
                           marginBottom: '0.85rem' }}>
                How scoring works
              </h3>
              <ul style={{ fontSize: '0.875rem', color: 'var(--slate)',
                           lineHeight: 1.75, paddingLeft: '1.1rem' }}>
                <li><strong>Pick 4 golfers</strong> — 2 top tier (OWGR 1–24), 2 dark horses (25+).</li>
                <li><strong>Top 3 of 4 count</strong> — your worst golfer is dropped automatically.</li>
                <li><strong>Lower is better</strong> — strokes to par. <span className="score-under">−5</span> beats <span className="score-over">+2</span>.</li>
                <li><strong>Picks lock</strong> Thursday before first tee.</li>
                <li><strong>Live scoring</strong> — leaderboard updates every 10 min Thu–Sun.</li>
              </ul>
            </div>
            <div className="card">
              <h3 style={{ fontFamily: "'Playfair Display', serif",
                           fontSize: '1.05rem', fontWeight: 700,
                           marginBottom: '0.85rem' }}>
                When things go sideways
              </h3>
              <ul style={{ fontSize: '0.875rem', color: 'var(--slate)',
                           lineHeight: 1.75, paddingLeft: '1.1rem' }}>
                <li><strong>Missed cut</strong> → score is the cut line + 1 stroke. (Eckroat above: cut +3 → his score +4.)</li>
                <li><strong>Made cut, played badly</strong> → score is capped at the cut line. (Si Woo Kim above: capped at +3 even if he plays poorly.)</li>
                <li><strong>Withdrawal before teeing off</strong> → swap in any golfer who hasn&rsquo;t teed off yet. (Jon P. above swapped Tom Kim for Bhatia.)</li>
                <li><strong>Withdrawal mid-round</strong> → no replacement, that slot stays at WD with no score.</li>
                <li><strong>No copycats</strong> — no two players in your league can pick the identical 4.</li>
              </ul>
            </div>
          </div>

          {/* ── CTA ───────────────────────────────────────── */}
          <div className="card card-green" style={{ textAlign: 'center', padding: '2rem 1.5rem' }}>
            <h3 style={{ fontFamily: "'Playfair Display', serif",
                         fontSize: '1.4rem', marginBottom: '0.5rem' }}>
              Ready to build yours?
            </h3>
            <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: '0.95rem',
                        marginBottom: '1.5rem', maxWidth: 480, margin: '0 auto 1.5rem' }}>
              Free, private, no ads. Spin up a league in under 3 minutes and send the invite link to your group.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link href="/auth/signup" className="btn btn-brass btn-lg">
                Create a League →
              </Link>
              <Link href="/" className="btn btn-outline-white btn-lg">
                Back to Home
              </Link>
            </div>
          </div>
        </div>
      </div>

      <footer style={{
        background: '#0d1c10', color: 'rgba(255,255,255,0.45)',
        padding: '1.5rem', textAlign: 'center', fontSize: '0.82rem',
      }}>
        <p>Demo league. Sample data only — no real golfers were affected.</p>
      </footer>

      {/* Native <details> styling reset (default markers can clash with summary layout) */}
      <style>{`
        details > summary::-webkit-details-marker { display: none; }
        details > summary::marker { content: ''; }
        details > summary { -webkit-tap-highlight-color: transparent; }
        details > summary:hover { background: var(--green-pale); }
        details[open] > summary { background: var(--cream); }
      `}</style>
    </div>
  );
}
