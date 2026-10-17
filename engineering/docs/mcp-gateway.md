# alepo-mcp gateway (v0)

Agent-manager serves an MCP server at `POST /api/mcp/gateway` (MCP Streamable
HTTP, stateless, JSON responses). A Claude Code session or a sandbox run talks
to Jira, Confluence, the product registry, the lab-host locks and the evidence
store through it, and never holds the credentials itself. Every call is
audit-logged with who made it, the arguments (redacted), the outcome and how
long it took.

Code: `server/utils/mcpGateway.ts` (tools, resources, policy),
`server/utils/envLocks.ts` (locks), `server/utils/mcpAudit.ts` (audit sink),
`server/api/mcp/gateway.ts` (transport), `server/api/env-locks/*` (operator
list/revoke). Test: `node scripts/test-mcp-gateway.mjs`.

## Authentication

The gateway is behind the same `/api/*` middleware as everything else. Two ways in:

- **Bearer API token** - `AGENT_MANAGER_API_TOKEN`, acting as the developer in
  `AGENT_MANAGER_API_LOGIN` (see `server/utils/session.ts`). This is what a
  Claude Code session or the sandbox runner uses. There is no per-run token in
  this repo yet; when one lands, the route only needs to accept it in
  `requireUser` and the gateway is unchanged.
- **Session cookie** - a signed-in browser. Not what you want for an agent.

The caller's **role** travels into the gateway: the three writing tools
(`jira.transition_with_evidence`, `env.request_lock`, `evidence.put`) refuse a
role that could not do the same thing through the UI (`answerGate` /
`startRun` in `shared/types/role.ts`). Reads need no capability.

## Tools

| Tool | What it does | Guard |
|---|---|---|
| `jira.get_issue(key)` | One issue with description as plain text | project must be in the allowlist |
| `jira.search(jql, maxResults<=50)` | JQL search | query must name allowed project(s); no negated project clause, no top-level `OR`; the query is wrapped as `project in (<allowed>) AND (<jql>)` |
| `jira.transition_with_evidence(key, transition, evidenceUrl, fields?)` | **The only write.** Moves an issue, setting fields on the transition screen | `evidenceUrl` must be `https://<AGENT_MANAGER_URL host>/...` or `artifact:<runId>/<name>` of an attached artifact; honours `JIRA_POST_ENABLED` (reports instead of posting when not `1`); records which Yes/No gate fields it set |
| `confluence.get_page(id)` | One page, storage body as text | page's space must be allowlisted (checked after the read; body not echoed on refusal) |
| `confluence.search(cql)` | CQL search | wrapped as `space in (<allowed>) AND (<cql>)`; a `space =` outside the list is refused |
| `registry.products()` | Every product with repos and projects | - |
| `registry.product(id)` | One product as `ProductMatch` | - |
| `registry.resolve(issueKey \| project+component)` | Which product a ticket routes to (same rules as the runner) | - |
| `env.request_lock(host, reason, ttlMinutes<=240)` | Issues `ALEPO_ENV_LOCK_TOKEN`; one holder per host; the holder may renew | `startRun` |
| `env.release_lock(token)` | Releases the lock the token names | - |
| `evidence.put(runId, bundle)` | Validates against `engineering/schemas/evidence-bundle.v0.2.schema.json` (else v0.1), stores `bundle.json` on the run, returns `{url, sha256}` | `startRun`; `bundle.ticket` must match the run's ticket |

Resources: `alepo://registry/products` (JSON) and
`alepo://ticket/{key}/context` (the same text as `GET /api/v1/tickets/:key/context`
when that route is present, else the equivalent from the run store).

### Allowlists (env wins over settings, as everywhere)

| Variable | Default |
|---|---|
| `ALEPO_MCP_JIRA_PROJECTS` | every project a registered product claims in `match.projects` |
| `ALEPO_MCP_CONFLUENCE_SPACES` | `RDPR, QAP, RDP, RD, RNDM, ASE13, AMS, ACSDOC, PMS, PPC, FFM` |
| `CONFLUENCE_BASE_URL` | `<JIRA_BASE_URL>/wiki` (Atlassian Cloud layout) |

Jira credentials are the instance's (`JIRA_BASE_URL`, `JIRA_EMAIL`,
`JIRA_API_TOKEN`), or the calling developer's own from their profile when set,
exactly as the runner's Jira step resolves them.

## Environment locks

`<CLAUDE_DIR>/env-locks.json`, one live lock per host, each with requester,
reason, issue and expiry times and the token. TTL defaults to 60 minutes and
is capped at 240. Operators:

```
GET    /api/env-locks          every lock in force (token shown as its last 4 chars)
DELETE /api/env-locks/:host    revoke; needs the runEngine capability (operator)
```

A session that holds a token exports it as `ALEPO_ENV_LOCK_TOKEN` before
deploying or running tests against the host; a hook that wants to insist on
one can check `verifyEnvLock(host, token)` from `server/utils/envLocks.ts`.

## Audit

Every tool call and resource read writes one record: `ts`, `actor`
(`api-token:<login>` or the session login), `kind: "mcp-call"`, `ref` (tool
name, or `resource:<uri>`), `payload` (`args` redacted - tokens by length,
bundles by size - `ok`, `error`, `ms`, plus tool notes such as the effective
JQL, the gate fields set, a lock's expiry or who held it).

Sink: when `server/utils/auditLog.ts` (the hash-chained instance log a sibling
change adds) is present, records go into that chain through `appendAudit`.
Otherwise they append to `<AGENT_RUNS_DIR>/audit/mcp.jsonl`. The test passes
against both.

## Registering the gateway

### Claude Code session (`.mcp.json` in the checkout, or `~/.claude.json`)

```json
{
  "mcpServers": {
    "alepo": {
      "type": "http",
      "url": "https://agent-manager.alepo.internal/api/mcp/gateway",
      "headers": {
        "Authorization": "Bearer ${AGENT_MANAGER_API_TOKEN}"
      }
    }
  }
}
```

`${AGENT_MANAGER_API_TOKEN}` is expanded by Claude Code from the session's
environment, so the token is never written into the file. Tools appear as
`mcp__alepo__jira.search` and so on.

### Sandbox runner

The runner passes the same block to the SDK's `mcpServers` option (or writes
it as the sandbox's `.mcp.json`) with the token from the instance environment:

```ts
mcpServers: {
  alepo: {
    type: 'http',
    url: `${process.env.AGENT_MANAGER_URL}/api/mcp/gateway`,
    headers: { Authorization: `Bearer ${process.env.AGENT_MANAGER_API_TOKEN}` },
  },
},
```

### Managed settings (`/etc/claude-code/managed-settings.json`, or the admin console)

Allow exactly this server and nothing else, so a session cannot be pointed at
a look-alike. Each `allowedMcpServers` entry carries one key; `serverUrl` is
the one that enforces (a `serverName` is only the label a user chose), and once
any `serverUrl` entry exists every remote server must match one:

```json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [
    { "serverUrl": "https://agent-manager.alepo.internal/api/mcp/gateway" }
  ],
  "permissions": {
    "allow": [
      "mcp__alepo__jira.get_issue",
      "mcp__alepo__jira.search",
      "mcp__alepo__confluence.get_page",
      "mcp__alepo__confluence.search",
      "mcp__alepo__registry.products",
      "mcp__alepo__registry.product",
      "mcp__alepo__registry.resolve",
      "mcp__alepo__env.request_lock",
      "mcp__alepo__env.release_lock",
      "mcp__alepo__evidence.put"
    ],
    "ask": [
      "mcp__alepo__jira.transition_with_evidence"
    ]
  }
}
```

The one write stays behind a permission prompt. See `managed-settings.md` for
how managed settings sit above every other settings file on a machine.

## Not in v0

- No per-run bearer token (none exists in the repo yet; see Authentication).
- No Jira comment, create or field edit outside a transition; no Confluence write.
- No streaming responses or server-initiated notifications (stateless JSON mode).
- Lock state is a file under `CLAUDE_DIR`: two instances share it only if they share that directory.
