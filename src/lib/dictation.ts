import type { Lang } from './format.ts';

const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/;

/**
 * Courriel dicté dans une transcription : « marie point tremblay arobase gmail point com » ou déjà écrit
 * « marie.tremblay@gmail.com ». Renvoie l'adresse en minuscules, ou `null`.
 *
 * Le résultat est une supposition : il doit être validé par un humain avant d'être utilisé (jamais écrit
 * tel quel sur le contact).
 */
export function extractDictatedEmail(transcript: string, lang: Lang = 'fr'): string | null {
  const text = transcript.toLowerCase().normalize('NFC');

  const written = EMAIL.exec(text);
  if (written) return cleanup(written[0]);

  let spoken = text.replace(/[,;:!?«»"“”]/g, ' ');
  if (lang === 'fr') {
    spoken = spoken
      .replace(/\s*\b(?:arobase|arobas|a commercial)\b\s*/g, '@')
      .replace(/\s*\b(?:tiret bas|souligné|underscore)\b\s*/g, '_')
      .replace(/\s*\btiret\b\s*/g, '-')
      .replace(/\s*\bpoint\b\s*/g, '.');
  } else {
    // « at » seulement devant « <domaine> dot … », et seulement le dernier : dans « reach me at john dot
    // smith at gmail dot com », le premier « at » fait partie de la phrase.
    const ats = [...spoken.matchAll(/\s+at\s+(?=[a-z0-9-]+\s+dot\s+)/g)];
    const last = ats.at(-1);
    if (last?.index !== undefined) {
      spoken = `${spoken.slice(0, last.index)}@${spoken.slice(last.index + last[0].length)}`;
    }
    spoken = spoken
      .replace(/\s*\bunderscore\b\s*/g, '_')
      .replace(/\s*\b(?:dash|hyphen)\b\s*/g, '-')
      .replace(/\s*\bdot\b\s*/g, '.');
  }
  const dictated = EMAIL.exec(spoken);
  return dictated ? cleanup(dictated[0]) : null;
}

function cleanup(email: string): string {
  return email.replace(/\.+$/, '');
}
