'use client';

// Seasons + season bets editor (migration 027). Shared by the create
// form and the admin League Rules card so the two can't drift.

type BetKey = 'team' | 'topTier' | 'darkHorse' | 'ace';

export interface SeasonBetsValue {
  seasonCount:  number;
  bets:         Record<BetKey, { on: boolean; amount: string }>;
  addPenalties: boolean;
}

export const DEFAULT_SEASON_BETS: SeasonBetsValue = {
  seasonCount: 1,
  bets: {
    team:      { on: false, amount: '10' },
    topTier:   { on: false, amount: '10' },
    darkHorse: { on: false, amount: '10' },
    ace:       { on: false, amount: '5' },
  },
  addPenalties: false,
};

type Money = string | number | null | undefined;

export function seasonBetsFromLeague(l: {
  season_count?: number | null;
  bet_team_cumulative?: Money; bet_top_tier_cumulative?: Money;
  bet_dark_horse_cumulative?: Money; bet_ace_bounty?: Money;
  bets_add_penalties?: boolean | null;
}): SeasonBetsValue {
  const b = (v: Money, dflt: string) => ({
    on: v != null, amount: v != null ? Number(v).toFixed(2) : dflt,
  });
  return {
    seasonCount: l.season_count ?? 1,
    bets: {
      team:      b(l.bet_team_cumulative, '10'),
      topTier:   b(l.bet_top_tier_cumulative, '10'),
      darkHorse: b(l.bet_dark_horse_cumulative, '10'),
      ace:       b(l.bet_ace_bounty, '5'),
    },
    addPenalties: !!l.bets_add_penalties,
  };
}

/** API payload: off bets are null. Unparseable amounts become NaN so validation rejects them. */
export function seasonBetsPayload(v: SeasonBetsValue) {
  const amt = (k: BetKey) => (v.bets[k].on ? parseFloat(v.bets[k].amount) : null);
  const anyCumulative = v.bets.team.on || v.bets.topTier.on || v.bets.darkHorse.on;
  return {
    seasonCount:            v.seasonCount,
    betTeamCumulative:      amt('team'),
    betTopTierCumulative:   amt('topTier'),
    betDarkHorseCumulative: amt('darkHorse'),
    betAceBounty:           amt('ace'),
    betsAddPenalties:       anyCumulative && v.addPenalties,
  };
}

const ROWS: Array<{ key: BetKey; label: string; unit: string; hint: string }> = [
  { key: 'team',      label: 'Best cumulative team',       unit: 'per player, per season',
    hint: 'Every golfer on the team, all tournaments in the season (6 golfers on 6-man majors).' },
  { key: 'topTier',   label: 'Best cumulative top tier',   unit: 'per player, per season',
    hint: 'Top-tier golfers only.' },
  { key: 'darkHorse', label: 'Best cumulative dark horse', unit: 'per player, per season',
    hint: 'Dark-horse golfers only.' },
  { key: 'ace',       label: 'Hole-in-one bounty',         unit: 'per ace',
    hint: 'When a golfer on your team makes an ace, every other player pays you this.' },
];

export default function SeasonBetsFields({ value, onChange, readOnly }: {
  value:     SeasonBetsValue;
  onChange?: (v: SeasonBetsValue) => void;
  readOnly?: boolean;
}) {
  const set = (patch: Partial<SeasonBetsValue>) => onChange?.({ ...value, ...patch });
  const setBet = (k: BetKey, patch: Partial<{ on: boolean; amount: string }>) =>
    set({ bets: { ...value.bets, [k]: { ...value.bets[k], ...patch } } });
  const anyCumulative = value.bets.team.on || value.bets.topTier.on || value.bets.darkHorse.on;

  if (readOnly) {
    const on = ROWS.filter(r => value.bets[r.key].on);
    return (
      <div style={{ fontSize: '0.88rem', lineHeight: 1.7 }}>
        <div>{value.seasonCount} season{value.seasonCount === 1 ? '' : 's'}</div>
        {on.length === 0
          ? <div style={{ color: 'var(--slate-mid)' }}>No season bets</div>
          : on.map(r => (
              <div key={r.key}>{r.label}: ${Number(value.bets[r.key].amount).toFixed(2)} {r.unit}</div>
            ))}
        {anyCumulative && (
          <div style={{ color: 'var(--slate-mid)' }}>
            Penalties {value.addPenalties ? 'added' : 'not added'} to cumulative scores
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.9rem' }}>
        <span style={{ fontWeight: 600 }}>Seasons</span>
        <select value={value.seasonCount} onChange={e => set({ seasonCount: Number(e.target.value) })}
                style={{ padding: '0.3rem 0.5rem', fontSize: '0.9rem' }}>
          {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="hint" style={{ margin: 0 }}>
          Tournaments split evenly into this many seasons; season bets pay out at the end of each.
        </span>
      </label>

      {ROWS.map(r => (
        <div key={r.key} style={{
          border: `1px solid ${value.bets[r.key].on ? 'var(--green-mid)' : 'var(--cream-dark)'}`,
          borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.75rem',
          background: value.bets[r.key].on ? 'var(--green-pale)' : 'white',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 600, fontSize: '0.9rem', flex: '1 1 200px' }}>
              <input type="checkbox" checked={value.bets[r.key].on}
                     onChange={e => setBet(r.key, { on: e.target.checked })} />
              {r.label}
            </label>
            {value.bets[r.key].on && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.88rem' }}>
                $
                <input type="number" min={0} step={0.01} inputMode="decimal"
                       value={value.bets[r.key].amount}
                       onChange={e => setBet(r.key, { amount: e.target.value })}
                       aria-label={`${r.label} amount`}
                       style={{ width: '6rem', padding: '0.25rem 0.4rem', fontFamily: 'monospace' }} />
                <span style={{ color: 'var(--slate-mid)' }}>{r.unit}</span>
              </span>
            )}
          </div>
          <p className="hint" style={{ margin: '0.25rem 0 0' }}>{r.hint}</p>
        </div>
      ))}

      {anyCumulative && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.45rem', fontSize: '0.88rem' }}>
          <input type="checkbox" checked={value.addPenalties}
                 onChange={e => set({ addPenalties: e.target.checked })} style={{ marginTop: '0.2rem' }} />
          <span>
            <strong>Add penalties to cumulative scores</strong>
            <span className="hint" style={{ display: 'block', margin: 0 }}>
              Adds the missed-cut penalty for each missed-cut golfer, and the missed-deadline penalty on
              the team bet. Missed-cut golfers always count at their score through the cut.
            </span>
          </span>
        </label>
      )}
      <p className="hint" style={{ margin: 0 }}>
        Every player bets the amount each season; the lowest total takes the whole pot (ties split it).
        Example: $10 with 20 players is a $200 pot — the winner nets +$190.
      </p>
    </div>
  );
}
