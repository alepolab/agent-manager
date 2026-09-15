import type { ContextMetrics, ToolCall, TokenUsage } from '~/types'

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
      total: 200_000,
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
  function resetMetrics() {
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
        total: 200_000,
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

  // `handleWebSocketEvent` lived here and was the ONLY writer of
  // `metrics.files` — and nothing ever called it. It took `CliWebSocketEvent`,
  // a shape the server stopped producing when the terminal was removed, so the
  // file arrays it filled have been empty ever since, and the two computeds
  // over them (`totalFileChanges`, `recentFileChanges`) could only ever answer
  // 0 and []. `updateTokenUsage` is the live path for the numbers that matter.

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
  function updateTokenUsage(tokens: { input: number; output: number; cacheCreation?: number; cacheRead?: number }) {
    metrics.value.tokens = { 
      input: tokens.input, 
      output: tokens.output, 
      cached: tokens.cacheRead || 0,
      cacheCreation: tokens.cacheCreation || 0
    }
    
    // Calculate context usage (reference logic: input + cacheCreation + cacheRead)
    const total = metrics.value.contextWindow.total || 200000
    const used = tokens.input + (tokens.cacheCreation || 0) + (tokens.cacheRead || 0)
    const percentage = Math.min(100, (used / total) * 100)
    
    metrics.value.contextWindow = {
      used,
      total,
      percentage: Math.round(percentage * 100) / 100
    }
  }

  return {
    metrics,
    isMonitoring,
    totalToolCalls,
    successfulToolCalls,
    failedToolCalls,
    runningToolCalls,
    contextUsageText,
    costText,
    contextUsageColor,
    recentToolCalls,
    toolStats,
    startMonitoring,
    stopMonitoring,
    resetMetrics,
    updateTokenUsage,
  }
}
