import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * Splits a markdown file into its YAML frontmatter and its body.
 *
 * The line-ending class is not cosmetic. This regex was `\n`-only, and every
 * agent file on a Windows checkout is CRLF - so the match failed, the catch
 * below never ran (nothing threw), and callers silently received EMPTY
 * frontmatter with the whole `---` block still sitting in the body.
 *
 * What that cost, on every Windows install, invisibly: resolveTools saw no
 * `tools` and handed every pipeline agent the SDK's FULL default toolset, so
 * agents declaring four read-only tools ran with Bash and every configured MCP
 * server; `model:` was ignored, so the per-agent model split never happened;
 * `maxTurns: 30` fell back to 10; declared skills never loaded. The tool policy
 * in agentToolPolicy.ts - written expressly to stop that, and verified against
 * the SDK - was inert on this platform the whole time.
 */
export function parseFrontmatter<T>(raw: string): { frontmatter: T; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {} as T, body: raw }
  }
  const yamlBlock = match[1]!
  const bodyBlock = match[2]!
  try {
    const frontmatter = parseYaml(yamlBlock) as T
    const body = bodyBlock.replace(/^\r?\n/, '')
    return { frontmatter, body }
  } catch {
    // Fallback: try to parse key-value pairs manually for malformed YAML
    const lines = yamlBlock.split('\n')
    const fm: Record<string, unknown> = {}
    for (const line of lines) {
      const kvMatch = line.match(/^(\S+):\s*(.*)$/)
      if (kvMatch) {
        const key = kvMatch[1]!
        let value: unknown = kvMatch[2]!.trim()
        // Strip surrounding quotes
        if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1)
        }
        fm[key] = value
      }
    }
    const body = bodyBlock.replace(/^\r?\n/, '')
    return { frontmatter: fm as T, body }
  }
}

export function serializeFrontmatter(frontmatter: object, body: string): string {
  const yamlStr = stringifyYaml(frontmatter as Record<string, unknown>, { lineWidth: 0 }).trimEnd()
  return `---\n${yamlStr}\n---\n\n${body}`
}
