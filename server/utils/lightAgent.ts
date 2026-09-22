import { query } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from './log.ts'
import { allowedProcessEnv } from './agentCaller.ts'

const log = createLogger('artifacts')

/**
 * One cheap model turn for a question that is genuinely about MEANING, not
 * about a contract — "what kind of evidence is this file", not "did the
 * reviewer say PASS".
 *
 * A regex over names is a guess dressed as a rule: it says nothing about
 * `verify-t4` or `t7-child-journey-assessment-CSUP-7526.md`, and the next run
 * invents a name nobody wrote a rule for. A model reads those the way a person
 * does. So wherever this codebase was pattern-matching at SEMANTICS, it asks
 * here instead — and keeps the pattern matcher as the fallback, because an
 * interpretation that needs the network must never be the only way a run can
 * finish.
 *
 * Deliberately NOT used for, and never to be used for:
 *  - `parseReviewVerdict` / `PIPELINE-HALT` / monitor verdicts. Those are
 *    machine-readable contract markers an agent is told to emit, and a gate
 *    that asks a model whether a gate passed is a gate that can hallucinate its
 *    way open — the exact bypass those parsers were written to close.
 *  - `scanSensitivity`. Sending evidence that may contain credentials to a
 *    model to ask whether it contains credentials is the disclosure the label
 *    exists to prevent.
 *  - anything derived from git or the filesystem (shipIntegrity, commit counts,
 *    sizes). Those are facts, and a fact must never be interpreted.
 *
 * No tools, no settings inheritance, one turn, haiku: this costs a fraction of
 * a cent and cannot touch the repository. Returns null — never a guess, never a
 * partial — on every failure path, so the caller falls back deterministically.
 */
export interface LightAskOptions {
  timeoutMs?: number
  /** Overrides the model when a caller needs a different one; 'haiku' otherwise. */
  model?: string
}

export function lightAgentEnabled(): boolean {
  return process.env.AGENT_LIGHT_INTERPRET !== '0'
}

export type Asker = (system: string, prompt: string, opts?: LightAskOptions) => Promise<string | null>

/** Test seam, same shape as notify.ts's `setPoster`: a test pins the CONTRACT
 *  (what answers are accepted, what is ignored) without a live model call. */
let asker: Asker | undefined
export function setAsker(fn: Asker | undefined) { asker = fn }

export async function askLight(
  system: string, prompt: string, opts: LightAskOptions = {},
): Promise<string | null> {
  if (asker) return asker(system, prompt, opts)
  if (!lightAgentEnabled()) return null
  const { timeoutMs = 30_000, model = 'haiku' } = opts
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), timeoutMs)
  try {
    let text = ''
    for await (const message of query({
      prompt,
      options: {
        model,
        // Two, not one: with `maxTurns: 1` the SDK ends the query with
        // "Reached maximum number of turns (1)" — an error result — even for a
        // model that answered in one turn and stopped. Two lets the answer
        // land. There are no tools, so nothing can spend the second turn.
        maxTurns: 2,
        abortController,
        // No tools at all: this reads a list and answers. Anything it could
        // reach on disk would be evidence it has no business opening.
        allowedTools: [],
        // Same reason callAgent sets this: a person's interactive settings
        // (persona, skills, CLAUDE.md) are not part of a classification.
        settingSources: [],
        env: allowedProcessEnv(),
        systemPrompt: system,
      },
    })) {
      if (message.type === 'assistant') {
        const content = (message as { message?: { content?: unknown } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
              text += String((block as { text?: unknown }).text ?? '')
            }
          }
        }
      }
    }
    return text.trim() || null
  } catch (e) {
    log.warn('light interpretation unavailable; falling back to rules', { error: String(e) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

const FLOOR_SYSTEM = `You read the file paths a code change touched and answer with the LOWEST risk class that change is definitely AT LEAST.

Classes, least to most dangerous:
docs | ui_parsing | schema | deployment | protocol | money

- money: billing, charging, tax, pricing, credits, invoices, refunds, proration — anything that decides what a customer is charged.
- protocol: an interface other systems depend on — API contracts, message schemas, RADIUS/Diameter, auth or session protocol.
- deployment: how the system is built, configured or run — compose files, Dockerfiles, CI workflows, infrastructure, boot configuration.
- schema: the shape of stored data — migrations, changelogs, SQL, ORM models.
- ui_parsing: presentation, templates, parsing of input.
- docs: documentation only.

Answer with ONE JSON object: {"class": "<one of the classes>", "why": "<under 15 words>"}
Answer {"class": null} when the paths do not PROVE any class — ordinary source files usually do not.
You may only raise risk, never lower it: if unsure between two, answer the LOWER one or null.
No prose, no code fence.`

/**
 * The risk floor a model reads in the touched paths, when the path RULES saw
 * nothing.
 *
 * Path rules catch liquibase, compose files and terraform because those live at
 * recognisable paths. They are blind to what code DOES: money arithmetic lives
 * in ordinary Java, and CSUP-7516 — a change to tax arithmetic — was approved
 * in a single click because no rule matched its path. A model reading
 * `BillingChargeCalculator.java` sees what a regex over directories cannot.
 *
 * Safe by construction, and this is the only reason it may touch a gate input:
 * the caller takes the STRONGER of the rules floor and this, so an answer can
 * only ever raise oversight. A model that is slow, wrong-shaped or unavailable
 * returns null and the rules floor stands unchanged.
 */
export async function agentFloorFrom(paths: string[]): Promise<string | null> {
  if (!paths.length) return null
  const answer = parseJsonObject(await askLight(FLOOR_SYSTEM, paths.slice(0, 300).join('\n'), { timeoutMs: 20_000 }))
  const cls = answer?.class
  return typeof cls === 'string' && cls ? cls : null
}

/** The JSON object a light call answered with, or null when it did not answer
 *  with one. Fenced code blocks are stripped: a model asked for bare JSON still
 *  sometimes wraps it, and failing over that would discard a good answer. */
export function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
