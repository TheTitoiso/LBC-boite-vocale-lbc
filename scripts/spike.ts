/**
 * Étape 0 du brief : vérifier les hypothèses sur Chatwoot et Shopify avant de construire le service.
 *
 *   npm run spike -- check                           lecture seule : jeton, boîtes, étiquettes, réglages, Shopify
 *   npm run spike -- transcription --yes             validations 1 et 2 : boîte API, audio, transcription, formes
 *   npm run spike -- email --yes                     validation 3, partie 1 : boîte courriel, aucune réponse envoyée
 *   npm run spike -- email --reply <id> --yes        validation 3, partie 2 : réponse d'agent envoyée par courriel
 *   npm run spike -- shopify [numéros…] [--sample N] validation 4 (lecture seule)
 *
 * Options : --audio <fichier.mp3> (défaut test/fixtures/message-qc.mp3), --wait <minutes> (3 pour la
 * transcription, 1 pour le courriel),
 * --to <courriel> (défaut SPIKE_TEST_EMAIL).
 *
 * Les réponses brutes de Chatwoot sont gardées dans spike-output/<date>-<commande>/ (ignoré par git).
 * Les écritures (contact, conversation, messages de test) demandent --yes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ChatwootClient,
  ChatwootError,
  sourceIdForInbox,
  type ChatwootMessage,
  type ChatwootResponseEvent,
} from '../src/clients/chatwoot.ts';
import { ShopifyClient } from '../src/clients/shopify.ts';
import { chatwootConfigSchema, parseEnv, shopifyConfigSchema } from '../src/config.ts';
import { extractDictatedEmail } from '../src/lib/dictation.ts';
import { formatDuration, formatLongDate } from '../src/lib/format.ts';
import { maskPhone, normalizePhone } from '../src/lib/phone.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_AUDIO = join(ROOT, 'test/fixtures/message-qc.mp3');

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    yes: { type: 'boolean', default: false },
    audio: { type: 'string' },
    wait: { type: 'string' },
    to: { type: 'string' },
    reply: { type: 'string' },
    sample: { type: 'string' },
  },
});
const [command = 'help', ...args] = positionals;

// ---------------------------------------------------------------------------------------------- sortie

const log = (text = '') => console.log(text);
const section = (title: string) => log(`\n━━ ${title} ${'━'.repeat(Math.max(0, 70 - title.length))}`);
const ok = (text: string) => log(`  ✅ ${text}`);
const warn = (text: string) => log(`  ⚠️  ${text}`);
const fail = (text: string) => log(`  ❌ ${text}`);
const info = (text: string) => log(`     ${text}`);

const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${command}`;
const runDir = join(ROOT, 'spike-output', runId);
let recordSeq = 0;
let recording = true;

/** Garde chaque réponse de Chatwoot dans spike-output/, sans les secrets éventuels des boîtes. */
function record(event: ChatwootResponseEvent): void {
  if (!recording) return;
  mkdirSync(runDir, { recursive: true });
  recordSeq += 1;
  const slug = event.path.replace(/\?.*$/, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'account';
  const file = `${String(recordSeq).padStart(2, '0')}-${event.method}-${slug}.json`;
  writeFileSync(join(runDir, file), JSON.stringify({ ...event, body: maskSecrets(event.body) }, null, 2));
}

function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        /password|secret|token|api_key|hmac/i.test(key) && inner ? '[masqué]' : maskSecrets(inner),
      ]),
    );
  }
  return value;
}

function saveJson(name: string, data: unknown): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, name), JSON.stringify(data, null, 2));
}

/** Forme d'une réponse, sur deux niveaux : `{ payload: { contact: {…}, contact_inbox: {…} } }`. */
function shape(value: unknown, depth = 2): string {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${shape(value[0], depth)} ×${value.length}]`;
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  if (depth === 0) return `{${entries.length} clés}`;
  const shown = entries.slice(0, 12).map(([key, inner]) =>
    inner && typeof inner === 'object' ? `${key}: ${shape(inner, depth - 1)}` : key,
  );
  return `{ ${shown.join(', ')}${entries.length > 12 ? ', …' : ''} }`;
}

// ---------------------------------------------------------------------------------------------- clients

const spikeChatwootSchema = chatwootConfigSchema.partial({ CHATWOOT_INBOX_ID: true });
let lastResponse: ChatwootResponseEvent | undefined;

function chatwoot() {
  const config = parseEnv(spikeChatwootSchema);
  const client = new ChatwootClient({
    baseUrl: config.CHATWOOT_BASE_URL,
    accountId: config.CHATWOOT_ACCOUNT_ID,
    apiToken: config.CHATWOOT_API_TOKEN,
    auth: config.CHATWOOT_AUTH,
    onResponse: (event) => {
      lastResponse = event;
      record(event);
    },
  });
  return { client, config };
}

function shopify() {
  const config = parseEnv(shopifyConfigSchema);
  return new ShopifyClient({
    shop: config.SHOPIFY_SHOP,
    apiVersion: config.SHOPIFY_API_VERSION,
    clientId: config.SHOPIFY_CLIENT_ID,
    clientSecret: config.SHOPIFY_CLIENT_SECRET,
  });
}

function hasShopifyConfig(): boolean {
  return Boolean(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}

function requireYes(what: string): void {
  if (!options.yes) {
    throw new Error(`Cette commande ${what}. Relancer avec --yes pour confirmer.`);
  }
}

// ---------------------------------------------------------------------------------------------- audio

interface Audio {
  path: string;
  data: Uint8Array;
  seconds: number | null;
  reference: string | null;
}

function loadAudio(): Audio {
  const path = resolve(options.audio ?? DEFAULT_AUDIO);
  if (!existsSync(path)) throw new Error(`Fichier audio introuvable : ${path}`);
  const referencePath = path.replace(/\.mp3$/i, '.txt');
  const reference = existsSync(referencePath)
    ? readFileSync(referencePath, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join(' ')
        .trim() || null
    : null;
  return { path, data: readFileSync(path), seconds: probeSeconds(path), reference };
}

function probeSeconds(path: string): number | null {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], {
      encoding: 'utf8',
    });
    const seconds = Number.parseFloat(out);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- check

async function check(): Promise<void> {
  const { client, config } = chatwoot();
  section('Chatwoot : jeton et compte');
  const profile = (await client.getProfile()) as {
    name?: string;
    role?: string;
    accounts?: Array<{ id: number; role?: string; name?: string }>;
  };
  const membership = profile.accounts?.find((account) => account.id === config.CHATWOOT_ACCOUNT_ID);
  if (!membership) fail(`Le jeton n'a pas accès au compte ${config.CHATWOOT_ACCOUNT_ID}.`);
  else ok(`Jeton valide : « ${profile.name} », rôle ${membership.role ?? profile.role ?? '?'} dans « ${membership.name} ».`);
  info(`Auth : ${config.CHATWOOT_AUTH === 'bearer' ? 'Authorization: Bearer' : 'en-tête api_access_token'}.`);

  try {
    const account = await client.getAccount();
    const flat = flatten(account);
    const related = [...flat].filter(([path]) => /transcri|captain|audio/i.test(path));
    if (related.length === 0) warn('Aucun réglage « transcription / captain / audio » visible dans le compte.');
    for (const [path, value] of related) info(`compte.${path} = ${JSON.stringify(value)}`);
  } catch (error) {
    warn(`Lecture du compte impossible (${(error as Error).message}).`);
  }

  section('Chatwoot : boîtes');
  const inboxes = await client.listInboxes();
  for (const inbox of inboxes) info(`#${inbox.id} ${inbox.name} (${inbox.channel_type})`);

  const voicemailCandidates = inboxes.filter(
    (inbox) => inbox.channel_type === 'Channel::Api' && /bo[iî]te\s*vocale/i.test(inbox.name),
  );
  const apiInbox = inboxes.find((inbox) => inbox.id === config.CHATWOOT_INBOX_ID);
  if (!config.CHATWOOT_INBOX_ID) {
    if (voicemailCandidates[0]) warn(`CHATWOOT_INBOX_ID absent; candidat : #${voicemailCandidates[0].id} « ${voicemailCandidates[0].name} ».`);
    else fail('CHATWOOT_INBOX_ID absent et aucune boîte API « Boîte vocale » dans le compte.');
  } else if (!apiInbox) {
    fail(`CHATWOOT_INBOX_ID=${config.CHATWOOT_INBOX_ID} : boîte introuvable.`);
  } else if (apiInbox.channel_type !== 'Channel::Api') {
    fail(`CHATWOOT_INBOX_ID=${apiInbox.id} est une boîte ${apiInbox.channel_type}, pas une boîte API.`);
  } else {
    ok(`Boîte API #${apiInbox.id} « ${apiInbox.name} ».`);
    if (apiInbox.webhook_url) warn(`Elle a une URL de webhook (${String(apiInbox.webhook_url)}) : le brief la veut sans.`);
  }

  if (config.CHATWOOT_EMAIL_INBOX_ID) {
    const emailInbox = inboxes.find((inbox) => inbox.id === config.CHATWOOT_EMAIL_INBOX_ID);
    if (emailInbox?.channel_type === 'Channel::Email') ok(`Boîte courriel #${emailInbox.id} « ${emailInbox.name} » (${String(emailInbox.email ?? '?')}).`);
    else fail(`CHATWOOT_EMAIL_INBOX_ID=${config.CHATWOOT_EMAIL_INBOX_ID} n'est pas une boîte courriel.`);
  } else {
    info('CHATWOOT_EMAIL_INBOX_ID absent : option « boîte courriel » non configurée.');
  }

  section('Chatwoot : étiquettes');
  const labels = new Set((await client.listAccountLabels()).map((label) => label.title));
  for (const label of ['boite-vocale', 'anglais']) {
    if (labels.has(label)) ok(`Étiquette « ${label} ».`);
    else fail(`Étiquette « ${label} » absente (à créer dans Paramètres → Étiquettes).`);
  }

  section('Shopify');
  if (!hasShopifyConfig()) {
    warn('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET absents : jeton non vérifié.');
  } else {
    const shop = shopify();
    await shop.getAccessToken();
    ok(`Jeton obtenu pour ${shop.shopDomain} (client credentials grant).`);
    const scopes = shop.grantedScopes;
    info(`Portées : ${scopes.join(', ') || '(aucune)'}`);
    for (const scope of ['read_customers', 'read_orders']) {
      if (!scopes.includes(scope)) fail(`Portée « ${scope} » manquante.`);
    }
    if (!scopes.includes('read_all_orders')) info('read_all_orders absente : seulement utile pour la phase 2.');
  }
}

// ---------------------------------------------------------------------------------------------- transcription

async function transcription(): Promise<void> {
  requireYes('crée un contact, une conversation et des messages de test dans Chatwoot');
  const { client, config } = chatwoot();
  if (!config.CHATWOOT_INBOX_ID) throw new Error('CHATWOOT_INBOX_ID est obligatoire pour ce test (boîte API « Boîte vocale »).');
  const inboxId = config.CHATWOOT_INBOX_ID;
  const audio = loadAudio();
  const waitMinutes = Number(options.wait ?? 3) || 3;
  const shapes: Record<string, string> = {};
  const note = (key: string) => {
    shapes[key] = shape(lastResponse?.body);
  };

  section('Contact de test');
  // Numéro fictif (plage 555-01XX, réservée à la fiction en Amérique du Nord).
  const phone = `+1450555${String(100 + Math.floor(Math.random() * 100)).padStart(4, '0')}`;
  const before = await client.searchContacts(phone);
  note('GET /contacts/search (aucun résultat)');
  info(`Recherche de ${phone} avant création : ${before.length} résultat(s).`);

  const created = await client.createContact({ inboxId, name: `Test boîte vocale (étape 0) ${runId.slice(0, 16)}`, phoneNumber: phone });
  note('POST /contacts');
  ok(`Contact #${created.contact.id} créé; source_id dans la réponse : ${created.sourceId ? 'oui' : 'non'}.`);

  const fetched = await client.getContact(created.contact.id);
  note('GET /contacts/{id}');
  info(`contact_inboxes dans GET /contacts/{id} : ${fetched.contact_inboxes ? fetched.contact_inboxes.length : 'absent'}.`);

  const found = await client.searchContacts(phone);
  note('GET /contacts/search (un résultat)');
  const exact = found.filter((contact) => normalizePhone(contact.phone_number) === phone);
  info(`Recherche après création : ${found.length} résultat(s), ${exact.length} correspondance(s) exacte(s).`);
  info(`contact_inboxes dans la recherche : ${found[0]?.contact_inboxes ? 'oui' : 'non'}.`);

  const extraInbox = await client.createContactInbox(created.contact.id, inboxId);
  note('POST /contacts/{id}/contact_inboxes');
  const knownSourceId = created.sourceId ?? sourceIdForInbox(fetched, inboxId);
  info(
    `POST contact_inboxes sur la même boîte : ${extraInbox.source_id === knownSourceId ? 'renvoie le même source_id' : 'crée un NOUVEAU source_id'}.`,
  );
  const sourceId = knownSourceId ?? extraInbox.source_id;

  section('Conversation et message vocal');
  const conversation = await client.createConversation({
    sourceId,
    inboxId,
    contactId: created.contact.id,
    status: 'open',
    ...(config.CHATWOOT_TEAM_ID ? { teamId: config.CHATWOOT_TEAM_ID } : {}),
  });
  note('POST /conversations');
  const conversationUrl = `${config.CHATWOOT_BASE_URL}/app/accounts/${config.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}`;
  ok(`Conversation #${conversation.id} : ${conversationUrl}`);

  const content = `Message vocal (${audio.seconds === null ? '?:??' : formatDuration(audio.seconds)})`;
  const postedAt = Date.now();
  const message = await client.createIncomingMessageWithAttachment(conversation.id, {
    content,
    file: { data: audio.data, filename: 'message-vocal-spike.mp3', contentType: 'audio/mpeg' },
  });
  note('POST /conversations/{id}/messages (multipart)');
  const attachment = message.attachments?.[0];
  ok(`Message entrant #${message.id} « ${content} », pièce jointe : ${attachment ? `${attachment.file_type}` : 'AUCUNE'}.`);

  await client.createPrivateNote(conversation.id, 'Test de l’étape 0 (scripts/spike.ts) : contact et conversation de test, à ignorer.');
  note('POST /conversations/{id}/messages (note privée)');
  ok('Note privée ajoutée.');

  const accountLabels = new Set((await client.listAccountLabels()).map((label) => label.title));
  if (accountLabels.has('boite-vocale')) {
    const labels = await client.addConversationLabels(conversation.id, ['boite-vocale']);
    note('POST /conversations/{id}/labels');
    ok(`Étiquettes : ${labels.join(', ')}.`);
  } else {
    warn('Étiquette « boite-vocale » absente du compte : étape sautée.');
  }

  const conversations = await client.listContactConversations(created.contact.id);
  note('GET /contacts/{id}/conversations');
  const listed = conversations.find((c) => c.id === conversation.id);
  info(
    `GET /contacts/{id}/conversations : ${conversations.length} conversation(s); status=${String(listed?.status)}, inbox_id=${String(listed?.inbox_id)}, last_activity_at=${String(listed?.last_activity_at)}.`,
  );

  section(`Transcription (attente jusqu'à ${waitMinutes} min)`);
  const result = await watchForTranscription(client, conversation.id, message.id, postedAt, waitMinutes);

  section('Résultat');
  if (!result.found) {
    fail(`Aucune transcription après ${waitMinutes} min.`);
  } else {
    ok(`Transcription trouvée après ${result.seconds} s, dans ${result.where}.`);
    log(`\n     « ${result.text} »\n`);
    evaluate(result.text, audio.reference);
  }

  section('Formes des réponses');
  for (const [endpoint, description] of Object.entries(shapes)) {
    log(`  ${endpoint}\n     ${description}`);
  }
  saveJson('resume.json', { conversation: conversation.id, contact: created.contact.id, conversationUrl, shapes, result });
  log(`\nRéponses brutes : ${runDir}`);
}

interface TranscriptionResult {
  found: boolean;
  seconds?: number;
  where?: string;
  text: string;
  changes: Array<{ path: string; before: unknown; after: unknown; seconds: number }>;
  newMessages: Array<{ id: number; message_type: unknown; private: boolean; content: string | null; seconds: number }>;
}

const NOISE = /url|updated_at|last_activity_at|thumb|availability|signed|expires|_at$/i;

/**
 * Relit les messages toutes les 5 s et compare le message vocal à son premier état : tout nouveau texte
 * (champ du message, de sa pièce jointe ou nouveau message dans la conversation) est un candidat.
 */
async function watchForTranscription(
  client: ChatwootClient,
  conversationId: number,
  messageId: number,
  postedAt: number,
  waitMinutes: number,
): Promise<TranscriptionResult> {
  const first = await client.listMessages(conversationId);
  saveJson('messages-debut.json', maskSecrets(first));
  const baseline = first.find((m) => m.id === messageId);
  const baselineFlat = flatten(baseline);
  const knownIds = new Set(first.map((m) => m.id));
  const result: TranscriptionResult = { found: false, text: '', changes: [], newMessages: [] };

  // Un champ « transcri… » déjà présent dès le départ compte aussi.
  for (const [path, value] of baselineFlat) {
    if (/transcri/i.test(path) && typeof value === 'string' && value.trim()) {
      Object.assign(result, { found: true, seconds: Math.round((Date.now() - postedAt) / 1000), where: `message.${path}`, text: value });
    }
  }

  recording = false;
  const deadline = postedAt + waitMinutes * 60_000;
  let last: ChatwootMessage[] = first;
  while (!result.found && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const seconds = Math.round((Date.now() - postedAt) / 1000);
    try {
      last = await client.listMessages(conversationId);
    } catch (error) {
      warn(`Lecture des messages à ${seconds} s : ${(error as Error).message}`);
      continue;
    }

    const current = last.find((m) => m.id === messageId);
    for (const [path, value] of flatten(current)) {
      if (NOISE.test(path) || baselineFlat.get(path) === value) continue;
      if (result.changes.some((change) => change.path === path && change.after === value)) continue;
      result.changes.push({ path, before: baselineFlat.get(path), after: value, seconds });
      info(`${seconds} s : message.${path} → ${JSON.stringify(value).slice(0, 120)}`);
      if (typeof value === 'string' && value.trim().split(/\s+/).length >= 3) {
        Object.assign(result, { found: true, seconds, where: `message.${path}`, text: value });
      }
    }

    for (const m of last.filter((m) => !knownIds.has(m.id))) {
      knownIds.add(m.id);
      result.newMessages.push({ id: m.id, message_type: m.message_type, private: m.private, content: m.content, seconds });
      info(`${seconds} s : nouveau message #${m.id} (type ${String(m.message_type)}, privé ${m.private}) : ${JSON.stringify(m.content).slice(0, 120)}`);
      if (typeof m.content === 'string' && m.content.trim().split(/\s+/).length >= 3) {
        Object.assign(result, { found: true, seconds, where: `nouveau message #${m.id}`, text: m.content });
      }
    }
    if (!result.found && seconds % 30 < 5) info(`${seconds} s : rien de nouveau.`);
  }
  recording = true;
  saveJson('messages-fin.json', maskSecrets(last));
  return result;
}

/** Qualité : taux d'erreur par mot contre le texte de référence, courriel et numéro de commande. */
function evaluate(transcript: string, reference: string | null): void {
  if (reference) {
    const rate = wordErrorRate(reference, transcript);
    info(`Taux d'erreur par mot (WER) contre test/fixtures/*.txt : ${(rate * 100).toFixed(0)} %`);
    info('(un courriel bien écrit « marie.tremblay@gmail.com » compte comme des erreurs : lire le texte.)');
  }
  const expectedEmail = reference ? extractDictatedEmail(reference) : null;
  const email = extractDictatedEmail(transcript);
  if (email && email === expectedEmail) ok(`Courriel dicté reconnu : ${email}`);
  else if (email) warn(`Courriel trouvé : ${email} (attendu : ${expectedEmail ?? '?'})`);
  else fail('Aucun courriel reconnaissable dans la transcription.');

  const expectedOrders = reference ? orderNumbersIn(reference) : [];
  const orders = orderNumbersIn(transcript);
  const matched = expectedOrders.filter((order) => orders.includes(order));
  if (matched.length > 0) ok(`Numéro de commande reconnu : ${matched.join(', ')}`);
  else warn(`Numéro de commande attendu ${expectedOrders.join(', ') || '?'}, trouvé : ${orders.join(', ') || 'aucun'}.`);
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9@.\s]/g, ' ')
    .replace(/\.(\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return ref.length === 0 ? 0 : previous[hyp.length]! / ref.length;
}

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5', six: '6', sept: '7', huit: '8', neuf: '9',
  one: '1', two: '2', three: '3', four: '4', five: '5', seven: '7', eight: '8', nine: '9',
};

/** Suites de 4 à 7 chiffres, dits un par un (« six quatre zéro trois six ») ou écrits (« 64036 »). */
function orderNumbersIn(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[\s,.;:!?#-]+/)
    .map((token) => DIGIT_WORDS[token] ?? token);
  const numbers: string[] = [];
  let run = '';
  for (const token of [...tokens, '']) {
    if (/^\d+$/.test(token)) run += token;
    else {
      if (run.length >= 4 && run.length <= 7) numbers.push(run);
      run = '';
    }
  }
  return numbers;
}

function flatten(value: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((inner, i) => flatten(inner, `${prefix}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
  } else out.set(prefix, value);
  return out;
}

// ---------------------------------------------------------------------------------------------- courriel

async function emailInbox(): Promise<void> {
  requireYes('crée une conversation de test dans la boîte courriel (et, avec --reply, envoie un vrai courriel)');
  const { client, config } = chatwoot();
  const inboxId = config.CHATWOOT_EMAIL_INBOX_ID;
  if (!inboxId) throw new Error('CHATWOOT_EMAIL_INBOX_ID est obligatoire pour ce test.');
  const to = (options.to ?? process.env.SPIKE_TEST_EMAIL ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(to)) throw new Error('Adresse de test absente : --to <courriel> ou SPIKE_TEST_EMAIL.');

  if (options.reply) {
    await emailReply(client, Number(options.reply), to);
    return;
  }

  section('Contact de test (boîte courriel)');
  const existing = (await client.searchContacts(to)).find((contact) => contact.email?.toLowerCase() === to);
  let contactId: number;
  if (existing) {
    contactId = existing.id;
    ok(`Contact existant #${contactId} réutilisé.`);
  } else {
    const created = await client.createContact({ inboxId, name: 'Test boîte vocale (courriel)', email: to });
    contactId = created.contact.id;
    ok(`Contact #${contactId} créé.`);
  }

  section('Conversation courriel avec message vocal');
  const subject = `Votre message vocal du ${formatLongDate(new Date())}`;
  const conversation = await client.createConversation({
    sourceId: to,
    inboxId,
    contactId,
    status: 'open',
    additionalAttributes: { mail_subject: subject },
  });
  info(`POST /conversations : ${shape(lastResponse?.body)}`);
  const audio = loadAudio();
  const message = await client.createIncomingMessageWithAttachment(conversation.id, {
    content: `Message vocal (${audio.seconds === null ? '?:??' : formatDuration(audio.seconds)})`,
    file: { data: audio.data, filename: 'message-vocal-spike.mp3', contentType: 'audio/mpeg' },
  });
  ok(`Conversation #${conversation.id}, sujet « ${subject} », message entrant #${message.id}.`);
  info(`${config.CHATWOOT_BASE_URL}/app/accounts/${config.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}`);

  const waitSeconds = Math.round((Number(options.wait ?? 1) || 1) * 60);
  info(`Attente de ${waitSeconds} s pour voir si Chatwoot crée un message sortant de lui-même…`);
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));
  const messages = await client.listMessages(conversation.id);
  const outgoing = messages.filter((m) => m.id !== message.id && !m.private && Number(m.message_type) !== 2 && m.message_type !== 'activity');
  if (outgoing.length === 0) ok('Aucun message sortant créé par Chatwoot.');
  else for (const m of outgoing) warn(`Message #${m.id} (type ${String(m.message_type)}) : ${JSON.stringify(m.content).slice(0, 120)}`);

  section('À vérifier par un humain');
  info(`1. Aucun courriel ne doit être arrivé à ${to}.`);
  info(`2. Ensuite : npm run spike -- email --reply ${conversation.id} --yes`);
  saveJson('resume.json', { conversation: conversation.id, contact: contactId, subject, outgoing });
}

async function emailReply(client: ChatwootClient, conversationId: number, to: string): Promise<void> {
  section(`Réponse d'agent dans la conversation #${conversationId}`);
  const conversation = await client.getConversation(conversationId);
  const subject = (conversation.additional_attributes as { mail_subject?: string } | undefined)?.mail_subject;
  info(`Sujet de la conversation : « ${subject ?? '(aucun)'} »`);
  const reply = await client.createOutgoingMessage(
    conversationId,
    'Bonjour, ceci est un test de la boîte vocale des Belles Combines (étape 0) : une réponse d’agent doit partir par courriel. Vous pouvez ignorer ce message.',
  );
  ok(`Réponse #${reply.id} créée.`);

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const current = (await client.listMessages(conversationId)).find((m) => m.id === reply.id);
    const status = String(current?.status ?? '?');
    const error = (current?.content_attributes as { external_error?: string } | undefined)?.external_error;
    if (error) {
      fail(`Échec d'envoi : ${error}`);
      break;
    }
    if (status !== 'progress' && status !== '?') {
      ok(`Statut du message : ${status}.`);
      break;
    }
  }
  section('À vérifier par un humain');
  info(`Le courriel doit être arrivé à ${to}, avec le sujet « ${subject ?? '?'} » (ou « Re: … »).`);
}

// ---------------------------------------------------------------------------------------------- Shopify

const SPIKE_CUSTOMER_QUERY = /* GraphQL */ `
  query SpikeCustomerByPhone($q: String!) {
    customers(first: 3, query: $q) {
      nodes {
        id
        defaultPhoneNumber { phoneNumber }
        defaultEmailAddress { emailAddress }
        firstName
        numberOfOrders
        lastOrder { name displayFulfillmentStatus }
      }
    }
  }
`;

async function shopifyPhones(): Promise<void> {
  const client = shopify();
  section('Shopify : jeton');
  await client.getAccessToken();
  ok(`Jeton obtenu pour ${client.shopDomain}, portées : ${client.grantedScopes.join(', ')}.`);

  const raw = args.length > 0 ? args : (process.env.SPIKE_SHOPIFY_PHONES ?? '').split(',');
  const phones = raw.map((p) => p.trim()).filter(Boolean);
  if (phones.length > 0) section('Shopify : CustomerByPhone');
  for (const input of phones) {
    const e164 = normalizePhone(input);
    if (!e164) {
      fail(`${maskPhone(input)} : numéro inutilisable.`);
      continue;
    }
    // La requête exacte du brief, par le client du service…
    const customer = await client.findCustomerByPhone(e164);
    // …et une variante qui montre d'où vient la correspondance et s'il y a plusieurs clients.
    const detail = await client.graphql<{ customers: { nodes: Array<{ defaultPhoneNumber: { phoneNumber: string } | null }> } }>(
      SPIKE_CUSTOMER_QUERY,
      { q: `phone:${e164}` },
    );
    const nodes = detail.customers.nodes;
    if (!customer) {
      fail(`${maskPhone(e164)} : aucun client.`);
      continue;
    }
    const onCustomer = nodes[0]?.defaultPhoneNumber?.phoneNumber === e164;
    ok(
      `${maskPhone(e164)} : client trouvé; nom ${customer.name ? 'oui' : 'non'}, courriel ${customer.email ? 'oui' : 'non'}, ` +
        `${customer.numberOfOrders} commande(s), dernière ${customer.lastOrder ? `${customer.lastOrder.name} (${customer.lastOrder.fulfillmentStatus})` : 'aucune'}; ` +
        `numéro ${onCustomer ? 'sur la fiche (defaultPhoneNumber)' : 'seulement dans une adresse'}${nodes.length > 1 ? `; ⚠️ ${nodes.length} clients ont ce numéro` : ''}.`,
    );
  }

  const sample = Number(options.sample ?? 0);
  if (sample > 0) await shopifyCoverage(client, sample);
  if (phones.length === 0 && sample === 0) info('Aucun numéro : passer des numéros en arguments, SPIKE_SHOPIFY_PHONES ou --sample N.');
}

/** Part des clients récents qu'une recherche par téléphone peut trouver (fiche ou adresse). */
async function shopifyCoverage(client: ShopifyClient, size: number): Promise<void> {
  section(`Shopify : couverture sur ${size} clients ayant commandé depuis 6 mois`);
  const since = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
  const query = /* GraphQL */ `
    query Coverage($q: String!, $after: String) {
      customers(first: 50, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes { defaultPhoneNumber { phoneNumber } addressesV2(first: 5) { nodes { phone } } }
      }
    }
  `;
  type Page = {
    customers: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ defaultPhoneNumber: { phoneNumber: string } | null; addressesV2: { nodes: Array<{ phone: string | null }> } }>;
    };
  };
  let after: string | null = null;
  let total = 0;
  let onCustomer = 0;
  let anywhere = 0;
  while (total < size) {
    const page: Page = await client.graphql<Page>(query, { q: `order_date:>='${since}'`, after });
    for (const node of page.customers.nodes) {
      if (total >= size) break;
      total += 1;
      const hasOwn = Boolean(node.defaultPhoneNumber?.phoneNumber);
      const hasAddress = node.addressesV2.nodes.some((address) => normalizePhone(address.phone, 'CA'));
      if (hasOwn) onCustomer += 1;
      if (hasOwn || hasAddress) anywhere += 1;
    }
    if (!page.customers.pageInfo.hasNextPage) break;
    after = page.customers.pageInfo.endCursor;
  }
  const pct = (n: number) => `${Math.round((100 * n) / Math.max(total, 1))} %`;
  ok(`${total} clients : defaultPhoneNumber rempli ${pct(onCustomer)}, un numéro quelque part (fiche ou adresse) ${pct(anywhere)}.`);
}

// ---------------------------------------------------------------------------------------------- main

const commands: Record<string, () => Promise<void>> = {
  check,
  transcription,
  email: emailInbox,
  shopify: shopifyPhones,
};

const run = commands[command];
if (!run) {
  const usage = readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0] ?? '';
  console.log(usage.replace(/^\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
  process.exit(command === 'help' ? 0 : 1);
}

try {
  await run();
} catch (error) {
  fail((error as Error).message);
  if (error instanceof ChatwootError && lastResponse) {
    info(`Dernière réponse Chatwoot : ${lastResponse.method} ${lastResponse.path} → HTTP ${lastResponse.status}`);
    info(`Réponses brutes : ${runDir}`);
  }
  process.exitCode = 1;
}
