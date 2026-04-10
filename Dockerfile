# ── Stage 1: Build the React frontend ──────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY scripts/ ./scripts/
RUN npm ci

COPY index.html vite.config.ts tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production runtime ────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Install Python + pip for yt-dlp fallback
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends python3 python3-pip curl wget ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    pip install --quiet --break-system-packages yt-dlp && \
    yt-dlp --version

# Install Node production deps (includes @distube/ytdl-core and youtubei.js)
COPY package*.json ./
COPY scripts/ ./scripts/
RUN npm ci --omit=dev

# Copy built frontend + server
COPY --from=builder /app/dist ./dist
COPY server.cjs ./

ENV PORT=7860
ENV NODE_ENV=production
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -sf http://localhost:7860/api/health || exit 1

CMD ["node", "server.cjs"]
