import type { ContextMetrics, FileChange, ToolCall, TokenUsage, CliWebSocketEvent } from '~/types'
import { DEFAULT_MODEL, getModelContextWindow } from '~/utils/models'

export function useContextMonitor() {
  // Initialize empty metrics
  const metrics = ref<ContextMetrics>({
    tokens: {
      input: 0,
      output: 0,
      cached: 0,
    },
    cost: {
      total: 0,
      input: 0,
      output: 0,
      cached: 0,
    },
    contextWindow: {
      used: 0,
      total: getModelContextWindow(DEFAULT_MODEL),
      percentage: 0,
    },
    files: {
      created: [],
      modified: [],
      deleted: [],
    },
    tools: [],
  })

  const isMonitoring = ref(false)

  /**
   * Start monitoring by attaching to WebSocket event handler
   */
  function startMonitoring() {
    isMonitoring.value = true
  }

  /**
   * Stop monitoring
   */
  function stopMonitoring() {
    isMonitoring.value = false
  }

  /**
   * Reset metrics to initial state
   */
  function resetMetrics(contextWindowTotal?: number) {
    metrics.value = {
      tokens: {
        input: 0,
        output: 0,
        cached: 0,
      },
      cost: {
        total: 0,
        input: 0,
        output: 0,
        cached: 0,
      },
      contextWindow: {
        used: 0,
        total: contextWindowTotal || getModelContextWindow(DEFAULT_MODEL),
        percentage: 0,
      },
      files: {
        created: [],
        modified: [],
        deleted: [],
      },
      tools: [],
    }
  }

  /**
   * Handle WebSocket events to update metrics
   */
  function handleWebSocketEvent(event: CliWebSocketEvent) {
    if (!isMonitoring.value) return

    switch (event.type) {
      case 'context_update':
        // Full context update from server
        metrics.value = event.metrics
        break

      case 'token_update':
        // Partial token update
        if (event.tokens.input !== undefined) {
          metrics.value.tokens.input += event.tokens.input
        }
        if (event.tokens.output !== undefined) {
          metrics.value.tokens.output += event.tokens.output
        }
        if (event.tokens.cached !== undefined) {
          metrics.value.tokens.cached += event.tokens.cached
        }
        break

      case 'file_change':
        // File system change
        const change = event.change
        switch (change.type) {
          case 'created':
            metrics.value.files.created.push(change)
            break
          case 'modified':
            metrics.value.files.modified.push(change)
            break
          case 'deleted':
            metrics.value.files.deleted.push(change)
            break
        }
        break

      case 'tool_call':
        // Tool execution
        metrics.value.tools.push(event.tool)
        break
    }
  }

  /**
   * Get total file changes count
   */
  const totalFileChanges = computed(() => {
    return (
      metrics.value.files.created.length +
      metrics.value.files.modified.length +
      metrics.value.files.deleted.length
    )
  })

  /**
   * Get total tool calls count
   */
  const totalToolCalls = computed(() => {
    return metrics.value.tools.length
  })

  /**
   * Get successful tool calls
   */
  const successfulToolCalls = computed(() => {
    return metrics.value.tools.filter((t) => t.status === 'success').length
  })

  /**
   * Get failed tool calls
   */
  const failedToolCalls = computed(() => {
    return metrics.value.tools.filter((t) => t.status === 'error').length
  })

  /**
   * Get running tool calls
   */
  const runningToolCalls = computed(() => {
    return metrics.value.tools.filter((t) => t.status === 'running').length
  })

  /**
   * Get context window usage as formatted string
   */
  const contextUsageText = computed(() => {
    const { used, total, percentage } = metrics.value.contextWindow
    return `${used.toLocaleString()} / ${total.toLocaleString()} (${percentage.toFixed(1)}%)`
  })

  /**
   * Get cost as formatted currency
   */
  const costText = computed(() => {
    return `$${metrics.value.cost.total.toFixed(4)}`
  })

  /**
   * Get context usage color based on percentage
   */
  const contextUsageColor = computed(() => {
    const percentage = metrics.value.contextWindow.percentage
    if (percentage < 50) return 'green'
    if (percentage < 75) return 'yellow'
    if (percentage < 90) return 'orange'
    return 'red'
  })

  /**
   * Get most recent file changes (last 10)
   */
  const recentFileChanges = computed(() => {
    const allChanges = [
      ...metrics.value.files.created,
      ...metrics.value.files.modified,
      ...metrics.value.files.deleted,
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    return allChanges.slice(0, 10)
  })

  /**
   * Get recent tool calls (last 20)
   */
  const recentToolCalls = computed(() => {
    return [...metrics.value.tools]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 20)
  })

  /**
   * Get tool call statistics
   */
  const toolStats = computed(() => {
    const stats = new Map<string, { count: number; totalElapsed: number; avgElapsed: number }>()

    for (const tool of metrics.value.tools) {
      const existing = stats.get(tool.toolName) || { count: 0, totalElapsed: 0, avgElapsed: 0 }
      existing.count++
      if (tool.elapsed !== undefined) {
        existing.totalElapsed += tool.elapsed
      }
      stats.set(tool.toolName, existing)
    }

    // Calculate averages
    for (const [name, stat] of stats) {
      stat.avgElapsed = stat.count > 0 ? stat.totalElapsed / stat.count : 0
    }

    // Convert to array and sort by count
    return Array.from(stats.entries())
      .map(([name, stat]) => ({ name, ...stat }))
      .sort((a, b) => b.count - a.count)
  })

  /**
   * Update metrics with specific token usage (overwrites current)
   */
  function updateTokenUsage(
    tokens: { input: number; output: number; cacheCreation?: number; cacheRead?: number },
    contextWindowTotal?: number
  ) {
    metrics.value.tokens = {
      input: tokens.input,
      output: tokens.output,
      cached: tokens.cacheRead || 0,
      cacheCreation: tokens.cacheCreation || 0
    }

    // Calculate context usage (reference logic: input + cacheCreation + cacheRead)
    const total = contextWindowTotal || metrics.value.contextWindow.total || getModelContextWindow(DEFAULT_MODEL)
    const used = tokens.input + (tokens.cacheCreation || 0) + (tokens.cacheRead || 0)
    const percentage = Math.min(100, (used / total) * 100)
    
    metrics.value.contextWindow = {
      used,
      total,
      percentage: Math.round(percentage * 100) / 100
    }
  }

  /**
   * Point the usage bar at a different window, keeping whatever tokens are
   * already counted. Used when the model changes: the panel should say 1M as
   * soon as the picker moves, not at the end of the next turn.
   */
  function setContextWindow(total: number) {
    const used = metrics.value.contextWindow.used
    metrics.value.contextWindow = {
      used,
      total,
      percentage: Math.round(Math.min(100, (used / total) * 100) * 100) / 100
    }
  }

  return {
    metrics,
    isMonitoring,
    totalFileChanges,
    totalToolCalls,
    successfulToolCalls,
    failedToolCalls,
    runningToolCalls,
    contextUsageText,
    costText,
    contextUsageColor,
    recentFileChanges,
    recentToolCalls,
    toolStats,
    startMonitoring,
    stopMonitoring,
    resetMetrics,
    updateTokenUsage,
    setContextWindow,
    handleWebSocketEvent,
  }
}
