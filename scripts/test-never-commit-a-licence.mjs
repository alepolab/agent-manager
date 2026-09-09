#!/usr/bin/env node
/**
 * The PCRF checkout on this instance carries `license/Alepo-License-PCRF.lic`.
 * It is correctly ignored — `.gitignore` covers `license/` wholesale, with only
 * a `.gitkeep` tracked — and `git ls-files` confirms it is untracked.
 *
 * But that is ONE rule standing between a Padlock-signed proprietary licence
 * and a public commit, in a checkout that agents commit and push from. The
 * provisioner was already told never to copy a developer's `.env`; nothing said
 * the same about a licence, and nothing at all governed what the fix step
 * stages.
 *
 * Two placements, deliberately: the provisioner reads these files, and the
 * fix-implementer is the step that actually runs `git add`. A rule about
 * committing belongs where the commit happens.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const t = readFileSync(join(root, 'app/utils/templates.ts'), 'utf8')
const seg = (id, next) => t.slice(t.indexOf(`id: '${id}'`), t.indexOf(`id: '${next}'`)).replace(/\s+/g, ' ')
const prov = seg('sdlc-stack-provisioner', 'sdlc-test-author')
const fix = seg('sdlc-fix-implementer', 'sdlc-verifier')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

// ── provisioner: never copy ───────────────────────────────────────────────
check('the provisioner covers licence files alongside .env',
  /licence files/i.test(prov) && /license\/\*\.lic/.test(prov),
  'the .env rule existed and the licence sat outside it, in the same checkouts')

check('it says to mount the host copy rather than copy it',
  /Mount the one already on the host/.test(prov),
  'a stack may genuinely need the licence; forbidding use rather than copying would just halt every licensed product')

check('it names the artifacts directory and the PR as exfiltration paths',
  /kept as evidence/.test(prov) && /PR body/.test(prov),
  'the artifacts directory is retained and the bundle travels into a pull request — those are how a file leaves the machine')

// ── fix-implementer: never commit ─────────────────────────────────────────
check('the fix step has its own rule, where the commit happens',
  /Never commit a credential or a licence/.test(fix),
  'the provisioner reads these files but the fix step is the one that runs git add; a rule only in the reader does not bind the writer')

check('blanket staging is forbidden by name',
  /git add -A/.test(fix) && /git add \./.test(fix) && /git commit -a/.test(fix),
  'these are the exact commands that sweep in an untracked licence sitting in the tree')

check('the reason is given, not just the prohibition',
  /what is sitting in the tree is not something you chose/.test(fix),
  'an agent told only "do not use git add -A" will reach for it under time pressure unless it knows what it risks')

check('it says an unexpected file is reported, not swept in',
  /leave it alone and say so in your report/.test(fix),
  'the alternative to staging everything must be stated, or the agent stalls')

check('the irreversibility is stated',
  /not fixed by a later commit removing/.test(fix) && /rotation/.test(fix),
  'a secret in history is a rotation someone else has to perform — that is what makes this worth a rule rather than a preference')

check('the concrete file is named',
  /Alepo-License-PCRF\.lic/.test(fix),
  'a rule about "licences" in the abstract does not tell an agent the one it will actually meet')

console.log(failures === 0 ? '\nnever commit a licence: all checks passed' : `\nnever commit a licence: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
