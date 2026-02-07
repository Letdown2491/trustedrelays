FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY public/ ./public/

# Create data directory
RUN mkdir -p /app/data

# Default port for API
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Run daemon by default
CMD ["bun", "run", "--smol", "src/index.ts", "daemon"]
