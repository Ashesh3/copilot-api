FROM oven/bun:1.4.1-alpine@sha256:2ef545220f7a886f22fcb3f2309bbd6bcf1c0aa04b7d79c31765c7aa4a13aac1 AS builder
WORKDIR /app

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.4.1-alpine@sha256:2ef545220f7a886f22fcb3f2309bbd6bcf1c0aa04b7d79c31765c7aa4a13aac1 AS runner
WORKDIR /app

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --no-cache

COPY --from=builder /app/dist ./dist
COPY .env.schema ./

EXPOSE 4141

# Docker-friendly data directory for token persistence
ENV DATA_DIR=/app/data
VOLUME /app/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:4141/health/health || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
