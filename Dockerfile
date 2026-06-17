# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci

# ── Stage 2: builder ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: runner ───────────────────────────────────────────────────────────
FROM node:20-bookworm AS runner
WORKDIR /app

# Install LibreOffice for PPTX → PNG conversion and poppler-utils for PDF → PNG
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libreoffice \
      libreoffice-impress \
      fonts-liberation \
      fonts-dejavu \
      poppler-utils \
      && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy built app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/public ./public

# Compile server.ts → server.js (fast startup, no tsx overhead)
RUN node_modules/.bin/esbuild server.ts \
    --platform=node \
    --target=node20 \
    --format=cjs \
    --bundle \
    --packages=external \
    --outfile=server.js

# Ensure runtime dirs exist (but we store slides in memory, not disk)
RUN mkdir -p tmp

EXPOSE 3000

CMD ["node", "server.js"]
