/**
 * Minimal Atlassian Document Format (ADF) <-> plain text conversion.
 *
 * Jira Cloud's v3 REST API returns rich-text fields (issue `description`,
 * comment `body`) as ADF — a nested JSON document, not a string — and
 * requires ADF on write too (a plain string body is a 400). This file is
 * deliberately NOT a full ADF implementation: it round-trips exactly what
 * this app needs (plain paragraphs and line breaks) and degrades gracefully
 * on anything richer (tables, mentions, code blocks, panels) by extracting
 * whatever text nodes it can find rather than throwing. A ticket's
 * description existing only to be read into a run's prompt does not need a
 * lossless conversion; it needs to never crash the ticket source over a
 * Jira field shape it doesn't fully model.
 */

interface AdfTextNode {
  type: 'text'
  text: string
}

interface AdfNode {
  type: string
  text?: string
  content?: AdfNode[]
  [key: string]: unknown
}

export interface AdfDocument {
  type: 'doc'
  version: 1
  content: AdfNode[]
}

/** Block-level node types whose children are separated by a blank line when
 *  flattened to plain text. Everything else (paragraph, list item, ...) is
 *  joined with a single newline. */
const BLOCK_SEPARATED = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock'])

function walk(node: AdfNode | undefined | null, out: string[]): void {
  if (!node || typeof node !== 'object') return
  if (node.type === 'text' && typeof node.text === 'string') {
    out.push(node.text)
    return
  }
  if (node.type === 'hardBreak') {
    out.push('\n')
    return
  }
  if (!Array.isArray(node.content)) return

  for (const child of node.content) {
    walk(child, out)
    if (BLOCK_SEPARATED.has(child?.type)) out.push('\n\n')
  }
}

/**
 * Extracts plain text from an ADF document (or a bare node). Accepts
 * `unknown` because a Jira field is exactly that until validated — a
 * `description` can legitimately be `null` (no description), a plain string
 * (some fields / older data), or a full ADF doc. Never throws: anything
 * that isn't recognizably ADF text yields `''`, the honest "nothing to
 * extract" rather than a crash over a field shape this file doesn't model.
 */
export function adfToPlainText(doc: unknown): string {
  if (doc == null) return ''
  if (typeof doc === 'string') return doc
  if (typeof doc !== 'object') return ''

  const out: string[] = []
  walk(doc as AdfNode, out)
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Builds the minimal ADF document Jira's v3 comment-create API requires
 * from plain text: one `paragraph` per blank-line-separated block, `\n`
 * within a block becomes a `hardBreak`. This is the encode half of the
 * round trip `adfToPlainText` is the decode half of — good enough for a
 * generated comment (this app's own text), not for arbitrary rich content.
 */
export function plainTextToAdf(text: string): AdfDocument {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(b => b.length > 0)
  const content: AdfNode[] = (blocks.length ? blocks : ['']).map(block => {
    const lines = block.split('\n')
    const paraContent: AdfNode[] = []
    lines.forEach((line, i) => {
      if (line.length > 0) paraContent.push({ type: 'text', text: line } satisfies AdfTextNode)
      if (i < lines.length - 1) paraContent.push({ type: 'hardBreak' })
    })
    // ADF forbids an empty `content` array on a paragraph — a genuinely
    // blank block still needs a single (empty) text node to stay valid.
    return {
      type: 'paragraph',
      content: paraContent.length ? paraContent : [{ type: 'text', text: '' } satisfies AdfTextNode],
    }
  })

  return { type: 'doc', version: 1, content }
}
