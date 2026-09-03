FROM oven/bun:1.1-slim AS build

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
RUN bun install

# Build node-pty from source for ARM64
RUN bun add -g node-gyp
RUN cd node_modules/node-pty && \
    bun run install

# Copy source files (excluding node_modules via .dockerignore)
COPY . .

# Build the Nuxt application
RUN bun run build

# Production stage
FROM oven/bun:1.1-slim

WORKDIR /app

# Install runtime dependencies for node-pty and the healthcheck
RUN apt-get update && apt-get install -y \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy built application from build stage
COPY --from=build /app/.output .output

# Copy node-pty native bindings to production
COPY --from=build /app/node_modules/node-pty/build /app/.output/server/node_modules/node-pty/build

# Set environment variables
ENV HOST=0.0.0.0
ENV PORT=3030
ENV NODE_ENV=production

EXPOSE 3030

# Run the production server
CMD ["node", ".output/server/index.mjs"]
