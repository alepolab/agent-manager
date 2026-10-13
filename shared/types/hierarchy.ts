/**
 * Whose work a person may see and act on, beside the role that says what kind
 * of work they do.
 *
 * Three levels and a lead. An L1 works on their own; an L2 leads L1s; an L3
 * leads L2s and, through them, their L1s. Supervision follows the lead links,
 * not the level alone: an L2 supervises the L1s whose lead they are, not every
 * L1 on the instance. The level is what keeps the links honest - a lead is
 * always of a higher level than the people they lead, so the chain cannot loop.
 *
 * Someone with no level is outside the hierarchy and sees what everyone saw
 * before it existed: every run. Adding levels to a running instance therefore
 * narrows nobody until they are placed in it, the same promise roles.json makes.
 */
export type Level = 1 | 2 | 3

export const LEVELS: Level[] = [1, 2, 3]

export interface Placement {
  level: Level
  /** The login of the person who supervises them. Absent at the top of a team. */
  lead?: string
}

export const LEVEL_LABEL: Record<Level, string> = {
  1: 'Works on their own runs and chats.',
  2: 'Leads L1s: sees and acts on their runs and chats.',
  3: 'Leads L2s, and through them their L1s.',
}

export const isLevel = (v: unknown): v is Level => v === 1 || v === 2 || v === 3

/**
 * Everyone below `login` through the lead links, nearest first. Pure, so the
 * server and the Team page answer "whose team is this" the same way. A broken
 * file that somehow holds a loop ends the walk rather than spinning.
 */
export function teamOf(login: string, placements: Record<string, Placement>): string[] {
  const out: string[] = []
  const seen = new Set([login])
  const queue = [login]
  while (queue.length) {
    const lead = queue.shift()!
    for (const [member, p] of Object.entries(placements)) {
      if (p.lead === lead && !seen.has(member)) {
        seen.add(member)
        out.push(member)
        queue.push(member)
      }
    }
  }
  return out
}

/** Why `member` cannot be placed at `level` under `lead`, or null. */
export function placementProblem(member: string, next: Placement, placements: Record<string, Placement>): string | null {
  if (!isLevel(next.level)) return 'level must be 1, 2 or 3'
  if (!next.lead) return null
  if (next.lead === member) return 'nobody leads themselves'
  const lead = placements[next.lead]
  if (!lead) return `@${next.lead} has no level; place them first`
  if (lead.level <= next.level) return `@${next.lead} is L${lead.level}, so cannot lead an L${next.level}`
  if (teamOf(member, placements).includes(next.lead)) return `@${next.lead} is in @${member}'s own team`
  // Their own team must stay below them at the new level.
  for (const m of teamOf(member, placements)) {
    if (placements[m]?.lead === member && placements[m]!.level >= next.level) {
      return `@${m} is L${placements[m]!.level} and led by @${member}; an L${next.level} cannot lead them`
    }
  }
  return null
}
