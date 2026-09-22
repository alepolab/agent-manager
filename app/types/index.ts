import type { Role } from '~~/shared/types/role'
import type { GateKind } from '~~/shared/utils/oversight'

export type AgentModel = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type AgentMemory = 'user' | 'project' | 'local' | 'none'
export type AgentTool = 'Read' | 'Grep' | 'Glob' | 'Bash' | 'Write' | 'Edit'

export interface AgentFrontmatter {
  name: string
  description: string
  model?: AgentModel
  color?: string
  memory?: AgentMemory
  skills?: string[]
  tools?: AgentTool[]
  /** Tool-call budget for one turn of this agent. Absent means the server default. */
  maxTurns?: number
  /** Wall-clock budget in milliseconds for one call of this agent. Absent means
   *  the server default. Bounds what maxTurns cannot: a single turn stuck in one
   *  long-running command. */
  maxDurationMs?: number
}

export interface Agent {
  slug: string
  filename: string
  directory: string
  frontmatter: AgentFrontmatter
  body: string
  hasMemory: boolean
  filePath: string
}

export interface CommandFrontmatter {
  name: string
  description: string
  'argument-hint'?: string
  // Claude Code writes this either as a YAML list or as one comma-separated
  // string ("Bash, Read, Grep"). Both forms are valid; normalise before use.
  'allowed-tools'?: string[] | string
}

export interface Command {
  slug: string
  filename: string
  directory: string
  frontmatter: CommandFrontmatter
  body: string
  filePath: string
}

export interface Settings {
  /** Agent Manager's own switches, kept under one key so Claude Code ignores them. */
  agentManager?: { labs?: boolean, /** Per-run caps applied to new runs; an instance env var overrides them. */ runBudget?: { maxTokens?: number, maxMinutes?: number, /** Dollars per run. */ maxUsd?: number }, /** Every pipeline agent runs on this model when set; otherwise each agent's own. */ agentModel?: AgentModel }
  hooks?: Record<string, unknown[]>
  enabledPlugins?: Record<string, boolean>
  statusLine?: { type: string; command: string }
  alwaysThinkingEnabled?: boolean
  /** Lookback window, in seconds, for the /tasks-picker-infra command: how
   *  far back on the DEVOPS board it treats an issue as newly raised.
   *  Defaults to 60 when unset. Note JQL cannot express a sub-minute
   *  relative date, so the command queries the window rounded UP to whole
   *  minutes and then filters by each issue's real created timestamp - the
   *  seconds resolution is applied client-side, not by Jira. */
  tasksPickerWindowSeconds?: number
  onboardingCompleted?: boolean
  guidanceSeen?: {
    agentDetail?: boolean
    explore?: boolean
    chat?: boolean
  }
  [key: string]: unknown
}

export type RelationshipType = 'spawns' | 'agent-frontmatter' | 'spawned-by'

export interface Relationship {
  sourceType: 'agent' | 'command' | 'skill' | 'plugin' | 'mcp'
  sourceSlug: string
  targetType: 'agent' | 'command' | 'skill' | 'plugin' | 'mcp'
  targetSlug: string
  type: RelationshipType
  evidence: string
}

export interface AgentPayload {
  frontmatter: AgentFrontmatter
  body: string
  directory?: string
}

export interface CommandPayload {
  frontmatter: CommandFrontmatter
  body: string
  directory?: string
}

export interface Plugin {
  id: string
  name: string
  marketplace: string
  description: string
  version: string
  enabled: boolean
  installedAt: string
  lastUpdated: string
  installPath: string
  skills: string[]
  author?: { name: string; email?: string }
}

export interface SkillFrontmatter {
  name: string
  description: string
  context?: string
  agent?: string
  [key: string]: unknown
}

export interface Skill {
  slug: string
  frontmatter: SkillFrontmatter
  /** Present on the detail route only; the list omits it for size. */
  body?: string
  filePath: string
  source?: 'local' | 'github' | 'plugin'
  githubRepo?: string
  pluginName?: string
  mcpServer?: { name: string; scope: string }
  /** Agents that DECLARE this skill: its full body is inlined into their prompt. */
  agents?: { name: string; slug: string }[]
  /**
   * Agents that read this skill from disk at run time without declaring it —
   * the language catalogue ($SDLC_SKILLS_DIR), read by name at run time
   * rather than declared. Separate from `agents` because declaring these
   * instead would add ~80,000 tokens to every agent's prompt on every step.
   */
  readBy?: { name: string; slug: string }[]
}

export interface AgentSkill {
  slug: string
  frontmatter: SkillFrontmatter
  body: string
  filePath: string
  source: 'standalone' | 'plugin'
  pluginId?: string
  pluginName?: string
}

export interface SkillPayload {
  frontmatter: SkillFrontmatter
  body: string
}

// ── GitHub Imports ──────────────────────────────────

export interface ScannedSkill {
  slug: string
  name: string
  description: string
  category: string | null
  tags: string[]
  filePath: string
  hasSupporting: boolean
  conflict: boolean
}

export interface ScannedAgent {
  slug: string
  name: string
  description: string
  category: string | null
  filePath: string
  conflict: boolean
}

export interface SkillScanResult {
  owner: string
  repo: string
  branch: string
  targetPath: string
  skills: ScannedSkill[]
  totalSkills: number
  detectionMethod: 'frontmatter' | 'skills-index'
}

export interface AgentScanResult {
  owner: string
  repo: string
  branch: string
  targetPath: string
  agents: ScannedAgent[]
  totalAgents: number
  detectionMethod: 'frontmatter'
}

export interface GithubImport {
  owner: string
  repo: string
  url: string
  targetPath: string
  localPath: string
  importedAt: string
  lastChecked: string
  currentSha: string
  remoteSha: string
  selectedItems: string[]
  totalItems: number
}

export interface GithubImportsRegistry {
  imports: GithubImport[]
}

// ── Marketplace ─────────────────────────────────────

export interface AvailablePlugin {
  name: string
  description: string
  author?: { name: string; email?: string }
  skillCount: number
  commandCount: number
  installed: boolean
  marketplace: string
}

export interface MarketplaceSource {
  name: string
  sourceType: string
  sourceUrl: string
  lastUpdated: string
}

export interface MarketplaceData {
  marketplaces: Record<string, { plugins: AvailablePlugin[] }>
}

export interface PluginDetail extends Plugin {
  skillDetails: Skill[]
}

export interface SkillInvocation {
  skill: string
  args: string | null
}

export type WizardStep = 1 | 2 | 3

export interface WorkflowStep {
  id: string
  agentSlug: string
  label: string
  /** Explicit successors. Absent means "the next step in array order" (legacy workflows). */
  next?: string[]
  /** Agent that reviews this step's output and returns CONTINUE / RETRY / ABORT. */
  monitorSlug?: string
  /** How many times this step may run in one execution. Guards cycles. Default 3. */
  maxVisits?: number
  /** The run pauses before this step and waits for the operator to approve it, even when running to completion. */
  approval?: boolean
  /** A review step whose stated `Review Result:` the runner enforces. */
  verdict?: boolean
  /**
   * Hand this step the review a GitHub Actions run left on the run's pull
   * request. The runner writes `review-comments.json` into the run's artifacts
   * BEFORE the agent starts, because an agent cannot act on evidence that
   * appears after it finishes.
   */
  reviewComments?: boolean
  /**
   * Bring the product's stack up before this step's agent runs.
   *
   * The runner reads the lifecycle out of the product's own compose file in the
   * infra repo (server/utils/stackRecipe.ts), so a step asks for a stack rather
   * than describing how to build one. The stack is taken down when the run
   * settles, including when it fails.
   */
  stack?: 'up'
  /**
   * Drive the infra repo's deploy.sh for this step: `{ env, step, app?, check? }`.
   *
   * Only `dev` runs unattended. Any other environment requires this step to
   * carry `approval: true` AND for that gate to have been answered - the runner
   * refuses otherwise, before assembling an ansible argument.
   */
  deploy?: { env: string, step: string, app?: string, limit?: string, check?: boolean }
  /**
   * Whose decision this gate is. Copied onto `run.question.role` when the gate
   * fires, and enforced by the gate routes.
   *
   * Without it, any holder of `answerGate` could answer any gate: a developer
   * could accept QA's verification, and QA could approve a plan. The runbooks
   * already asserted the mapping in their own comments ("Gate 3 of 4:
   * verification. QA answers this one") — this makes the workflow say it in data
   * rather than in prose nothing reads. An operator may always answer, as the
   * backstop for a role nobody on this instance holds.
   */
  gateRole?: Role
  /**
   * What KIND of question this gate asks, where that raises the oversight
   * floor above the run's blast-radius tier.
   *
   * `story`, `spec` and `security` gates cannot be tiered by blast radius:
   * the first two ask whether this is the right thing to build (which no
   * classification predicts, and which are asked before the diff that would
   * produce one exists), and the third is triggered by what the change
   * touches rather than how hard it is to undo. A step without this field
   * tiers exactly as before. See shared/utils/oversight.ts.
   */
  gateKind?: GateKind
  /**
   * Whose WORK this step is \u2014 a different question from whose decision its
   * gate is (`gateRole`) and from what the reader may do (`can()`).
   *
   * It grants nothing and is read only to render. A person opening a run asks
   * "which of these steps is mine", and the console had no field to answer
   * with: a step said which agent ran it and, on three of nine, whose gate it
   * carried. Deriving the owner from those two was rejected on evidence \u2014 the
   * CSUP template's "Plan Review" runs `architecture-reviewer` while its gate
   * belongs to `developer`, so the two disagree on the first real step, and
   * most steps map to no role at all. A derived owner would be a guess wearing
   * a fact's shape.
   */
  ownerRole?: Role
  /** Canvas position, persisted so branches and loops keep their layout. */
  position?: { x: number, y: number }
  /**
   * Which upstream outputs this step receives. `'predecessors'` (the default)
   * passes only immediate forward predecessors; `'ancestors'` passes the full
   * transitive ancestry, budgeted and truncation-marked. Use `'ancestors'`
   * for a step that must see evidence produced several hops upstream.
   */
  contextMode?: 'predecessors' | 'ancestors'
  /** Present on a step the runner executes itself, without a model: move the ticket, post the outcome comment, or both. */
  /**
   * Jira work the RUNNER performs for this step: move the ticket, post the
   * outcome comment, attach the evidence.
   *
   * By default this replaces the step's agent entirely - no model, no prompt,
   * just the REST calls. `after: true` keeps the agent and runs the Jira work
   * once it has succeeded, which is the only order in which the outcome
   * comment can carry a pull request the agent opened in that same step.
   */
  jira?: { transition?: string, comment?: boolean, attach?: boolean, after?: boolean }
  /**
   * After this step's agent succeeds, the RUNNER pushes the run's branch and
   * opens a pull request into the run's base branch, for every repository in
   * the checkout that is on that branch - then records each URL in
   * `meta.fix.repos[].pr`.
   *
   * It is the runner's job because it was nobody's: a run committed a CRM gate
   * and its documentation, this step reported success, and no pull request
   * existed - the step's agent curates docs, and no agent in the estate opens
   * a PR. Ordered before the Jira work so the outcome comment can carry a URL
   * that exists.
   */
  pr?: boolean
  /**
   * This step writes tests and code together, so the plugin's test lock (armed the
   * moment source is edited) must not block it: the runner writes the unlock file
   * into the run's checkout before the step starts, with the reason recorded.
   */
  testsUnlocked?: boolean
  /**
   * This step continues its predecessor's Claude Code session instead of
   * starting a fresh one.
   *
   * The default is a cold start per step: a new session, a new context, and the
   * repository re-read from nothing. Measured across the four recorded runs,
   * the three steps that share one piece of work — write the failing test, fix
   * it, verify it — were 55-75% of every run's cost, each rebuilding what the
   * one before it had just learned.
   *
   * Set it only where the next phase needs everything the last one learned AND
   * independence does not matter. It is wrong wherever a fresh pair of eyes is
   * the point: a reviewer continuing the implementer's session reviews its own
   * work from inside its own assumptions, and QA that watched the fix being
   * written is no longer testing it.
   *
   * The step keeps its own agent: system prompt, tools, model and hooks are
   * sent on every call, resumed or not. What carries is the conversation.
   *
   * Ignored — with a cold start, which is always correct and only more
   * expensive — when the step has no single predecessor, or that predecessor's
   * transcript is not on disk.
   */
  continuesSession?: boolean
}

export interface Workflow {
  slug: string
  name: string
  description: string
  steps: WorkflowStep[]
  createdAt: string
  lastRunAt?: string
  filePath: string
}

export interface WorkflowPayload {
  name: string
  description: string
  steps: WorkflowStep[]
}

export interface StepExecution {
  stepId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  input: string
  output: string
  error?: string
  startedAt?: number
  completedAt?: number
  /** Times this step has run. Above 1 means a cycle or a monitor retry brought it back. */
  visits?: number
  monitorVerdict?: 'CONTINUE' | 'RETRY' | 'ABORT'
  monitorNote?: string
}

// ── Output Styles ─────────────────────────────────────

export interface OutputStyle {
  id: string
  name: string
  description?: string
  keepCodingInstructions?: boolean
  content: string
  scope: 'global' | 'project'
  path: string
}

export interface OutputStylePayload {
  id: string
  name: string
  description?: string
  keepCodingInstructions?: boolean
  content: string
  scope: 'global' | 'project'
  oldId?: string
  workingDir?: string
}

// ── Chat ──────────────────────────────────────────

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  timestamp: number
  toolCalls?: Array<{ id: string; toolName: string; input: any }>
  toolResults?: Array<{ id: string; toolName: string; result: any; isError?: boolean }>
}

export type StreamActivity =
  | { type: 'thinking' }
  | { type: 'tool'; name: string; elapsed: number }
  | { type: 'writing' }
  | null

// ── History ───────────────────────────────────────

export interface ToolCallRecord {
  toolName: string
  elapsed: number
  timestamp: number
}

export interface ConversationSession {
  id: string
  agentSlug: string
  messages: ChatMessage[]
  toolCalls: ToolCallRecord[]
  tokenUsage: { input: number; output: number }
  duration: number
  createdAt: string
}

export interface ConversationSummary {
  id: string
  agentSlug: string
  messageCount: number
  firstUserMessage: string
  createdAt: string
}

// ── CLI Terminal ──────────────────────────────────

export interface TokenUsage {
  input: number
  output: number
  cached: number
  cacheCreation?: number
}

export interface CostBreakdown {
  total: number
  input: number
  output: number
  cached: number
}

export interface FileChange {
  path: string
  type: 'created' | 'modified' | 'deleted'
  timestamp: string
  size?: number
  diff?: string
}

export interface ToolCall {
  toolName: string
  timestamp: string
  elapsed?: number
  args?: any
  result?: any
  status: 'running' | 'success' | 'error'
}

export interface ContextMetrics {
  tokens: TokenUsage
  cost: CostBreakdown
  contextWindow: {
    used: number
    total: number
    percentage: number
  }
  files: {
    created: FileChange[]
    modified: FileChange[]
    deleted: FileChange[]
  }
  tools: ToolCall[]
}

export interface CliSettings {
  defaultShell: string
  fontSize: number
  fontFamily: string
  cursorStyle: 'block' | 'underline' | 'bar'
  scrollback: number
  autoSave: boolean
}

// WebSocket message types
export type CliWebSocketMessage =
  | { type: 'execute'; sessionId?: string; agentSlug?: string; workingDir?: string; cols?: number; rows?: number }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }

// ── Claude Code Chat ──────────────────────────────────

export type NormalizedMessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'complete'
  | 'error'
  | 'status'
  | 'session_created'
  // Chat v2 message kinds
  | 'permission_request'
  | 'permission_cancelled'
  | 'interactive_prompt'
  | 'task_notification'

export interface NormalizedMessage {
  kind: NormalizedMessageKind
  id: string
  sessionId: string
  timestamp: string
  role?: 'user' | 'assistant'
  content?: string
  toolName?: string
  toolInput?: any
  toolResult?: any
  isError?: boolean
  exitCode?: number
  stopReason?: string
  metadata?: Record<string, any>
  // Chat v2 extensions
  provider?: string
  images?: string[]
  toolId?: string
  canInterrupt?: boolean
  tokenBudget?: TokenBudget
  requestId?: string
  newSessionId?: string
  summary?: string
  resolvedDecision?: 'allow' | 'deny'
  resolvedAnswer?: string
}

// ── Chat v2 Types ──────────────────────────────────────

export type PermissionMode = 'default' | 'skip' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface PendingPermission {
  id: string
  toolName: string
  toolInput: any
  sessionId: string
  receivedAt: string
  expiresAt: string
  message?: string
}

export interface TokenBudget {
  maxTokens?: number
  usedTokens?: number
  warningThreshold?: number
}

export interface Project {
  id: string
  name: string
  path: string
  sessionsCount: number
  lastActivity: string
  isStarred: boolean
}

export interface DisplayChatMessage {
  id: string
  kind: NormalizedMessageKind
  role?: 'user' | 'assistant'
  content?: string
  timestamp: string
  toolName?: string
  toolInput?: any
  toolResult?: any
  isError?: boolean
  thinking?: string
  images?: string[]
  requestId?: string
  permissionRequest?: PendingPermission
  taskProgress?: TaskProgress
  interactivePrompt?: InteractivePrompt
  isStreaming?: boolean
  resolvedDecision?: 'allow' | 'deny'
  resolvedAnswer?: string
}

export interface TaskProgress {
  id: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress?: number
  message?: string
}

export interface InteractivePrompt {
  id: string
  question: string
  options?: string[]
  placeholder?: string
  multiline?: boolean
}

export interface ChatSession {
  id: string
  agentSlug?: string
  workingDir?: string
  messages: NormalizedMessage[]
  createdAt: string
  lastActivity: string
  status: 'active' | 'completed' | 'error'
  tokenUsage?: TokenUsage
  messageCount: number
}

export interface ChatSessionSummary {
  id: string
  agentSlug?: string
  messageCount: number
  firstUserMessage: string
  lastActivity: string
  createdAt: string
  status: 'active' | 'completed' | 'error'
}

// WebSocket message types for Chat
export type ChatWebSocketMessage =
  | { type: 'start'; message: string; sessionId?: string; agentSlug?: string; workingDir?: string }
  | { type: 'abort'; sessionId: string }

export type ChatWebSocketEvent =
  | NormalizedMessage
  | { type: 'connected'; sessionId?: string }
  | { type: 'disconnected' }

// ── Chat v2 WebSocket Types ──────────────────────────────────

export type ChatV2WebSocketMessage =
  | {
      type: 'start'
      message: string
      sessionId?: string
      agentSlug?: string
      workingDir?: string
      provider?: string
      permissionMode?: PermissionMode
      model?: string
      effort?: EffortLevel
      outputStyleId?: string
      images?: string[]
    }
  | { type: 'abort'; sessionId: string }
  | { type: 'permission_response'; permissionId: string; decision: 'allow' | 'deny'; remember?: boolean; updatedInput?: any }
  | { type: 'interactive_response'; promptId: string; value: string }

export type ChatV2WebSocketEvent =
  | NormalizedMessage
  | { type: 'connected'; sessionId?: string }
  | { type: 'disconnected' }
  | { type: 'permission_expired'; permissionId: string }

// ── Effort Level ────────────────────────────────────────

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

// ── Provider Types ──────────────────────────────────────

export interface ProviderQueryOptions {
  prompt: string
  sessionId?: string
  agentSlug?: string
  agentInstructions?: string
  workingDir?: string
  model?: string
  permissionMode?: PermissionMode
  effort?: EffortLevel
  outputStyleId?: string
  images?: string[]
}

export interface ProviderFetchOptions {
  limit?: number
  offset?: number
  projectName?: string
  projectPath?: string
}

export interface ProviderFetchResult {
  messages: NormalizedMessage[]
  total: number
  hasMore: boolean
  tokenUsage?: TokenUsage
}
