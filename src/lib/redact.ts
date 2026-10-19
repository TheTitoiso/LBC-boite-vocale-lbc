import { maskPhone, normalizePhone } from './phone.ts';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Suites de 10 à 15 chiffres, avec ou sans « + », espaces, points, tirets ou parenthèses.
const PHONE = /[+(]?\d[\d\s().-]{8,18}\d/g;
// Les URL de médias Twilio et Chatwoot donnent accès à l'audio : on n'en garde que l'hôte.
const URL = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Masque les courriels, numéros de téléphone et URL dans un texte destiné aux journaux
 * (messages d'erreur, corps de réponse d'une API). Ne sert pas à protéger un texte affiché à un humain.
 */
export function redactText(text: string): string {
  return text
    .replace(URL, (url) => {
      try {
        return `${new globalThis.URL(url).origin}/[…]`;
      } catch {
        return '[url]';
      }
    })
    .replace(EMAIL, '[courriel]')
    .replace(PHONE, (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return match;
      const e164 = normalizePhone(match);
      return e164 ? maskPhone(e164) : `***${digits.slice(-4)}`;
    });
}

/** Version courte et masquée d'un corps de réponse, pour un message d'erreur. */
export function redactBody(body: string, maxLength = 300): string {
  const redacted = redactText(body.replace(/\s+/g, ' ').trim());
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
