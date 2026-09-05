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

# Git credentials for private-repo imports.
#
# The app clones and ls-remotes with plain `git` subprocesses, so it inherits
# whatever credentials the environment provides. On the host that is the `gh`
# credential helper reading ~/.config/gh/hosts.yml; a container has neither gh
# nor that file, so private imports fail there while succeeding on the host —
# the same operation, two different answers, with nothing saying why.
#
# This helper supplies a token from the environment instead. The token is never
# written to disk and never echoed: git reads it on stdin-free stdout at the
# moment of use, and it lives only in the process environment.
#
# GITHUB_TOKEN unset OR empty means no credentials at all, and git falls back to
# unauthenticated access — public repos keep working. That distinction matters
# because compose's `${VAR:-}` DEFINES the variable as an empty string rather
# than leaving it absent, so a presence check alone would wrongly claim
# credentials exist and turn a clean "repo not found" into a confusing auth
# failure.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '[ "$1" = get ] || exit 0' \
      '[ -n "$GITHUB_TOKEN" ] || exit 0' \
      'echo username=x-access-token' \
      'echo "password=$GITHUB_TOKEN"' \
    > /usr/local/bin/git-credential-env \
    && chmod +x /usr/local/bin/git-credential-env \
    && git config --system credential."https://github.com".helper env 2>/dev/null || true

# Set environment variables
ENV HOST=0.0.0.0
ENV PORT=3030
ENV NODE_ENV=production

EXPOSE 3030

# Run the production server
CMD ["node", ".output/server/index.mjs"]
