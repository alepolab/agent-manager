# The sandboxed step runner image (server/utils/runner/sandbox.ts).
#
# Build, from the repository root:
#   docker build -f engineering/runner/Dockerfile -t ghcr.io/alepolab/agent-manager-runner:latest .
#
# One Claude Code process per step runs in a container of this image, driven
# over stdin/stdout by the Agent SDK on the host (the SDK's
# spawnClaudeCodeProcess). The image therefore needs exactly what that process
# needs: the `claude` CLI at the version the host SDK speaks, git for the
# worktree, gh for pull requests, a docker client for steps that build or run
# the product in containers, and the pinned alepo plugin skills the steps read.
#
# Why a thin image here and not FROM alepolab/claude-code-podman: that image is
# a Jira-key harness with its own ENTRYPOINT (run.sh), a renamed `xooa` user
# whose home paths a mirrored laptop config depends on, Playwright with a
# Chromium download, jira-cli, confluence-cli and the mcp-atlassian server -
# and run.sh exits 3 when ANTHROPIC_API_KEY is set, which is how the pipeline
# authenticates. Everything the SDK protocol needs is the first apt/npm layer
# of that Containerfile; layering on top of it would carry 1-2 GB of tooling
# the step cannot use and would fight its entrypoint. The two images share
# their base and their pinning convention, so a later merge is a FROM change.
#
# CLAUDE_CODE_VERSION must match the CLI the host's @anthropic-ai/claude-agent-sdk
# bundles (node_modules/@anthropic-ai/claude-agent-sdk/manifest.json: "version").
# The SDK and the CLI negotiate over the stream-json control protocol, and a
# mismatch surfaces as an initialize timeout, not as a clear error.
FROM docker.io/library/node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.263

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl jq ca-certificates gnupg python3 coreutils \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /usr/share/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends gh docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# The pinned alepo plugins the steps read at run time, at the paths the host
# env already names (SDLC_SCRIPTS_DIR etc. point under the host's engineering/,
# which the runner bind-mounts read-only at the same path). This copy is the
# fallback for an install whose engineering/ is not on a mountable path, and
# it pins the plugin version into the image digest the run records.
COPY engineering/.claude-plugin /opt/alepo/engineering/.claude-plugin
COPY engineering/hooks /opt/alepo/engineering/hooks
COPY engineering/scripts /opt/alepo/engineering/scripts
COPY engineering/schemas /opt/alepo/engineering/schemas
COPY engineering/skills /opt/alepo/engineering/skills
COPY engineering/vendor /opt/alepo/engineering/vendor

# Unprivileged. The runner may pass --user <uid:gid> (AGENT_SANDBOX_USER) so
# files written into the bind-mounted worktree belong to the host user that
# owns the clone; without it they belong to `node` (uid 1000), which is the
# common case on a single-developer host.
USER node
ENV HOME=/home/node
# CLAUDE_CONFIG_DIR is set by the runner to the staged config mount; nothing
# of the host's ~/.claude is ever in this image or mounted into it.
WORKDIR /work
LABEL org.opencontainers.image.title="agent-manager-runner" \
      org.opencontainers.image.description="Sandboxed Claude Code step runner for Agent Manager" \
      org.opencontainers.image.source="https://github.com/alepolab/agent-manager" \
      agent-manager.claude-code-version="${CLAUDE_CODE_VERSION}"
# No ENTRYPOINT: the runner passes `timeout <s> claude <args>` as the command.
