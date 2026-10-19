import { redactBody } from '../lib/redact.ts';

/**
 * Client de l'API applicative de Chatwoot, limité aux appels dont la boîte vocale a besoin.
 *
 * Les réponses de Chatwoot n'ont pas toutes la même forme (objet à la racine, sous `payload`, ou sous
 * `payload.contact`) : chaque méthode passe par les fonctions `unwrap*`, qui acceptent toutes ces formes.
 * Aucune écriture n'est répétée automatiquement : un délai dépassé ne prouve pas que Chatwoot n'a rien
 * fait, et répéter créerait des doublons. Les nouvelles tentatives se décident plus haut.
 */

export interface ContactInbox {
  source_id: string;
  inbox?: { id: number; name?: string; channel_type?: string } | null;
  inbox_id?: number;
}

export interface ChatwootContact {
  id: number;
  name: string | null;
  email: string | null;
  phone_number: string | null;
  contact_inboxes?: ContactInbox[];
  [key: string]: unknown;
}

export interface ChatwootConversation {
  id: number;
  inbox_id: number;
  status: string;
  last_activity_at?: number;
  labels?: string[];
  contact_inbox?: { source_id?: string } | null;
  [key: string]: unknown;
}

export interface ChatwootAttachment {
  id: number;
  file_type: string;
  data_url?: string;
  [key: string]: unknown;
}

export interface ChatwootMessage {
  id: number;
  content: string | null;
  message_type: number | string;
  private: boolean;
  created_at: number;
  attachments?: ChatwootAttachment[];
  content_attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChatwootClientOptions {
  baseUrl: string;
  accountId: number;
  apiToken: string;
  auth: 'header' | 'bearer';
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Appelé après chaque réponse (le script de l'étape 0 s'en sert pour garder les réponses brutes). */
  onResponse?: (event: ChatwootResponseEvent) => void;
}

export interface ChatwootResponseEvent {
  method: string;
  path: string;
  status: number;
  ms: number;
  body: unknown;
}

export class ChatwootError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string, message?: string) {
    super(message ?? `Chatwoot ${method} ${path} : HTTP ${status}${body ? ` ${body}` : ''}`);
    this.name = 'ChatwootError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }

  /** Erreur réseau ou délai dépassé : on ne sait pas si Chatwoot a traité la requête. */
  get uncertain(): boolean {
    return this.status === 0;
  }
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: Query;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
}

export interface AudioFile {
  data: Uint8Array;
  filename: string;
  contentType: string;
}

export class ChatwootClient {
  private readonly options: Required<Pick<ChatwootClientOptions, 'timeoutMs'>> & ChatwootClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ChatwootClientOptions) {
    this.options = { timeoutMs: 20_000, ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') };
    this.fetchImpl = options.fetch ?? fetch;
  }

  // ------------------------------------------------------------------ requêtes

  /** `path` est relatif au compte (`/contacts`), sauf s'il commence par `/api/` (`/api/v1/profile`). */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const fullPath = path.startsWith('/api/') ? path : `/api/v1/accounts/${this.options.accountId}${path}`;
    const url = new URL(this.options.baseUrl + fullPath);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.options.auth === 'bearer') headers.Authorization = `Bearer ${this.options.apiToken}`;
    else headers.api_access_token = this.options.apiToken;

    let body: string | FormData | undefined;
    if (options.form) {
      body = options.form; // fetch ajoute lui-même l'en-tête multipart avec sa frontière
    } else if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }

    const attempts = method === 'GET' ? 2 : 1;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs),
        });
      } catch (error) {
        if (attempt < attempts) {
          await sleep(1000);
          continue;
        }
        const reason = error instanceof Error && error.name === 'TimeoutError' ? 'délai dépassé' : 'erreur réseau';
        throw new ChatwootError(method, path, 0, '', `Chatwoot ${method} ${path} : ${reason}`);
      }

      const text = await response.text();
      const parsed = parseJson(text);
      this.options.onResponse?.({ method, path, status: response.status, ms: Date.now() - started, body: parsed ?? text });

      if (response.ok) return (parsed ?? {}) as T;
      if ((response.status >= 500 || response.status === 429) && attempt < attempts) {
        await sleep(1000);
        continue;
      }
      throw new ChatwootError(method, path, response.status, redactBody(text));
    }
  }

  // ------------------------------------------------------------------ compte

  getProfile(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/v1/profile');
  }

  async getAccount(): Promise<Record<string, unknown>> {
    return unwrapObject(await this.request('GET', ''));
  }

  async listInboxes(): Promise<Array<{ id: number; name: string; channel_type: string; [key: string]: unknown }>> {
    return unwrapList(await this.request('GET', '/inboxes'));
  }

  async listAccountLabels(): Promise<Array<{ id: number; title: string; [key: string]: unknown }>> {
    return unwrapList(await this.request('GET', '/labels'));
  }

  // ------------------------------------------------------------------ contacts

  async searchContacts(q: string): Promise<ChatwootContact[]> {
    return unwrapList<ChatwootContact>(await this.request('GET', '/contacts/search', { query: { q } }));
  }

  async getContact(contactId: number): Promise<ChatwootContact> {
    return unwrapContact(await this.request('GET', `/contacts/${contactId}`));
  }

  /**
   * Crée un contact rattaché à une boîte. Chatwoot crée en même temps son `contact_inbox` : on renvoie
   * son `source_id` quand la réponse le donne, pour éviter un appel à `/contact_inboxes`.
   */
  async createContact(input: {
    inboxId: number;
    name: string;
    email?: string | null;
    phoneNumber?: string | null;
  }): Promise<{ contact: ChatwootContact; sourceId: string | null }> {
    const body = await this.request('POST', '/contacts', {
      json: {
        inbox_id: input.inboxId,
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
        ...(input.phoneNumber ? { phone_number: input.phoneNumber } : {}),
      },
    });
    const contact = unwrapContact(body);
    return { contact, sourceId: unwrapCreatedSourceId(body, input.inboxId) ?? sourceIdForInbox(contact, input.inboxId) };
  }

  async updateContact(
    contactId: number,
    changes: { name?: string; email?: string; phone_number?: string },
  ): Promise<ChatwootContact> {
    return unwrapContact(await this.request('PUT', `/contacts/${contactId}`, { json: changes }));
  }

  async createContactInbox(contactId: number, inboxId: number, sourceId?: string): Promise<ContactInbox> {
    const body = await this.request('POST', `/contacts/${contactId}/contact_inboxes`, {
      json: { inbox_id: inboxId, ...(sourceId ? { source_id: sourceId } : {}) },
    });
    const contactInbox = unwrapObject(body) as Partial<ContactInbox>;
    if (typeof contactInbox.source_id !== 'string') {
      throw new ChatwootError('POST', `/contacts/${contactId}/contact_inboxes`, 200, '', 'Réponse sans source_id');
    }
    return contactInbox as ContactInbox;
  }

  async listContactConversations(contactId: number): Promise<ChatwootConversation[]> {
    return unwrapList<ChatwootConversation>(await this.request('GET', `/contacts/${contactId}/conversations`));
  }

  // ------------------------------------------------------------------ conversations

  async createConversation(input: {
    sourceId: string;
    inboxId: number;
    contactId: number;
    status?: 'open' | 'pending';
    teamId?: number;
    additionalAttributes?: Record<string, unknown>;
  }): Promise<ChatwootConversation> {
    const body = await this.request('POST', '/conversations', {
      json: {
        source_id: input.sourceId,
        inbox_id: input.inboxId,
        contact_id: input.contactId,
        status: input.status ?? 'open',
        ...(input.teamId ? { team_id: input.teamId } : {}),
        ...(input.additionalAttributes ? { additional_attributes: input.additionalAttributes } : {}),
      },
    });
    return unwrapObject(body) as ChatwootConversation;
  }

  async getConversation(conversationId: number): Promise<ChatwootConversation> {
    return unwrapObject(await this.request('GET', `/conversations/${conversationId}`)) as ChatwootConversation;
  }

  async listMessages(conversationId: number): Promise<ChatwootMessage[]> {
    return unwrapList<ChatwootMessage>(await this.request('GET', `/conversations/${conversationId}/messages`));
  }

  /** Message entrant (vu comme venant du client) avec un fichier joint, en multipart/form-data. */
  async createIncomingMessageWithAttachment(
    conversationId: number,
    input: { content: string; file: AudioFile },
  ): Promise<ChatwootMessage> {
    const form = new FormData();
    form.append('content', input.content);
    form.append('message_type', 'incoming');
    form.append('private', 'false');
    form.append('attachments[]', new Blob([input.file.data], { type: input.file.contentType }), input.file.filename);
    const body = await this.request('POST', `/conversations/${conversationId}/messages`, { form, timeoutMs: 60_000 });
    return unwrapObject(body) as ChatwootMessage;
  }

  /** Note privée : jamais envoyée au client. */
  async createPrivateNote(conversationId: number, content: string): Promise<ChatwootMessage> {
    const body = await this.request('POST', `/conversations/${conversationId}/messages`, {
      json: { content, message_type: 'outgoing', private: true },
    });
    return unwrapObject(body) as ChatwootMessage;
  }

  /** Réponse publique d'agent. Le service ne s'en sert jamais : seulement l'étape 0 (boîte courriel). */
  async createOutgoingMessage(conversationId: number, content: string): Promise<ChatwootMessage> {
    const body = await this.request('POST', `/conversations/${conversationId}/messages`, {
      json: { content, message_type: 'outgoing', private: false },
    });
    return unwrapObject(body) as ChatwootMessage;
  }

  async getConversationLabels(conversationId: number): Promise<string[]> {
    return unwrapList<string>(await this.request('GET', `/conversations/${conversationId}/labels`));
  }

  /**
   * Ajoute des étiquettes sans retirer celles déjà présentes : `POST /labels` remplace la liste complète
   * de la conversation, il faut donc lui envoyer l'union.
   */
  async addConversationLabels(conversationId: number, labels: string[]): Promise<string[]> {
    const current = await this.getConversationLabels(conversationId);
    const union = [...new Set([...current, ...labels])];
    if (union.length === current.length) return current;
    return unwrapList<string>(
      await this.request('POST', `/conversations/${conversationId}/labels`, { json: { labels: union } }),
    );
  }
}

// -------------------------------------------------------------------- formes des réponses

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ payload: {...} }`, `{ data: {...} }` ou l'objet lui-même. */
export function unwrapObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return {};
  if (isRecord(body.payload)) return body.payload;
  if (isRecord(body.data) && !('id' in body)) return isRecord(body.data.payload) ? body.data.payload : body.data;
  return body;
}

/** `{ payload: [...] }`, `{ data: { payload: [...] } }`, `{ data: [...] }` ou un tableau. */
export function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (!isRecord(body)) return [];
  if (Array.isArray(body.payload)) return body.payload as T[];
  if (isRecord(body.data)) {
    if (Array.isArray(body.data.payload)) return body.data.payload as T[];
  }
  if (Array.isArray(body.data)) return body.data as T[];
  return [];
}

/** Contact à la racine, sous `payload`, sous `payload.contact` ou sous `contact`. */
export function unwrapContact(body: unknown): ChatwootContact {
  const candidates: unknown[] = [];
  if (isRecord(body)) {
    if (isRecord(body.payload)) candidates.push(body.payload.contact, body.payload);
    candidates.push(body.contact, body);
  }
  const contact = candidates.find((candidate) => isRecord(candidate) && typeof candidate.id === 'number');
  if (!contact) throw new ChatwootError('?', '/contacts', 200, '', 'Réponse de contact sans id');
  return contact as ChatwootContact;
}

/** `source_id` du `contact_inbox` renvoyé par `POST /contacts`, s'il correspond à la boîte demandée. */
function unwrapCreatedSourceId(body: unknown, inboxId: number): string | null {
  if (!isRecord(body)) return null;
  const holder = isRecord(body.payload) ? body.payload : body;
  const contactInbox = holder.contact_inbox;
  if (!isRecord(contactInbox) || typeof contactInbox.source_id !== 'string') return null;
  const inbox = contactInbox.inbox;
  const id = isRecord(inbox) ? inbox.id : contactInbox.inbox_id;
  return id === undefined || id === inboxId ? contactInbox.source_id : null;
}

/** `source_id` du contact pour une boîte donnée, d'après `contact_inboxes`. */
export function sourceIdForInbox(contact: ChatwootContact, inboxId: number): string | null {
  const match = contact.contact_inboxes?.find((ci) => (ci.inbox?.id ?? ci.inbox_id) === inboxId);
  return match?.source_id ?? null;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
