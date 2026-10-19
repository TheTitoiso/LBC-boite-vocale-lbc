import { z } from 'zod';

// Messages d'erreur de zod en français.
z.config(z.locales.fr());

const positiveId = z.coerce.number().int().positive();
const flag = (defaultValue: boolean) => z.stringbool().default(defaultValue);

export const chatwootConfigSchema = z.object({
  CHATWOOT_BASE_URL: z.url().default('https://app.chatwoot.com'),
  CHATWOOT_ACCOUNT_ID: positiveId,
  CHATWOOT_API_TOKEN: z.string().min(1),
  // `header` : en-tête api_access_token (toutes versions). `bearer` : Authorization: Bearer (v4.19+).
  CHATWOOT_AUTH: z.enum(['header', 'bearer']).default('header'),
  CHATWOOT_INBOX_ID: positiveId,
  CHATWOOT_EMAIL_INBOX_ID: positiveId.optional(),
  CHATWOOT_TEAM_ID: positiveId.optional(),
  REUSE_CONVERSATION_HOURS: z.coerce.number().min(0).default(24),
});

export const shopifyConfigSchema = z.object({
  // Sous-domaine myshopify (`lesbellescombines`) ou domaine complet (`lesbellescombines.myshopify.com`).
  SHOPIFY_SHOP: z
    .string()
    .trim()
    .default('lesbellescombines')
    .transform((shop) => shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com\/?$/, ''))
    .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'sous-domaine myshopify attendu')),
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/).default('2026-10'),
  SHOPIFY_CLIENT_ID: z.string().min(1),
  SHOPIFY_CLIENT_SECRET: z.string().min(1),
});

export const twilioConfigSchema = z.object({
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-f]{32}$/, 'SID de compte Twilio attendu (AC…)'),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  DELETE_TWILIO_RECORDING: flag(true),
  MIN_RECORDING_SECONDS: z.coerce.number().int().min(0).default(3),
  MAX_RECORDING_SECONDS: z.coerce.number().int().min(10).max(14400).default(180),
  GREETING_AUDIO_URL_FR: z.url().optional(),
  GREETING_AUDIO_URL_EN: z.url().optional(),
});

export const configSchema = z
  .object({
    PUBLIC_BASE_URL: z.url().transform((url) => url.replace(/\/+$/, '')),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ORDER_STATUS_MODE: z.enum(['redirect', 'lookup']).default('redirect'),
    CHAT_MENTION_ENABLED: flag(false),
    TRANSCRIPTION_MODE: z.enum(['chatwoot', 'service']).default('chatwoot'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    ALERT_WEBHOOK_URL: z.url().optional(),
  })
  .extend(twilioConfigSchema.shape)
  .extend(shopifyConfigSchema.shape)
  .extend(chatwootConfigSchema.shape)
  .superRefine((config, ctx) => {
    if (config.TRANSCRIPTION_MODE === 'service' && !config.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'obligatoire quand TRANSCRIPTION_MODE=service',
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type ChatwootConfig = z.infer<typeof chatwootConfigSchema>;
export type ShopifyConfig = z.infer<typeof shopifyConfigSchema>;
export type TwilioConfig = z.infer<typeof twilioConfigSchema>;

type Env = Record<string, string | undefined>;

/**
 * Valide les variables d'environnement avec le schéma donné. Une variable vide compte comme absente,
 * pour que les lignes vides de `.env.example` prennent la valeur par défaut. Le message d'erreur
 * nomme les variables fautives, jamais leur valeur.
 */
export function parseEnv<S extends z.ZodType>(schema: S, env: Env = process.env): z.infer<S> {
  const present = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== ''),
  );
  const result = schema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? '(racine)');
      const absent = !(name in present) && issue.code !== 'custom';
      return `  - ${name} : ${absent ? 'obligatoire, absente ou vide' : issue.message}`;
    });
    throw new Error(`Configuration invalide :\n${problems.join('\n')}`);
  }
  return result.data;
}

export function loadConfig(env: Env = process.env): Config {
  return parseEnv(configSchema, env);
}
