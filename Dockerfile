# ── Stage 1: Build the React frontend ──────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY scripts/ ./scripts/

RUN npm ci

COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production runtime ────────────────────────────────────────────────
# Using node:20-slim (Debian/glibc) — required for yt-dlp impersonate mode
FROM node:20-slim AS runtime

WORKDIR /app

# Install Python3 + pip + curl-impersonate dependencies for yt-dlp
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
      python3 python3-pip curl wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (works on Debian glibc without issues)
RUN pip install --quiet --break-system-packages yt-dlp && \
    yt-dlp --version

# Copy package files and install ALL production deps
COPY package*.json ./
COPY scripts/ ./scripts/

RUN npm ci --omit=dev

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy the Express server
COPY server.cjs ./

# Hugging Face Spaces uses port 7860
ENV PORT=7860
ENV NODE_ENV=production

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -sf http://localhost:7860/api/health || exit 1

CMD ["node", "server.cjs"]
