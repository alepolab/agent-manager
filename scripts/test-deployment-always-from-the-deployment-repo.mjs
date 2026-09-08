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

// ── the Ansible layer is a data source, not a second deploy path ──────────
check('the provisioner is told to read the per-product role defaults',
  /deploy\/ansible\/roles\/app_<product>\/defaults\/main\.yml/.test(prov),
  'that file names the compose file, the profile, the pinned image tag, the health container and the init order — every value this step otherwise infers')

check('the specific keys are named, not just the file',
  ['app_compose_files', 'app_compose_profiles', 'app_image_tag', 'app_health_containers', 'app_health_path']
    .every(k => prov.includes(k)),
  'pointing at a file without naming the keys leaves the agent to guess which of them matter')

check('it is stated NOT to be a second deploy path',
  /not a second way to deploy/.test(prov) && /drives the ones this repo\s*\n?already has/.test(prov),
  "the layer's own docs say it does not render compose files; an agent that thinks otherwise will try to run playbooks instead of reading them")

check('the "no image tag" halt is called out as no longer honest',
  /no longer\s*\n?honest/.test(prov) && /app_image_tag/.test(prov),
  'a real run halted on a missing tag that was sitting in the role defaults — the instruction must close that specific hole')

check('absence of the ansible directory is handled',
  /has not been merged to the branch\s*\n?you cloned/.test(prov),
  'it currently lives on a feature branch; an instruction that assumes it is present would make every run report a false gap')

// ── configure the env, and pin where it runs ──────────────────────────────
check('every stack variable must hold a real value',
  /must actually hold a value/.test(prov) && /TEST-NET/.test(prov),
  'a 192.0.2.x placeholder is reserved and unroutable — it fails as a timeout minutes later and far from the cause')

check('empty vs unset vs absent is called out',
  /Empty, unset and absent behave differently/.test(prov),
  '`${VAR:-}` in compose DEFINES the variable as empty, satisfying a presence check while meaning nothing')

check('the run is pinned to one host group',
  // Substrings, not regex: the source escapes every backtick as \\` (two
  // characters), so a single `.` cannot span one and the pattern silently
  // fails against text that is plainly there.
  prov.includes('only.**') && prov.includes('never') && /staging[\s\S]{0,20}prod/.test(prov)
  && prov.includes('production incident rather than a mistake'),
  'the playbooks target hosts: "{{ target_env }}" — an unpinned target_env is a deploy to whatever the inventory happens to list')

check('it narrows to a single host via host_apps',
  /host_apps/.test(prov) && /--limit <host>/.test(prov),
  'a product deployed to a box that does not claim it still reports success')

check('one environment per run',
  /One environment per run\. Never two\./.test(prov),
  "the estate's standing rule, and the one a --limit mistake violates silently")

check('the pinned target is recorded in the stack report',
  /which group and\s*\n?which host you pinned to/.test(prov),
  'a wrong-target deploy has to be visible in review, not six weeks later')

check('shared inventory is never edited in place',
  /Never edit the inventory in the repo\s*\n?checkout/.test(prov),
  'the checkout is shared configuration; a run is not entitled to rewrite it')

// The user asked for no specific hosts in the instructions: inventories are
// edited, and an address baked into a prompt outlives the machine it named.
check('no hostname or address is hardcoded in any agent prompt',
  !/dev-app-0\d/.test(templates) && !/172\.16\.\d+\.\d+/.test(templates) && !/10\.79\.\d+\.\d+/.test(templates),
  'a remembered address outlives the machine it named; the host must be derived from the inventory at run time')

check('the agent is told to derive the host from the checkout',
  /Derive the host from the inventory in the checkout you cloned/.test(prov),
  'without this the model will happily reuse an address it saw in an example')

console.log(failures === 0 ? '\ndeployment repo is the only source: all checks passed' : `\ndeployment repo is the only source: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
