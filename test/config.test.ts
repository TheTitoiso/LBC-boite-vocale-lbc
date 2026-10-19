import { describe, expect, it } from 'vitest';
import { chatwootConfigSchema, loadConfig, parseEnv, shopifyConfigSchema } from '../src/config.ts';

const minimalEnv = {
  PUBLIC_BASE_URL: 'https://lbc-boite-vocale.up.railway.app/',
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'secret',
  SHOPIFY_CLIENT_ID: 'id',
  SHOPIFY_CLIENT_SECRET: 'secret',
  CHATWOOT_ACCOUNT_ID: '139187',
  CHATWOOT_API_TOKEN: 'token',
  CHATWOOT_INBOX_ID: '42',
};

describe('loadConfig', () => {
  it('applique les valeurs par défaut du brief', () => {
    const config = loadConfig(minimalEnv);
    expect(config).toMatchObject({
      PUBLIC_BASE_URL: 'https://lbc-boite-vocale.up.railway.app',
      PORT: 8080,
      DELETE_TWILIO_RECORDING: true,
      MIN_RECORDING_SECONDS: 3,
      MAX_RECORDING_SECONDS: 180,
      SHOPIFY_SHOP: 'lesbellescombines',
      SHOPIFY_API_VERSION: '2026-10',
      CHATWOOT_BASE_URL: 'https://app.chatwoot.com',
      CHATWOOT_ACCOUNT_ID: 139187,
      CHATWOOT_AUTH: 'header',
      CHATWOOT_INBOX_ID: 42,
      REUSE_CONVERSATION_HOURS: 24,
      ORDER_STATUS_MODE: 'redirect',
      CHAT_MENTION_ENABLED: false,
      TRANSCRIPTION_MODE: 'chatwoot',
    });
    expect(config.CHATWOOT_EMAIL_INBOX_ID).toBeUndefined();
  });

  it('une variable vide compte comme absente', () => {
    const config = loadConfig({ ...minimalEnv, CHATWOOT_EMAIL_INBOX_ID: '', GREETING_AUDIO_URL_FR: '  ', PORT: '' });
    expect(config.CHATWOOT_EMAIL_INBOX_ID).toBeUndefined();
    expect(config.GREETING_AUDIO_URL_FR).toBeUndefined();
    expect(config.PORT).toBe(8080);
  });

  it('nomme les variables fautives sans afficher leur valeur', () => {
    expect(() => loadConfig({ ...minimalEnv, TWILIO_ACCOUNT_SID: 'pas-un-sid', CHATWOOT_AUTH: 'basic' })).toThrow(
      /TWILIO_ACCOUNT_SID[\s\S]*CHATWOOT_AUTH|CHATWOOT_AUTH[\s\S]*TWILIO_ACCOUNT_SID/,
    );
    try {
      loadConfig({ ...minimalEnv, TWILIO_ACCOUNT_SID: 'pas-un-sid' });
    } catch (error) {
      expect((error as Error).message).not.toContain('pas-un-sid');
    }
  });

  it('exige OPENAI_API_KEY en mode service', () => {
    expect(() => loadConfig({ ...minimalEnv, TRANSCRIPTION_MODE: 'service' })).toThrow(/OPENAI_API_KEY/);
    expect(loadConfig({ ...minimalEnv, TRANSCRIPTION_MODE: 'service', OPENAI_API_KEY: 'sk-test' }).TRANSCRIPTION_MODE).toBe(
      'service',
    );
  });

  it('lit les booléens', () => {
    expect(loadConfig({ ...minimalEnv, DELETE_TWILIO_RECORDING: 'false', CHAT_MENTION_ENABLED: 'true' })).toMatchObject({
      DELETE_TWILIO_RECORDING: false,
      CHAT_MENTION_ENABLED: true,
    });
  });
});

describe('sous-schémas', () => {
  it('SHOPIFY_SHOP accepte le domaine complet', () => {
    const config = parseEnv(shopifyConfigSchema, {
      SHOPIFY_SHOP: 'https://lesbellescombines.myshopify.com/',
      SHOPIFY_CLIENT_ID: 'id',
      SHOPIFY_CLIENT_SECRET: 'secret',
    });
    expect(config.SHOPIFY_SHOP).toBe('lesbellescombines');
  });

  it('Chatwoot seul', () => {
    const config = parseEnv(chatwootConfigSchema, {
      CHATWOOT_ACCOUNT_ID: '139187',
      CHATWOOT_API_TOKEN: 'token',
      CHATWOOT_INBOX_ID: '42',
      CHATWOOT_AUTH: 'bearer',
    });
    expect(config.CHATWOOT_AUTH).toBe('bearer');
  });
});
