/**
 * A chat whose folder is gone says so, instead of the SDK's "native binary
 * failed to launch ... libc" - which is what a spawn into a missing cwd reads
 * as. A session resumed from a removed run worktree hit exactly that.
 *
 *   node scripts/test-chat-missing-workdir.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

const { workingDirProblem } = await import('../server/utils/providers/workingDir.ts')

assert.equal(workingDirProblem(undefined), null, 'no folder given: the server cwd is used')
assert.equal(workingDirProblem(tmpdir()), null, 'an existing folder is fine')
const gone = '/home/nobody/alepo-workspace/local/X-1@fix-X-1-deadbeef'
const p = workingDirProblem(gone)
assert.ok(p?.includes(gone), 'names the folder')
assert.match(p, /no longer exists/)
assert.doesNotMatch(p, /libc|binary/i)

const src = (await import('node:fs')).readFileSync(new URL('../server/utils/providers/claudeProvider.ts', import.meta.url), 'utf8')
assert.ok(src.indexOf('workingDirProblem(options.workingDir)') < src.indexOf('query({'), 'checked before the SDK is spawned')

console.log('ok - a chat whose folder is gone says so')
