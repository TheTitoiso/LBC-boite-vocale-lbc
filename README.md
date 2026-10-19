# lbc-boite-vocale : boîte vocale des Belles Combines vers Chatwoot

Petit service Node qui répond au téléphone (menu Twilio), enregistre le message de l'appelant et le
dépose dans Chatwoot avec l'audio, son numéro et son courriel, en laissant Chatwoot faire ce qu'il sait
faire nativement (transcription par Captain, commandes Shopify, Copilot).

**État : étape 0** (validations avant de construire). Rapport : [`docs/etape-0.md`](docs/etape-0.md).
Les routes `/voice/*`, le traitement des messages et le guide d'installation complet (Twilio, Shopify,
Chatwoot, Railway) viennent ensuite.

## Développement

Node 24 exécute le TypeScript directement : pas d'étape de build.

```bash
npm ci
cp .env.example .env    # puis remplir
npm run dev             # serveur local, GET /healthz
npm test                # tests vitest
npm run typecheck       # vérification des types (tsc)
npm run spike -- help   # étape 0, voir docs/etape-0.md
```

## Structure

```
src/
  server.ts              Fastify, formbody, /healthz
  config.ts              validation zod des variables
  clients/chatwoot.ts    contacts, conversations, messages, étiquettes
  clients/shopify.ts     jeton (cache), CustomerByPhone
  lib/phone.ts           E.164, numéros masqués, affichage
  lib/redact.ts          masquage pour les journaux
  lib/format.ts          durées et dates (heure de Toronto)
  lib/dictation.ts       courriel dicté dans une transcription
scripts/spike.ts         étape 0
test/                    vitest + fixtures
Dockerfile
.env.example
```

Aucun secret dans ce dépôt : en production, les valeurs vivent seulement dans les variables Railway.
