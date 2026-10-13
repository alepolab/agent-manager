/**
 * Each developer's agents run as their own Unix user (AGENT_RUN_AS=user).
 *
 *   node scripts/test-run-as.mjs
 *
 * No root here, so no real user switch: a fake `sudo` first on PATH drops its
 * own flags and runs what follows, which is the real launcher. That is the
 * whole chain except the switch itself - the argv sudo is given, the env it
 * carries, and what the launcher does with it.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'run-as-'))
process.env.AGENT_USERS_DIR = join(root, 'users')
process.env.AGENT_DEVELOPERS_ROOT = join(root, 'developers')
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_MANAGER_SECRET = 's'.repeat(40)
process.env.AGENT_RUN_AS_LAUNCHER = join(import.meta.dirname, '..', 'engineering', 'run-as', 'launch.sh')
delete process.env.AGENT_RUN_AS
delete process.env.AUTH_DISABLED

const os = await import('../server/utils/osUsers.ts')
const { agentEnvFor, launchAs, launchProblem } = await import('../server/utils/agentCaller.ts')
const { saveProfile, envForUser } = await import('../server/utils/users.ts')

try {
  // ── off: nothing changes ──
  assert.equal(os.runAsUsers(), false)
  assert.equal(os.spawnAs('alice'), undefined)
  assert.deepEqual(launchAs('alice'), {})
  assert.equal(os.osUserProblem('alice'), null)
  assert.ok(!('GIT_CONFIG_KEY_1' in await agentEnvFor()), 'no safe.directory when one user owns everything')

  // ── names: what useradd will accept, the same way provision-developer.sh derives them ──
  assert.equal(os.osUserFor('Vivek.Ojha'), 'am-vivek.ojha')
  assert.equal(os.osUserFor('123bob'), 'am-bob')
  assert.equal(os.osUserFor('x'.repeat(50)).length, 32)
  const sh = (login) => execFileSync('bash', ['-c', `SAFE=$(printf '%s' "$1" | sed 's/[^A-Za-z0-9_.-]/_/g'); printf '%s%s' am- "$(printf '%s' "$SAFE" | tr 'A-Z' 'a-z' | sed 's/^[^a-z_]*//')" | cut -c1-32`, '_', login], { encoding: 'utf8' }).trim()
  for (const login of ['Vivek.Ojha', '123bob', 'x'.repeat(50), 'we!rd name']) assert.equal(sh(login), os.osUserFor(login), `script and server agree on ${login}`)

  process.env.AGENT_RUN_AS = 'user'

  // ── argv carries no secret; env carries home, config dir and PATH across sudo ──
  const argv = os.runAsArgv('alice', '/usr/bin/node', ['cli.js'])
  assert.deepEqual(argv, ['-n', '-E', '-u', 'am-alice', '--', process.env.AGENT_RUN_AS_LAUNCHER, '/usr/bin/node', 'cli.js'])
  const env = os.runAsEnv('alice', { PATH: '/opt/node/bin:/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-SECRET' })
  assert.equal(env.HOME, join(root, 'developers', 'alice', 'home'))
  assert.equal(env.CLAUDE_CONFIG_DIR, join(root, 'developers', 'alice', 'home', '.claude'))
  assert.equal(env.AM_PATH, '/opt/node/bin:/usr/bin')
  assert.ok(!argv.join(' ').includes('SECRET'), 'the credential is never an argument')

  // ── an unprovisioned developer is refused, not run as the server ──
  const missing = os.osUserProblem('nobody-here-xyz')
  assert.match(missing, /has no Unix user \(am-nobody-here-xyz\).*provision-developer\.sh nobody-here-xyz/)
  assert.match(os.osUserProblem(undefined), /started by nobody/)
  assert.match(launchProblem({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, 'nobody-here-xyz'), /provision-developer/, 'a credential alone is not enough')
  assert.match(launchProblem({}, 'nobody-here-xyz'), /no Claude credential/, 'the credential is asked about first')

  // ── git trusts checkouts another user owns ──
  const agentEnv = await agentEnvFor()
  assert.equal(agentEnv.GIT_CONFIG_COUNT, '2')
  assert.equal(agentEnv.GIT_CONFIG_KEY_1, 'safe.directory')
  assert.equal(agentEnv.GIT_CONFIG_KEY_0, 'commit.gpgsign', 'beside the unsigned-commit setting, not instead of it')

  // ── tool config written from stored tokens goes in the developer's own directory ──
  await saveProfile('alice', { jiraEmail: 'alice@example.test', jiraTokenPlain: 'jira-secret' })
  const userEnv = await envForUser('alice')
  assert.equal(userEnv.JIRA_CONFIG_FILE, join(root, 'developers', 'alice', 'credentials', 'alice.jira.yml'))
  assert.equal(statSync(userEnv.JIRA_CONFIG_FILE).mode & 0o777, 0o660, 'group-readable, so the ACL mask lets their user in')

  // ── the real spawn path, through a fake sudo and the real launcher ──
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, 'sudo-argv')}"\nwhile [ "$1" != "--" ]; do shift; done; shift\nPATH=/usr/bin:/bin exec "$@"\n`)
  chmodSync(join(bin, 'sudo'), 0o755)
  const out = join(root, 'child')
  const spawn = os.spawnAs('alice')
  const child = spawn({
    command: '/bin/sh',
    args: ['-c', `printf '%s\\n%s\\n%s\\n' "$HOME" "$PATH" "$(umask)" > ${out}`],
    env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-SECRET' },
  })
  const code = await new Promise(r => child.on('exit', r))
  assert.equal(code, 0)
  const [home, path, umask] = readFileSync(out, 'utf8').trim().split('\n')
  assert.equal(home, join(root, 'developers', 'alice', 'home'), 'the launcher restores HOME after sudo')
  assert.equal(path, `${bin}:/usr/bin:/bin`, 'and PATH, which sudo would replace with secure_path')
  assert.equal(umask, '0077')
  const sudoArgv = readFileSync(join(root, 'sudo-argv'), 'utf8')
  assert.match(sudoArgv, /^-n\n-E\n-u\nam-alice\n--\n/)
  assert.ok(!sudoArgv.includes('SECRET'))

  // ── preflight asks, as the developer's user, whether it can work where its agents will ──
  // A working directory its user cannot enter fails every shell command with
  // exit 1 and no output; a real run spent two steps finding that out.
  {
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}:${savedPath}`
    try {
      const open = join(root, 'open'); mkdirSync(open, { mode: 0o755 })
      const shut = join(root, 'shut'); mkdirSync(shut, { mode: 0o000 })
      assert.equal(os.unreachableFor('alice', { enter: [open], write: [open] }), null, 'a directory it can use passes')
      assert.match(os.unreachableFor('alice', { enter: [open, shut] }), new RegExp(`am-alice cannot enter ${shut}`), 'one it cannot enter is named')
      assert.match(os.unreachableFor('alice', { write: [shut] }), /cannot write to/, 'and one it cannot write to')
      chmodSync(shut, 0o755)
    } finally { process.env.PATH = savedPath }
  }

  // ── a run's artifacts directory is granted to its starter's user (needs setfacl) ──
  let hasAcl = true
  try { execFileSync('setfacl', ['--version'], { stdio: 'ignore' }) } catch { hasAcl = false }
  if (hasAcl) {
    const me = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()
    process.env.AGENT_OS_USER_PREFIX = ''
    const dir = join(root, 'runs', 'r1', 'artifacts')
    // Created the way initRunArtifacts creates it: the umask's 0755/0644,
    // readable by every user on the host until the grant takes that away.
    mkdirSync(join(dir, 'steps'), { recursive: true, mode: 0o755 })
    writeFileSync(join(dir, 'meta.json'), '{}', { mode: 0o644 })
    await os.grantDeveloper(dir, me)
    const acl = (p) => execFileSync('getfacl', ['-p', p], { encoding: 'utf8' })
    assert.match(acl(dir), new RegExp(`default:user:${me}:rwx`), 'the starter is let in, and so is what comes later')
    for (const p of [dir, join(dir, 'steps'), join(dir, 'meta.json'), join(root, 'runs', 'r1')]) {
      assert.match(acl(p), /^other::---$/m, `nobody else can open ${p.slice(root.length)}`)
    }
    assert.match(acl(dir), /^default:other::---$/m, 'nor anything created in it later')
    delete process.env.AGENT_OS_USER_PREFIX
  } else {
    console.log('  (setfacl not installed: the artifacts ACL grant is not exercised here)')
  }

  console.log('run as: off by default, refused unprovisioned, spawned through the launcher with no secret in argv')
} finally {
  delete process.env.AGENT_RUN_AS
  rmSync(root, { recursive: true, force: true })
}
