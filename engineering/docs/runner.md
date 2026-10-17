# Step runner: host or sandbox

Where a step's Claude Code process runs. Code: `server/utils/runner/{index,host,sandbox}.ts`,
wired from `server/utils/agentCaller.ts` (the spawn) and `server/utils/workflowRunner.ts`
(the decision, once per run, in `finishRun`).

## Selection

`settings.json` → `agentManager.runnerMode`, or `AGENT_RUNNER_MODE` (non-empty wins):

| mode | behaviour |
|---|---|
| `host` (default) | every step on the host, exactly as before this existed |
| `sandbox` | every step in a container; no image → host, recorded as a `runner` warn check on the run's preflight |
| `policy` | the risk policy's `sandbox` column for the run's blast radius: `required` → sandbox, `preferred`/`optional` → host. No `shared/utils/riskPolicy.ts` on the build (it is on another branch) → host |

The decision is made once, after preflight, and recorded as
`run.sandbox = { image, digest, egressProfile }` (absent = host). Every step of the run then
uses it. A test run (`testOf`) always runs on the host. The choice and its reason are logged
(`runner selected`). Tests: `scripts/test-runner-selection.mjs`.

## How the SDK still drives the step

The Agent SDK's `query()` keeps running on the host. For a sandboxed step `callAgent` passes
the SDK `spawnClaudeCodeProcess`, which runs `docker run -i … <image> timeout <s> claude
<the SDK's own CLI args>` and returns the docker client process. Its stdin/stdout are the
CLI's, so the stream-json control protocol, the hooks (`pipelineHooks`), steering notes,
`resume`, the `result` interpretation and the live-log lines are byte-for-byte what the host
path sees. Nothing in `messageNormalizer` or the step pipeline changes; `claude -p
--output-format stream-json` re-parsing was not needed. The one constraint this creates:
the image's Claude Code version must match the CLI the host SDK bundles
(`node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`), see the Dockerfile.

## One container per step

Fresh container per step (`--rm`, foreground), not per run. Simpler: nothing outlives the SDK
process that spawned it, and teardown is "the client exited" plus a labelled sweep
(`agent-manager.sandbox=<run id>`) in `runTeardown.ts` for anything left when the run ends.
The worktree persists between steps because it is the host's.

## What the container gets

- The run's git worktree bind-mounted **at the same host path**, and the clone it belongs to
  (`<clone>@<branch>` → `<clone>`) beside it, because a worktree's `.git` is a pointer into
  the clone. Every recorded path stays true inside.
- A per-run staged config dir at `/sandbox/claude` (`CLAUDE_CONFIG_DIR`), built by
  `stageSandboxConfig` on the `stage-claude-config.sh` allowlist: `agents`, `skills`,
  `commands`, `output-styles`, `plugins`; never `.credentials.json`, `projects/`,
  `history.jsonl`, keys, `node_modules`, marketplace clones. **The host `~/.claude` is never
  mounted.** Authentication is `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` in the env.
- `engineering/` read-only at its host path (hooks, scripts, skills, vendored review skill).
- Env **allowlist only** (`SANDBOX_ENV_ALLOW`): `ANTHROPIC_*`, proxy vars, `NODE_EXTRA_CA_CERTS`,
  `JIRA_*`, `GH_TOKEN`/`GITHUB_TOKEN`, `AGENT_MANAGER_URL`/`AGENT_MANAGER_API_TOKEN`,
  `SDLC_*`/`CE_SKILLS_DIR`/`ALEPO_SKILLS_DIR`, git identity, `OTEL_*`, plus always
  `ALEPO_PIPELINE=1`, `ALEPO_STOP_GATE=1`. Passed as `-e NAME` (never a value on the command
  line) from a client env that holds only those values. Server secrets, SMTP, Slack, the
  session key and `AGENT_GH_TOKEN` itself do not cross. Test: `scripts/test-sandbox-env-allowlist.mjs`.
- Limits: `--cpus` (2), `--memory` (4g), `--pids-limit` (512) from `settings.sandbox`;
  `--cap-drop ALL`, `no-new-privileges`; wall clock = run budget minutes + 5 min via
  `timeout --signal=TERM --kill-after=30` inside, so a step can report before it is cut.
- GitHub token: the existing resolution (profile token → `AGENT_GH_TOKEN` → host `gh`) via
  `launchEnv`. `githubTokenFor` in `sandbox.ts` is the hook for a GitHub App installation
  token scoped to the run's repos (TODO in code).

## Egress (v1) and residual risk

Every sandbox joins a dedicated bridge network `agent-manager-sandbox`
(`ensureSandboxNetwork`), not the default bridge, so host-level rules can target it. v1 is
**"bridge + proxy only"** by convention, recorded on the run as `egressProfile`
(`settings.sandbox.egressProfile` / `AGENT_SANDBOX_EGRESS`, default `bridge-proxy-only`):

1. Point the CLI at a proxy: set `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (and
   `ANTHROPIC_BASE_URL` if a gateway fronts the API) on the Agent Manager host; they are
   allowlisted into the container.
2. Deny direct egress from the sandbox network except to the proxy, on the Docker host:
   ```
   # subnet from: docker network inspect agent-manager-sandbox -f '{{(index .IPAM.Config 0).Subnet}}'
   iptables -I DOCKER-USER -s <subnet> -d <proxy ip> -p tcp --dport <proxy port> -j ACCEPT
   iptables -I DOCKER-USER -s <subnet> -d <docker host ip>  -j ACCEPT   # Agent Manager API, if local
   iptables -I DOCKER-USER -s <subnet> ! -d <subnet> -j DROP
   ```
   (`DOCKER-USER` is evaluated before Docker's own forwarding rules and survives daemon
   restarts if persisted with `iptables-save`.)
3. Stricter: create the network with `--internal` and reach the proxy through a second
   container on the same network; then `--network agent-manager-sandbox` is sufficient and no
   host rule is needed. Not the default because `git push`/`gh` need the proxy to allow
   GitHub too.

**Residual risk, stated plainly.** Without step 2 the sandbox has full outbound network
through Docker NAT; the env allowlist limits *what it can leak*, not *where to*. The worktree
and clone are writable (that is the job), so a malicious step can still commit anything into
the run branch — the plan gate, test lock and secrets guard hooks run inside as before, and
the PR review is the real control. The docker socket is **not** mounted, so a step that
builds the product in containers cannot do so in sandbox mode in v1 (steps that need
`docker compose` remain host-only until a rootless DinD or a socket proxy is added). Bind
mounts are written as the container user (`node`, uid 1000, or `AGENT_SANDBOX_USER`); on a
host where the clone belongs to another uid, set `AGENT_SANDBOX_USER=<uid>:<gid>`.

## Image

`engineering/runner/Dockerfile`, a thin image: `node:22-bookworm-slim` + pinned
`@anthropic-ai/claude-code` + git + gh + docker CLI + the pinned alepo plugin files under
`/opt/alepo/engineering`. Not `FROM alepolab/claude-code-podman`: that image is a Jira-key
harness (its own `run.sh` entrypoint, a renamed `xooa` user, Playwright/Chromium, jira-cli,
confluence-cli, mcp-atlassian) and its entrypoint refuses `ANTHROPIC_API_KEY`, which is how
the pipeline authenticates. Same base and pinning convention, so merging later is a `FROM`
change. Build: `docker build -f engineering/runner/Dockerfile -t ghcr.io/alepolab/agent-manager-runner:latest .`
Override with `settings.sandbox.image` or `AGENT_SANDBOX_IMAGE`. CI does not build or push
this image yet.

## Settings

```json
{ "agentManager": {
  "runnerMode": "policy",
  "sandbox": { "image": "ghcr.io/alepolab/agent-manager-runner:latest", "cpus": "2", "memory": "4g", "pidsLimit": 512, "egressProfile": "bridge-proxy-only" }
} }
```
