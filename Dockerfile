FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build
# Operational CLIs compiled to plain Node (dist/ops/*.cjs). Their only
# non-builtin runtime dependency is @prisma/client, so they run in ANY image
# stage with `node dist/ops/<tool>.cjs …` — no tsx / dev dependencies needed.
RUN npm run ops:build

# One-off operational tasks ONLY (prisma migrate deploy, the approval-gated
# working-days backfill and its validation). Never started by
# `docker compose up` — it sits behind the "ops" Compose profile and runs
# exclusively via `docker compose --profile ops run --rm kinsen-helpdesk-ops …`.
# See docs/working-days-deployment.md. Nothing in this stage (or any other)
# performs a data backfill at application startup.
FROM builder AS ops
ENV NODE_ENV=production
CMD ["node", "dist/ops/working-days-backfill.cjs", "status"]

# The application image — unchanged behaviour (still the default/last stage,
# so `build: .` keeps building exactly this).
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app ./

EXPOSE 3000
CMD ["npm", "run", "start"]
