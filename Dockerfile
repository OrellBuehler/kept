# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun --bun run build

FROM oven/bun:1-alpine AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1-alpine AS runner
ARG APP_VERSION=dev
ARG GIT_HASH=unknown
ARG BUILD_TIMESTAMP=unknown
LABEL org.opencontainers.image.title="kept" \
      org.opencontainers.image.description="Self-hosted personal finance" \
      org.opencontainers.image.source="https://github.com/OrellBuehler/kept" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_HASH}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}"
WORKDIR /app
RUN apk upgrade --no-cache && \
    addgroup -S -g 1001 kept && adduser -S -u 1001 -G kept kept && \
    mkdir -p /data && chown kept:kept /data
COPY --from=prod-deps --chown=kept:kept /app/node_modules ./node_modules
COPY --from=builder --chown=kept:kept /app/build ./build
COPY --from=builder --chown=kept:kept /app/drizzle ./drizzle
COPY --chown=kept:kept package.json ./
USER kept
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/kept.db \
    BODY_SIZE_LIMIT=25M \
    APP_VERSION=${APP_VERSION}
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["bun", "--smol", "./build/index.js"]
