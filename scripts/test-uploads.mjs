/**
 * Files uploaded for a workflow input of type `file` (server/utils/uploads.ts).
 *
 *   node scripts/test-uploads.mjs
 *
 * What matters: an upload lands where the starter's agents can read it and
 * nobody else's can, under a name that cannot climb out of its folder; it is
 * never overwritten; and a run start refuses someone else's upload.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'uploads-'))
process.env.AGENT_USERS_DIR = join(root, 'data', 'users')
process.env.AGENT_DEVELOPERS_ROOT = join(root, 'developers')
process.env.AGENT_MANAGER_SECRET = 's'.repeat(40)
delete process.env.AGENT_RUN_AS
delete process.env.UPLOAD_MAX_MB

const up = await import('../server/utils/uploads.ts')
const { isFileParameter, resolveParameters } = await import('../shared/utils/workflowParameters.ts')

try {
  // ══ names ═════════════════════════════════════════════════════════════════
  assert.equal(up.safeFileName('ase-crm Defect Register_12Oct.html'), 'ase-crm Defect Register_12Oct.html', 'spaces are kept')
  assert.equal(up.safeFileName('../../etc/passwd'), 'passwd', 'no directories')
  assert.equal(up.safeFileName('C:\\Users\\me\\Downloads\\reg.html'), 'reg.html', 'a Windows path keeps only its last part')
  assert.equal(up.safeFileName('.env'), 'env', 'no hidden files')
  assert.equal(up.safeFileName('a;$(rm -rf).html'), 'a__(rm -rf).html', 'nothing a shell reads specially')
  assert.equal(up.safeFileName(''), 'upload')
  assert.equal(up.safeFileName('x'.repeat(300)).length, 120)

  // ══ size limit ════════════════════════════════════════════════════════════
  assert.equal(up.maxUploadBytes(), 20 * 1024 * 1024, 'default 20 MB')
  process.env.UPLOAD_MAX_MB = '5'
  assert.equal(up.maxUploadBytes(), 5 * 1024 * 1024)
  process.env.UPLOAD_MAX_MB = 'lots'
  assert.equal(up.maxUploadBytes(), 20 * 1024 * 1024, 'nonsense falls back to the default')
  delete process.env.UPLOAD_MAX_MB

  // ══ agents as the server: beside the users directory, per login ══════════
  {
    const a = await up.saveUpload('alice', 'reg.html', Buffer.from('<html>1</html>'))
    assert.ok(a.path.startsWith(join(root, 'data', 'uploads', 'alice') + sep), a.path)
    assert.equal(readFileSync(a.path, 'utf8'), '<html>1</html>')
    assert.equal(a.size, 14)
    assert.equal(statSync(a.path).mode & 0o007, 0, 'not readable by other users')

    const b = await up.saveUpload('alice', 'reg.html', Buffer.from('<html>2</html>'))
    assert.notEqual(dirname(a.path), dirname(b.path), 'each upload has its own folder')
    assert.equal(readFileSync(a.path, 'utf8'), '<html>1</html>', 'a later upload of the same name leaves the earlier one alone')

    assert.equal(up.uploadOwnerOf(a.path), 'alice')
    assert.equal(up.uploadOwnerOf('/home/alice/defect-register/reg.html'), undefined, 'a typed path is not an upload')
    assert.equal(up.uploadProblem(a.path, 'alice'), null)
    assert.match(up.uploadProblem(a.path, 'bob'), /someone else/)
    assert.equal(up.uploadProblem('~/defect-register/reg.html', 'bob'), null, 'typed paths are the starter\'s business')
    rmSync(a.path)
    assert.match(up.uploadProblem(a.path, 'alice'), /no longer there/)
    assert.equal(up.uploadOwnerOf(join(root, 'data', 'uploads', 'alice', '..', 'bob', 'x', 'f')), 'bob', 'resolved before it is judged')
  }

  // ══ agents as their developer: in the developer's own directory ══════════
  {
    process.env.AGENT_RUN_AS = 'user'
    const a = await up.saveUpload('alice', 'reg.html', Buffer.from('x'))
    assert.ok(a.path.startsWith(join(root, 'developers', 'alice', 'uploads') + sep), a.path)
    assert.equal(up.uploadOwnerOf(a.path), 'alice')
    assert.match(up.uploadProblem(a.path, 'bob'), /someone else/)
    assert.equal(up.uploadOwnerOf(join(root, 'developers', 'alice', 'home', 'reg.html')), undefined,
      'a file in their home is not an upload')
    delete process.env.AGENT_RUN_AS
  }

  // ══ the declaration ═══════════════════════════════════════════════════════
  assert.equal(isFileParameter({ type: 'file' }), true)
  assert.equal(isFileParameter({}), false)
  assert.deepEqual(
    resolveParameters([{ name: 'registerFile', type: 'file', default: '~/r.html' }], {}).values,
    { registerFile: '~/r.html' }, 'a file input is still a path, and takes its default like any other')

  assert.ok(existsSync(root))
  console.log('uploads: all checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
