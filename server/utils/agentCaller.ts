import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { agentManagerSettings } from './appSettings.ts'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { resolveTools, resolveMaxTurns, resolveMaxDurationMs } from './agentToolPolicy.ts'
import { buildAgentSystemPrompt } from './agentSystemPrompt.ts'
import { pipelineHooks } from './agentHooks.ts'
import { createLogger, preview } from './log.ts'
import type { AgentFrontmatter } from '~/types'

/**
 * Absolute path to the shipped `engineering/scripts` directory, handed to every
 * agent as `SDLC_SCRIPTS_DIR`.
 *
 * The evidence step's instructions used to say `node
 * engineering/scripts/assemble-bundle.mjs` — a path relative to the *app*,
 * evaluated in the *product checkout*, where no `engineering/` exists. The
 * assembler is in the image at /app/engineering/scripts and always has been;
 * from the agent's cwd it simply is not there. So the bundle went unvalidated
 * and the agent reported the assembler "absent from this installation" — an
 * accurate description of what it could see, and a false one about the install.
 *
 * That is the failure worth naming: the run completed, the PR opened, and the
 * only sign was one line inside a step's output. An absolute path costs
 * nothing and cannot be read relative to the wrong tree.
 */
/**
 * The environment every pipeline agent runs in. Exported because preflight has
 * to ask git the same questions the AGENTS will ask it: a `commit.gpgsign` read
 * from this shell answers for the wrong process, and that is exactly how a run
 * finished its fix and then halted at `git commit`.
 */
export async function agentEnvFor(_startedBy?: string): Promise<Record<string, string>> {
  return {
    ...process.env as Record<string, string>,
    // A bot identity for git and gh, when one is configured, so agent pushes
    // and PRs are not attributed to whoever runs the server.
    ...(process.env.AGENT_GH_TOKEN ? { GH_TOKEN: process.env.AGENT_GH_TOKEN, GITHUB_TOKEN: process.env.AGENT_GH_TOKEN } : {}),
    SDLC_SCRIPTS_DIR: sdlcScriptsDir(),
    SDLC_SKILLS_DIR: sdlcSkillsDir(),
    CE_SKILLS_DIR: await ceSkillsDir(),
    // Pipeline commits are unsigned. The developer's own ~/.gitconfig is
    // mounted into the container and may say commit.gpgsign=true, but the
    // agents hold no signing key and the image has no gpg: a real run
    // finished its fix and then halted at `git commit`. Environment config
    // outranks every file, so this holds for every git the agent runs.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
  }
}

export function sdlcScriptsDir(): string {
  return join(process.cwd(), 'engineering', 'scripts')
}

/**
 * Absolute path to the seeded skills directory, handed to every agent as
 * `SDLC_SKILLS_DIR`.
 *
 * Language-matched skills are read from disk at run time rather than declared
 * in an agent's frontmatter, because `buildAgentSystemPrompt` inlines the FULL
 * BODY of every declared skill. Declaring all 24 would have put ~80,000 tokens
 * into every agent's prompt on every step of every run - an eleven-fold
 * increase on a prompt that is ~7,000 today, and most of it irrelevant, since a
 * Java run has no use for the Go testing skill.
 *
 * Absolute for the reason the assembler was: the agent's cwd is the product
 * checkout, where nothing of ours exists.
 */
export function sdlcSkillsDir(): string {
  return resolveClaudePath('skills')
}

/**
 * Absolute path to the compound-engineering plugin's skills directory, handed
 * to every agent as `CE_SKILLS_DIR`. The ce runbook's steps read `ce-plan`,
 * `ce-work`, `ce-code-review` and `ce-commit-push-pr` from there at run time,
 * for the reason SDLC_SKILLS_DIR exists: those four alone are ~240,000 bytes,
 * and declaring them would inline all of it into every step's prompt. Empty
 * when the plugin is not installed; a ce step halts on that rather than
 * improvising the skill from memory.
 */
export async function ceSkillsDir(): Promise<string> {
  try {
    const installed = JSON.parse(await readFile(resolveClaudePath('plugins', 'installed_plugins.json'), 'utf-8'))
    const entry = Object.entries<any>(installed?.plugins ?? {}).find(([k]) => k.startsWith('compound-engineering@'))?.[1]?.[0]
    return entry?.installPath ? join(entry.installPath, 'skills') : ''
  } catch { return '' }
}

const log = createLogger('agent')

/**
 * Token usage for one agent turn, as the SDK's own `result` message reported
 * it - never estimated. `input_tokens` folds THREE of the SDK's usage
 * buckets together: `input_tokens` (fresh, uncached), `cache_creation_input_tokens`
 * and `cache_read_input_tokens`. Judgement call, stated here because a
 * reviewer comparing two bundles needs both counted the same way: the
 * evidence-bundle schema has exactly one `input_tokens` slot, no separate
 * cache accounting, and a real agentic turn with prompt caching on can spend
 * >1000x more tokens on cache writes than on fresh input (measured: 3 fresh
 * vs 5406 cache-creation tokens on a trivial one-turn probe). Reporting only
 * the fresh-input figure in that slot would be technically non-fabricated
 * but functionally as misleading as the hardcoded 0 it replaces - a cost
 * field a reviewer can't use to gauge what the run actually spent. So
 * `input_tokens` here means "every input-side token the API processed",
 * not "every input-side token that was billed at the base input rate".
 * `output_tokens` is `usage.output_tokens` alone - there is no output-side
 * caching to fold in.
 */
export interface AgentUsage {
  input_tokens: number
  output_tokens: number
  /** Of input_tokens, the ones read back from the prompt cache (a tenth of the price). */
  cache_read_input_tokens?: number
  /** What the SDK itself says the call cost, in USD; the number to trust over any table here. */
  usd?: number
}

/**
 * What one agent turn actually did. `model` is the id the SDK's own
 * `system`/`init` message reported it ran with (e.g. 'claude-sonnet-4-6') -
 * an OBSERVED fact, not a value we requested or defaulted to. `null` when no
 * init message was seen (never guessed - see the comment below on why a
 * fallback here would be worse than an honest absence). `usage` is `null`
 * when the result message carried no usable usage object - never guessed
 * either; see AgentUsage for what "usable" means.
 */
export interface AgentCallResult {
  output: string
  model: string | null
  usage: AgentUsage | null
  /** The SDK session the call ran in: its transcript is `~/.claude/projects/<cwd>/<sessionId>.jsonl`. */
  sessionId: string | null
}

/**
 * Lightweight, diagnostic-only progress telemetry surfaced from the SDK's
 * message stream WHILE a step is still running — the thing a run record
 * could not show before: a step sat at `status: 'running'` with nothing
 * else until it terminated, sometimes 100-430s later. `turn` counts
 * assistant turns observed so far; `lastTool` is the name of the most
 * recently invoked tool (never its arguments — those can carry ticket text
 * or file contents, exactly what runArtifacts.ts's truncation policy exists
 * to keep out of persisted evidence); `lastActivityAt` is when either was
 * last observed, and is the one field that actually distinguishes "still
 * working" from "wedged". This is NOT provenance: never asserted by
 * runnerOwned() (runArtifacts.ts) and never written into a step's persisted
 * artifact — it exists only on the live RunStep record for the UI/SSE
 * stream to poll, and is allowed to be silently wrong or stale (a crash
 * mid-turn just leaves it at its last value) without that being a defect.
 */
export interface AgentProgress {
  turn: number
  lastTool?: string
  lastActivityAt: number
  /** One human-readable line for the live log: a tool call, a text excerpt or a result preview. Present only on events that carry one. */
  line?: string
}

const LINE_MAX = 300
const TOOL_LINE_MAX = 600
const squash = (s: string, max = LINE_MAX) => s.replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * The live-log line for one content block, or null when the block says
 * nothing a watcher needs. Tool inputs are summarised to the one field that
 * says what is happening (a command, a path, a pattern), never dumped whole:
 * a Write's content or a prompt's ticket text has no place in a log.
 */
export function describeBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const b = block as { type?: string, text?: string, name?: string, input?: Record<string, unknown>, content?: unknown, is_error?: boolean }
  if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return squash(b.text)
  if (b.type === 'tool_use' && typeof b.name === 'string') {
    const i = b.input ?? {}
    const detail = [i.command, i.file_path, i.path, i.pattern, i.query, i.url, i.description].find(v => typeof v === 'string' && v.trim()) as string | undefined
    return squash(`[${b.name}] ${detail ?? ''}`, TOOL_LINE_MAX)
  }
  if (b.type === 'tool_result') {
    const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ') : ''
    if (!text.trim()) return null
    return squash(`${b.is_error ? '✗' : '→'} ${text}`)
  }
  return null
}
export type OnAgentProgress = (progress: AgentProgress) => void

/** Per-call extras: the runner's abort signal, the starter's identity env, a progress sink,
 *  a steering hook and a session hook. `onSteer` receives `deliver`, which pushes an operator
 *  message into the agent's conversation while it works (the SDK delivers it once the tool
 *  call or model request in flight completes, without ending the turn); it returns false once the call is over.
 *  `onSession` fires as soon as the SDK reports the session id and the directory it ran in. */
export interface AgentCallOptions {
  signal?: AbortSignal
  env?: Record<string, string>
  onProgress?: OnAgentProgress
  onSteer?: (deliver: (text: string) => boolean) => void
  onSession?: (sessionId: string, cwd: string) => void
  /**
   * Continue an earlier SDK session instead of starting one. The model keeps
   * everything it already read, so a step that ran out of turns, or was
   * answered, or was interrupted by a server restart, carries on rather than
   * re-exploring from nothing — which is where a real step spent three whole
   * visits reading the same files and never wrote its plan.
   */
  resume?: string
}

/** Floor between successive progress emissions when the active tool hasn't
 *  changed — publishing on every SDK message would be far too chatty (a
 *  single turn can emit several messages: assistant text, tool_use,
 *  tool_result echoes) for a signal whose entire job is "did anything
 *  happen since I last looked". A tool-name CHANGE always emits immediately
 *  regardless of this floor: that transition (Read -> Bash, say) is itself
 *  the interesting event, worth surfacing right away rather than batched
 *  into the next tick. */
export const PROGRESS_MIN_INTERVAL_MS = 2000

/**
 * Pure throttle decision, pulled out specifically so the policy is
 * unit-testable without a live SDK call (see scripts/test-agent-progress.mjs):
 * given when the last emission happened and whether the active tool just
 * changed, should THIS observation be emitted now?
 */
export function shouldEmitProgress(
  now: number,
  lastEmitAt: number | undefined,
  toolChanged: boolean,
  minIntervalMs: number = PROGRESS_MIN_INTERVAL_MS,
): boolean {
  if (lastEmitAt === undefined) return true
  if (toolChanged) return true
  return now - lastEmitAt >= minIntervalMs
}

// Exported and imported directly by workflowRunner.ts (module scope, not a
// side-effect import) so the real caller is wired the instant that module
// loads — see the comment on `agentCaller` there. Do NOT import
// workflowRunner.ts from this file: workflowRunner.ts imports this file, and
// a back-reference would create a cycle.
/**
 * One agent turn. Returns its final text AND the model the SDK actually ran.
 *
 * Model handling here went through two rounds of correction, both against
 * measured behaviour of the installed SDK rather than its doc comments:
 *
 * 1. `frontmatter.model` (documented in CLAUDE.md's data model as
 *    `model: sonnet | opus | haiku`) used to be parsed and then silently
 *    ignored entirely — every agent ran on whatever the SDK's own default
 *    happened to be, regardless of what its frontmatter declared, no error.
 * 2. The first fix resolved the declared alias to a full id via this
 *    repo's own MODEL_ALIAS map (server/utils/models.ts) before passing it
 *    to query()'s `options.model`, on the strength of that field's doc
 *    comment ("Examples: 'claude-sonnet-4-6'"). A live `query()` call
 *    proved MODEL_ALIAS's ids are STALE ('claude-sonnet-4' etc. do not
 *    exist) - `Claude Code returned an error result: There's an issue with
 *    the selected model` on every single call. The doc comment misled; the
 *    artifact (a real API response) is what settled it.
 *
 * So: the bare alias declared in frontmatter is passed through to
 * `options.model` UNRESOLVED (measured directly: 'sonnet'/'opus'/'haiku'
 * are what the live API actually accepts there). MODEL_ALIAS itself is left
 * alone - it's stale and reported separately; correcting the registry is a
 * wider change than this function owns. When frontmatter declares no model,
 * the `model` option is omitted entirely rather than substituted with a
 * default: passing one would silently change every undeclared agent's model
 * (and cost) from whatever it inherits today, which is not this function's
 * call to make. Either way, what's RECORDED as `model` in the return value
 * is never the request — it's what the SDK's own `system`/`init` message
 * reports it resolved to, captured below.
 */
export async function callAgent(
  agentSlug: string, input: string, projectDir?: string, opts: AgentCallOptions = {},
): Promise<AgentCallResult> {
  const { signal, env: userEnv = {}, onProgress, onSteer, onSession, resume } = opts
  // The runner's stop aborts this controller; the SDK then ends the CLI process.
  const abortController = new AbortController()
  if (signal?.aborted) abortController.abort()
  signal?.addEventListener('abort', () => abortController.abort())
  const claudeDir = getClaudeDir()
  const cwd = projectDir && existsSync(projectDir) ? projectDir : claudeDir

  let systemAppend = `You are "${agentSlug}", a specialized agent.`
  let frontmatter: AgentFrontmatter | undefined

  const agentPath = resolveClaudePath('agents', `${agentSlug}.md`)
  if (existsSync(agentPath)) {
    const parsed = parseFrontmatter<AgentFrontmatter>(await readFile(agentPath, 'utf-8'))
    frontmatter = parsed.frontmatter
    systemAppend = await buildAgentSystemPrompt({
      agentSlug,
      agentName: parsed.frontmatter.name,
      agentBody: parsed.body,
      skills: parsed.frontmatter.skills,
      cwd,
    })
  }

  // An instance-wide override from the Settings page beats the agent's own file:
  // that is how a team moves every pipeline agent to a newer model without
  // editing ten agents and drifting from the shipped templates.
  const override = agentManagerSettings().agentModel
  const declaredModel = override || frontmatter?.model
  const toolsOption = resolveTools(frontmatter)
  const maxTurns = resolveMaxTurns(frontmatter)
  const maxDurationMs = resolveMaxDurationMs(frontmatter)
  // Armed here rather than around the loop so the budget covers everything the
  // call does, and cleared in the same finally that releases the input stream.
  // `timedOut` is the ONLY thing that distinguishes this abort from the
  // operator pressing Stop - both reach the SDK as the same aborted controller.
  let timedOut = false
  const deadline = setTimeout(() => { timedOut = true; abortController.abort() }, maxDurationMs)

  // Resolved before the call, and deliberately not caught: a missing guardrail
  // is a reason not to start, not a warning to run past. See agentHooks.ts.
  const { hooks, registered } = await pipelineHooks()

  const startedAt = Date.now()
  log.debug('agent call starting', () => ({
    agentSlug,
    cwd,
    modelRequested: declaredModel ?? '(sdk default)',
    modelSource: override ? 'settings override' : frontmatter?.model ? 'agent file' : 'sdk default',
    toolCount: toolsOption ? toolsOption.length : '(sdk default)',
    guardrails: registered.join(', '),
    maxTurns,
    maxDurationMs,
    inputLength: input.length,
    inputPreview: preview(input),
  }))

  let result = ''
  let modelRan: string | null = null
  let usage: AgentUsage | null = null
  let sessionId: string | null = null

  // ── steering: the prompt is a stream so the operator can talk to the agent mid-step ──
  // The first message is the step input. Later ones are operator notes, pushed
  // with priority 'next': the CLI hands them to the model as soon as the tool call
  // or model request in flight completes, without ending the turn. ('now' would
  // abort whatever is in flight, and an aborted model request comes back as an
  // error result that ends the step - seen live.) The stream ends at the first result
  // with nothing pending; a note that arrives after that is refused (deliver
  // returns false) and the runner falls back to queueing it for the next step.
  const pending: string[] = []
  let finished = false
  let wake: (() => void) | undefined
  const kick = () => { const w = wake; wake = undefined; w?.() }
  onSteer?.((text) => { if (finished) return false; pending.push(text); kick(); return true })
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: input }, parent_tool_use_id: null, session_id: sessionId ?? '' }
    for (;;) {
      while (pending.length) {
        yield {
          type: 'user', priority: 'next', parent_tool_use_id: null, session_id: sessionId ?? '',
          message: { role: 'user', content: `Operator note, sent while you were working. Take it into account from here on: ${pending.shift()!}` },
        }
      }
      if (finished) return
      await new Promise<void>((resolve) => { wake = resolve })
    }
  }

  // ── progress telemetry (diagnostic only — see AgentProgress's doc comment) ──
  let turn = 0
  let lastTool: string | undefined
  let lastEmitAt: number | undefined
  let lastEmittedTool: string | undefined
  const emitProgress = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    const toolChanged = lastTool !== lastEmittedTool
    if (!force && !shouldEmitProgress(now, lastEmitAt, toolChanged)) return
    lastEmitAt = now
    lastEmittedTool = lastTool
    const progress: AgentProgress = { turn, lastTool, lastActivityAt: now }
    log.debug('agent progress', () => ({ agentSlug, turn: progress.turn, lastTool: progress.lastTool ?? '(none yet)' }))
    onProgress(progress)
  }

  // The loop keeps its own indentation inside the try: the assembler test reads
  // this block by shape and expects `env: {` at the depth it has always had.
  try {
  for await (const message of query({
    prompt: messages(),
    options: {
      cwd,
      // A bot identity for git and gh, when one is configured, so agent pushes
      // and PRs are not attributed to whoever runs the server.
      // Identity for git, gh and jira: the starter's own tokens when they have
      // a profile, else the bot token, else whatever the host holds.
      // Unconditional, where it used to be spread only when a token or a user
      // profile existed. SDLC_SCRIPTS_DIR has to reach the agent on every path,
      // including the no-credential one; a conditional env is exactly how a
      // variable goes missing in the configuration nobody tests.
      env: { ...(await agentEnvFor()), ...userEnv },
      abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns,
      ...(declaredModel ? { model: declaredModel } : {}),
      ...(toolsOption ? { tools: toolsOption } : {}),
      // A pipeline agent gets a deliberate environment, not the developer's.
      //
      // The SDK used to read this instance's own `~/.claude` settings, which
      // put a person's interactive session into every step: the ponytail
      // persona, the explanatory output style, every discovered skill and
      // CLAUDE.md. Measured in a real worktree with the tool list an agent
      // declares: 30,516 tokens on turn one, re-paid on all 100-200 turns of
      // the step, against 13,157 with this empty. Over the ten runs recorded
      // when this was measured that inheritance cost ~59M input tokens, 31%
      // of everything the pipeline had spent.
      //
      // It also silently defeated `tools`: an agent declaring six tools had
      // THIRTY-THREE registered, because inherited settings re-add plugin and
      // MCP tools. Narrowing an agent's tools is a safety statement, not a
      // preference, so that alone would justify this.
      //
      // The guardrails the pipeline does need — plan gate, test lock, secrets
      // guard — arrived by the same inheritance, so they are now registered
      // explicitly from the plugin's own hooks.json. `pipelineHooks()` throws
      // when it cannot find them, and callAgent lets that through: an agent
      // editing a product repository without them is worse than no run.
      settingSources: [],
      hooks,
      ...(resume ? { resume } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
    },
  })) {
    // The one place the real, observed model comes from - never the request.
    if (message.type === 'system' && message.subtype === 'init') {
      modelRan = message.model
      if (message.session_id && message.session_id !== sessionId) { sessionId = message.session_id; onSession?.(sessionId, cwd) }
      log.debug('agent model resolved', { agentSlug, modelRequested: declaredModel ?? '(sdk default)', modelRan })
    }
    if (message.type === 'assistant') {
      turn += 1
      // Duck-typed on purpose: the SDK's BetaMessage content-block union is
      // deep and version-sensitive (see the doc comment on AgentProgress),
      // and all this needs is "was one of this turn's blocks a tool_use, and
      // what was its name" - never its `input`, which can carry ticket text
      // or file contents.
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use'
            && typeof (block as { name?: unknown }).name === 'string'
          ) {
            lastTool = (block as { name: string }).name
          }
          // Lines are never throttled: a watcher wants every command, not a sample.
          const line = describeBlock(block)
          if (line && onProgress) onProgress({ turn, lastTool, lastActivityAt: Date.now(), line })
        }
      }
      emitProgress()
    }
    if (message.type === 'user' && onProgress) {
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const line = describeBlock(block)
          if (line) onProgress({ turn, lastTool, lastActivityAt: Date.now(), line })
        }
      }
    }
    if (message.type === 'result') {
      const interpreted = interpretResultMessage(message, maxTurns)
      result = interpreted.output
      usage = interpreted.usage
      // The turn is over. Close the input stream unless a note is still queued,
      // in which case the agent gets one more turn to act on it.
      if (!pending.length) finished = true
      kick()
    }
  }
  } catch (err) {
    // A wall-clock abort surfaces as whatever the SDK throws when its
    // controller fires, which is indistinguishable from an operator stop
    // except by the flag. Reported as an AgentResultError so the runner's
    // existing out-of-budget path - record the attempt, retry from the log
    // tail - covers a timeout exactly as it covers a spent turn budget.
    if (timedOut) {
      throw new AgentResultError(
        `Claude Code ran past its wall-clock budget of ${Math.round(maxDurationMs / 60_000)} minutes and was stopped`
        + ' (raise this agent\'s maxDurationMs if the step legitimately needs longer)',
        usage, 'error_max_duration',
      )
    }
    throw err
  } finally {
    // Every exit path, a thrown error result included: otherwise the input
    // generator stays suspended forever and a queued note is never released.
    clearTimeout(deadline)
    finished = true
    kick()
  }
  // Final flush so the last observed turn/tool is never lost to the
  // throttle floor - only when there was ever anything to report (see
  // shouldEmitProgress's caller: "absent when nothing informative" holds
  // because emitProgress/onProgress are never called at all when turn stays 0).
  if (turn > 0) emitProgress(true)

  log.info('agent call completed', () => ({
    agentSlug,
    modelRequested: declaredModel ?? '(sdk default)',
    modelRan,
    turns: turn,
    durationMs: Date.now() - startedAt,
    outputLength: result.length,
    inputTokens: usage?.input_tokens ?? '(none reported)',
    outputTokens: usage?.output_tokens ?? '(none reported)',
  }))

  return { output: result, model: modelRan, usage, sessionId }
}

/**
 * Interprets one SDKResultMessage: returns the real output and usage on a
 * genuine success, or throws. `subtype === 'success'` is NOT sufficient on
 * its own: SDKResultSuccess also carries `is_error`, and a live probe
 * against a bad model id returned `subtype: 'success'` WITH `is_error: true`
 * - a result whose `.result` text is an error description, not agent
 * output. Treating that as success would silently record the error text as
 * the step's real output, the same failure class an earlier fix already
 * closed once for the `'result' in message` bug (see callAgent's doc
 * comment). On any other shape - SDKResultError (no `.result` field at all,
 * never read here) or an is_error:true SDKResultSuccess - `.errors` is the
 * error-shaped field to surface, since SDKResultSuccess carries none itself.
 *
 * Exported specifically so a test can drive it with a synthetic message:
 * `is_error: true` cannot be provoked from a live call on demand, but the
 * shape is real - a concurrent model-registry probe against a stale model
 * id hit exactly this combination mid-development.
 */
/**
 * An agent call that reached the model and came back an error, carrying what it
 * spent. Distinct from a transport failure, which has no usage to report.
 */
/**
 * The model an agent DECLARES, read from its seeded file.
 *
 * Used when a call fails before the SDK reports the model it resolved: without
 * it a failed step is priced at the default, and a failed opus step showed
 * $10.07 against a true $50.35. A declared model is not proof of what ran, but
 * it is the closest honest answer available and far better than the default.
 */
export async function declaredModelOf(agentSlug: string): Promise<string | undefined> {
  const agentPath = resolveClaudePath('agents', `${agentSlug}.md`)
  if (!existsSync(agentPath)) return undefined
  try {
    return parseFrontmatter<AgentFrontmatter>(await readFile(agentPath, 'utf-8')).frontmatter?.model
  }
  catch { return undefined }
}

export class AgentResultError extends Error {
  // Declared and assigned explicitly, not as constructor parameter properties:
  // those are TypeScript syntax that has to be COMPILED rather than stripped,
  // and every scripts/test-*.mjs suite imports this module straight into node,
  // which refuses it with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
  usage: AgentUsage | null
  subtype: string

  constructor(message: string, usage: AgentUsage | null, subtype: string) {
    super(message)
    this.name = 'AgentResultError'
    this.usage = usage
    this.subtype = subtype
  }
}

export function interpretResultMessage(
  message: { subtype: string, is_error?: boolean, result?: string, usage?: unknown, errors?: string[], total_cost_usd?: unknown },
  /** The budget this call ran under, folded into the thrown message. The SDK
   *  reports `error_max_turns` with an empty `errors` array, so the bare error
   *  read "no further detail" and said nothing about WHICH limit was hit -
   *  diagnosing one meant grepping the agent templates for the number. It also
   *  invited the wrong conclusion: progress telemetry counts assistant
   *  messages, not SDK turns, so a step showing 87 messages against a budget of
   *  40 looks like a broken limit when the limit worked correctly. */
  maxTurns?: number,
): { output: string, usage: AgentUsage | null } {
  if (message.subtype === 'success' && !message.is_error) {
    return { output: String(message.result ?? ''), usage: usageFrom(message.usage, message.total_cost_usd) }
  }
  const errors = 'errors' in message ? message.errors : undefined
  log.warn('agent call returned an error result', () => ({
    subtype: message.subtype,
    isError: Boolean(message.is_error),
    errorsPreview: errors?.length ? preview(errors.join('; ')) : '(none)',
  }))
  const budget = message.subtype === 'error_max_turns' && maxTurns
    ? ` (turn budget: ${maxTurns} - raise this agent's maxTurns if the step legitimately needs more work)`
    : ''
  // The SDK reports usage on an error result too, and throwing it away made a
  // failed step cost $0.00 in the run's own accounting. One error_max_turns
  // step burned 519 seconds and 109 assistant messages and was recorded as
  // free — the most expensive failures were the least visible ones, which is
  // exactly backwards for a budget you are trying to hold.
  throw new AgentResultError(
    `Claude Code returned an error result (${message.subtype}` +
    `${message.is_error ? ', is_error' : ''}): ` +
    `${errors?.join('; ') || 'no further detail'}${budget}`,
    usageFrom(message.usage),
    message.subtype,
  )
}

/** Folds the SDK's usage object into AgentUsage - see that type's doc comment
 *  for which buckets are summed and why. `null` when the object isn't in the
 *  shape expected (never guessed at a partial or malformed one). */
function usageFrom(raw: unknown, totalCostUsd?: unknown): AgentUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (typeof u.input_tokens !== 'number' && typeof u.output_tokens !== 'number') return null
  return {
    input_tokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    ...(typeof totalCostUsd === 'number' && Number.isFinite(totalCostUsd) ? { usd: totalCostUsd } : {}),
  }
}
