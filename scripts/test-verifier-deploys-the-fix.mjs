#!/usr/bin/env node
/**
 * The pipeline verified source and called it evidence.
 *
 * The provisioner stands a stack up from a GHCR image built BEFORE the fix
 * exists. The verifier then ran tests, lint and typecheck in the checkout, and
 * neither it nor the trace step contained the string "docker" at all. So no run
 * ever demonstrated that the fixed code builds into a deployable image, or that
 * the image starts and serves — while the PR it opened claimed to be
 * evidence-backed. Against the estate's own rule ("verify against the artifact,
 * not the source") that was the weakest link in the chain.
 *
 * The verifier now builds and deploys the fixed build. The constraint that
 * shapes the whole design is in the DAG: sdlc-fix-implementer fans out to
 * sdlc-verifier, sdlc-trace-capture and sdlc-security-review IN PARALLEL. An
 * in-place redeploy would swap the application out from under a browser session
 * mid-trace and produce a recording of a half-restarted app — evidence that is
 * worse than none, because it looks real. Hence: its own compose project, never
 * over the baseline.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

const templates = read('app/utils/templates.ts')
const verifier = templates.slice(
  templates.indexOf("id: 'sdlc-verifier'"),
  templates.indexOf("id: 'sdlc-trace-capture'"))

check('the verifier deploys the fixed build',
  /## Deploy the fixed build and prove it runs/.test(verifier),
  'without this section the run proves the source and never the artifact')

check('it builds from the checkout with a local tag',
  /docker build -t localhost\/agent-sdlc\//.test(verifier),
  'the image under test must come from the fixed checkout, not from GHCR')

check('it deploys under its own compose project',
  /docker compose -p sdlc-<run id>/.test(verifier)
  && /alongside the baseline/.test(verifier),
  'an in-place redeploy races the parallel Browser Trace and would swap the app out mid-session')

check('the parallel-fan-out hazard is named, not merely avoided',
  /in parallel[\s\S]{0,400}Browser Trace/.test(verifier)
  && /half-restarted/.test(verifier),
  'the next person to edit this must know WHY the deploy is side-by-side, or they will simplify it back into a race')

check('it uses TAG, not IMAGE_TAG',
  /TAG=localhost\/agent-sdlc\//.test(verifier) && /never\s*\n?\s*\\`IMAGE_TAG\\`/.test(verifier),
  'IMAGE_TAG is the recurring wrong lever in this estate')

check('health is proved from inside the network',
  /docker exec <container> curl -sf/.test(verifier)
  && /host-published ports are\n\s*unreachable/.test(verifier),
  'the agent runs inside a container; a timeout against a host port says nothing about the build')

check('teardown is scoped and non-destructive',
  /docker compose -p sdlc-<run id> down\\`/.test(verifier)
  && /Never \\`down -v\\`/.test(verifier)
  && /never remove anything you did not start/.test(verifier),
  'down -v destroys seeded data other runs depend on, and a shared estate means someone else owns the stacks you did not start')

check('the built image is never pushed',
  /Never push the image you build/.test(verifier),
  'a registry push from inside a run puts an unreviewed build where real deployments can find it')

check('a skip must state what was measured',
  /When to skip, and how to say so/.test(verifier)
  && /A skip with a measured reason is a pass/.test(verifier)
  && /ocs_cpp14/.test(verifier),
  'skipping is often correct here; skipping silently is how a step stops doing its job without anyone noticing')

check('the local tag is podman-unambiguous and checked before use',
  /prefix is load-bearing, not decoration/.test(verifier)
  && /docker image inspect localhost\/agent-sdlc/.test(verifier),
  'podman normalises a bare agent-sdlc/x:y to docker.io/... — a registry name for an image only this machine has, inviting a pull that cannot succeed')

check('the deploy verdict reaches the report and the artifacts',
  /whether the fixed build was deployed and proved\s*\n?\s*healthy/.test(verifier)
  && /deploy-report\.md/.test(verifier),
  'a reviewer needs to see the decision, not its absence')

// The added work has to be paid for. A verifier that runs out of turns returns
// EMPTY output (error_max_turns), which is the worst failure mode in this
// system: it looks like an agent that had nothing to say.
check('the turn budget was raised to pay for the build',
  /maxTurns: 80,/.test(verifier),
  'build + deploy + health + teardown does not fit in the 60 turns the old scope was proven at')

console.log(failures === 0 ? '\nverify-against-the-artifact: all checks passed' : `\nverify-against-the-artifact: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
