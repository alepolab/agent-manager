/**
 * `git diff` output for one file, as rows a reviewer reads: the hunk headers,
 * and each line with its number on the old side, the new side, or both.
 */
export interface DiffRow {
  kind: 'hunk' | 'context' | 'add' | 'del' | 'note'
  text: string
  /** Line number before the change; null on an added line or a header. */
  old: number | null
  /** Line number after the change; null on a removed line or a header. */
  new: number | null
}

export interface FileDiff {
  rows: DiffRow[]
  added: number
  removed: number
  binary: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

export function parseUnifiedDiff(diff: string): FileDiff {
  const rows: DiffRow[] = []
  let added = 0, removed = 0, binary = false
  let o = 0, n = 0, inHunk = false
  for (const line of diff.split('\n')) {
    const h = HUNK.exec(line)
    if (h) {
      o = Number(h[1]); n = Number(h[2]); inHunk = true
      rows.push({ kind: 'hunk', text: line, old: null, new: null })
      continue
    }
    if (!inHunk) {
      // The file header: diff --git, index, mode, ---/+++. Only a binary marker matters.
      if (/^Binary files .* differ$/.test(line)) binary = true
      continue
    }
    if (line.startsWith('+')) { rows.push({ kind: 'add', text: line.slice(1), old: null, new: n++ }); added++ }
    else if (line.startsWith('-')) { rows.push({ kind: 'del', text: line.slice(1), old: o++, new: null }); removed++ }
    else if (line.startsWith(' ')) rows.push({ kind: 'context', text: line.slice(1), old: o++, new: n++ })
    else if (line.startsWith('\\')) rows.push({ kind: 'note', text: line.slice(2), old: null, new: null })
    // An empty string is the split's trailing newline, or a context line git
    // emitted without its leading space; either way there is nothing to number.
  }
  return { rows, added, removed, binary }
}

/**
 * The path a renamed file has now, from numstat's `dir/{old => new}/f` or
 * `old => new` - the form `git diff` needs after `--`.
 */
export function currentPath(numstatPath: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(numstatPath)
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, '/')
  const plain = /^(.*) => (.*)$/.exec(numstatPath)
  return plain ? plain[2]! : numstatPath
}
