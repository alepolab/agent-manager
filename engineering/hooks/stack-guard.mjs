#!/usr/bin/env node
/**
 * PreToolUse hook — the stack guard.
 *
 * The runner owns a run's environment: it reads the lifecycle out of the infra
 * repo's published contract (`agent/stack-contract.json`), runs the compose
 * stages in the order that repo documents, verifies what came up, and takes the
 * stack down when the run settles — never with `-v`, so seeded data survives.
 * `deploy.sh` is the same story one level up: dev may run unattended, staging
 * and prod stop at a human gate before a single ansible argument is assembled.
 *
 * Every step is told this in words. Words were not enough: an agent that cannot
 * see a service tries `docker compose up` itself, and then the run has two
 * owners of the same containers — one that labelled them with the run id and
 * one that did not, one that knows the profile order and one that guessed. The
 * reaper cleans up what the runner started; what an agent started is nobody's.
 * A `down -v` typed by an agent costs hours of seeded data.
 *
 * So this denies the MUTATING half and leaves reading alone:
 *
 *   denied   docker compose up|down|start|stop|restart, docker-compose the same,
 *            deploy.sh, ansible-playbook
 *   allowed  docker compose ps|logs|config|top|events, docker ps|inspect|logs,
 *            and every build form — `docker compose run/exec/build`,
 *            `docker build`, `docker run` — because building in the product's
 *            own container is exactly what the pull-request gate requires.
 *
 * Contract: tool call as JSON on stdin; exit 0 allows; exit 2 with a printed
 * reason denies. Internal errors allow — a broken hook must not wedge the estate.
 */
import { readFileSync } from 'node:fs'
import { commandSegments, segmentTokens } from './command-segments.mjs'

/** Compose verbs that change what is running. `run`, `exec` and `build` are not
 *  here on purpose: they are how a step builds and tests inside the stack. */
const MUTATING_COMPOSE = new Set(['up', 'down', 'start', 'stop', 'restart', 'kill', 'rm'])

/** The first non-flag word after `compose`, which is the verb docker acts on. */
function composeVerb(tokens, from) {
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i] ?? ''
    if (t.startsWith('-')) {
      if (!t.includes('=')) i++
      continue
    }
    return t
  }
  return ''
}

export function denyReason(call) {
  if (call.tool_name !== 'Bash') return null
  const cmd = String(call.tool_input?.command ?? '')

  for (const segment of commandSegments(cmd)) {
    const tokens = segmentTokens(segment)
    if (!tokens.length) continue
    const bin = (tokens[0] ?? '').replace(/^.*[\\/]/, '')

    if (/^deploy\.sh$/.test(bin) || tokens.some(t => t.replace(/^.*[\\/]/, '') === 'deploy.sh')) {
      return 'running deploy.sh yourself is denied. The runner drives it for a step that declares a deploy: dev runs unattended, '
        + 'staging and prod are refused until a person answers the gate and a secrets file is configured. '
        + 'If this step needs a deploy it does not have, say so in your output — do not deploy around the gate.'
    }
    if (bin === 'ansible-playbook' || bin === 'ansible') {
      return 'running ansible directly is denied. deploy.sh is the infra repo\'s one integration surface — Jenkins, a person and this pipeline drive it identically — '
        + 'and the runner is what invokes it. A playbook run by hand skips the environment validation and the approval gate that script carries.'
    }

    const isDockerLike = /^(docker|podman|nerdctl)$/.test(bin)
    if (bin === 'docker-compose' && MUTATING_COMPOSE.has(composeVerb(tokens, 1))) {
      return stackMessage(composeVerb(tokens, 1))
    }
    if (isDockerLike && tokens[1] === 'compose' && MUTATING_COMPOSE.has(composeVerb(tokens, 2))) {
      return stackMessage(composeVerb(tokens, 2))
    }
  }
  return null
}

function stackMessage(verb) {
  const extra = verb === 'down' || verb === 'rm'
    ? ' Teardown is the runner\'s too, and it never removes volumes — a stack taken down by hand is how seeded data that takes hours to rebuild disappears.'
    : ''
  return `\`compose ${verb}\` is denied: the runner owns this run's stack. It reads the profile order from the infra repo's published contract, `
    + 'labels the containers with this run id so they can be reaped, and records what came up in stack-facts.json in your artifacts directory. '
    + `A stack you start yourself is unlabelled, unordered and nobody's to clean up.${extra} `
    + 'Read what is running instead — `docker compose ps`, `docker compose logs`, `docker ps` — and build or test inside it with '
    + '`docker compose run --rm <service> <command>`, which is allowed and is what the pull-request gate asks for. '
    + 'If the stack you need is not up, say so in your output: the step that declares it is where that gets fixed.'
}

function main() {
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { process.exit(0) }
  let call
  try { call = JSON.parse(raw) } catch { process.exit(0) }
  const reason = denyReason(call)
  if (reason) {
    console.error(`Blocked by the stack guard: ${reason}`)
    process.exit(2)
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))
if (isMain) {
  try { main() } catch { process.exit(0) }
}
