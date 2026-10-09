# pwmig/agent-runner: Agent Manager (production build, bun) + everything the porting agents run:
# node + Playwright chromium (base image), git, flock, curl, python venv with robotframework.
# Build context: the agentmanager repo root.
#   docker build -f deploy/robot-migration/images/agent-runner.Dockerfile -t pwmig/agent-runner .
FROM oven/bun:1.3-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM mcr.microsoft.com/playwright:v1.63.0-noble
LABEL pwmig=1
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates python3 python3-venv util-linux \
    && rm -rf /var/lib/apt/lists/*
# robot_inventory.py / robot_model.py parse the Robot suite with Robot Framework's own parser.
RUN python3 -m venv /opt/robot && /opt/robot/bin/pip install --no-cache-dir robotframework==6.1.1
ENV PATH=/opt/robot/bin:$PATH
# The `claude` CLI, for the one-time login inside the container (docker exec -it pwmig-am claude).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
WORKDIR /app
COPY --from=build /app/.output .output
# The SDK's native Claude Code binary is loaded at runtime, so Nitro's tracing leaves it out of .output.
COPY --from=build /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 .output/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64
# Hooks (plan-gate, test-lock, secrets-guard) are found relative to the cwd; every agent call needs them.
COPY engineering ./engineering
COPY deploy/robot-migration/runner /opt/pwmig
COPY deploy/robot-migration/state /opt/pwmig/state
RUN chmod +x /opt/pwmig/*.sh && chown -R pwuser:pwuser /app && mkdir -p /data /work /home/pwuser/.claude && chown pwuser:pwuser /data /work /home/pwuser/.claude
USER pwuser
ENV HOME=/home/pwuser
# Browsers matching the suite's own @playwright/test, installed on first boot into the state volume.
ENV PLAYWRIGHT_BROWSERS_PATH=/data/ms-playwright
EXPOSE 3030
ENTRYPOINT ["/opt/pwmig/entrypoint.sh"]
