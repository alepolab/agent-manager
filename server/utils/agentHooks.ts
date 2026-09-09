/**
 * The guardrail hooks a pipeline agent runs under, registered explicitly.
 *
 * They used to arrive by inheritance: the SDK read the developer's own
 * `~/.claude` settings, which is where the alepo-engineering plugin declares
 * them. That inheritance also dragged in everything else a person's
 * interactive session carries — the ponytail persona, the explanatory output
 * style, every discovered skill and CLAUDE.md — measured at ~17,000 tokens
 * on EVERY turn of every step, and it silently re-added tools an agent's
 * frontmatter had narrowed away (six declared, thirty-three registered).
 *
 * So the runner passes `settingSources: []` and registers these four hooks
 * itself. The matchers and the scripts are still the plugin's: this file
 * reads its `hooks.json` rather than restating it, so a plugin update is
 * picked up here without a code change.
 *
 * A hook that cannot be registered is fatal — an agent editing a product
 * repository without the plan gate, the test lock and the secrets guard is
 * worse than a run that does not start. A hook that FAILS at run time is
 * not: the scripts themselves specify that an internal error allows, because
 * a broken hook must not wedge the estate.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { createLogger } from './log.ts'

// 'agent' rather than a namespace of its own: these run inside an agent call.
const log = createLogger('agent')

/** Hook events the pipeline registers. Anything else in hooks.json is ignored with a warning. */
const SUPPORTED = ['PreToolUse', 'PostToolUse'] as const
type SupportedEvent = typeof SUPPORTED[number]

interface HookSpec { matcher?: string, hooks: { type?: string, command?: string }[] }

/**
 * Where the guardrail scripts live: the installed plugin first, the copy
 * shipped in this product second. Same order, and the same reason, as
 * teamSync's skills — a team container installs no plugins.
 */
export function hooksDir(): string | null {
  try {
    const installed = resolveClaudePath('plugins', 'installed_plugins.json')
    if (existsSync(installed)) {
      const raw = JSON.parse(readFileSync(installed, 'utf-8'))
      const entry = Object.entries<any>(raw?.plugins ?? {}).find(([k]) => k.startsWith('alepo-engineering@'))?.[1]?.[0]
      const dir = entry?.installPath ? join(entry.installPath, 'hooks') : null
      if (dir && existsSync(join(dir, 'hooks.json'))) return dir
    }
  } catch { /* fall through to the shipped copy */ }
  const shipped = join(process.cwd(), 'engineering', 'hooks')
  return existsSync(join(shipped, 'hooks.json')) ? shipped : null
}

/** Resolves `${CLAUDE_PLUGIN_ROOT}` and pulls the script path out of a `node "<path>"` command. */
function scriptOf(command: string, dir: string): string | null {
  const resolved = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, join(dir, '..'))
  const m = resolved.match(/node\s+"?([^"\s]+\.mjs)"?/)
  return m?.[1] ?? null
}

export interface HookRegistration {
  /** Passed straight to the SDK's `hooks` option. */
  hooks: Record<string, { matcher?: string, hooks: ((input: any, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<any>)[] }[]>
  /** `<event>:<script name>` per registered hook, for the preflight report and the run record. */
  registered: string[]
}

/**
 * Builds the hook option for one agent call. Throws when the plugin's hooks
 * are not on this instance at all, or when a declared script is missing:
 * both mean the guardrails would be silently absent.
 */
export async function pipelineHooks(): Promise<HookRegistration> {
  const dir = hooksDir()
  if (!dir) {
    throw new Error(
      'The alepo-engineering guardrail hooks (plan gate, test lock, secrets guard) are on neither the installed plugin '
      + `nor the copy shipped at ${join(process.cwd(), 'engineering', 'hooks')}. A pipeline agent must not edit a product `
      + 'repository without them. Install the plugin, or restore engineering/hooks/.',
    )
  }
  const spec = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf-8'))?.hooks ?? {}
  const hooks: HookRegistration['hooks'] = {}
  const registered: string[] = []

  for (const [event, matchers] of Object.entries(spec) as [string, HookSpec[]][]) {
    if (!SUPPORTED.includes(event as SupportedEvent)) {
      log.warn('hook event not registered for pipeline agents', { event, dir })
      continue
    }
    hooks[event] = (matchers ?? []).map((m) => {
      const scripts = (m.hooks ?? [])
        .filter(h => (h.type ?? 'command') === 'command' && h.command)
        .map((h) => {
          const script = scriptOf(h.command!, dir)
          if (!script || !existsSync(script)) {
            throw new Error(`Guardrail hook "${h.command}" (${event}, matcher ${m.matcher ?? '*'}) resolves to ${script ?? 'nothing'}, which does not exist. A pipeline agent must not run without it.`)
          }
          registered.push(`${event}:${script.split('/').pop()}`)
          return script
        })
      return { matcher: m.matcher, hooks: scripts.map(script => runScript(script, event as SupportedEvent)) }
    })
  }
  if (!registered.length) throw new Error(`${join(dir, 'hooks.json')} registered no PreToolUse or PostToolUse hook; the guardrails would be absent.`)
  return { hooks, registered }
}

/**
 * One hook script as an SDK callback: the same contract the CLI gives it —
 * the call as JSON on stdin, exit 2 to deny with the reason on stderr,
 * anything else to allow.
 */
function runScript(script: string, event: SupportedEvent) {
  return (input: any, _toolUseID: string | undefined, opts: { signal: AbortSignal }): Promise<any> =>
    new Promise((resolve) => {
      const child = execFile('node', [script], { timeout: 15_000, signal: opts.signal, maxBuffer: 1024 * 1024 },
        (err: any, _stdout, stderr) => {
          const code = typeof err?.code === 'number' ? err.code : 0
          if (code === 2) {
            const reason = (stderr || '').trim() || `Blocked by ${script.split('/').pop()}.`
            log.info('guardrail hook denied a call', { script: script.split('/').pop(), tool: input?.tool_name })
            // PostToolUse cannot deny — the call already happened — so the
            // arming hook's exit code is only ever informational there.
            return resolve(event === 'PreToolUse'
              ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
              : { systemMessage: reason })
          }
          // Anything else allows, by the scripts' own rule: a broken hook must
          // not wedge the estate. Logged so a silently-failing guard is visible.
          if (err && code !== 0) log.warn('guardrail hook errored; allowing', { script: script.split('/').pop(), code, error: String(err?.message ?? err).slice(0, 200) })
          resolve({})
        })
      child.stdin?.end(JSON.stringify({
        tool_name: input?.tool_name, tool_input: input?.tool_input, tool_response: input?.tool_response,
        cwd: input?.cwd ?? process.cwd(), hook_event_name: event, session_id: input?.session_id,
      }))
    })
}
