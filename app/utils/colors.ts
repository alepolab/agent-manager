/**
 * Agent accent color palette.
 * Model colors/badges are in ~/utils/models.ts — import from there.
 */
export const agentColorMap = {
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  green: '#22c55e',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  indigo: '#6366f1',
  purple: '#a855f7',
  pink: '#ec4899',
} as Record<string, string>

export function getAgentColor(color: string | undefined): string {
  if (!color) return '#71717a'
  // If it's a hex color, return it directly
  if (color.startsWith('#')) return color
  return agentColorMap[color] || '#71717a'
}

export function getAgentColorName(colorValue: string): string | null {
  for (const [name, value] of Object.entries(agentColorMap)) {
    if (value.toLowerCase() === colorValue.toLowerCase()) return name
  }
  return null
}
