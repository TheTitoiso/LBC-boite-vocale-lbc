import { describe, expect, it } from 'vitest';
import { extractDictatedEmail } from '../src/lib/dictation.ts';

describe('extractDictatedEmail', () => {
  it.each([
    ['vous pouvez m’écrire à marie point tremblay arobase gmail point com. Merci', 'marie.tremblay@gmail.com'],
    ['à marie point tremblay, arobase, gmail point com', 'marie.tremblay@gmail.com'],
    ['mon courriel c’est Marie.Tremblay@Gmail.com.', 'marie.tremblay@gmail.com'],
    ['jean tiret pierre arobase videotron point ca', 'jean-pierre@videotron.ca'],
    ['marie tiret bas t arobase hotmail point fr', 'marie_t@hotmail.fr'],
    ['écrivez à info arobase lesbellescombines point com', 'info@lesbellescombines.com'],
  ])('FR : %s', (transcript, expected) => {
    expect(extractDictatedEmail(transcript)).toBe(expected);
  });

  it.each([
    ['you can reach me at john dot smith at gmail dot com thanks', 'john.smith@gmail.com'],
    ['email me at jsmith@outlook.com', 'jsmith@outlook.com'],
  ])('EN : %s', (transcript, expected) => {
    expect(extractDictatedEmail(transcript, 'en')).toBe(expected);
  });

  it.each([
    ['Bonjour, rappelez-moi au même numéro.'],
    ['Le point important, c’est la livraison.'],
    ['call me at home at five'],
  ])('aucun courriel : %s', (transcript) => {
    expect(extractDictatedEmail(transcript, transcript.startsWith('call') ? 'en' : 'fr')).toBeNull();
  });
});
