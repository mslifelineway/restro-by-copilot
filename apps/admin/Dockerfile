# Build from the repo root:  docker build -f apps/admin/Dockerfile -t rms-admin .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/printer/package.json packages/printer/
RUN pnpm install --frozen-lockfile --filter @rms/admin...
COPY packages/shared packages/shared
COPY apps/admin apps/admin
RUN pnpm --filter @rms/shared build && pnpm --filter @rms/admin build

FROM node:22-alpine
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
# Next "standalone" output keeps the monorepo layout: server.js lives in apps/admin/
COPY --from=build /repo/apps/admin/.next/standalone ./
COPY --from=build /repo/apps/admin/.next/static ./apps/admin/.next/static
USER node
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]
