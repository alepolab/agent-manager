#!/usr/bin/env node
/**
 * Deployment comes from alepo-dev-team-infra, always. The product repo builds
 * and tests the change; the deployment repo runs it.
 *
 * The provisioner used to permit the opposite: "when the affected product has
 * none, do not halt on that alone: use the product's own compose from its
 * checkout". Run 1dd343a8 is what that costs — the step read the deployment
 * repo's compose, found a missing licence and an unresolved image tag, and
 * skipped the stack, so the change was verified by unit tests alone against an
 * environment nobody runs.
 *
 * A stack stood up from a product's own compose LOOKS like it works. It is
 * wired differently from production — different network, different env
 * prefixes, its own database rather than the shared `database` and `sso`
 * stacks — so everything it proves is about the wrong environment, confidently.
 * That is why the fallback is removed rather than discouraged: a route that
 * exists gets taken under pressure.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const templates = readFileSync(join(root, 'app/utils/templates.ts'), 'utf8')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

const seg = (id) => {
  const i = templates.indexOf(`id: '${id}'`)
  const j = templates.indexOf("id: 'sdlc-", i + 10)
  return templates.slice(i, j > 0 ? j : undefined)
}
const prov = seg('sdlc-stack-provisioner')
const verif = seg('sdlc-verifier')

check('the provisioner states the rule without hedging',
  /## Deployment comes from the deployment repo\. Always\./.test(prov),
  'a rule stated as a preference is one an agent trades away when the deployment repo is inconvenient')

check('it clones the deployment repo',
  /git clone https:\/\/github\.com\/alepolab\/alepo-dev-team-infra\.git/.test(prov),
  'the rule is unusable if the repo is not on disk; the provisioner already clones the product repo and must clone this one too')

check('the build/run split is named',
  /product repo is for \*\*building and testing\*\*[\s\S]{0,120}deployment\n?repo is for \*\*running\*\*/.test(prov),
  'without the split someone reads "always use the infra repo" as forbidding product-repo builds, which is not the rule')

check('a missing compose is a halt, not a fallback',
  /that is a halt/.test(prov) && /deliberately removed/.test(prov),
  'the halt names a gap in the deployment repo that someone must close — worth more than a run that quietly proved the wrong thing')

// The exact sentence that permitted the old route must be gone, not softened.
check('the product-own-compose fallback is deleted',
  !/use the product's own compose from its checkout/.test(templates)
  && !/fall back to the product checkout's own compose/.test(templates),
  'a documented escape hatch is the one that gets used at 2am')

check('the reason is given, not just the rule',
  /wired differently from\s*\n?production/.test(prov),
  'an agent that knows only the rule cannot tell when it is being asked to break it')

check('the rule is stated to bind later steps too',
  /same rule binds every later step/.test(prov),
  'the verifier redeploys as well; a rule that lives only in the provisioner leaks')

check('the verifier deploys from the deployment repo compose',
  /-f <infra checkout>\/docker-compose\.<product>\.yml/.test(verif)
  && /never the\n?\s*product's own/.test(verif),
  'the deploy step said "-f <compose file>" without saying whose, which is an invitation to use the nearest one')

console.log(failures === 0 ? '\ndeployment repo is the only source: all checks passed' : `\ndeployment repo is the only source: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
