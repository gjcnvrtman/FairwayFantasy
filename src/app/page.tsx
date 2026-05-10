import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Fairway Fantasy — Private Golf Fantasy Leagues for Your Group',
  description: 'Pick 4 golfers each tournament, top 3 count. Live ESPN scoring, all four Majors, every PGA Tour event. Free, private, no ads.',
};

// ── Static demo data for the inline preview section ────────────
// Hardcoded sample standings so visitors see the product before
// signing up. Replaced by a real /demo route in prompt 3.
const DEMO_LEADERBOARD = [
  { rank: 1, name: 'Tyler M.',  picks: ['Scheffler', 'Schauffele', 'Spaun',  'Eckroat'],   score: -14 },
  { rank: 2, name: 'Greg C.',   picks: ['McIlroy',   'Hovland',    'Henley', 'McCarthy'],  score: -11 },
  { rank: 3, name: 'Jon P.',    picks: ['Aberg',     'Morikawa',   'Bhatia', 'Kim'],       score:  -9 },
  { rank: 4, name: 'Marge K.',  picks: ['Cantlay',   'Burns',      'List',   'Theegala'],  score:  -7 },
  { rank: 5, name: 'Osm L.',    picks: ['Thomas',    'Fleetwood',  'Pendrith', 'Sigg'],    score:  -3 },
  { rank: 6, name: 'MJ T.',     picks: ['Finau',     'Conners',    'Harman', 'Davis'],     score:  +2 },
];

const HOW_IT_WORKS = [
  { n: 1, t: 'Create a private league',
    d: 'Name it, share one invite link. You\'re the commissioner.' },
  { n: 2, t: 'Pick 4 golfers each tournament',
    d: '2 top-tier (OWGR 1–24) and 2 dark horses (ranked 25+). Locks Thursday before tee time.' },
  { n: 3, t: 'Top 3 scores count',
    d: 'Best 3 of your 4 golfers contribute. Missed cut? Penalty + replacement window for WDs.' },
  { n: 4, t: 'Track live standings',
    d: 'Scores sync from ESPN every 10 minutes Thursday through Sunday.' },
];

const RULES = [
  { icon: '🏌️', title: 'Pick 4 Golfers',  desc: '2 top-tier (OWGR 1–24) and 2 dark horses (25+) before Thursday tee time.' },
  { icon: '🤝', title: 'No Copycats',    desc: 'No two players in a league pick the identical foursome. Make it yours.' },
  { icon: '🥇', title: 'Top 3 Count',    desc: 'Only your best 3 of 4 golfers count toward your weekly score.' },
  { icon: '✂️', title: 'Cut Rules',      desc: 'Missed cut = cut score +1. Made cut = score capped at the cut line.' },
  { icon: '🔄', title: 'Withdrawals',    desc: "Golfer WDs? Swap in anyone who hasn't teed off yet." },
  { icon: '🏆', title: 'Season Long',    desc: 'Scores accumulate across every PGA Tour event and the four Majors.' },
];

// ── Visual placeholders for product screenshots ────────────────
// These are styled SVG cards that hint at the real screen
// composition. Swapped for real screenshots once the product has
// shipped sample data we're allowed to show.
const SCREENSHOTS = [
  { label: 'Pick selection', tag: 'Picks',
    body: ['Top Tier #1', 'Top Tier #2', 'Dark Horse #1', 'Dark Horse #2'],
    accent: 'var(--green-mid)' },
  { label: 'Live leaderboard', tag: 'Leaderboard',
    body: ['1   Tyler M.   −14', '2   Greg C.    −11', '3   Jon P.     −9', '4   Marge K.   −7'],
    accent: 'var(--brass)' },
  { label: 'Season standings', tag: 'Season',
    body: ['8 events played', '3 first-place finishes', '−42 to par overall', 'Tied for 2nd in club'],
    accent: 'var(--green-deep)' },
];

const TESTIMONIALS = [
  { quote: 'We finally killed our spreadsheet. Foursome lock-in Thursday morning, leaderboard updates Sunday afternoon — that\'s it.',
    by: 'Group of 8, weekend foursome', placeholder: true },
  { quote: 'Cut rule + dark-horse split makes it feel like a real strategy game, not just "did your guy win the tournament."',
    by: 'Office league, 14 players', placeholder: true },
  { quote: 'The Group Chat won\'t shut up about the leaderboard now. Worth it.',
    by: 'Brothers + cousins, 6 players', placeholder: true },
];

// Format strokes-to-par for display ("E", "−4", "+2")
function fmt(n: number): string {
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

export default function HomePage() {
  return (
    <div className="page-shell">
      <nav className="nav">
        <div className="nav-inner">
          <a href="/" className="nav-logo">Fairway <span>Fantasy</span></a>
          <div className="nav-actions">
            <Link href="/auth/signin" className="btn btn-ghost btn-sm" style={{ color: 'rgba(255,255,255,0.7)' }}>Sign In</Link>
            <Link href="/auth/signup" className="btn btn-brass btn-sm">Get Started</Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section style={{
        background: 'linear-gradient(155deg, #1a2f1e 0%, #2d5a34 55%, #3a7040 100%)',
        color: 'white', padding: 'clamp(4rem,10vw,7rem) 1.25rem',
        textAlign: 'center', position: 'relative', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'radial-gradient(ellipse at 25% 60%, rgba(184,146,74,0.15) 0%, transparent 55%), radial-gradient(ellipse at 75% 30%, rgba(74,140,84,0.12) 0%, transparent 50%)',
          pointerEvents: 'none',
        }} />
        <div style={{ position: 'relative', maxWidth: 760, margin: '0 auto' }}>
          <div style={{
            display: 'inline-block', background: 'rgba(184,146,74,0.18)',
            border: '1px solid rgba(184,146,74,0.45)', borderRadius: 20,
            padding: '0.3rem 1.1rem', fontSize: '0.72rem', fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: '#d4b06a', marginBottom: '1.75rem',
          }}>
            ⛳ Free · Private · No Ads
          </div>
          <h1 style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 'clamp(2.6rem, 8vw, 5.5rem)', fontWeight: 900,
            lineHeight: 1.0, marginBottom: '1.25rem', letterSpacing: '-0.02em',
          }}>
            Pick Your <span style={{ color: '#d4b06a' }}>Foursome.</span><br />
            Beat Your Buddies.
          </h1>
          <p style={{ fontSize: 'clamp(0.98rem, 2.2vw, 1.18rem)', color: 'rgba(255,255,255,0.78)',
                      marginBottom: '2.5rem', lineHeight: 1.65,
                      maxWidth: 580, margin: '0 auto 2.5rem' }}>
            Private fantasy golf for your group. Pick 4 golfers per tournament — top 3 count.
            PGA Tour, all four Majors, live ESPN scoring every 10 minutes.
          </p>
          <div style={{ display: 'flex', gap: '0.85rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/auth/signup" className="btn btn-brass btn-lg" aria-label="Create a new league">
              Create a League →
            </Link>
            <a href="#demo-preview" className="btn btn-outline-white btn-lg" aria-label="View the demo league preview below">
              View Demo League
            </a>
          </div>
          <p style={{ marginTop: '2rem', fontSize: '0.78rem', color: 'rgba(255,255,255,0.45)' }}>
            No credit card. No paywall. Self-hostable. Open source.
          </p>
        </div>
      </section>

      {/* ── Demo leaderboard preview ──────────────────────────── */}
      {/* Inline taste of what the product looks like — same .lb-table
          styles as a real league page so visitors see the actual UI. */}
      <section id="demo-preview" style={{ padding: 'clamp(3rem,8vw,5rem) 1.25rem', background: 'white' }}>
        <div className="container" style={{ maxWidth: 880 }}>
          <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
            <span className="badge badge-live" style={{ marginBottom: '0.85rem' }}>🔴 Live preview</span>
            <h2 style={{ fontFamily: "'Playfair Display', serif",
                         fontSize: 'clamp(1.8rem,4vw,2.4rem)', marginBottom: '0.5rem' }}>
              See it in action
            </h2>
            <p style={{ color: 'var(--slate-mid)', fontSize: '1rem', maxWidth: 560, margin: '0 auto' }}>
              Sample leaderboard from a 6-player league mid-tournament. Real leagues update from ESPN every 10 minutes Thu–Sun.
            </p>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '1.1rem 1.4rem', background: 'var(--green-deep)', color: 'white',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <div className="major-badge" style={{ marginBottom: '0.3rem' }}>🏆 Major Championship</div>
                <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.15rem', fontWeight: 700 }}>
                  The Masters · Round 3
                </h3>
              </div>
              <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.78rem' }}>
                Cut: +3 · Last sync: 2 min ago
              </span>
            </div>
            <table className="lb-table">
              <thead>
                <tr>
                  <th style={{ width: 56 }}>#</th>
                  <th>Player</th>
                  <th className="hide-mobile">Top 3 Counting</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {DEMO_LEADERBOARD.map((row) => (
                  <tr key={row.rank} className={`rank-${row.rank}`}>
                    <td><span className="rank-num">{row.rank}</span></td>
                    <td><strong style={{ fontSize: '0.95rem' }}>{row.name}</strong></td>
                    <td className="hide-mobile" style={{ fontSize: '0.78rem', color: 'var(--slate-mid)' }}>
                      {row.picks.slice(0, 3).join(' · ')}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <strong className={row.score < 0 ? 'score-under' : row.score > 0 ? 'score-over' : 'score-even'}>
                        {fmt(row.score)}
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ textAlign: 'center', marginTop: '1.25rem', fontSize: '0.85rem', color: 'var(--slate-mid)' }}>
            Sample data. Your league looks the same — minus the sample names.
          </p>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────── */}
      <section style={{ padding: 'clamp(3rem,8vw,5rem) 1.25rem', background: 'var(--cream)' }}>
        <div className="container" style={{ maxWidth: 860 }}>
          <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
            <h2 style={{ fontFamily: "'Playfair Display', serif",
                         fontSize: 'clamp(1.8rem,4vw,2.4rem)', marginBottom: '0.5rem' }}>
              How it works
            </h2>
            <p style={{ color: 'var(--slate-mid)', fontSize: '1rem' }}>
              Up and running in 3 minutes.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {HOW_IT_WORKS.map(step => (
              <div key={step.n} className="card" style={{
                display: 'flex', gap: '1.25rem', alignItems: 'flex-start',
                background: 'white', borderColor: 'var(--cream-dark)',
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--green-deep)', color: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: "'Playfair Display', serif", fontSize: '1.2rem', fontWeight: 900,
                }}>{step.n}</div>
                <div style={{ paddingTop: '0.4rem' }}>
                  <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: '1.1rem',
                               marginBottom: '0.25rem', fontWeight: 700 }}>
                    {step.t}
                  </h3>
                  <p style={{ color: 'var(--slate-mid)', fontSize: '0.92rem', lineHeight: 1.6 }}>
                    {step.d}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Rules ─────────────────────────────────────────────── */}
      <section style={{ padding: 'clamp(3rem,8vw,5rem) 1.25rem', background: 'white' }}>
        <div className="container">
          <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
            <h2 style={{ fontFamily: "'Playfair Display', serif",
                         fontSize: 'clamp(1.8rem,4vw,2.4rem)', marginBottom: '0.5rem' }}>
              Simple rules. Real stakes.
            </h2>
            <p style={{ color: 'var(--slate-mid)', fontSize: '1rem' }}>
              Everything you need to know in 30 seconds.
            </p>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '1.1rem',
          }}>
            {RULES.map(r => (
              <div key={r.title} className="card card-hover" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '2rem', marginBottom: '0.85rem' }}>{r.icon}</div>
                <h3 style={{ fontFamily: "'Playfair Display', serif",
                             fontSize: '1.05rem', marginBottom: '0.5rem' }}>
                  {r.title}
                </h3>
                <p style={{ fontSize: '0.875rem', color: 'var(--slate-mid)', lineHeight: 1.6 }}>
                  {r.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Product screenshots / placeholder cards ──────────── */}
      <section style={{ padding: 'clamp(3rem,8vw,5rem) 1.25rem', background: 'var(--cream)' }}>
        <div className="container">
          <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
            <h2 style={{ fontFamily: "'Playfair Display', serif",
                         fontSize: 'clamp(1.8rem,4vw,2.4rem)', marginBottom: '0.5rem' }}>
              Built for your phone
            </h2>
            <p style={{ color: 'var(--slate-mid)', fontSize: '1rem', maxWidth: 540, margin: '0 auto' }}>
              Pick golfers from the parking lot. Check leaderboards from the 9th tee. No app to install.
            </p>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '1.25rem',
          }}>
            {SCREENSHOTS.map((s) => (
              <div key={s.label} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {/* Placeholder phone screenshot — SVG will be swapped for
                    real screenshots once the demo league is live. */}
                <div style={{
                  background: `linear-gradient(180deg, ${s.accent} 0%, var(--green-deep) 100%)`,
                  padding: '1.5rem 1.25rem', color: 'white', minHeight: 180,
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                }}>
                  <div style={{
                    fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.12em',
                    textTransform: 'uppercase', opacity: 0.65,
                  }}>{s.tag}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem',
                                fontSize: '0.85rem', fontFamily: 'monospace',
                                background: 'rgba(0,0,0,0.18)', padding: '0.85rem',
                                borderRadius: 'var(--radius-sm)' }}>
                    {s.body.map((line, i) => (
                      <div key={i} style={{ opacity: 0.9 }}>{line}</div>
                    ))}
                  </div>
                </div>
                <div style={{ padding: '1rem 1.25rem', background: 'white' }}>
                  <h3 style={{ fontFamily: "'Playfair Display', serif",
                               fontSize: '1rem', fontWeight: 700, marginBottom: '0.25rem' }}>
                    {s.label}
                  </h3>
                  <p style={{ color: 'var(--slate-mid)', fontSize: '0.82rem', lineHeight: 1.55 }}>
                    Mobile-first layout. Tap to interact. No clutter.
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Social proof (placeholder) ────────────────────────── */}
      <section style={{ padding: 'clamp(3rem,8vw,5rem) 1.25rem', background: 'white' }}>
        <div className="container" style={{ maxWidth: 1080 }}>
          <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
            <h2 style={{ fontFamily: "'Playfair Display', serif",
                         fontSize: 'clamp(1.8rem,4vw,2.4rem)', marginBottom: '0.5rem' }}>
              Built for groups that take it seriously
            </h2>
            <p style={{ color: 'var(--slate-mid)', fontSize: '0.95rem',
                        maxWidth: 540, margin: '0 auto' }}>
              Sample testimonials from early test groups — real ones land here once we ship.
            </p>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1.25rem',
          }}>
            {TESTIMONIALS.map((t, i) => (
              <div key={i} className="card" style={{ position: 'relative' }}>
                {t.placeholder && (
                  <span className="badge badge-gray"
                        style={{ position: 'absolute', top: '0.85rem', right: '0.85rem' }}>
                    Placeholder
                  </span>
                )}
                <div style={{
                  fontSize: '2.5rem', color: 'var(--brass)',
                  fontFamily: "'Playfair Display', serif",
                  lineHeight: 0.5, marginBottom: '0.75rem',
                }}>
                  &ldquo;
                </div>
                <p style={{ fontSize: '0.92rem', color: 'var(--slate)', lineHeight: 1.65,
                            marginBottom: '1rem' }}>
                  {t.quote}
                </p>
                <p style={{ fontSize: '0.78rem', color: 'var(--slate-mid)',
                            fontWeight: 600, letterSpacing: '0.02em' }}>
                  — {t.by}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <section style={{
        padding: 'clamp(3rem,8vw,5rem) 1.25rem',
        background: 'linear-gradient(135deg, var(--green-deep) 0%, var(--green-mid) 100%)',
        color: 'white', textAlign: 'center',
      }}>
        <div className="container" style={{ maxWidth: 640 }}>
          <h2 style={{ fontFamily: "'Playfair Display', serif",
                       fontSize: 'clamp(1.8rem,5vw,2.6rem)', marginBottom: '0.75rem' }}>
            Your group. Your rules. Your foursome.
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '1rem',
                      marginBottom: '2rem', maxWidth: 480, margin: '0 auto 2rem' }}>
            Spin up a league in under 3 minutes. Send the invite link.
            First picks lock Thursday morning.
          </p>
          <div style={{ display: 'flex', gap: '0.85rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/auth/signup" className="btn btn-brass btn-lg">
              Start Your League →
            </Link>
            <a href="#demo-preview" className="btn btn-outline-white btn-lg">
              See the Demo
            </a>
          </div>
        </div>
      </section>

      <footer style={{
        background: '#0d1c10', color: 'rgba(255,255,255,0.45)',
        padding: '2rem 1.5rem', textAlign: 'center', fontSize: '0.82rem',
      }}>
        <p>Fairway Fantasy · Free forever · Built for golf groups</p>
        <p style={{ marginTop: '0.4rem' }}>
          Scores powered by ESPN public data. Not affiliated with PGA Tour or ESPN.
        </p>
      </footer>
    </div>
  );
}
