import type { ChatSession, ChatSessionSummary, NormalizedMessage } from '~/types'
import { useSessionStore } from './useSessionStore'

export function useChatSessions() {
  // Use the new session store
  const sessionStore = useSessionStore()

  // Current active session
  const currentSessionId = useState<string | null>('chat-current-session', () => null)
  const currentSession = useState<ChatSession | null>('chat-current-session-data', () => null)

  // List of all sessions
  const sessions = useState<ChatSessionSummary[]>('chat-sessions', () => [])

  // Messages from store (computed from current session)
  const messages = computed(() => {
    if (!currentSessionId.value) return []
    return sessionStore.getMessages(currentSessionId.value)
  })

  // Loading states
  const isLoadingSessions = ref(false)
  const isLoadingSession = ref(false)
  const error = ref<string | null>(null)

  // Pagination state
  const hasMoreMessages = computed(() => {
    if (!currentSessionId.value) return false
    const slot = sessionStore.getSessionSlot(currentSessionId.value)
    return slot?.hasMore ?? false
  })

  const isLoadingMoreMessages = ref(false)

  /**
   * Fetch all sessions
   */
  async function fetchSessions() {
    isLoadingSessions.value = true
    error.value = null

    try {
      const data = await $fetch<ChatSessionSummary[]>('/api/chat-ws/sessions')
      sessions.value = data
    } catch (e: any) {
      error.value = e.message || 'Failed to fetch sessions'
      console.error('Error fetching sessions:', e)
    } finally {
      isLoadingSessions.value = false
    }
  }

  /**
   * Load a specific session
   */
  async function loadSession(sessionId: string, options: { limit?: number; offset?: number } = {}) {
    console.log('[useChatSessions] loadSession called:', sessionId, options)
    isLoadingSession.value = true
    error.value = null

    try {
      // Set as active session in store
      console.log('[useChatSessions] Setting active session in store')
      sessionStore.setActiveSession(sessionId)
      currentSessionId.value = sessionId

      // Fetch from server if stale or not loaded
      const isStale = sessionStore.isStale(sessionId)
      const hasSession = sessionStore.has(sessionId)
      console.log('[useChatSessions] Session state - isStale:', isStale, 'hasSession:', hasSession)

      if (isStale || !hasSession) {
        console.log('[useChatSessions] Fetching from server...')
        await sessionStore.fetchFromServer(sessionId, {
          limit: options.limit || 50,
          offset: options.offset || 0,
        })
        console.log('[useChatSessions] Fetched from server')
      }

      // Get current messages from store
      const storeMessages = sessionStore.getMessages(sessionId)
      console.log('[useChatSessions] Messages from store:', storeMessages.length)

      // Get session metadata
      console.log('[useChatSessions] Fetching session metadata...')
      const data = await $fetch<ChatSession & { pagination: any }>(`/api/chat-ws/sessions/${sessionId}`, {
        query: {
          limit: options.limit || 50,
          offset: options.offset || 0,
        },
      })

      console.log('[useChatSessions] Session metadata:', data)
      currentSession.value = data

      return data
    } catch (e: any) {
      error.value = e.message || 'Failed to load session'
      console.error('[useChatSessions] Error loading session:', e)
      return null
    } finally {
      isLoadingSession.value = false
    }
  }

  /**
   * Create a new session
   */
  async function createSession(options: { agentSlug?: string; workingDir?: string } = {}) {
    error.value = null

    try {
      const data = await $fetch<ChatSession>('/api/chat-ws/sessions', {
        method: 'POST',
        body: {
          agentSlug: options.agentSlug,
          workingDir: options.workingDir,
        },
      })

      // Set as active session in store
      sessionStore.setActiveSession(data.id)
      currentSessionId.value = data.id
      currentSession.value = data

      // Refresh sessions list
      await fetchSessions()

      return data
    } catch (e: any) {
      error.value = e.message || 'Failed to create session'
      console.error('Error creating session:', e)
      return null
    }
  }

  /**
   * Delete a session
   */
  async function deleteSession(sessionId: string) {
    error.value = null

    try {
      await $fetch(`/api/chat-ws/sessions/${sessionId}`, {
        method: 'DELETE',
      })

      // Remove from sessions list
      sessions.value = sessions.value.filter((s) => s.id !== sessionId)

      // Clear current session if it was deleted
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null
        currentSession.value = null
        // `messages` is a computed derived from currentSessionId (it returns []
        // when there is none), so it clears itself. The assignment that used to
        // be here was a write to a read-only computed - Vue refuses it at
        // runtime and warns; it never did anything.
      }

      return true
    } catch (e: any) {
      error.value = e.message || 'Failed to delete session'
      console.error('Error deleting session:', e)
      return false
    }
  }

  /**
   * Add a message to the session (realtime)
   */
  function addMessage(message: NormalizedMessage) {
    const targetSessionId = message.sessionId || currentSessionId.value
    if (!targetSessionId) return

    // Add to session store (realtime messages)
    sessionStore.appendRealtime(targetSessionId, message)

    // Update current session metadata only if it's the current session
    if (currentSession.value && targetSessionId === currentSessionId.value) {
      currentSession.value.lastActivity = message.timestamp
      currentSession.value.messageCount = (currentSession.value.messageCount || 0) + 1
    }
  }

  /**
   * Update a message (for streaming updates)
   * Note: For streaming text, use sessionStore.updateStreaming instead
   */
  function updateMessage(messageId: string, updates: Partial<NormalizedMessage>) {
    const targetSessionId = updates.sessionId || currentSessionId.value
    if (!targetSessionId) return

    // Get current messages from store for this session
    const currentMessages = sessionStore.getMessages(targetSessionId)
    const idx = currentMessages.findIndex((m) => m.id === messageId)

    if (idx !== -1) {
      // Create updated message
      const updated: NormalizedMessage = { ...currentMessages[idx], ...updates } as NormalizedMessage

      // Update in store
      sessionStore.appendRealtime(targetSessionId, updated)
    }
  }

  /**
   * Clear current session
   */
  function clearCurrentSession() {
    if (currentSessionId.value) {
      sessionStore.clearRealtime(currentSessionId.value)
    }
    sessionStore.setActiveSession(null)
    currentSessionId.value = null
    currentSession.value = null
  }

  /**
   * Load more messages (pagination)
   */
  async function loadMoreMessages() {
    if (!currentSessionId.value) return false

    isLoadingMoreMessages.value = true

    try {
      const slot = await sessionStore.fetchMore(currentSessionId.value, {
        limit: 20,
      })

      return slot?.hasMore ?? false
    } catch (e: any) {
      error.value = e.message || 'Failed to load more messages'
      console.error('Error loading more messages:', e)
      return false
    } finally {
      isLoadingMoreMessages.value = false
    }
  }

  return {
    // State
    currentSessionId,
    currentSession,
    sessions,
    messages,
    isLoadingSessions,
    isLoadingSession,
    isLoadingMoreMessages,
    hasMoreMessages,
    error,

    // Actions
    fetchSessions,
    loadSession,
    createSession,
    deleteSession,
    addMessage,
    updateMessage,
    clearCurrentSession,
    loadMoreMessages,

    // Session store (for advanced usage)
    sessionStore,
  }
}
