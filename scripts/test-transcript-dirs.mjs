/**
 * Which directories the chat sidebar and session lookup read transcripts from.
 *
 *   node scripts/test-transcript-dirs.mjs
 *
 * The SDK writes to CLAUDE_CONFIG_DIR when it is set and to $HOME/.claude only
 * when it is not. Reading HOME regardless listed the whole account's Claude
 * Code history - on a shared VM, 4,504 sessions of other people's work - in an
 * instance that had its own config directory.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'transcript-dirs-'))
process.env.HOME = join(root, 'home')
process.env.CLAUDE_DIR = join(root, 'app-claude')
delete process.env.AGENT_RUN_AS

const { projectsDirCandidates } = await import('../server/utils/claudeDir.ts')
const homeProjects = join(root, 'home', '.claude', 'projects')

try {
  // An instance with its own config directory: its own transcripts, and not the account's.
  process.env.CLAUDE_CONFIG_DIR = join(root, 'instance')
  const own = projectsDirCandidates()
  assert.ok(own.includes(join(root, 'instance', 'projects')), 'its own config directory is read')
  assert.ok(!own.includes(homeProjects), "the account's $HOME/.claude is not - someone else's history")

  // No config directory set: HOME is exactly where the SDK writes, as before.
  delete process.env.CLAUDE_CONFIG_DIR
  const local = projectsDirCandidates()
  assert.ok(local.includes(homeProjects), 'without CLAUDE_CONFIG_DIR, $HOME/.claude is the SDK\'s own and is read')
  assert.ok(local.includes(join(root, 'app-claude', 'projects')), "and the app's directory, as before")

  console.log('transcript dirs: the SDK\'s own directory, never the account\'s when the instance has its own')
} finally {
  rmSync(root, { recursive: true, force: true })
}
