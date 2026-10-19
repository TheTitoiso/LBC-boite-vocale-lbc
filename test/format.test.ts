import { describe, expect, it } from 'vitest';
import { formatDuration, formatLongDate, formatReceivedAt } from '../src/lib/format.ts';

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [3, '0:03'],
    [47, '0:47'],
    [60, '1:00'],
    [125, '2:05'],
    [180, '3:00'],
    [46.6, '0:47'],
  ])('%s s → %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('dates (heure de Toronto)', () => {
  const afternoon = new Date('2026-10-19T18:32:00Z'); // 14 h 32 à Montréal (UTC-4)

  it('note privée : 19 oct. 2026 à 14 h 32', () => {
    expect(formatReceivedAt(afternoon)).toBe('19 oct. 2026 à 14 h 32');
  });

  it('sujet du courriel : 19 octobre 2026', () => {
    expect(formatLongDate(afternoon)).toBe('19 octobre 2026');
    expect(formatLongDate(afternoon, 'en')).toBe('October 19, 2026');
  });

  it('le premier du mois : 1er', () => {
    expect(formatLongDate(new Date('2026-05-01T16:00:00Z'))).toBe('1er mai 2026');
  });

  it('après 20 h à Montréal, la date UTC est déjà le lendemain', () => {
    expect(formatLongDate(new Date('2026-10-20T01:30:00Z'))).toBe('19 octobre 2026');
  });
});
