// Tests for the tournament-recap email template.
//
// The template is the contract: callers in sync.ts pass standings +
// best round + an optional season snapshot, and the template renders
// subject + plain text + HTML. These tests pin the rendered output
// for the obvious shapes without locking down whitespace.

import { describe, it, expect } from 'vitest';
import {
  tournamentRecapEmail,
  type TournamentRecapLeaderboardRow,
  type TournamentRecapBestRound,
  type TournamentRecapSeasonRow,
} from '@/lib/email';

const baseLeaderboard: TournamentRecapLeaderboardRow[] = [
  { rank: 1, displayName: 'Rory McLeague',  totalScore: -8, isMe: false },
  { rank: 2, displayName: 'Nick Lucca',     totalScore: -3, isMe: true  },
  { rank: 3, displayName: 'Joel Dahmen Jr', totalScore:  4, isMe: false },
];

const baseBestRound: TournamentRecapBestRound = {
  roundNum: 3, score: -6, golfer: 'Scottie Scheffler',
};

const baseSeason: TournamentRecapSeasonRow[] = [
  { rank: 1, displayName: 'Rory McLeague',  totalScore: -22, tournamentsPlayed: 4, isMe: false },
  { rank: 2, displayName: 'Nick Lucca',     totalScore: -10, tournamentsPlayed: 4, isMe: true  },
  { rank: 3, displayName: 'Joel Dahmen Jr', totalScore:   8, tournamentsPlayed: 3, isMe: false },
];

function makeInput(over: Partial<Parameters<typeof tournamentRecapEmail>[0]> = {}) {
  return {
    displayName:    'Nick Lucca',
    leagueName:     'GMN Test',
    leagueSlug:     'gmn-test',
    tournamentName: 'the Memorial Tournament pres. by Workday',
    leaderboard:    baseLeaderboard,
    bestRound:      baseBestRound,
    seasonStandings: baseSeason,
    siteUrl:        'https://fairwayfantasy.example',
    ...over,
  };
}

describe('tournamentRecapEmail', () => {
  it('renders subject, text, and html for a full payload', () => {
    const { subject, text, html } = tournamentRecapEmail(makeInput());

    expect(subject).toContain('Memorial Tournament');
    expect(subject).toContain('GMN Test');

    // Text body
    expect(text).toContain('Hi Nick Lucca,');
    expect(text).toContain('FINAL STANDINGS');
    expect(text).toContain('Rory McLeague');
    expect(text).toContain('-8');
    expect(text).toContain('← you');                  // recipient marker
    expect(text).toContain('Your best round: R3');
    expect(text).toContain('Scottie Scheffler');
    expect(text).toContain('SEASON STANDINGS');
    expect(text).toContain('https://fairwayfantasy.example/league/gmn-test');

    // HTML body
    expect(html).toContain('<table');
    expect(html).toContain('Rory McLeague');
    expect(html).toContain('Scottie Scheffler');
    expect(html).toContain('Season standings');
    expect(html).toContain('View full leaderboard');
    expect(html).toContain('href="https://fairwayfantasy.example/league/gmn-test"');
  });

  it('omits the best-round block when no rounds posted', () => {
    const { text, html } = tournamentRecapEmail(makeInput({ bestRound: null }));
    expect(text).not.toContain('Your best round');
    expect(html).not.toContain('Your best round');
  });

  it('omits the season-snapshot section when seasonStandings is null', () => {
    const { text, html } = tournamentRecapEmail(makeInput({ seasonStandings: null }));
    expect(text).not.toContain('SEASON STANDINGS');
    expect(html).not.toContain('Season standings');
  });

  it('omits the season-snapshot section when seasonStandings is empty', () => {
    const { text, html } = tournamentRecapEmail(makeInput({ seasonStandings: [] }));
    expect(text).not.toContain('SEASON STANDINGS');
    expect(html).not.toContain('Season standings');
  });

  it('handles a null total_score gracefully (renders em dash)', () => {
    const lb: TournamentRecapLeaderboardRow[] = [
      { rank: 1, displayName: 'Rory McLeague', totalScore: -8,   isMe: false },
      { rank: 2, displayName: 'Did Not Play',  totalScore: null, isMe: false },
    ];
    const { text, html } = tournamentRecapEmail(makeInput({ leaderboard: lb }));
    expect(text).toContain('Did Not Play');
    expect(text).toContain('—');                       // em dash for null
    expect(html).toContain('Did Not Play');
  });

  it('formats positive scores with a leading + sign', () => {
    const lb: TournamentRecapLeaderboardRow[] = [
      { rank: 1, displayName: 'Rory McLeague', totalScore: 4, isMe: false },
    ];
    const { text, html } = tournamentRecapEmail(makeInput({ leaderboard: lb, bestRound: null }));
    expect(text).toContain('+4');
    expect(html).toContain('+4');
  });

  it('escapes HTML in user-provided strings', () => {
    const lb: TournamentRecapLeaderboardRow[] = [
      { rank: 1, displayName: '<script>alert(1)</script>', totalScore: -3, isMe: false },
    ];
    const { html } = tournamentRecapEmail(makeInput({
      leaderboard: lb,
      tournamentName: 'X<&>"Y',
      bestRound: null,
    }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('X&lt;&amp;&gt;&quot;Y');
  });
});
