import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Valeurs que Twilio (ou l'opérateur) met dans `From` quand l'appelant masque son numéro.
 * Les numéros « + » sont les mots ANONYMOUS, UNAVAILABLE, UNKNOWN et RESTRICTED tapés sur un clavier.
 */
const ANONYMOUS_VALUES = new Set([
  'anonymous',
  'restricted',
  'unavailable',
  'unknown',
  'private',
  '+266696687',
  '+86282452253',
  '+8656696',
  '+7378742833',
]);

/**
 * Normalise un numéro en E.164 (`+14505551234`). Renvoie `null` pour un numéro masqué, vide ou
 * inutilisable (adresse SIP, client Twilio, chiffres en trop ou en moins).
 *
 * On vérifie que le numéro est *possible* (bonne longueur pour son pays) plutôt que *valide* : la
 * validité dépend des métadonnées de libphonenumber, qui peuvent ignorer un nouvel indicatif
 * régional. Perdre le vrai numéro d'un appelant serait pire que de garder un numéro douteux.
 */
export function normalizePhone(raw: string | null | undefined, defaultRegion: CountryCode = 'CA'): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (ANONYMOUS_VALUES.has(value.toLowerCase())) return null;
  if (/[a-z@:]/i.test(value)) return null;

  const parsed = parsePhoneNumberFromString(value, defaultRegion);
  if (!parsed || !parsed.isPossible()) return null;
  const e164 = parsed.number;
  return ANONYMOUS_VALUES.has(e164) ? null : e164;
}

/** Affichage pour les humains : `+1 450-555-1234` en Amérique du Nord, format international ailleurs. */
export function formatPhone(e164: string): string {
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (nanp) return `+1 ${nanp[1]}-${nanp[2]}-${nanp[3]}`;
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}

/** Masquage pour les journaux : `+1450***1234`. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '(aucun)';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '***';
  return `+${digits.slice(0, 4)}***${digits.slice(-4)}`;
}
