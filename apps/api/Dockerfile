# Build from the repo root:  docker build -f apps/api/Dockerfile -t rms-api .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/printer/package.json packages/printer/
RUN pnpm install --frozen-lockfile --filter @rms/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @rms/shared build && pnpm --filter @rms/api build
# production dependency tree (workspace package @rms/shared is copied in)
RUN pnpm --filter @rms/api deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 3100
# Migrations are a separate step:  docker run --rm <image> node dist/db/migrate.js
CMD ["node", "dist/main.js"]
