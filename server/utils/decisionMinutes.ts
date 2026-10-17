/**
 * The self-reported `minutes` on a gate decision's request body: a finite,
 * non-negative number or nothing. Never coerced from a string and never
 * defaulted - a figure nobody gave is a figure the board must not sum.
 */
export function minutesOf(body: { minutes?: unknown } | null | undefined): number | undefined {
  const m = body?.minutes
  return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? Math.round(m * 100) / 100 : undefined
}
