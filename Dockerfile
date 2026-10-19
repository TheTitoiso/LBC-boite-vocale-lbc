# Image portable (Railway aujourd'hui, Cloud Run possible plus tard).
# Node 24 exécute le TypeScript directement (suppression native des types) : aucune étape de build.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
