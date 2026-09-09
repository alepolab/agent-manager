#!/usr/bin/env node
/**
 * The Runs page 500'd while a run was live:
 *
 *   [request error] [unhandled] [GET] /api/runs/a070061f.../artifacts
 *   ENOENT: no such file or directory, statx '.../artifacts/oracle/raw-3.txt'
 *
 * `readdir` then `stat` is a time-of-check/time-of-use race, and this directory
 * is read WHILE it is written: the page polls during a run and the agent
 * underneath creates and deletes scratch files as it works. Losing the race is
 * normal, not exceptional — and one vanished scratch file took down the whole
 * listing, so the page showed nothing at exactly the moment someone was
 * watching a run to see what it was doing.
 *
 * The fix must be narrow. Swallowing every error would turn a real fault — a
 * permissions problem, a broken mount — into an empty list indistinguishable
 * from a run that produced no artifacts, which is the silent-empty failure this
 * codebase keeps finding.
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { listArtifactFiles } from '../server/utils/artifactListing.ts'

const root = mkdtempSync(join(tmpdir(), 'artifacts-'))
mkdirSync(join(root, 'oracle'), { recursive: true })
writeFileSync(join(root, 'meta.json'), '{}')
writeFileSync(join(root, 'oracle', 'raw-1.txt'), 'a')
writeFileSync(join(root, 'oracle', 'raw-3.txt'), 'ccc')

// 1. the ordinary case still works
{
  const files = await listArtifactFiles(root)
  assert.deepEqual(files.map(f => f.name).sort(),
    ['meta.json', 'oracle/raw-1.txt', 'oracle/raw-3.txt'],
    'a quiet directory lists every file')
  assert.equal(files.find(f => f.name === 'oracle/raw-3.txt').size, 3, 'sizes are real')
  console.log('  ok   a settled directory lists completely')
}

// 2. the reported failure: a file vanishes between readdir and stat
{
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, statx"), { code: 'ENOENT' })
  const files = await listArtifactFiles(root, {
    readdir,
    stat: async (p) => { if (String(p).endsWith('raw-3.txt')) throw enoent; return stat(p) },
  })
  assert.deepEqual(files.map(f => f.name).sort(), ['meta.json', 'oracle/raw-1.txt'],
    'the vanished file is skipped and every surviving file is still returned')
  console.log('  ok   a file vanishing mid-walk is skipped, not fatal')
}

// 3. a whole subdirectory disappearing mid-walk
{
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const files = await listArtifactFiles(root, {
    readdir: async (d, o) => { if (String(d).endsWith('oracle')) throw enoent; return readdir(d, o) },
    stat,
  })
  assert.deepEqual(files.map(f => f.name), ['meta.json'],
    'a directory removed mid-walk is skipped too')
  console.log('  ok   a subdirectory vanishing mid-walk is skipped')
}

// 4. a REAL fault must still surface — this is the half that keeps the fix honest
{
  const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  await assert.rejects(
    () => listArtifactFiles(root, { readdir, stat: async () => { throw eacces } }),
    /EACCES/,
    'a permissions error must NOT be swallowed: an empty list would be indistinguishable from a run that produced nothing')
  console.log('  ok   a permissions error still throws')

  await assert.rejects(
    () => listArtifactFiles(root, { readdir: async () => { throw eacces }, stat }),
    /EACCES/,
    'the same on readdir')
  console.log('  ok   a readdir fault still throws')
}

rmSync(root, { recursive: true, force: true })
console.log('\nartifact listing: all checks passed')
