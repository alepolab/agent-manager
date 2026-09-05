FROM oven/bun:1.3-slim AS build

WORKDIR /app

# Build tools for any native dependency
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source files (excluding node_modules via .dockerignore)
COPY . .

# Build the Nuxt application
RUN bun run build

# Production stage
FROM oven/bun:1.3-slim

WORKDIR /app

# Runtime dependencies: python3 for agent scripts, curl for the healthcheck, git for pipeline steps
RUN apt-get update && apt-get install -y \
    python3 \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy built application from build stage
COPY --from=build /app/.output .output

# Bake in a curated Claude config so the image is self-contained: plugins,
# skills, agents and settings travel with it, and a fresh host needs no
# ~/.claude of its own.
#
# The payload is produced by scripts/stage-claude-config.sh, which stages an
# allowlist and then refuses to proceed if anything credential-shaped or any
# session transcript made it in. Never COPY ~/.claude directly — it holds OAuth
# tokens and every transcript this machine has produced.
#
# docker-compose mounts a NAMED volume over this path. Docker seeds a new named
# volume from the image's contents on first creation, so these files become the
# starting state and anything the app writes afterwards persists in the volume.
# A bind mount would instead hide all of this.
COPY docker/claude-config /root/.claude

# Set environment variables
ENV HOST=0.0.0.0
ENV PORT=3030
ENV NODE_ENV=production

EXPOSE 3030

# Run the production server
CMD ["node", ".output/server/index.mjs"]
