# ── Stage 1: Build the React frontend ──────────────────────────────────────────
FROM node:20-alpine AS builder

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
FROM node:20-alpine AS runtime

WORKDIR /app

# Install Python3 + pip so we can install yt-dlp via pip
# (The yt-dlp_linux binary doesn't work on Alpine/musl — pip version does)
RUN apk add --no-cache python3 py3-pip \
    && pip install --quiet --break-system-packages yt-dlp \
    && yt-dlp --version

# Copy package files and install production deps only
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
  CMD wget -qO- http://localhost:7860/api/health || exit 1

CMD ["node", "server.cjs"]
