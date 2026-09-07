/**
 * promoteToTeam against a local bare repository standing in for GitHub and a
 * stubbed PR opener: the file lands on a fresh branch off main, the push
 * carries it, the PR is opened as the developer, and an unchanged file is a
 * 409 rather than an empty PR.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'promote-'))
const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()

// A bare "origin" seeded with a main branch that has engineering/ in it.
const origin = join(root, 'origin.git')
git(root, ['init', '--quiet', '--bare', '-b', 'main', origin])
const seed = join(root, 'seed')
git(root, ['clone', '--quiet', origin, seed])
mkdirSync(join(seed, 'engineering', 'commands'), { recursive: true })
writeFileSync(join(seed, 'engineering', 'commands', 'triage.md'), '# triage\n')
git(seed, ['add', '.']); git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '--quiet', '-m', 'seed']); git(seed, ['push', '--quiet', 'origin', 'main'])

process.env.CLAUDE_DIR = join(root, 'claude'); mkdirSync(join(process.env.CLAUDE_DIR, 'agents'), { recursive: true }); mkdirSync(join(process.env.CLAUDE_DIR, 'skills', 'my-skill'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n')
writeFileSync(join(process.env.CLAUDE_DIR, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nDo.\n')
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
process.env.TEAM_REPO_URL = origin
process.env.AGENT_GH_TOKEN = 'token-for-test'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'

const P = await import('../server/utils/promote.ts')
const opened = []
P.setPrOpener(async (o) => { opened.push(o); return `https://example.invalid/pr/${opened.length}` })

const r = await P.promoteToTeam('agent', 'reviewer', 'sandeep')
assert.match(r.branch, /^promote\/agent-reviewer-/)
assert.equal(r.path, 'engineering/agents/reviewer.md')
assert.equal(r.pr, 'https://example.invalid/pr/1')
assert.equal(opened[0].token, 'token-for-test'); assert.equal(opened[0].head, r.branch)
assert.match(opened[0].body, /@sandeep/, 'the PR names the developer')
assert.equal(git(root, ['--git-dir', origin, 'show', `${r.branch}:engineering/agents/reviewer.md`]), '---\nname: reviewer\n---\nReview.', 'the branch on origin carries the file')
assert.equal(git(root, ['--git-dir', origin, 'log', '-1', '--format=%an', r.branch]), 'sandeep', 'committed as the developer')

const s = await P.promoteToTeam('skill', 'my-skill', 'sandeep')
assert.equal(git(root, ['--git-dir', origin, 'show', `${s.branch}:engineering/skills/my-skill/SKILL.md`]), '---\nname: my-skill\n---\nDo.')

// Already merged upstream: no PR for an identical file.
git(seed, ['pull', '--quiet', 'origin', r.branch]); git(seed, ['push', '--quiet', 'origin', 'main'])
await assert.rejects(P.promoteToTeam('agent', 'reviewer', 'sandeep'), /already matches/, 'identical content is refused')
await assert.rejects(P.promoteToTeam('agent', 'nope', 'sandeep'), /not on this instance/)
await assert.rejects(P.promoteToTeam('agent', '../etc', 'sandeep'), /invalid slug/)
delete process.env.AGENT_GH_TOKEN
await assert.rejects(P.promoteToTeam('skill', 'my-skill', 'nobody'), /No GitHub token/)

rmSync(root, { recursive: true, force: true })
console.log('promote: all assertions passed')
