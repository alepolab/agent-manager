import type { Peer } from 'crossws'
import type {
  NormalizedMessage,
  PermissionMode,
  ProviderFetchOptions,
  ProviderFetchResult,
} from '~/types'

/**
 * Provider adapter interface for multi-provider support.
 * Each provider (Claude, OpenAI, etc.) implements this interface.
 */
export interface ProviderAdapter {
  /** Provider name (e.g., 'claude', 'openai') */
  name: string

  /**
   * Execute a query and stream responses via WebSocket.
   * @param prompt User's message
   * @param options Query options (session, agent, working dir, etc.)
   * @param ws WebSocket peer to send messages to
   */
  query(
    prompt: string,
    options: ProviderQueryOptions,
    ws: Peer
  ): Promise<void>

  /**
   * Interrupt an active query.
   * @param sessionId Session ID to interrupt
   * @returns true if interrupted, false if not found
   */
  interrupt(sessionId: string): Promise<boolean>

  /**
   * Normalize raw provider-specific messages to NormalizedMessage format.
   * @param raw Raw message from provider SDK
   * @param sessionId Current session ID
   * @returns Array of normalized messages
   */
  normalizeMessage(raw: any, sessionId: string): NormalizedMessage[]

  /**
   * Fetch message history from storage.
   * @param sessionId Session ID
   * @param options Fetch options (pagination, filters)
   */
  fetchHistory(
    sessionId: string,
    options: ProviderFetchOptions
  ): Promise<ProviderFetchResult>

  /**
   * Respond to a permission request (optional, only for providers that support it).
   * @param permissionId Permission request ID
   * @param decision Allow or deny
   */
  respondToPermission?(
    permissionId: string,
    decision: 'allow' | 'deny',
    updatedInput?: any
  ): Promise<void>

  /**
   * Load agent instructions from slug (optional).
   * @param agentSlug Agent slug
   * @returns Agent instructions or null
   */
  loadAgentInstructions?(agentSlug: string): Promise<string | null>
}

export interface ProviderQueryOptions {
  sessionId?: string
  agentSlug?: string
  agentInstructions?: string
  workingDir?: string
  model?: string
  permissionMode?: PermissionMode
  images?: string[]
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** User message to save with correct sessionId (passed from WS handler) */
  userMessage?: NormalizedMessage
  /** Output style to apply to this query. Read by claudeProvider and passed by
   *  the v2 chat socket; it was simply never declared here, so both ends
   *  type-errored while the feature worked at runtime. */
  outputStyleId?: string
}

/**
 * Provider registration info
 */
export interface ProviderInfo {
  name: string
  displayName: string
  description: string
  models: string[]
  supportsPermissions: boolean
  supportsImages: boolean
  supportsInterrupt: boolean
}
