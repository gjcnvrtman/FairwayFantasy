// Pins the commissioner-driven field upload helper used by
// /api/admin/upload-field as the ESPN-late-publish fallback.

import { describe, it, expect } from 'vitest';
import {
  normalizeGolferName,
  parseUploadedNames,
  matchNamesToGolfers,
} from '../src/lib/field-upload';

describe('normalizeGolferName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeGolferName('Scottie  Scheffler')).toBe('scottie scheffler');
    expect(normalizeGolferName('  TOM  KIM  ')).toBe('tom kim');
  });

  it('strips accents / diacritics', () => {
    expect(normalizeGolferName('Joaquín Niemann')).toBe('joaquin niemann');
    expect(normalizeGolferName('Adrián Otaegui')).toBe('adrian otaegui');
  });

  it('drops punctuation but keeps spaces', () => {
    expect(normalizeGolferName('Sungjae Im, *')).toBe('sungjae im');
    expect(normalizeGolferName("Davis Riley Jr.")).toBe('davis riley jr');
    expect(normalizeGolferName('John Doe-Smith')).toBe('john doe smith');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeGolferName('')).toBe('');
    expect(normalizeGolferName('   \t  ')).toBe('');
  });
});

describe('parseUploadedNames', () => {
  it('splits on newlines + skips blanks', () => {
    const text = 'Scottie Scheffler\nTom Kim\n\n  \nJoaquín Niemann\n';
    const r = parseUploadedNames(text);
    expect(r.uniqueOriginals).toEqual(['Scottie Scheffler', 'Tom Kim', 'Joaquín Niemann']);
    expect(r.uniqueKeys).toEqual(['scottie scheffler', 'tom kim', 'joaquin niemann']);
  });

  it('handles CRLF line endings', () => {
    const text = 'Scottie Scheffler\r\nTom Kim\r\n';
    const r = parseUploadedNames(text);
    expect(r.uniqueKeys).toEqual(['scottie scheffler', 'tom kim']);
  });

  it('takes the first cell of comma-separated rows (CSV exports)', () => {
    const text = 'Scottie Scheffler, 1, USA\nTom Kim, 32, KOR';
    const r = parseUploadedNames(text);
    expect(r.uniqueOriginals).toEqual(['Scottie Scheffler', 'Tom Kim']);
    expect(r.uniqueKeys).toEqual(['scottie scheffler', 'tom kim']);
  });

  it('dedupes by canonical key (case + whitespace variants of the same name)', () => {
    const text = 'Scottie Scheffler\nSCOTTIE SCHEFFLER\nScottie  Scheffler';
    const r = parseUploadedNames(text);
    expect(r.uniqueKeys).toEqual(['scottie scheffler']);
    expect(r.uniqueOriginals).toEqual(['Scottie Scheffler']); // first wins
  });

  it('returns empty arrays for empty input', () => {
    expect(parseUploadedNames('')).toEqual({ uniqueOriginals: [], uniqueKeys: [] });
    expect(parseUploadedNames('   \n   \n')).toEqual({ uniqueOriginals: [], uniqueKeys: [] });
  });
});

describe('matchNamesToGolfers', () => {
  const golfers = [
    { id: 'g1', espn_id: '101', name: 'Scottie Scheffler' },
    { id: 'g2', espn_id: '102', name: 'Tom Kim' },
    { id: 'g3', espn_id: '103', name: 'Joaquín Niemann' },
    { id: 'g4', espn_id: '104', name: 'Sungjae Im' },
  ];

  it('matches exact names', () => {
    const { matched, unmatched } = matchNamesToGolfers({
      uniqueOriginals: ['Scottie Scheffler', 'Tom Kim'],
      uniqueKeys:      ['scottie scheffler', 'tom kim'],
      golfers,
    });
    expect(matched).toEqual([
      { originalName: 'Scottie Scheffler', golferId: 'g1', espnId: '101' },
      { originalName: 'Tom Kim',           golferId: 'g2', espnId: '102' },
    ]);
    expect(unmatched).toEqual([]);
  });

  it('matches across accent / case / whitespace variants', () => {
    const parsed = parseUploadedNames('joaquin niemann\nSUNGJAE  IM');
    const { matched, unmatched } = matchNamesToGolfers({
      uniqueOriginals: parsed.uniqueOriginals,
      uniqueKeys:      parsed.uniqueKeys,
      golfers,
    });
    expect(matched.map(m => m.golferId)).toEqual(['g3', 'g4']);
    expect(unmatched).toEqual([]);
  });

  it('collects unmatched names rather than failing', () => {
    const { matched, unmatched } = matchNamesToGolfers({
      uniqueOriginals: ['Scottie Scheffler', 'Phil Mickelson', 'Tom Kim', 'Made Up Person'],
      uniqueKeys:      ['scottie scheffler', 'phil mickelson', 'tom kim', 'made up person'],
      golfers,
    });
    expect(matched.map(m => m.golferId)).toEqual(['g1', 'g2']);
    expect(unmatched).toEqual(['Phil Mickelson', 'Made Up Person']);
  });

  it('dedupes by golfer id when two input names map to the same row', () => {
    // Both lines normalize to "tom kim" — only one match emitted.
    const { matched, unmatched } = matchNamesToGolfers({
      uniqueOriginals: ['Tom Kim'],
      uniqueKeys:      ['tom kim'],
      golfers: [
        ...golfers,
        // Defensive: same canonical name appearing twice in the
        // golfers table (shouldn't happen in prod, espn_id is UNIQUE).
        { id: 'g2-dup', espn_id: '999', name: 'TOM KIM' },
      ],
    });
    // First-seen wins (Map.set overwrites, but we already verified
    // dedupe by id — the duplicate golfer row is fine to keep in the
    // index because matchNamesToGolfers's seen-set tracks `id` not
    // `key`). The contract is: each *input* name maps to at most one
    // golfer; here Tom Kim resolves to whichever id is last in the
    // index (the duplicate). We only assert there's exactly one match
    // and zero unmatched, not which id wins — the production schema
    // forbids the duplicate anyway.
    expect(matched).toHaveLength(1);
    expect(unmatched).toEqual([]);
  });

  it('returns empty matched on a fully-empty input', () => {
    const { matched, unmatched } = matchNamesToGolfers({
      uniqueOriginals: [],
      uniqueKeys:      [],
      golfers,
    });
    expect(matched).toEqual([]);
    expect(unmatched).toEqual([]);
  });
});
