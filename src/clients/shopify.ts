import { redactBody } from '../lib/redact.ts';

/**
 * Client Shopify Admin GraphQL. Le jeton vient du « client credentials grant » d'une app du Dev Dashboard
 * (les apps personnalisées classiques ne se créent plus depuis le 1er janvier 2026). Il dure 24 h : on le
 * garde en mémoire et on le renouvelle avant son expiration.
 */

export const CUSTOMER_BY_PHONE = /* GraphQL */ `
  query CustomerByPhone($q: String!) {
    customers(first: 1, query: $q) {
      nodes {
        id
        displayName
        firstName
        lastName
        defaultEmailAddress { emailAddress }
        numberOfOrders
        lastOrder { name displayFulfillmentStatus }
      }
    }
  }
`;

export interface ShopifyCustomer {
  id: string;
  name: string | null;
  email: string | null;
  numberOfOrders: number;
  lastOrder: { name: string; fulfillmentStatus: string | null } | null;
}

export interface ShopifyClientOptions {
  shop: string;
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ShopifyError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ShopifyError';
    this.status = status;
    this.code = code;
  }
}

/** Marge avant l'expiration du jeton : on le renouvelle 5 minutes avant. */
const TOKEN_RENEWAL_MARGIN_MS = 5 * 60_000;

export class ShopifyClient {
  private readonly options: ShopifyClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number; scope: string } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(options: ShopifyClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get shopDomain(): string {
    return `${this.options.shop}.myshopify.com`;
  }

  /** Portées accordées au jeton courant (vide tant qu'aucun jeton n'a été demandé). */
  get grantedScopes(): string[] {
    return this.token?.scope.split(',').filter(Boolean) ?? [];
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_RENEWAL_MARGIN_MS > this.now()) return this.token.value;
    // Une seule demande à la fois, même si plusieurs messages arrivent ensemble.
    this.pendingToken ??= this.requestToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async requestToken(): Promise<string> {
    const response = await this.send(`https://${this.shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }),
    });
    const text = await response.text();
    const body = parseJson(text) as { access_token?: string; scope?: string; expires_in?: number; error?: string } | undefined;

    if (!response.ok || !body?.access_token) {
      const code = body?.error;
      const hint =
        code === 'shop_not_permitted'
          ? " : l'app du Dev Dashboard et la boutique ne sont pas dans la même organisation"
          : '';
      throw new ShopifyError(`Jeton Shopify refusé (HTTP ${response.status}${code ? `, ${code}` : ''})${hint}`, response.status, code);
    }

    const expiresInMs = (body.expires_in ?? 86_399) * 1000;
    this.token = { value: body.access_token, expiresAt: this.now() + expiresInMs, scope: body.scope ?? '' };
    return body.access_token;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const token = await this.getAccessToken();
      const response = await this.send(
        `https://${this.shopDomain}/admin/api/${this.options.apiVersion}/graphql.json`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query, variables }),
        },
      );
      const text = await response.text();

      // Jeton révoqué ou expiré plus tôt que prévu : on en redemande un, une seule fois.
      if (response.status === 401 && attempt === 1) {
        this.token = null;
        continue;
      }
      if (!response.ok) {
        throw new ShopifyError(`Shopify GraphQL : HTTP ${response.status} ${redactBody(text)}`, response.status);
      }

      const body = parseJson(text) as { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> } | undefined;
      const errors = body?.errors ?? [];
      if (errors.some((error) => error.extensions?.code === 'THROTTLED') && attempt === 1) {
        await sleep(1000);
        continue;
      }
      if (errors.length > 0 || !body?.data) {
        const message = errors.map((error) => error.message).join(' · ') || 'réponse sans données';
        throw new ShopifyError(`Shopify GraphQL : ${redactBody(message)}`, response.status, errors[0]?.extensions?.code);
      }
      return body.data;
    }
  }

  /** Client Shopify dont un numéro (fiche ou adresse) correspond exactement au numéro E.164 donné. */
  async findCustomerByPhone(e164: string): Promise<ShopifyCustomer | null> {
    const data = await this.graphql<{ customers: { nodes: RawCustomer[] } }>(CUSTOMER_BY_PHONE, { q: `phone:${e164}` });
    const raw = data.customers.nodes[0];
    return raw ? toCustomer(raw) : null;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000) });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'délai dépassé' : 'erreur réseau';
      throw new ShopifyError(`Shopify injoignable (${reason})`, 0);
    }
  }
}

interface RawCustomer {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  defaultEmailAddress: { emailAddress: string | null } | null;
  // UnsignedInt64 : Shopify le renvoie sous forme de chaîne (« 5 »).
  numberOfOrders: string | number;
  lastOrder: { name: string; displayFulfillmentStatus: string | null } | null;
}

function toCustomer(raw: RawCustomer): ShopifyCustomer {
  const fullName = [raw.firstName, raw.lastName].filter(Boolean).join(' ').trim();
  // Sans prénom ni nom, Shopify met le courriel ou le téléphone dans displayName : ce n'est pas un nom.
  const displayName = raw.displayName?.trim() ?? '';
  const looksLikeName = displayName !== '' && !displayName.includes('@') && !/^\+?[\d\s().-]+$/.test(displayName);
  return {
    id: raw.id,
    name: fullName || (looksLikeName ? displayName : null),
    email: raw.defaultEmailAddress?.emailAddress ?? null,
    numberOfOrders: Number(raw.numberOfOrders) || 0,
    lastOrder: raw.lastOrder ? { name: raw.lastOrder.name, fulfillmentStatus: raw.lastOrder.displayFulfillmentStatus } : null,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
