FROM oven/bun:1.3-slim AS build

WORKDIR /app

# Install build dependencies for node-pty (native module)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Build node-pty from source for ARM64
RUN bun add -g node-gyp
RUN cd node_modules/node-pty && \
    bun run install

# Copy source files (excluding node_modules via .dockerignore)
COPY . .

# Build the Nuxt application
RUN bun run build

# Production stage
FROM oven/bun:1.3-slim

WORKDIR /app

# Install runtime dependencies for node-pty and the healthcheck
RUN apt-get update && apt-get install -y \
    python3 \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy built application from build stage
COPY --from=build /app/.output .output

# Copy node-pty native bindings to production
COPY --from=build /app/node_modules/node-pty/build /app/.output/server/node_modules/node-pty/build

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
