export type Lang = 'fr' | 'en';

export const TIME_ZONE = 'America/Toronto';

/** Durée d'un message : 47 → « 0:47 », 125 → « 2:05 ». */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Date et heure de réception, pour la note privée : « 19 oct. 2026 à 14 h 32 ». */
export function formatReceivedAt(date: Date): string {
  const day = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TIME_ZONE });
  const time = new Intl.DateTimeFormat('fr-CA', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });
  return `${firstOfMonth(day.format(date))} à ${time.format(date)}`;
}

/** Date longue : « 19 octobre 2026 », « 1er mai 2026 », “October 19, 2026”. */
export function formatLongDate(date: Date, lang: Lang = 'fr'): string {
  const locale = lang === 'fr' ? 'fr-CA' : 'en-CA';
  const formatted = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: TIME_ZONE }).format(
    date,
  );
  return lang === 'fr' ? firstOfMonth(formatted) : formatted;
}

/** En français, le premier du mois s'écrit « 1er ». */
function firstOfMonth(formatted: string): string {
  return formatted.replace(/^1 /, '1er ');
}
