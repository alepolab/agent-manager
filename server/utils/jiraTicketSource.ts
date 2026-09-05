import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Watch, TicketRef } from '../../shared/types/watch.ts'
import type { TicketSource } from './ticketSource.ts'

const execFileP = promisify(execFile)

/**
 * A TicketSource backed by the `jira` CLI (jira-cli), which is already
 * authenticated on this host and, through the mounted home directory, inside
 * the container. The watch's `query` is JQL and runs verbatim, so it must
 * carry its own `project = ...` clause: the CLI otherwise scopes it to the
 * configured default project. Descriptions arrive as ADF and are flattened to
 * text; formatting is not what the pipeline reads, the words are.
 */
export type Exec = (args: string[]) => Promise<string>

const realExec: Exec = async (args) => {
  const { stdout } = await execFileP('jira', args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}
let exec: Exec = realExec
/** Test seam. */
export function setJiraExec(fn: Exec) { exec = fn }

/** Atlassian Document Format to plain text: paragraphs and list items on their own lines. */
export function adfToText(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(adfToText).join('')
  const type = node.type
  const inner = adfToText(node.content ?? [])
  if (type === 'text') return String(node.text ?? '')
  if (type === 'hardBreak') return '\n'
  if (type === 'paragraph' || type === 'heading') return inner + '\n'
  if (type === 'listItem') return '- ' + inner
  if (type === 'bulletList' || type === 'orderedList' || type === 'blockquote') return inner + '\n'
  if (type === 'codeBlock') return '```\n' + inner + '\n```\n'
  if (type === 'mention') return String(node.attrs?.text ?? '')
  if (type === 'inlineCard') return String(node.attrs?.url ?? '')
  return inner
}

export interface JiraIssue { key: string, summary: string, description: string, labels: string[], updatedAt: number, url?: string }

export async function viewIssue(key: string): Promise<JiraIssue> {
  const raw = JSON.parse(await exec(['issue', 'view', key, '--raw']))
  const f = raw.fields ?? {}
  const description = typeof f.description === 'string' ? f.description : adfToText(f.description)
  return {
    key: raw.key ?? key,
    summary: String(f.summary ?? ''),
    description: description.trim(),
    labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
    updatedAt: f.updated ? Date.parse(f.updated) : Date.now(),
    url: typeof raw.self === 'string' ? raw.self.replace(/\/rest\/api\/\d+\/issue\/.*$/, `/browse/${raw.key ?? key}`) : undefined,
  }
}

/** Keys and update times for a JQL query, oldest update first so a backlog drains in order. */
export async function listKeys(jql: string): Promise<{ key: string, updatedAt: number }[]> {
  const out = await exec(['issue', 'list', '-q', jql, '--plain', '--no-headers', '--columns', 'key,updated'])
  return out.split('\n').map(l => l.trim()).filter(Boolean).map((line) => {
    const [key, ...rest] = line.split(/\t+|\s{2,}/)
    const updated = rest.join(' ').trim()
    return { key: key!.trim(), updatedAt: updated ? Date.parse(updated.replace(' ', 'T')) || Date.now() : Date.now() }
  }).filter(r => /^[A-Z][A-Z0-9]+-\d+$/.test(r.key))
    .sort((a, b) => a.updatedAt - b.updatedAt)
}

/** The text a run should start from for one ticket: key, summary, labels and description. */
export function ticketText(issue: JiraIssue): string {
  return [
    `${issue.key}: ${issue.summary}`,
    issue.url ? `URL: ${issue.url}` : '',
    issue.labels.length ? `Labels: ${issue.labels.join(', ')}` : '',
    '',
    issue.description,
  ].filter((l, i) => l !== '' || i === 3).join('\n')
}

const MAX_PER_FETCH = 20

export function createJiraTicketSource(): TicketSource {
  return {
    async fetch(watch: Watch): Promise<TicketRef[]> {
      if (!watch.query?.trim()) return []
      try {
        const keys = (await listKeys(watch.query)).slice(0, MAX_PER_FETCH)
        const refs: TicketRef[] = []
        for (const k of keys) {
          try {
            const issue = await viewIssue(k.key)
            refs.push({ key: issue.key, summary: issue.summary, description: ticketText(issue), updatedAt: issue.updatedAt })
          } catch (err) {
            console.error(`[jiraTicketSource] ${k.key}:`, err instanceof Error ? err.message : err)
          }
        }
        return refs
      } catch (err) {
        // A broken query or an expired login degrades this watch's cycle to
        // empty; the scheduler keeps running everything else.
        console.error('[jiraTicketSource] list failed:', err instanceof Error ? err.message : err)
        return []
      }
    },
  }
}

/** For a manual run started with only a key: the ticket text, or null when the CLI cannot serve it. */
export async function expandTicketKey(prompt: string): Promise<string | null> {
  const key = prompt.trim()
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return null
  try {
    return ticketText(await viewIssue(key))
  } catch {
    return null
  }
}
