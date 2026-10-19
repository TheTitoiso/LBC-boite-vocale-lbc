import { describe, expect, it } from 'vitest';
import { formatPhone, maskPhone, normalizePhone } from '../src/lib/phone.ts';

describe('normalizePhone', () => {
  it.each([
    ['+14505551234', '+14505551234'],
    ['4505551234', '+14505551234'],
    ['14505551234', '+14505551234'],
    ['1-450-555-1234', '+14505551234'],
    ['(450) 555-1234', '+14505551234'],
    ['+1 450 555 1234', '+14505551234'],
    ['+33612345678', '+33612345678'],
    ['+41792654125', '+41792654125'],
    ['  +14505551234  ', '+14505551234'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    ['anonymous'],
    ['Anonymous'],
    ['restricted'],
    ['unknown'],
    ['+266696687'],
    ['+86282452253'],
    ['+8656696'],
    ['+7378742833'],
    [''],
    ['   '],
    ['client:alice'],
    ['sip:alice@example.com'],
    ['12345'],
    ['+1450555123456789'],
  ])('%s est masqué ou inutilisable', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });

  it('accepte null et undefined', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('formatPhone', () => {
  it('Amérique du Nord : +1 450-555-1234', () => {
    expect(formatPhone('+14505551234')).toBe('+1 450-555-1234');
  });

  it('ailleurs : format international', () => {
    expect(formatPhone('+33612345678')).toBe('+33 6 12 34 56 78');
  });
});

describe('maskPhone', () => {
  it('garde l’indicatif et les 4 derniers chiffres', () => {
    expect(maskPhone('+14505551234')).toBe('+1450***1234');
    expect(maskPhone('+33612345678')).toBe('+3361***5678');
  });

  it('numéro absent ou trop court', () => {
    expect(maskPhone(null)).toBe('(aucun)');
    expect(maskPhone('12345')).toBe('***');
  });
});
