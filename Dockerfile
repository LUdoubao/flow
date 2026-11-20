FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.6.4 --activate
COPY . .
RUN pnpm dlx turbo@1.11.3 prune --scope=@flow/reader --docker

FROM node:20-bookworm-slim AS installer
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.6.4 --activate
COPY .gitignore .gitignore
COPY --from=builder /app/out/json/ ./
COPY --from=builder /app/out/pnpm-*.yaml ./
# turbo prune 1.11.3 生成的裁剪锁文件会遗漏根 workspace 的部分条目。
RUN pnpm install --no-frozen-lockfile
COPY --from=builder /app/out/full/ ./
COPY turbo.json turbo.json
COPY tsconfig.*json ./
ARG FLOW_BASE_PATH=/flow
RUN DOCKER=1 FLOW_BASE_PATH=${FLOW_BASE_PATH} pnpm --filter @flow/reader build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
# Standalone 输出需要在运行时读取 public 下的 PWA 文件。
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV FLOW_BASE_PATH=/flow
USER nextjs
COPY --from=installer /app/apps/reader/next.config.js ./apps/reader/next.config.js
COPY --from=installer /app/apps/reader/package.json ./apps/reader/package.json
COPY --from=installer --chown=nextjs:nodejs /app/apps/reader/public ./apps/reader/public
COPY --from=installer --chown=nextjs:nodejs /app/apps/reader/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/reader/.next/static ./apps/reader/.next/static
CMD ["node", "apps/reader/server.js"]
