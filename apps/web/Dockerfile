# DipBuyer AI web (Next.js). Builds the workspace and serves the web app.
# NEXT_PUBLIC_* are build-time; override via build args if the API is not on localhost:3001.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app .
EXPOSE 3000
CMD ["pnpm", "--filter", "@dipbuyer/web", "start"]
