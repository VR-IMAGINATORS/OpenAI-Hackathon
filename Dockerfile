# Official node:22-bookworm-slim, resolved 2026-09-13 (Node v22.23.2).
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN node infra/codex/install.mjs /opt/codex
RUN CODEX_POC_BIN=/opt/codex/package/vendor/x86_64-unknown-linux-musl/bin/codex node --input-type=module -e "import { codexPreflight } from './dist/server/apps/server/codex-preflight.js'; await codexPreflight();"
RUN npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4310
ENV HOST=0.0.0.0
ENV CODEX_POC_BIN=/opt/codex/package/vendor/x86_64-unknown-linux-musl/bin/codex
COPY --from=build /opt/codex /opt/codex
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/scenarios ./scenarios
COPY --from=build --chown=node:node /app/config ./config
USER node
EXPOSE 4310
CMD ["node", "dist/server/apps/server/index.js"]
