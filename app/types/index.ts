import type { WorkflowParameter } from '~~/shared/utils/workflowParameters'

export type { WorkflowParameter }

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
  agentManager?: { labs?: boolean, /** Per-run caps applied to new runs; an instance env var overrides them. */ runBudget?: { maxTokens?: number, maxMinutes?: number }, /** Every pipeline agent runs on this model when set; otherwise each agent's own. */ agentModel?: AgentModel }
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
  agents?: { name: string; slug: string }[]
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
  jira?: { transition?: string, comment?: boolean, attach?: boolean }
  /**
   * This step writes tests and code together, so the plugin's test lock (armed the
   * moment source is edited) must not block it: the runner writes the unlock file
   * into the run's checkout before the step starts, with the reason recorded.
   */
  testsUnlocked?: boolean
  /**
   * Conditional routing: the step runs only when the named run artifact holds
   * something. Absent means it always runs.
   *
   * `artifact` is a filename relative to the run's artifacts directory. Not
   * written, blank, or holding an empty array / object / string / null / 0 /
   * false, and the step is skipped - its successors still schedule, so a join
   * downstream is not wedged behind the branch that had nothing to do. Present
   * but not valid JSON FAILS the step, because a producer that crashed
   * mid-write must not read as "nothing to do".
   *
   * Only "non-empty" is expressible, deliberately. If a negated form is ever
   * needed ("run only when nothing was escalated"), add a mode to this object
   * rather than a parallel `skipWhen` - two fields that gate the same step from
   * opposite directions is a rule nobody can read off the canvas.
   */
  runWhen?: { artifact: string }
  /**
   * Present on a step the runner executes itself, without a model: it starts
   * one child run per entry in `source`, routing each entry to a workflow.
   *
   * `source` is a filename relative to the run's artifacts directory, holding
   * a JSON array. Not written or empty and the step dispatches nothing and
   * completes; present but not valid JSON, or not an array, FAILS the step -
   * the same rule `runWhen` uses, and for the same reason.
   *
   * `routeBy` names a field on each entry and `routes` maps that field's value
   * to a workflow slug, so one step fans a mixed batch out to several
   * workflows. `slug` is the target for an entry no route matches, and the
   * only target when neither is set. An entry nobody can route fails the whole
   * step and starts nothing: a half-dispatched batch leaves some work in
   * flight and some silently dropped, with nothing recording which.
   *
   * Children are started and not waited for. The step's own successors run
   * immediately; a child's outcome reaches its own run, not this one.
   */
  triggerWorkflow?: {
    source: string
    routeBy?: string
    routes?: Record<string, string>
    slug?: string
  }
  /**
   * Present on a step the runner executes itself, without a model: it posts one
   * message to a channel configured under Settings, and completes.
   *
   * `channel` is a NAME, never a URL. Workflow definitions are staged into the
   * distributable image and written onto the shared team volume, so a webhook
   * written here would ship inside an image; the URL lives encrypted outside the
   * config tree (server/utils/channels.ts).
   *
   * `message` is the step author's own sentence, with `{count}` replaced by the
   * number of entries in this step's `runWhen` artifact. The entry names and a
   * link to the run are appended. There is no other substitution: projecting
   * arbitrary entry fields would make this config know the artifact's schema,
   * and a producer renaming a field would silently empty the message.
   *
   * Placement matters. A wave stops at an `approval` step BEFORE any of its
   * members run (workflowRunner.ts, runWave), so a notify step placed BESIDE a
   * gated step never sends. Put it upstream of the gate, not in parallel with
   * it.
   */
  notify?: {
    channel: string
    message?: string
  }
}

export interface Workflow {
  slug: string
  name: string
  description: string
  steps: WorkflowStep[]
  /**
   * Inputs this workflow needs stated before it runs, instead of hoping the
   * operator buried them in the prompt and every agent parses them out the
   * same way. Resolved once at start (shared/utils/workflowParameters.ts) and
   * stated to every step by artifactHeader.
   *
   * Only declared names reach a run: a value nothing declared is dropped, not
   * passed along. `projectDir` is the one name the runner acts on rather than
   * merely states - it supplies the run's working directory, so a workflow
   * cannot end up naming that directory twice in two places that disagree.
   */
  parameters?: WorkflowParameter[]
  /**
   * The concurrency group this workflow's runs count against
   * (shared/types/workflowGroup.ts). Absent or empty means the default group,
   * never "uncapped" — see DEFAULT_GROUP_ID.
   *
   * Held here rather than as a list of members on the group, so a workflow
   * carries its own membership: renaming or deleting a workflow cannot leave a
   * dangling entry in the registry, and one file is the answer to "which group
   * is this in?".
   */
  group?: string
  /**
   * The named channel this workflow's run transitions are announced to
   * (server/utils/channels.ts). Absent falls back to a channel called `default`,
   * then to SLACK_WEBHOOK_URL.
   *
   * A name, not a URL, for the same reason WorkflowStep.notify holds one: this
   * file ships inside the distributable image.
   */
  notifyChannel?: string
  createdAt: string
  lastRunAt?: string
  filePath: string
}

export interface WorkflowPayload {
  name: string
  description: string
  steps: WorkflowStep[]
  /** See Workflow.parameters. */
  parameters?: WorkflowParameter[]
  /** See Workflow.group. Sent as '' rather than omitted to clear it: the PUT
   *  route is a shallow merge, so an absent key keeps the stored value. */
  group?: string
  /** See Workflow.notifyChannel. Sent as '' to clear it, like `group`. */
  notifyChannel?: string
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

export interface CliSession {
  id: string
  agentSlug?: string
  workingDir: string
  shell: string
  status: 'active' | 'idle' | 'terminated'
  createdAt: string
  lastActivity: string
  tokenUsage?: TokenUsage
  cost?: number
}

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

export type CliWebSocketEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'context_update'; metrics: ContextMetrics }
  | { type: 'token_update'; tokens: Partial<TokenUsage> }
  | { type: 'file_change'; change: FileChange }
  | { type: 'tool_call'; tool: ToolCall }
  | { type: 'error'; error: string }
  | { type: 'exit'; exitCode: number }

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
