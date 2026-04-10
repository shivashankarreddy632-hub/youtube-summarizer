# ── Stage 1: Build the React frontend ──────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency files first for better layer caching
COPY package*.json ./
COPY scripts/ ./scripts/

# Install all dependencies (includes devDependencies needed for build)
RUN npm ci

# Copy source files
COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./
COPY src/ ./src/

# Build the React app
RUN npm run build

# ── Stage 2: Production runtime ────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy package files and install only production dependencies
COPY package*.json ./
COPY scripts/ ./scripts/

# Install production deps only (skip devDependencies)
RUN npm ci --omit=dev

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy the Express server
COPY server.cjs ./

# Hugging Face Spaces exposes port 7860
ENV PORT=7860
ENV NODE_ENV=production

EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:7860/api/health || exit 1

# Start the server
CMD ["node", "server.cjs"]
