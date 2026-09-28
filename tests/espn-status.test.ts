// ESPN per-golfer status (core API) — adopted 2026-09-28. Fixtures are
// the real responses probed that day for completed 2026 events.

import { describe, it, expect } from 'vitest';
import {
  parseCompetitorStatus, competitorStatusToken, deriveCutLine, mapESPNStatus,
} from '@/lib/espn';

const raw = {
  missedCut:  { type: { name: 'STATUS_CUT', state: 'post', completed: false, description: 'Missed Cut' },
                position: { displayName: '-' }, period: 2, hole: 18 },                 // 3M Open, Putnam
  wdEarly:    { type: { name: 'STATUS_CUT', state: 'post', completed: false, description: 'Withdrawn' },
                position: { displayName: '-' }, period: 1 },                           // TOUR Champ, Spaun
  wdAfterR2:  { type: { name: 'STATUS_CUT', state: 'post', completed: false, description: 'Withdrawn' },
                position: { displayName: '-' }, period: 2 },                           // St. Jude, MacIntyre
  finish:     { type: { name: 'STATUS_FINISH', state: 'post', completed: true, description: 'Finish' },
                position: { displayName: 'T58' }, period: 4, thru: 18 },               // St. Jude, Fox
};

describe('parseCompetitorStatus', () => {
  it('reads type, description, period, position, thru', () => {
    expect(parseCompetitorStatus(raw.finish)).toEqual({
      typeName: 'STATUS_FINISH', description: 'Finish', period: 4, position: 'T58', thru: 18,
    });
  });
  it('"-" position becomes null; junk returns null', () => {
    expect(parseCompetitorStatus(raw.missedCut)?.position).toBeNull();
    expect(parseCompetitorStatus(null)).toBeNull();
    expect(parseCompetitorStatus({ foo: 1 })).toBeNull();
  });
});

describe('competitorStatusToken', () => {
  const tok = (r: unknown) => competitorStatusToken(parseCompetitorStatus(r)!);
  it('missed cut → cut', () => expect(tok(raw.missedCut)).toBe('cut'));
  it('STATUS_CUT + "Withdrawn" is a withdrawal, not a missed cut', () => {
    expect(tok(raw.wdEarly)).toBe('wd');
    expect(tok(raw.wdAfterR2)).toBe('wd');
  });
  it('withdrawal after making the cut (round 3+) is still a withdrawal (dropout rule)', () => {
    expect(tok({ ...raw.wdAfterR2, period: 3 })).toBe('wd_late');
    expect(mapESPNStatus('wd_late')).toBe('withdrawn');
  });
  it('finish → complete; in progress → active; DQ → dq', () => {
    expect(tok(raw.finish)).toBe('complete');
    expect(tok({ type: { name: 'STATUS_IN_PROGRESS', description: 'In Progress' }, period: 2, thru: 9 })).toBe('active');
    expect(tok({ type: { name: 'STATUS_CUT', description: 'Disqualified' }, period: 2 })).toBe('dq');
  });
  it('tokens map to the right stored status', () => {
    expect(mapESPNStatus('cut')).toBe('missed_cut');
    expect(mapESPNStatus('wd')).toBe('withdrawn');
    expect(mapESPNStatus('mdf')).toBe('active');
    expect(mapESPNStatus('dq')).toBe('disqualified');
    expect(mapESPNStatus('complete')).toBe('complete');
  });
  it('mapESPNStatus now accepts the full words too', () => {
    expect(mapESPNStatus('withdrawn')).toBe('withdrawn');
    expect(mapESPNStatus('disqualified')).toBe('disqualified');
  });
});

describe('deriveCutLine (to par)', () => {
  it('worst 36-hole score among golfers who made the cut', () => {
    expect(deriveCutLine([
      { token: 'complete', r1: -3, r2: -2 },
      { token: 'active',   r1: 1,  r2: 2 },   // made it at +3
      { token: 'cut',      r1: 2,  r2: 3 },   // missed at +5
      { token: 'wd',       r1: 5,  r2: 9 },   // ignored
    ])).toBe(3);
  });
  it('no-cut event (nobody STATUS_CUT) → null, so no fake cap', () => {
    expect(deriveCutLine([
      { token: 'complete', r1: -3, r2: -2 },
      { token: 'complete', r1: 5,  r2: 7 },
    ])).toBeNull();
  });
  it('golfers who withdrew after making the cut still count toward the line', () => {
    expect(deriveCutLine([
      { token: 'wd_late', r1: 3, r2: 1 },
      { token: 'cut', r1: 4, r2: 4 },
    ])).toBe(4);
  });
});
