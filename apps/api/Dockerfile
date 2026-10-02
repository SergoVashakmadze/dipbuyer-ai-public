# DipBuyer AI API. Builds only the API and the workspace packages it depends on (not the web app).
# Build context = repository root:  docker build -f apps/api/Dockerfile .
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@dipbuyer/api...

FROM node:24-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app .
# Investor records and agent runs (personal data) live on a mounted volume, never in the image.
ENV INVESTOR_STORE_PATH=/data/investors.json AGENT_RUNS_PATH=/data/agent-runs.json
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
