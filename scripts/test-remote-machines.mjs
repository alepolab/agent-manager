/**
 * Running a step on a registered machine.
 *
 * Everything here is the part that can be wrong without a host to notice: how
 * a run picks its machine, what reaches the ssh command line, which of this
 * server's environment travels, where this server's paths land on the
 * machine, the order of the git and rsync steps around a call, and that a
 * pasted key is sealed on disk and never shown back.
 *
 *   node scripts/test-remote-machines.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'machines-'))
process.env.AGENT_MACHINES_FILE = join(DIR, 'machines.json')
process.env.AGENT_MANAGER_SECRET = 'test-secret-for-machines'
process.env.CLAUDE_DIR = join(DIR, 'claude')
mkdirSync(process.env.CLAUDE_DIR, { recursive: true })

const machines = await import('../server/utils/machines.ts')
const remote = await import('../server/utils/remoteAgent.ts')

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----'

// ══ 1. precedence: the start, then the workflow, then the instance; `local` stops the cascade ══
{
  const { resolveMachineId, LOCAL_MACHINE } = machines
  assert.equal(resolveMachineId({}), LOCAL_MACHINE, 'nothing said: this server')
  assert.equal(resolveMachineId({ instanceDefault: 'm1' }), 'm1', 'the instance default applies when nothing else says')
  assert.equal(resolveMachineId({ workflow: 'm2', instanceDefault: 'm1' }), 'm2', 'the workflow beats the instance')
  assert.equal(resolveMachineId({ requested: 'm3', workflow: 'm2', instanceDefault: 'm1' }), 'm3', 'the start beats the workflow')
  assert.equal(resolveMachineId({ workflow: LOCAL_MACHINE, instanceDefault: 'm1' }), LOCAL_MACHINE,
    'THE REQUIREMENT: a workflow pinned to this server stays here even when the instance default is a machine')
  assert.equal(resolveMachineId({ requested: '  ', workflow: '', instanceDefault: 'm1' }), 'm1', 'blank means unsaid, not local')
}

// ══ 2. the store: sealed key, public shape, default, delete ═════════════════
{
  const saved = await machines.saveMachine({ name: 'build-box', host: 'build.internal', user: 'agent', port: '2222', privateKeyPlain: KEY, transport: 'sync', workspaceRoot: '/srv/work', env: { JAVA_HOME: '/opt/jdk' } }, 'sandeep')
  assert.ok(saved.id, 'an id is minted')
  assert.equal(saved.port, 2222)
  assert.ok(saved.privateKey?.startsWith('v1:'), 'the key is sealed, not stored in clear')
  assert.ok(!saved.privateKey.includes('OPENSSH'), 'no key material in the sealed value')
  const onDisk = readFileSync(process.env.AGENT_MACHINES_FILE, 'utf8')
  assert.ok(!onDisk.includes('BEGIN OPENSSH'), 'THE REQUIREMENT: the pasted key never reaches disk in clear')
  const pub = machines.toPublicMachine(saved)
  assert.equal(pub.privateKey, undefined, 'the browser never sees the sealed key either')
  assert.equal(pub.hasPrivateKey, true)

  const keyFile = await machines.keyFileFor(saved)
  assert.ok(keyFile && existsSync(keyFile), 'ssh gets a file')
  assert.equal(readFileSync(keyFile, 'utf8'), `${KEY}\n`, 'holding the key, decrypted')
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, 'readable by this user alone')

  await assert.rejects(machines.saveMachine({ name: 'Build-Box', host: 'other' }), /already exists/, 'names are unique, case-insensitively')
  await assert.rejects(machines.saveMachine({ name: 'x', host: '-oProxyCommand=evil' }), /hostname/, 'a host that is an ssh option is refused')
  await assert.rejects(machines.saveMachine({ name: 'x', host: 'ok', user: 'a b' }), /ssh user/, 'a user with a space is refused')
  await assert.rejects(machines.saveMachine({ name: 'x', host: 'ok', workspaceRoot: 'relative/dir' }), /absolute path/, 'a relative root is refused')
  await assert.rejects(machines.saveMachine({ name: 'x', host: 'ok', privateKeyPlain: 'not a key' }), /not a private key/, 'random text is not a key')
  await assert.rejects(machines.saveMachine({ name: 'x', host: 'ok', env: { 'BAD NAME': '1' } }), /environment variable name/)

  assert.equal(await machines.defaultMachineId(), undefined, 'no default until one is set')
  await machines.setDefaultMachine(saved.id)
  assert.equal(await machines.defaultMachineId(), saved.id)
  await assert.rejects(machines.setDefaultMachine('nope'), /No machine/)
  const resolved = await machines.machineForRun({})
  assert.equal(resolved?.id, saved.id, 'machineForRun reads the stored default')
  assert.equal(await machines.machineForRun({ requested: 'local' }), null, 'and `local` overrides it')
  await assert.rejects(machines.machineForRun({ requested: 'gone' }), /not configured/)

  // An edit keeps the key unless told otherwise, and clearing it removes the file.
  const edited = await machines.saveMachine({ id: saved.id, name: 'build-box', host: 'build.internal', user: 'agent', port: 2222 })
  assert.equal(edited.privateKey, saved.privateKey, 'absent privateKeyPlain keeps the stored key')
  const off = await machines.saveMachine({ id: saved.id, name: 'build-box', host: 'build.internal', enabled: false })
  assert.equal(off.enabled, false)
  await assert.rejects(machines.machineForRun({ requested: saved.id }), /switched off/, 'a disabled machine refuses the run rather than silently running here')
  const cleared = await machines.saveMachine({ id: saved.id, name: 'build-box', host: 'build.internal', privateKeyPlain: '' })
  assert.equal(cleared.privateKey, undefined, "'' clears the key")
  assert.ok(!existsSync(keyFile), 'and the file ssh read is gone with it')

  assert.equal(await machines.deleteMachine(saved.id), true)
  assert.equal(await machines.defaultMachineId(), undefined, 'deleting the default clears it')
  assert.equal(await machines.deleteMachine(saved.id), false, 'deleting twice says so')
}

// ══ 3. the ssh command line ═════════════════════════════════════════════════
const box = {
  id: 'id-1', name: 'box', host: 'build.internal', user: 'agent', port: 2222, transport: 'sync',
  workspaceRoot: '/srv/work', runsRoot: '/srv/runs', appRoot: '/srv/agent-manager', claudeDir: '/home/agent/.claude',
  env: { JAVA_HOME: '/opt/jdk' }, enabled: true, createdAt: 0, updatedAt: 0,
}
{
  assert.equal(machines.shellQuote("it's"), `'it'\\''s'`)
  assert.equal(machines.shellPath('~/work'), `"$HOME"/'work'`, 'a tilde path expands on the machine, not here')
  assert.equal(machines.shellPath('/srv/w s'), `'/srv/w s'`)
  assert.equal(machines.sshTarget(box), 'agent@build.internal')
  const args = machines.sshOptionArgs(box, '/k')
  assert.ok(args.includes('BatchMode=yes'), 'never waits on a password prompt')
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2), ['-p', '2222'])
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', '/k'])
  assert.ok(!machines.sshOptionArgs({ port: undefined }).includes('-p'), 'the default port is left to ssh')
  assert.equal(machines.loginShellCommand('echo hi'), `bash -lc 'echo hi'`, 'a login shell, so the PATH holds what the user installed')
}

// ══ 4. paths and environment on the machine ═════════════════════════════════
const roots = { workspace: '/home/app/alepo-workspace', runs: '/home/app/.agent-runs', app: '/app', claude: '/home/app/.claude' }
{
  const { remotePathFor, mapPath, remoteEnvFor, remoteCliArgs, remoteAgentCommand, remoteGitUrl } = remote
  assert.equal(remotePathFor(box, '/home/app/alepo-workspace/sandeep/ase-crm@abc', roots), '/srv/work/sandeep/ase-crm@abc', 'a checkout is re-rooted')
  assert.equal(remotePathFor(box, '/home/app/.agent-runs/run-1', roots), '/srv/runs/run-1', 'evidence is re-rooted')
  assert.equal(remotePathFor(box, '/app/engineering/scripts', roots), '/srv/agent-manager/engineering/scripts', 'the app checkout is re-rooted')
  assert.equal(remotePathFor(box, '/home/app/.claude/skills', roots), '/home/agent/.claude/skills', 'the config dir is re-rooted')
  assert.equal(remotePathFor(box, '/elsewhere/x', roots), '/elsewhere/x', 'a path under no root is unchanged')
  assert.equal(remotePathFor({ transport: 'shared' }, '/home/app/alepo-workspace/x', roots), '/home/app/alepo-workspace/x', 'no roots set: the same path on both sides')
  assert.equal(mapPath('C:\\work\\x', 'C:/work', '/srv'), '/srv/x', 'backslashes are normalised before matching')

  const env = remoteEnvFor(box, {
    PATH: '/usr/bin', HOME: '/home/app', PORT: '3030', HTTPS_PROXY: 'http://proxy',
    ANTHROPIC_API_KEY: 'sk-1', GH_TOKEN: 'gh-1', GITHUB_TOKEN: 'gh-1', JIRA_API_TOKEN: 'j', JIRA_EMAIL: 'me@x',
    GIT_AUTHOR_NAME: 'Me', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
    SDLC_SCRIPTS_DIR: '/app/engineering/scripts', SDLC_SKILLS_DIR: '/home/app/.claude/skills', CE_SKILLS_DIR: '/app/vendor/compound-engineering/skills',
    AGENT_MANAGER_SECRET: 'never', GITHUB_CLIENT_SECRET: 'never', DOCKER_CONFIG: '/home/app/.agent-manager/users/x.docker', JIRA_CONFIG_FILE: '/x.yml',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', AGENT_MANAGER_URL: 'https://am', AGENT_MANAGER_API_TOKEN: 't',
  }, roots)
  for (const k of ['PATH', 'HOME', 'PORT', 'HTTPS_PROXY']) assert.equal(env[k], undefined, `${k} is this host's own and does not travel`)
  for (const k of ['AGENT_MANAGER_SECRET', 'GITHUB_CLIENT_SECRET', 'DOCKER_CONFIG', 'JIRA_CONFIG_FILE']) assert.equal(env[k], undefined, `THE REQUIREMENT: ${k} never travels`)
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-1', 'the model credential travels')
  assert.equal(env.GH_TOKEN, 'gh-1', 'the GitHub identity travels')
  assert.equal(env.GIT_CONFIG_VALUE_0, 'false', 'the signing override travels')
  assert.equal(env.SDLC_SCRIPTS_DIR, '/srv/agent-manager/engineering/scripts', 'a path the agents are handed is re-rooted')
  assert.equal(env.SDLC_SKILLS_DIR, '/home/agent/.claude/skills')
  assert.equal(env.CE_SKILLS_DIR, '/srv/agent-manager/vendor/compound-engineering/skills')
  assert.equal(env.JAVA_HOME, '/opt/jdk', "the machine's own env is added")
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts', "Claude Code's own switches travel")
  assert.equal(env.AGENT_MANAGER_URL, 'https://am')

  assert.deepEqual(remoteCliArgs('/usr/bin/node', ['/x/cli.js', '--output-format', 'stream-json']), ['--output-format', 'stream-json'], 'the local script path is dropped for a runtime')
  assert.deepEqual(remoteCliArgs('/x/claude', ['--output-format', 'stream-json']), ['--output-format', 'stream-json'], 'a native binary keeps its args')
  assert.deepEqual(remoteCliArgs('C:\\node.exe', ['C:\\cli.js', '-p']), ['-p'])

  const cmd = remoteAgentCommand({ ...box, claudePath: '/opt/claude/bin/claude' }, { command: '/usr/bin/node', args: ['/x/cli.js', '--verbose', "it's"], env: { ANTHROPIC_API_KEY: 'sk-1', PATH: '/nope' } }, '/srv/work/x y', roots)
  assert.equal(cmd, `cd '/srv/work/x y' && exec env ANTHROPIC_API_KEY='sk-1' JAVA_HOME='/opt/jdk' '/opt/claude/bin/claude' '--verbose' 'it'\\''s'`,
    'one shell line: cd, env, exec the machine\'s claude, every word quoted')
  const spawnArgs = remote.remoteSpawnArgs(box, '/k', cmd)
  assert.equal(spawnArgs.at(-1), machines.loginShellCommand(cmd), 'the line runs under a login shell')
  assert.equal(spawnArgs.at(-3), 'agent@build.internal')
  assert.equal(spawnArgs.at(-2), '--', 'nothing after the target is read as an option')
  assert.ok(spawnArgs.includes('-T'), 'no tty: the SDK speaks a line protocol')

  assert.equal(remoteGitUrl(box, '/srv/work/x'), 'ssh://agent@build.internal:2222/srv/work/x')
  assert.equal(remoteGitUrl({ ...box, port: undefined }, '~/work/x'), 'ssh://agent@build.internal/~/work/x', 'a home-relative path keeps its tilde for git to expand there')
  assert.ok(remote.sshCommandString(box, '/k').startsWith(`'ssh' '-o' 'BatchMode=yes'`), 'git and rsync connect with the same options')
}

// ══ 5. the sync around a step: what runs, in what order ═════════════════════
{
  const work = join(DIR, 'ws', 'ase-crm@run1')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'a.txt'), 'a')
  const artifacts = join(DIR, 'runs', 'run-1')
  mkdirSync(artifacts, { recursive: true })
  const r = { workspace: join(DIR, 'ws'), runs: join(DIR, 'runs'), app: '/app', claude: process.env.CLAUDE_DIR }
  const run = { id: 'run-1', projectDir: work, branch: 'agent/ASECRM-1', baseBranch: 'develop', baseCommit: 'b'.repeat(40), artifactsDir: artifacts }

  const calls = []
  const tools = {
    ssh: async (m, cmd) => {
      calls.push(['ssh', cmd])
      if (cmd.includes('git rev-parse HEAD')) return 'c'.repeat(40) + '\nagent/ASECRM-1\n'
      return ''
    },
    local: async (cmd, args, opts) => {
      calls.push([cmd, ...args])
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n'
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return 'a'.repeat(40) + '\n'
      if (cmd === 'git' && args[0] === 'remote') return 'git@github.com:alepolab/ase-crm.git\n'
      assert.equal(opts.env?.GIT_SSH_COMMAND === undefined, cmd !== 'git', 'git connects with the machine\'s ssh options')
      return ''
    },
  }
  const lines = await remote.pushToMachine(box, run, { tools, roots: r })
  const text = calls.map(c => c.join(' '))
  const at = (needle) => { const i = text.findIndex(t => t.includes(needle)); assert.ok(i >= 0, `expected a call containing ${needle}; got:\n${text.join('\n')}`); return i }
  const mk = at('mkdir -p')
  const init = at('git init -q')
  const push = at(`push -q ssh://agent@build.internal:2222/srv/work/ase-crm@run1 +${'a'.repeat(40)}:refs/agent-manager/incoming +${'b'.repeat(40)}:refs/heads/develop`)
  const checkout = at('git update-ref refs/heads/agent/ASECRM-1 refs/agent-manager/incoming')
  const rsyncTree = at(`rsync -az -s --exclude=/.git -e`)
  const rsyncArt = text.findIndex(t => t.includes('rsync') && t.includes(`${artifacts}/ agent@build.internal:/srv/runs/run-1/`))
  assert.ok(rsyncArt >= 0, 'the evidence directory is copied too')
  assert.ok(mk < init && init < push && push < checkout && checkout < rsyncTree && rsyncTree < rsyncArt,
    'THE REQUIREMENT: directories, then the repository, then the commits, then the branch on the machine, then the working tree, then the evidence')
  assert.ok(text[checkout].includes('git reset -q --hard refs/agent-manager/incoming'), 'the machine is reset to exactly the pushed commit')
  assert.ok(text[init].includes("git remote add origin 'git@github.com:alepolab/ase-crm.git'"), 'the product origin is set so `git push origin` from a step reaches GitHub')
  assert.ok(!text.some(t => t.includes('HEAD:refs/heads/agent/ASECRM-1')), 'never pushed to the checked-out branch: git refuses that, and a dirty tree makes updateInstead refuse too')
  assert.ok(text[rsyncTree].endsWith(`${work}/ agent@build.internal:/srv/work/ase-crm@run1/`), 'the working tree goes to the re-rooted path')
  assert.ok(lines.some(l => /Pushed agent\/ASECRM-1 at aaaaaaaa/.test(l)), 'the step log says what went over')

  calls.length = 0
  const back = await remote.pullFromMachine(box, run, { tools, roots: r })
  const t2 = calls.map(c => c.join(' '))
  const fetch = t2.findIndex(t => t.startsWith(`git fetch -q ssh://agent@build.internal:2222/srv/work/ase-crm@run1 ${'c'.repeat(40)}`))
  const reset = t2.findIndex(t => t === `git reset -q --hard ${'c'.repeat(40)}`)
  const rsTree = t2.findIndex(t => t.includes('rsync') && t.endsWith(`agent@build.internal:/srv/work/ase-crm@run1/ ${work}/`))
  const rsArt = t2.findIndex(t => t.includes('rsync') && t.endsWith(`agent@build.internal:/srv/runs/run-1/ ${artifacts}/`))
  assert.ok(fetch >= 0 && reset > fetch && rsTree > reset && rsArt > rsTree, `THE REQUIREMENT: the commits come back first, then the tree, then the evidence; got:\n${t2.join('\n')}`)
  assert.ok(back.some(l => /Fetched agent\/ASECRM-1 at cccccccc/.test(l)))

  // The same commit on both sides: no fetch, no reset, still the files.
  calls.length = 0
  tools.ssh = async (m, cmd) => { calls.push(['ssh', cmd]); return cmd.includes('git rev-parse HEAD') ? 'a'.repeat(40) + '\nagent/ASECRM-1\n' : '' }
  await remote.pullFromMachine(box, run, { tools, roots: r })
  assert.ok(!calls.some(c => c[0] === 'git' && c[1] === 'fetch'), 'nothing new on the machine: nothing fetched')
  assert.equal(calls.filter(c => c[0] === 'rsync').length, 2, 'the tree and the evidence still come back')

  // A shared filesystem copies nothing.
  calls.length = 0
  assert.deepEqual(await remote.pullFromMachine({ ...box, transport: 'shared' }, run, { tools, roots: r }), [])
  assert.ok((await remote.pushToMachine({ ...box, transport: 'shared' }, run, { tools, roots: r }))[0].includes('nothing to copy'))
  assert.equal(calls.length, 0, 'THE REQUIREMENT: shared transport makes no ssh, git or rsync call')

  // No checkout: only the evidence travels.
  calls.length = 0
  await remote.pushToMachine(box, { ...run, projectDir: undefined }, { tools, roots: r })
  assert.ok(!calls.some(c => c[0] === 'git'), 'no git without a checkout')
  assert.equal(calls.filter(c => c[0] === 'rsync').length, 1)
}

// ══ 6. the connection test's verdict ════════════════════════════════════════
{
  const { parseCheckOutput, checkCommand } = machines
  const ok = parseCheckOutput('MACHINE=ok\nCLAUDE=2.1.0 (Claude Code)\nGIT=git version 2.43.0\nRSYNC=ok\nWS=ok\n', { transport: 'sync' })
  assert.equal(ok.ok, true)
  assert.equal(ok.claudeVersion, '2.1.0 (Claude Code)')
  const noClaude = parseCheckOutput('MACHINE=ok\nCLAUDE=missing\nGIT=git version 2.43.0\nRSYNC=ok\nWS=ok\n', { transport: 'sync' })
  assert.equal(noClaude.ok, false)
  assert.match(noClaude.detail, /claude is not on the PATH/)
  const noRsync = parseCheckOutput('MACHINE=ok\nCLAUDE=2.1.0\nGIT=git version 2.43.0\nRSYNC=missing\nWS=ok\n', { transport: 'sync' })
  assert.match(noRsync.detail, /rsync/)
  assert.equal(parseCheckOutput('MACHINE=ok\nCLAUDE=2.1.0\nGIT=git version 2.43.0\nRSYNC=missing\nWS=ok\n', { transport: 'shared' }).ok, true, 'a shared filesystem needs no rsync')
  assert.equal(parseCheckOutput('', {}).ok, false, 'no probe output is a failure, not a pass')
  assert.match(parseCheckOutput('MACHINE=ok\nCLAUDE=2.1.0\nGIT=git version 2\nRSYNC=ok\nWS=unwritable\n', { workspaceRoot: '/srv/work' }).detail, /\/srv\/work/)
  const cmd = checkCommand({ claudePath: '/opt/claude', workspaceRoot: '~/work' })
  assert.ok(cmd.includes(`'/opt/claude' --version`) && cmd.includes(`mkdir -p "$HOME"/'work'`), 'the probe asks about the configured claude and root')

  // An unreachable host is a recorded verdict, never a throw.
  const m = await machines.saveMachine({ name: 'down', host: 'down.internal' })
  const verdict = await machines.checkMachine(m, { ssh: async () => { const e = new Error('spawn'); e.stderr = 'ssh: connect to host down.internal port 22: Connection refused'; throw e } })
  assert.equal(verdict.ok, false)
  assert.match(verdict.detail, /Connection refused/)
  assert.equal((await machines.getMachine(m.id)).lastCheck.ok, false, 'the verdict is stored on the machine')
}

rmSync(DIR, { recursive: true, force: true })
console.log('remote-machines: all assertions passed')
