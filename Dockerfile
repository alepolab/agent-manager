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
COPY --from=build --chown=bun:bun /app/.output .output

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
# The product's own skills. teamSync seeds a team instance from the INSTALLED
# alepo-engineering plugin when there is one and falls back to these when there
# is not - the normal case in a container. Without them a fresh team instance
# boots "9 agents, 0 skills": every agent declares skills that cannot resolve,
# and because buildAgentSystemPrompt swallows a per-skill failure by design,
# each agent silently runs without the instructions it was supposed to have.
COPY --chown=bun:bun engineering/skills ./engineering/skills

# And its commands, for the same reason one level down. teamSync falls back to
# these when no plugin is installed. Without this COPY the fallback finds
# nothing and a container seeds zero commands - which is what shipped, because
# the staged ~/.claude payload below happened to carry the operator's own
# commands and made the gap look filled on the one box that built the image.
COPY --chown=bun:bun engineering/commands ./engineering/commands

COPY --chown=bun:bun docker/claude-config /root/.claude

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

# GitHub CLI.
#
# sdlc-evidence-and-pr opens the pull request that is the whole pipeline's
# deliverable. Without `gh` it would improvise against the REST API or fail
# outright — after seven successful steps have already spent real money.
#
# The single binary from the release tarball, not the apt repository: apt drags
# in a keyring and dependency closure for one executable. Pinned by version and
# verified by checksum, so a moved tag cannot change what lands in the image.
ARG GH_VERSION=2.100.0
ARG GH_SHA256=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be
RUN set -eux; \
    url="https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    curl -fsSL "$url" -o /tmp/gh.tgz; \
    echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"; \
    gh --version

# Run as a non-root user.
#
# Not hygiene — a hard requirement. agentCaller.ts starts every pipeline agent
# with permissionMode 'bypassPermissions' and allowDangerouslySkipPermissions,
# and Claude Code refuses both when it is running as root:
#
#   --dangerously-skip-permissions cannot be used with root/sudo privileges
#   for security reasons
#
# The SDK surfaces that only as "Claude Code process exited with code 1", so a
# deployed team instance failed every run at its first step with no usable
# reason. Verified both ways in the container: as uid 0 the CLI refuses, as
# uid 1000 the same command returns normally.
#
# `bun` (uid 1000) already exists in the base image. Both compose files put
# their config somewhere this user must be able to write: standalone at
# /root/.claude, team mode at /srv/agent-manager. /root is 700 by default, so
# it needs traverse permission as well as ownership of the directory inside it.
#
# A named volume created fresh inherits ownership from the image path, so a new
# deployment is correct on its own. An EXISTING root-owned volume does not — it
# must be chowned once, which is preferable to deleting it and losing the
# signed-in developers' sealed tokens:
#
#   docker run --rm -u 0 -v <project>_team-home:/srv/agent-manager \
#     <image> chown -R 1000:1000 /srv/agent-manager
# Ownership comes from `COPY --chown` above, not a recursive chown here. A
# `chown -R` over /app and /root/.claude rewrites every file into a new layer:
# it cost 106 MB (433 -> 539) for metadata changes alone, because a layer stores
# whole files, not the bits that differ.
RUN mkdir -p /srv/agent-manager /root/.agent-manager/workflow-runs \
    && chmod 711 /root \
    && chown bun:bun /app /srv/agent-manager /root/.agent-manager /root/.agent-manager/workflow-runs
USER bun

# Set environment variables
ENV HOST=0.0.0.0
ENV PORT=3030
ENV NODE_ENV=production

EXPOSE 3030

# Run the production server
CMD ["node", ".output/server/index.mjs"]
