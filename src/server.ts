import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import pkg from '../package.json' with { type: 'json' };
import { loadConfig, type Config } from './config.ts';

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-twilio-signature"]', 'req.headers.api_access_token'],
        censor: '[masqué]',
      },
    },
    // Railway place un proxy devant le service : l'URL publique vient de PUBLIC_BASE_URL, jamais des en-têtes.
    trustProxy: true,
  });

  // Twilio envoie ses webhooks en application/x-www-form-urlencoded.
  app.register(formbody);

  app.get('/healthz', async () => ({ ok: true, version: pkg.version }));

  // Les routes /voice/* (menu, enregistrement, traitement du message) arrivent après l'étape 0.

  return app;
}

if (import.meta.main) {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  const app = buildServer(config);
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'arrêt demandé');
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.fatal(error, 'démarrage impossible');
    process.exit(1);
  }
}
