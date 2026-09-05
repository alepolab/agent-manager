import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getModelPricing, getModelContextWindow } from './models'

export interface FileChange {
  path: string
  type: 'created' | 'modified' | 'deleted'
  timestamp: string
  size?: number
}

export interface TokenUsage {
  input: number
  output: number
  cached: number
}

export interface CostBreakdown {
  total: number
  input: number
  output: number
  cached: number
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

/**
 * Calculate cost from token usage.
 * Model string can be a full API id ("claude-sonnet-4") or a short alias ("sonnet").
 */
export function calculateCost(tokens: TokenUsage, model: string = 'default'): CostBreakdown {
  const pricing = getModelPricing(model)

  const inputCost = (tokens.input / 1_000_000) * pricing.input
  const outputCost = (tokens.output / 1_000_000) * pricing.output
  const cachedCost = (tokens.cached / 1_000_000) * pricing.cached

  return {
    total: inputCost + outputCost + cachedCost,
    input: inputCost,
    output: outputCost,
    cached: cachedCost,
  }
}

/**
 * Parse token usage from Claude CLI output
 * Looks for patterns like:
 * - "Input tokens: 12,450"
 * - "Output tokens: 3,210"
 * - "Cache read tokens: 8,100"
 */
export function parseTokenUsage(output: string): Partial<TokenUsage> | null {
  const tokens: Partial<TokenUsage> = {}

  // Match input tokens
  const inputMatch = output.match(/Input tokens?:\s*([\d,]+)/i)
  if (inputMatch?.[1]) {
    tokens.input = parseInt(inputMatch[1].replace(/,/g, ''), 10)
  }

  // Match output tokens
  const outputMatch = output.match(/Output tokens?:\s*([\d,]+)/i)
  if (outputMatch?.[1]) {
    tokens.output = parseInt(outputMatch[1].replace(/,/g, ''), 10)
  }

  // Match cached tokens
  const cachedMatch = output.match(/Cache (?:read )?tokens?:\s*([\d,]+)/i)
  if (cachedMatch?.[1]) {
    tokens.cached = parseInt(cachedMatch[1].replace(/,/g, ''), 10)
  }

  // Return null if no tokens were found
  return Object.keys(tokens).length > 0 ? tokens : null
}

/**
 * Parse tool calls from Claude CLI output
 * Looks for patterns like:
 * - "Tool: Read (path/to/file.ts)"
 * - "Tool: Bash completed in 1.2s"
 */
export function parseToolCalls(output: string): ToolCall[] {
  const tools: ToolCall[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    // Match tool start: "Tool: Read (path/to/file.ts)"
    const startMatch = line.match(/Tool:\s+(\w+)\s*(?:\((.*?)\))?/i)
    // Gate on the captured NAME, not merely on a match: a tool event with no
    // name is not a tool event, and pushing one would put an entry with an
    // undefined toolName into the timeline the UI renders.
    if (startMatch?.[1]) {
      tools.push({
        toolName: startMatch[1],
        timestamp: new Date().toISOString(),
        args: startMatch[2],
        status: 'running',
      })
      continue
    }

    // Match tool completion: "Tool: Bash completed in 1.2s"
    const completeMatch = line.match(/Tool:\s+(\w+)\s+completed in ([\d.]+)s/i)
    if (completeMatch?.[1] && completeMatch[2]) {
      // Find the most recent running tool with this name and mark it complete
      const tool = [...tools].reverse().find((t) => t.toolName === completeMatch[1] && t.status === 'running')
      if (tool) {
        tool.status = 'success'
        tool.elapsed = parseFloat(completeMatch[2]) * 1000 // Convert to ms
      }
      continue
    }

    // Match tool error
    const errorMatch = line.match(/Tool:\s+(\w+)\s+failed/i)
    if (errorMatch) {
      const tool = [...tools].reverse().find((t) => t.toolName === errorMatch[1] && t.status === 'running')
      if (tool) {
        tool.status = 'error'
      }
    }
  }

  return tools
}

/**
 * Watch a directory for file system changes
 */
export function watchDirectory(
  directory: string,
  callback: (change: FileChange) => void,
  options: {
    ignored?: string | string[]
    ignoreInitial?: boolean
  } = {}
): FSWatcher {
  const watcher = chokidar.watch(directory, {
    persistent: true,
    ignoreInitial: options.ignoreInitial ?? true,
    ignored: options.ignored || [
      '**/node_modules/**',
      '**/.git/**',
      '**/.next/**',
      '**/.nuxt/**',
      '**/dist/**',
      '**/build/**',
      '**/.DS_Store',
      '**/Thumbs.db',
    ],
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  })

  // Handle file creation
  watcher.on('add', async (filePath) => {
    try {
      const stats = await fs.stat(filePath)
      callback({
        path: path.relative(directory, filePath),
        type: 'created',
        timestamp: new Date().toISOString(),
        size: stats.size,
      })
    } catch (e) {
      // File might have been deleted before we could stat it
      console.error('Error stating file:', e)
    }
  })

  // Handle file modification
  watcher.on('change', async (filePath) => {
    try {
      const stats = await fs.stat(filePath)
      callback({
        path: path.relative(directory, filePath),
        type: 'modified',
        timestamp: new Date().toISOString(),
        size: stats.size,
      })
    } catch (e) {
      console.error('Error stating file:', e)
    }
  })

  // Handle file deletion
  watcher.on('unlink', (filePath) => {
    callback({
      path: path.relative(directory, filePath),
      type: 'deleted',
      timestamp: new Date().toISOString(),
    })
  })

  return watcher
}

/**
 * Calculate context window utilization
 */
export function calculateContextWindow(tokens: TokenUsage, maxTokens?: number): {
  used: number
  total: number
  percentage: number
} {
  const total = maxTokens ?? getModelContextWindow(undefined)
  const used = tokens.input + tokens.output + tokens.cached
  const percentage = Math.min(100, (used / total) * 100)

  return {
    used,
    total,
    percentage: Math.round(percentage * 100) / 100, // Round to 2 decimal places
  }
}

/**
 * Create initial empty context metrics
 */
export function createEmptyMetrics(): ContextMetrics {
  return {
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
      total: getModelContextWindow(undefined),
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
 * Update metrics with new token usage
 */
export function updateMetricsWithTokens(metrics: ContextMetrics, tokens: Partial<TokenUsage>, model?: string): void {
  // Update token counts
  if (tokens.input !== undefined) {
    metrics.tokens.input += tokens.input
  }
  if (tokens.output !== undefined) {
    metrics.tokens.output += tokens.output
  }
  if (tokens.cached !== undefined) {
    metrics.tokens.cached += tokens.cached
  }

  // Recalculate cost
  metrics.cost = calculateCost(metrics.tokens, model)

  // Recalculate context window
  metrics.contextWindow = calculateContextWindow(metrics.tokens)
}

/**
 * Add file change to metrics
 */
export function addFileChange(metrics: ContextMetrics, change: FileChange): void {
  switch (change.type) {
    case 'created':
      metrics.files.created.push(change)
      break
    case 'modified':
      metrics.files.modified.push(change)
      break
    case 'deleted':
      metrics.files.deleted.push(change)
      break
  }
}

/**
 * Add tool call to metrics
 */
export function addToolCall(metrics: ContextMetrics, tool: ToolCall): void {
  metrics.tools.push(tool)
}
