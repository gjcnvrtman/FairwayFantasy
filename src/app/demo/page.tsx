import Link from 'next/link';
import type { Metadata } from 'next';
import { formatScore } from '@/lib/scoring';

export const metadata: Metadata = {
  title: 'How It Works · Demo League — Fairway Fantasy',
  description: 'Full rules walkthrough with a sample league mid-tournament. Scoring, money, automated emails, and edge-case handling — no sign-up required.',
};

// ─────────────────────────────────────────────────────────────
// DEMO DATA — completely static. No DB calls. No writes possible.
// Designed to demonstrate ALL rules in one view:
//   1. Pick 4 golfers (2 top tier, 2 dark horse)
//   2. Top 3 of 4 count toward total
//   3. Missed cut → score capped at cut line + 1 stroke team penalty
//   4. Made cut → score capped at cut score
//   5. Withdrawal → replacement allowed if untaken AND not teed off
//   6. No copycats: no two players in a league have the identical 4
//
// Visual layout below mirrors the REAL leaderboard component used on
// /league/[slug] — same row structure, sort order, and post-cut
// summary — so the rules page reads like the thing visitors will
// actually use, not a separate explainer.
// ─────────────────────────────────────────────────────────────

type GolferStatus = 'active' | 'made_cut' | 'missed_cut' | 'withdrawn';

interface DemoGolfer {
  name: string;
  rank: number | null;        // OWGR rank
  score: number | null;       // strokes to par; null = no score yet
  status: GolferStatus;
  notes?: string;             // optional rule-explainer caption shown under the row
}

interface DemoUser {
  name: string;
  rank: number;
  picks: DemoGolfer[];        // exactly 4: [top, top, dark, dark]
  countingIdx: number[];      // 0-indexed slots that contribute to the total
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
// Each user illustrates a different rule case. Scores are
// strokes-to-par (negative = under par). `countingIdx` lists which
// 3 of the 4 picks contributed to the total under the top-3-of-4
// rule (golfers with status='missed_cut' are excluded from counting
// regardless of their numeric score).
const DEMO_USERS: DemoUser[] = [
  {
    name: 'Tyler M.', rank: 1, total: -13, countingIdx: [0, 1, 2],
    flavor: 'Three of four under par. Eckroat’s missed cut adds a +1 to the team total (Tyler goes from −14 to −13), but the top three are firing hard enough that the penalty barely registers.',
    picks: [
      { name: 'Scottie Scheffler', rank:  1, score:  -7, status: 'active' },
      { name: 'Xander Schauffele', rank:  3, score:  -4, status: 'active' },
      { name: 'J.J. Spaun',        rank: 35, score:  -3, status: 'active' },
      { name: 'Austin Eckroat',    rank: 58, score:   3, status: 'missed_cut',
        notes: 'Missed cut → player score capped at the cut line (+3). The +1 stroke team penalty applies even though Eckroat is Tyler’s dropped 4th slot.' },
    ],
  },
  {
    name: 'Greg C.', rank: 2, total: -11, countingIdx: [0, 1, 2],
    flavor: 'Solid lineup, no penalties. McCarthy chipped in the 4th-counting slot but Henley’s round 3 was the difference.',
    picks: [
      { name: 'Rory McIlroy',  rank:  2, score: -5, status: 'active' },
      { name: 'Viktor Hovland', rank: 13, score: -3, status: 'active' },
      { name: 'Russell Henley', rank: 32, score: -3, status: 'active' },
      { name: 'Denny McCarthy', rank: 42, score:  0, status: 'active' },
    ],
  },
  {
    name: 'Jon P.', rank: 3, total: -9, countingIdx: [0, 1, 2],
    flavor: 'Replaced his withdrawn pick mid-tournament — Bhatia hadn’t teed off when Tom Kim WD’d, so the swap was legal.',
    picks: [
      { name: 'Ludvig Aberg',     rank:  6, score: -5, status: 'active' },
      { name: 'Collin Morikawa',  rank:  9, score: -2, status: 'active' },
      { name: 'Akshay Bhatia',    rank: 28, score: -2, status: 'active',
        notes: 'Replacement: Jon’s original DH#1 (Tom Kim) withdrew Friday morning. Bhatia hadn’t teed off yet — swap allowed.' },
      { name: 'Si Woo Kim',       rank: 71, score:  3, status: 'made_cut',
        notes: 'Made cut at exactly +3 → score capped at the cut line. He can’t hurt the team further this weekend.' },
    ],
  },
  {
    name: 'Marge K.', rank: 4, total: -7, countingIdx: [0, 1, 3],
    flavor: 'Cantlay had a bad Friday — Theegala’s strong third round leapfrogs the slot-3 underperformer.',
    picks: [
      { name: 'Patrick Cantlay',     rank:  8, score: -4, status: 'active' },
      { name: 'Sam Burns',           rank: 18, score: -1, status: 'active' },
      { name: 'Luke List',           rank: 47, score:  3, status: 'made_cut',
        notes: 'Made cut, capped at +3. Doesn’t count today — Theegala beat him.' },
      { name: 'Sahith Theegala',     rank: 39, score: -2, status: 'active' },
    ],
  },
  {
    name: 'Osm L.', rank: 5, total: -2, countingIdx: [1, 2, 3],
    flavor: 'JT missed cut — his slot is dropped from the counting trio, but the +1 team penalty still applies (sum of top 3 = −3, plus 1 for the MC = −2).',
    picks: [
      { name: 'Justin Thomas',  rank: 11, score:  3, status: 'missed_cut',
        notes: 'Missed cut → score capped at +3. Slot is dropped from top-3, but the +1 team penalty still hits.' },
      { name: 'Tommy Fleetwood', rank: 14, score: -2, status: 'active' },
      { name: 'Taylor Pendrith', rank: 26, score: -1, status: 'active' },
      { name: 'Greyson Sigg',    rank: 89, score:  0, status: 'active' },
    ],
  },
  {
    name: 'MJ T.', rank: 6, total: 3, countingIdx: [0, 1, 3],
    flavor: 'Both top-tier picks playing okay; Harman’s missed cut drops from the counting trio AND adds +1 to the team total. Davis squeaks in as the third counted score.',
    picks: [
      { name: 'Tony Finau',     rank: 15, score:  0, status: 'active' },
      { name: 'Corey Conners',  rank: 20, score: -1, status: 'active' },
      { name: 'Brian Harman',   rank: 31, score:  3, status: 'missed_cut',
        notes: 'Missed cut → player score capped at +3. Slot dropped, but the +1 team penalty still applies.' },
      { name: 'Cam Davis',      rank: 60, score:  3, status: 'made_cut' },
    ],
  },
  {
    name: 'Sam W.', rank: 7, total: null, countingIdx: [],
    flavor: 'Total pending. Tom Kim WD’d Friday morning and Sam tried to swap to Bhatia — already taken AND already teed off, so the swap was refused. Sungjae’s round 1 is still in progress at sync time.',
    picks: [
      { name: 'Wyndham Clark',  rank:  7, score: -2, status: 'active' },
      { name: 'Joaquin Niemann', rank: 16, score:  1, status: 'active' },
      { name: 'Tom Kim',         rank: 22, score: null, status: 'withdrawn',
        notes: 'WD Friday morning. Replacement (Bhatia) was already in Jon P.’s lineup AND had teed off — swap refused. Slot stays at WD with no score.' },
      { name: 'Sungjae Im',      rank: 24, score: null, status: 'active',
        notes: 'Round 1 still in progress at sync time — no score posted yet.' },
    ],
  },
  {
    name: 'Hambone L.', rank: 8, total: 5, countingIdx: [0, 1],
    flavor: 'Bottom of the standings — two missed cuts. MC golfers are excluded from the top-3 counting pool entirely, so Hambone’s “top 3” only has 2 contributors (Hideki +3 and Will E = +3). Stack +1 for each MC and the team total lands at +5.',
    picks: [
      { name: 'Hideki Matsuyama', rank:  4, score:  3, status: 'made_cut',
        notes: 'Made cut at exactly +3 — score capped at the cut line.' },
      { name: 'Will Zalatoris',   rank: 19, score:  0, status: 'active' },
      { name: 'Davis Thompson',   rank: 33, score:  3, status: 'missed_cut',
        notes: 'Missed cut → excluded from top-3 entirely. +1 team penalty applies.' },
      { name: 'Eric Cole',        rank: 56, score:  3, status: 'missed_cut',
        notes: 'Also missed cut — also excluded from top-3. Second MC adds another +1 team penalty for a stacked +2.' },
    ],
  },
];

// ─────────────────────────────────────────────────────────────
// `/demo` is also used as the in-app rules reference (linked from
// the league hero’s “📖 Rules” button). When a logged-in user lands
// here from inside a league, we need a way back to their league —
// the marketing “← Home” link sends them to `/`, which is no help.
//
// Pass `?back=/league/<slug>` to get a “← Back to <label>” link in
// the top nav and a “Back to your league” CTA at the bottom. Only
// same-origin `/league/...` paths are accepted; anything else is
// ignored and the page falls back to the marketing chrome. `label`
// is a display string only — escaped for XSS.
function safeBack(searchParams: { back?: string; label?: string } | undefined): {
  href:  string | null;
  label: string;
} {
  const raw   = typeof searchParams?.back  === 'string' ? searchParams.back  : '';
  const lblIn = typeof searchParams?.label === 'string' ? searchParams.label : '';
  // Path-only same-origin guard: must start with /league/ and contain
  // no scheme or //-prefixed protocol-relative form. Defends against
  // open-redirect via ?back=https://evil.com or ?back=//evil.com.
  if (!raw.startsWith('/league/') || raw.startsWith('//')) {
    return { href: null, label: '' };
  }
  const label = lblIn.trim().slice(0, 60) || 'your league';
  return { href: raw, label };
}

export default function DemoPage({
  searchParams,
}: {
  searchParams?: { back?: string; label?: string };
}) {
  const totalCounting = DEMO_USERS.filter(u => u.total !== null).length;
  const back = safeBack(searchParams);

  return (
    <div className="page-shell">
      {/* ── Top bar — contextual back link when coming from inside a
            league, marketing chrome otherwise. */}
      <nav className="nav">
        <div className="nav-inner">
          <Link href={back.href ?? '/'} className="nav-logo">Fairway <span>Fantasy</span></Link>
          <div className="nav-actions">
            {back.href ? (
              <Link href={back.href} className="btn btn-ghost btn-sm" style={{ color: 'rgba(255,255,255,0.7)' }}>
                ← Back to {back.label}
              </Link>
            ) : (
              <>
                <Link href="/" className="btn btn-ghost btn-sm" style={{ color: 'rgba(255,255,255,0.7)' }}>
                  ← Home
                </Link>
                <Link href="/auth/signup" className="btn btn-brass btn-sm">
                  Create Your League
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ── Hero ─────────────────────── */}
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

          {/* ── Tournament card ────────────── */}
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

          {/* ── Leaderboard — mirrors the real /league/[slug] layout:
                always-expanded cards, vertical golfer rows with ticks for
                counting picks, MC/WD/DQ pills, post-cut penalty summary.
                Tutorial copy (flavor + per-row notes) stays as small
                italic captions so the rules-walkthrough purpose
                survives the visual mirror. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
              <h2 style={{ fontFamily: "'Playfair Display', serif",
                           fontSize: '1.2rem', fontWeight: 700 }}>
                Leaderboard
              </h2>
              <span className="badge badge-live">🔴 Live</span>
            </div>

            {DEMO_USERS.map((u, i) => (
              <DemoLeaderboardRow key={u.name} user={u} index={i} />
            ))}
          </div>

          {/* ── Scoring rules — quick reference ───────── */}
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
                <li><strong>Missed cut</strong> → MC golfers are <strong>excluded from your top-3 counting pool entirely</strong> AND <strong>+1 stroke is added to your team total</strong> per MC. The player score is shown capped at the cut line, but only the +1 team penalty actually moves your total. (Hambone above: two MCs → top-3 has only 2 contributors and the team total picks up +2.)</li>
                <li><strong>Made cut, played badly</strong> → score is capped at the cut line. No team penalty. (Si Woo Kim above: capped at +3 even if he plays poorly.)</li>
                <li><strong>Withdrawal before teeing off</strong> → swap in any golfer who hasn&rsquo;t teed off yet. (Jon P. above swapped Tom Kim for Bhatia.)</li>
                <li><strong>Withdrawal mid-round</strong> → no replacement, that slot stays at WD with no score.</li>
                <li><strong>Missed the pick deadline?</strong> We auto-assign a random foursome — excluding the top-4 of each tier so you don&rsquo;t accidentally luck into the optimal lineup — and add a <strong>2-stroke penalty</strong> to your team total. Better than getting zero, much worse than picking on time.</li>
                <li><strong>No copycats</strong> — no two players in your league can pick the identical 4.</li>
              </ul>
            </div>

            <div className="card">
              <h3 style={{ fontFamily: "'Playfair Display', serif",
                           fontSize: '1.05rem', fontWeight: 700,
                           marginBottom: '0.85rem' }}>
                Money &amp; bets
              </h3>
              <ul style={{ fontSize: '0.875rem', color: 'var(--slate)',
                           lineHeight: 1.75, paddingLeft: '1.1rem' }}>
                <li><strong>Default bet at league setup.</strong> When you create the league you set a weekly bet amount — that&rsquo;s the per-tournament stake everyone plays for by default.</li>
                <li><strong>Override per tournament.</strong> Commissioners can change the bet for any upcoming tournament from the admin page&rsquo;s Tournament Status table. Typical use: bump the stake for the four majors.</li>
                <li><strong>How the pot works.</strong> Pot = bet × number of losers. Rank-1 takes the whole pot (split evenly on ties). Everyone else pays the bet.</li>
                <li><strong>Late joiners don&rsquo;t owe back-bets.</strong> If you join mid-season, you skip every tournament whose picks already locked before you joined. You owe nothing for those events.</li>
                <li><strong>Majors play differently.</strong> Cuts vary by event — Masters: top 50 + ties (also: within 10 strokes of the leader); U.S. Open: top 60 + ties; The Open &amp; PGA Championship: top 70 + ties. Regular tour stops: top 65 + ties.</li>
              </ul>
            </div>

            <div className="card">
              <h3 style={{ fontFamily: "'Playfair Display', serif",
                           fontSize: '1.05rem', fontWeight: 700,
                           marginBottom: '0.85rem' }}>
                Emails we send you
              </h3>
              <ul style={{ fontSize: '0.875rem', color: 'var(--slate)',
                           lineHeight: 1.75, paddingLeft: '1.1rem' }}>
                <li><strong>📋 Pick reminders</strong> before the deadline so you don&rsquo;t miss a tournament. Time-before-lock is your call.</li>
                <li><strong>⛳ Daily scorecard recap</strong> after every round wraps — league standings, your foursome breakdown, and a <strong>printable PDF scorecard</strong> attached.</li>
                <li><strong>🏆 Tournament recap</strong> when an event ends — final standings, your best round, and a season-standings snapshot.</li>
                <li><strong>All on by default, all opt-out</strong> from <em>Account</em> in the top nav. Toggle any of the three independently.</li>
              </ul>
            </div>
          </div>

          {/* ── CTA ────────────────────── */}
          <div className="card card-green" style={{ textAlign: 'center', padding: '2rem 1.5rem' }}>
            <h3 style={{ fontFamily: "'Playfair Display', serif",
                         fontSize: '1.4rem', marginBottom: '0.5rem' }}>
              {back.href ? 'Back to the action' : 'Ready to build yours?'}
            </h3>
            <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: '0.95rem',
                        marginBottom: '1.5rem', maxWidth: 480, margin: '0 auto 1.5rem' }}>
              {back.href
                ? `Rules are just the warm-up. ${back.label} is one click away.`
                : 'Free, private, no ads. Spin up a league in under 3 minutes and send the invite link to your group.'}
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              {back.href ? (
                <Link href={back.href} className="btn btn-brass btn-lg">
                  ← Back to {back.label}
                </Link>
              ) : (
                <>
                  <Link href="/auth/signup" className="btn btn-brass btn-lg">
                    Create a League →
                  </Link>
                  <Link href="/" className="btn btn-outline-white btn-lg">
                    Back to Home
                  </Link>
                </>
              )}
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
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// DemoLeaderboardRow — mirrors the LeaderboardRow component on
// the real /league/[slug] page: rank | name | total in the header;
// vertical foursome list sorted with cut survivors first and
// missed-cut golfers last; post-cut summary lines. Tutorial copy
// (the optional `flavor` blurb under the header and per-row `notes`)
// lives in small italic captions so visitors get the
// rules-walkthrough value WHILE seeing the same layout they’ll meet
// in their own league.
// ────────────────────────────────────────────────────────────
function DemoLeaderboardRow({
  user, index,
}: {
  user: DemoUser;
  index: number;
}) {
  const totalClass =
    user.total == null ? 'score-even'
    : user.total < 0 ? 'score-under'
    : user.total > 0 ? 'score-over' : 'score-even';

  const counting = new Set<number>(user.countingIdx.map(i => i + 1));   // 1-indexed slot ids

  // Mirror the real leaderboard’s sort: cut survivors first, missed-cut
  // golfers last; within each group, lower fantasy score wins. Nulls last.
  const sortedPicks = user.picks
    .map((g, idx) => ({ ...g, slot: idx + 1, idx }))
    .sort((a, b) => {
      const aMc = a.status === 'missed_cut' ? 1 : 0;
      const bMc = b.status === 'missed_cut' ? 1 : 0;
      if (aMc !== bMc) return aMc - bMc;
      return (a.score ?? Infinity) - (b.score ?? Infinity);
    });

  const mcPicks = user.picks.filter(g => g.status === 'missed_cut');

  return (
    <div className={`card lb-card rank-${index + 1}`} style={{ padding: '0.9rem 1rem' }}>
      {/* Header: rank | name | total */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '0.75rem', flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
          <span className="rank-num" style={{ flexShrink: 0 }}>{user.rank}</span>
          <strong style={{ fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user.name}
          </strong>
        </div>
        <strong className={totalClass} style={{ fontSize: '1.15rem', flexShrink: 0 }}>
          {formatScore(user.total)}
        </strong>
      </div>

      {/* Flavor caption */}
      {user.flavor && (
        <p style={{
          marginTop: '0.4rem',
          fontSize: '0.78rem', color: 'var(--slate-mid)',
          fontStyle: 'italic', lineHeight: 1.5,
        }}>
          {user.flavor}
        </p>
      )}

      {/* Foursome list */}
      <div style={{
        marginTop: '0.6rem',
        paddingTop: '0.6rem',
        borderTop: '1px solid var(--cream-dark)',
        display: 'flex', flexDirection: 'column', gap: '0.3rem',
      }}>
        {sortedPicks.map(g => {
          const isCounting = counting.has(g.slot);
          const isMC = g.status === 'missed_cut';
          const isWD = g.status === 'withdrawn';
          const tier = g.slot <= 2 ? 'Top' : 'DH';
          const fClass =
            g.score == null ? 'score-even'
            : g.score < 0 ? 'score-under'
            : g.score > 0 ? 'score-over' : 'score-even';
          return (
            <div key={g.slot}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontSize: '0.85rem',
                opacity: isCounting ? 1 : 0.5,
              }}>
                <span style={{
                  width: 14, flexShrink: 0, fontSize: '0.85rem',
                  color: isCounting ? 'var(--green-mid)' : 'var(--slate-light)',
                }} aria-label={isCounting ? 'counting' : 'dropped'}>
                  {isCounting ? '✓' : '·'}
                </span>
                <span className={`badge ${g.slot <= 2 ? 'badge-green' : 'badge-brass'}`} style={{ fontSize: '0.58rem', flexShrink: 0 }}>
                  {tier}
                </span>
                <span style={{
                  fontWeight: 600, color: 'var(--slate)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flex: '1 1 auto', minWidth: 0,
                }}>
                  {g.name}
                </span>
                <span style={{ color: 'var(--slate-mid)', fontSize: '0.72rem', flexShrink: 0 }}>
                  {g.rank ? `#${g.rank}` : 'Unranked'}
                </span>
                {(isMC || isWD) && (
                  <span
                    className="badge"
                    style={{
                      fontSize: '0.58rem',
                      flexShrink: 0,
                      background: '#fef3c7',
                      color: '#92400e',
                      border: '1px solid #fcd34d',
                    }}
                    title={isMC ? 'Missed cut' : 'Withdrew'}
                  >
                    {isMC ? 'MC' : 'WD'}
                  </span>
                )}
                <strong className={fClass} style={{ fontSize: '0.9rem', flexShrink: 0, width: '3rem', textAlign: 'right' }}>
                  {formatScore(g.score)}
                </strong>
              </div>
              {g.notes && (
                <p style={{
                  margin: '0.25rem 0 0.25rem 1.6rem',
                  fontSize: '0.72rem', color: 'var(--slate-mid)',
                  fontStyle: 'italic', lineHeight: 1.5,
                }}>
                  {g.notes}
                </p>
              )}
            </div>
          );
        })}

        {/* Post-cut missed-cut summary — one row per MC golfer
            contributing +1 to the team total, or a friendly summary
            line when nobody missed. Mirrors the real leaderboard’s
            post-cut behavior. */}
        <div style={{
          marginTop: '0.5rem',
          paddingTop: '0.5rem',
          borderTop: '1px dashed var(--cream-dark)',
          display: 'flex', flexDirection: 'column', gap: '0.25rem',
        }}>
          {mcPicks.length === 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              fontSize: '0.82rem', color: 'var(--slate-mid)',
              fontStyle: 'italic',
            }}>
              <span style={{ flex: '1 1 auto' }}>No players missed cut</span>
              <strong className="score-even" style={{ fontSize: '0.9rem', flexShrink: 0, width: '3rem', textAlign: 'right' }}>
                0
              </strong>
            </div>
          ) : (
            mcPicks.map(g => (
              <div key={`mc-${g.name}`} style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontSize: '0.82rem', color: 'var(--slate)',
              }}>
                <span style={{
                  flex: '1 1 auto',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  Missed cut · {g.name}
                </span>
                <strong className="score-over" style={{ fontSize: '0.9rem', flexShrink: 0, width: '3rem', textAlign: 'right' }}>
                  +1
                </strong>
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}
