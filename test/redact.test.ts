import { describe, expect, it } from 'vitest';
import { redactBody, redactText } from '../src/lib/redact.ts';

describe('redactText', () => {
  it('masque les courriels', () => {
    expect(redactText('contact marie.tremblay@example.com déjà pris')).toBe('contact [courriel] déjà pris');
  });

  it('masque les numéros de téléphone', () => {
    expect(redactText('Phone number +14505551234 has already been taken')).toBe(
      'Phone number +1450***1234 has already been taken',
    );
    expect(redactText('appel de (450) 555-1234')).toBe('appel de +1450***1234');
    expect(redactText('ID 123456789012345678')).toBe('ID 123456789012345678');
  });

  it('ne garde que l’origine des URL', () => {
    expect(redactText('GET https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3 échoué')).toBe(
      'GET https://api.twilio.com/[…] échoué',
    );
  });

  it('laisse les petits nombres tranquilles', () => {
    expect(redactText('conversation 12345, inbox 678')).toBe('conversation 12345, inbox 678');
  });
});

describe('redactBody', () => {
  it('coupe les corps trop longs', () => {
    expect(redactBody('x'.repeat(400), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});
