import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { buildServer } from '../src/server.ts';

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://lbc-boite-vocale.up.railway.app',
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'secret',
  SHOPIFY_CLIENT_ID: 'id',
  SHOPIFY_CLIENT_SECRET: 'secret',
  CHATWOOT_ACCOUNT_ID: '1',
  CHATWOOT_API_TOKEN: 'token',
  CHATWOOT_INBOX_ID: '1',
  LOG_LEVEL: 'silent',
});

describe('serveur', () => {
  it('GET /healthz', async () => {
    const app = buildServer(config);
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it('aucune autre route publique', async () => {
    const app = buildServer(config);
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
