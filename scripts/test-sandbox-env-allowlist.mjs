/**
 * What a sandboxed step's container is given, checked on the spec alone -
 * no Docker involved.
 *
 *   1. Only allowlisted environment reaches the container: the model
 *      credentials and proxy, Jira, the GitHub token, this instance's URL and
 *      token, git identity, the pipeline flags. The server's own secrets, the
 *      session key, SMTP, AWS, and anything else in the host process do not.
 *   2. The host's ~/.claude is never mounted. CLAUDE_CONFIG_DIR inside points
 *      at the staged directory, and the staged directory carries no
 *      credentials, transcripts or history.
 *   3. cpu, memory and pid limits are on the command line, and the wall clock
 *      comes from the run budget.
 *   4. The worktree is mounted at the same path, with its clone beside it, and
 *      the CLI arguments the SDK built are passed through unchanged.
 *   5. The env the docker CLIENT is spawned with holds nothing but the
 *      allowlisted values (plus PATH/HOME/DOCKER_HOST for docker itself), so a
 *      `-e NAME` can only ever read an allowlisted name.
 *
 *   node scripts/test-sandbox-env-allowlist.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'sandbox-allowlist-'))
process.env.CLAUDE_DIR = CLAUDE_DIR

const sb = await import('../server/utils/runner/sandbox.ts')
const { withOtelAttributes } = await import('../server/utils/agentCaller.ts')

const hostEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_MODEL: 'sonnet',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth', HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost',
  JIRA_EMAIL: 'bot@alepo.com', JIRA_API_TOKEN: 'jt', JIRA_BASE_URL: 'https://alepo.atlassian.net',
  GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_x',
  AGENT_MANAGER_URL: 'http://am:3030', AGENT_MANAGER_API_TOKEN: 'amt',
  SDLC_SCRIPTS_DIR: '/app/engineering/scripts', SDLC_SKILLS_DIR: '/root/.claude/skills', CE_SKILLS_DIR: '', ALEPO_SKILLS_DIR: '/app/engineering/vendor/developer-workflow/skills',
  GIT_AUTHOR_NAME: 'bot', GIT_AUTHOR_EMAIL: 'bot@x', GIT_COMMITTER_NAME: 'bot', GIT_COMMITTER_EMAIL: 'bot@x',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
  OTEL_RESOURCE_ATTRIBUTES: 'run_id=r1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318', CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  // Must NOT cross.
  AGENT_MANAGER_SERVER_SECRET: 'secret', NUXT_SESSION_PASSWORD: 'sess', SMTP_PASSWORD: 'smtp', AWS_SECRET_ACCESS_KEY: 'aws',
  AGENT_GH_TOKEN: 'ghp_bot', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x', AGENT_MANAGER_LOGIN_PASSWORD_HASH: 'h',
  HOME: '/home/op', PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/home/op/.claude', CLAUDE_DIR: '/home/op/.claude', DOCKER_CONFIG: '/home/op/.docker',
  NODE_OPTIONS: '--inspect', SOME_RANDOM_HOST_VAR: 'x', DATABASE_URL: 'postgres://',
}

// ── 1. the allowlist ─────────────────────────────────────────────────────────
const env = sb.allowlistEnv(hostEnv)
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'NO_PROXY',
  'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_BASE_URL', 'GH_TOKEN', 'GITHUB_TOKEN', 'AGENT_MANAGER_URL', 'AGENT_MANAGER_API_TOKEN',
  'SDLC_SCRIPTS_DIR', 'ALEPO_SKILLS_DIR', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_KEY_0',
  'OTEL_RESOURCE_ATTRIBUTES', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_CODE_ENTRYPOINT']) {
  assert.equal(env[k], hostEnv[k], `${k} must reach the container`)
}
for (const k of ['AGENT_MANAGER_SERVER_SECRET', 'NUXT_SESSION_PASSWORD', 'SMTP_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'AGENT_GH_TOKEN',
  'SLACK_WEBHOOK_URL', 'AGENT_MANAGER_LOGIN_PASSWORD_HASH', 'HOME', 'PATH', 'CLAUDE_DIR', 'DOCKER_CONFIG', 'NODE_OPTIONS', 'SOME_RANDOM_HOST_VAR', 'DATABASE_URL']) {
  assert.equal(env[k], undefined, `${k} must NOT reach the container`)
}
assert.equal(env.ALEPO_PIPELINE, '1', 'the pipeline flag is always set')
assert.equal(env.ALEPO_STOP_GATE, '1', 'and so is the stop gate')
assert.equal(env.CLAUDE_CONFIG_DIR, sb.SANDBOX_CONFIG_MOUNT, 'the config dir inside is the staged mount, never the host path')
assert.notEqual(env.CLAUDE_CONFIG_DIR, hostEnv.CLAUDE_CONFIG_DIR)

// ── 2/3/4. the docker run spec ───────────────────────────────────────────────
const worktree = '/srv/alepo/local/ASECRM-1@fix-ASECRM-1-abcdef12'
const limits = sb.sandboxLimits({ budget: { maxMinutes: 90 } })
const spec = sb.buildSandboxSpec({
  runId: 'abcdef12-0000-4000-8000-000000000000', stepId: 'step-02', image: 'ghcr.io/alepolab/agent-manager-runner:test',
  cwd: worktree,
  mounts: { worktree, clone: sb.cloneOf(worktree), configDir: '/tmp/agent-manager-sandbox/abcdef12', engineeringDir: '/app/engineering' },
  hostEnv, cliArgs: ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--setting-sources', ''],
  limits,
})
const a = spec.args
const after = flag => a[a.indexOf(flag) + 1]
assert.equal(a[0], 'run')
assert.ok(a.includes('--rm') && a.includes('-i'), 'disposable and interactive (stdin is the protocol)')
assert.equal(after('--cpus'), '2')
assert.equal(after('--memory'), '4g')
assert.equal(after('--pids-limit'), '512')
assert.equal(after('--network'), sb.SANDBOX_NETWORK, 'the dedicated network, not the default bridge')
assert.ok(a.includes('--cap-drop') && a.includes('no-new-privileges'))
assert.equal(after('-w'), worktree, 'cwd inside is the worktree path')
assert.equal(limits.wallClockSeconds, 90 * 60 + 300, 'wall clock = run budget minutes + a 5 minute margin to report')
const timeoutAt = a.indexOf('timeout')
assert.ok(timeoutAt > 0 && a[timeoutAt - 1] === spec.image, 'the command after the image is timeout ...')
assert.equal(a[timeoutAt + 3], String(limits.wallClockSeconds))
assert.equal(a[timeoutAt + 4], 'claude', '... then claude on PATH, never the host binary path')
assert.deepEqual(a.slice(timeoutAt + 5), ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--setting-sources', ''], 'the SDK\'s arguments pass through unchanged')

const mounts = a.flatMap((x, i) => x === '-v' ? [a[i + 1]] : [])
assert.ok(mounts.includes(`${worktree}:${worktree}`), 'the worktree at the same path')
assert.ok(mounts.includes('/srv/alepo/local/ASECRM-1:/srv/alepo/local/ASECRM-1'), 'and its clone, which holds the worktree\'s .git')
assert.ok(mounts.includes(`/tmp/agent-manager-sandbox/abcdef12:${sb.SANDBOX_CONFIG_MOUNT}`), 'the staged config at the mount the env names')
assert.ok(mounts.includes('/app/engineering:/app/engineering:ro'), 'engineering/ read-only')
for (const m of mounts) {
  assert.ok(!/\/\.claude(:|$)/.test(m.split(':')[0]), `no mount of a ~/.claude: ${m}`)
  assert.ok(!m.startsWith('/home/op'), `nothing from the operator's home: ${m}`)
}
assert.ok(!a.includes('/var/run/docker.sock') && !mounts.some(m => m.includes('docker.sock')), 'the docker socket is not handed in by default')

// -e NAME only, by name: a value never appears on the command line.
const passed = a.flatMap((x, i) => x === '-e' ? [a[i + 1]] : [])
assert.deepEqual(new Set(passed), new Set(Object.keys(spec.env)), 'every -e is an allowlisted name and nothing else')
assert.ok(!a.some(x => x.includes('sk-ant-test') || x.includes('ghp_')), 'no secret value on the docker command line')
assert.ok(!passed.includes('AGENT_MANAGER_SERVER_SECRET'))

// ── 5. the staged config ─────────────────────────────────────────────────────
mkdirSync(join(CLAUDE_DIR, 'agents'), { recursive: true })
writeFileSync(join(CLAUDE_DIR, 'agents', 'sdlc-x.md'), '---\nname: x\n---\nhi')
mkdirSync(join(CLAUDE_DIR, 'projects', 'p'), { recursive: true })
writeFileSync(join(CLAUDE_DIR, 'projects', 'p', 's.jsonl'), '{}')
writeFileSync(join(CLAUDE_DIR, '.credentials.json'), '{"access_token":"x"}')
writeFileSync(join(CLAUDE_DIR, 'history.jsonl'), '{}')
writeFileSync(join(CLAUDE_DIR, 'settings.json'), JSON.stringify({ agentManager: { labs: true }, env: { SECRET: 'x' } }))
mkdirSync(join(CLAUDE_DIR, 'skills', 'k', 'node_modules', 'dep'), { recursive: true })
writeFileSync(join(CLAUDE_DIR, 'skills', 'k', 'SKILL.md'), '# k')
writeFileSync(join(CLAUDE_DIR, 'skills', 'k', 'node_modules', 'dep', 'index.js'), '')
writeFileSync(join(CLAUDE_DIR, 'skills', 'k', 'private.pem'), 'KEY')
const root = mkdtempSync(join(tmpdir(), 'sandbox-stage-'))
const staged = await sb.stageSandboxConfig('run-1', CLAUDE_DIR, root)
assert.ok(existsSync(join(staged, 'agents', 'sdlc-x.md')), 'agents are staged')
assert.ok(existsSync(join(staged, 'skills', 'k', 'SKILL.md')), 'skills are staged')
assert.ok(!existsSync(join(staged, 'skills', 'k', 'node_modules')), 'node_modules are not')
assert.ok(!existsSync(join(staged, 'skills', 'k', 'private.pem')), 'a key file is not')
assert.ok(!existsSync(join(staged, 'projects')), 'transcripts are not')
assert.ok(!existsSync(join(staged, '.credentials.json')), 'credentials are not')
assert.ok(!existsSync(join(staged, 'history.jsonl')), 'history is not')
const settings = JSON.parse(readFileSync(join(staged, 'settings.json'), 'utf8'))
assert.equal(settings.env, undefined, 'the host settings.json is not copied; a fresh one is written')
assert.equal(settings.agentManager.sandboxed, true)
await sb.removeSandboxConfig(staged)
assert.ok(!existsSync(staged), 'and it is removed after the step')

// ── 6. OTEL_RESOURCE_ATTRIBUTES merging ──────────────────────────────────────
{
  const e = withOtelAttributes({ OTEL_RESOURCE_ATTRIBUTES: 'host.name=am1,run_id=old' }, { run_id: 'r2', 'jira.key': 'ASECRM-9', product: 'ASE CRM', empty: '' })
  const pairs = Object.fromEntries(e.OTEL_RESOURCE_ATTRIBUTES.split(',').map(p => p.split('=')))
  assert.equal(pairs['host.name'], 'am1', 'the host\'s own attribute is kept')
  assert.equal(pairs.run_id, 'r2', 'ours wins on a clash')
  assert.equal(pairs['jira.key'], 'ASECRM-9')
  assert.equal(pairs.product, 'ASE_CRM', 'a space cannot appear in the variable; it is replaced')
  assert.equal(pairs.empty, undefined, 'an empty value is dropped')
  assert.ok(!e.OTEL_RESOURCE_ATTRIBUTES.includes(' '))
  assert.deepEqual(withOtelAttributes({ A: '1' }, undefined), { A: '1' }, 'no attributes: the env untouched')
}

// ── 7. the GitHub token hook ─────────────────────────────────────────────────
assert.deepEqual(await sb.githubTokenFor({ GH_TOKEN: 't' }, ['alepolab/x']), { GH_TOKEN: 't', GITHUB_TOKEN: 't' }, 'v1: the resolved token passes through')
assert.deepEqual(await sb.githubTokenFor({}, []), {}, 'no token, nothing invented')

console.log('sandbox env allowlist: ok')
