# RUNVERSE API — multi-stage build
FROM node:22-slim AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN npm install --no-audit --no-fund
COPY packages/core packages/core
COPY apps/api apps/api
COPY migrations migrations
COPY tools tools
RUN npm run build -w @runverse/core && npm run build -w @runverse/api

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=development
COPY --from=build /app /app
EXPOSE 3000
# run migrations, then serve
CMD ["sh", "-c", "npx tsx apps/api/src/db/migrate.ts && node apps/api/dist/main.js"]
