#!/usr/bin/env node
/**
 * PreToolUse hook — the internal-references guard (T1).
 *
 * Everything a user can read in a product is written for the operator or the
 * customer. It must never carry internal information: Jira keys (PCRFV-12,
 * SBN-4182, SASKNEPCR-36), Paperclip task ids (ALE-249), test-case ids (TC733),
 * Confluence / Atlassian links or internal lab hosts. They belong in code
 * comments, commit messages and PRs, never in a string. The rule text is
 * engineering/templates/CLAUDE.md "In-product text"; this is its control.
 *
 * Denies an Edit or Write that ADDS such a reference to a user-visible string in a
 * user-facing file: templates, i18n / message bundles, seed and customdata JSON,
 * Liquibase config descriptions, email and SMS templates, frontend string
 * literals, and API-doc annotations (@Schema, @Operation, @ApiResponse,
 * @Parameter). Comments, tests, docs and references that were already there are
 * left alone, so touching an old file is never blocked for its history.
 *
 * Contract: tool call as JSON on stdin; exit 0 allows; exit 2 with a printed
 * reason denies. Internal errors allow — a broken hook must not wedge the estate.
 */
import { existsSync, readFileSync } from 'node:fs'

// "KEY-123" shaped tokens that are standards, codecs or units, not tickets.
const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'AES', 'TLS', 'SSL', 'IPV', 'CVE', 'MD', 'RSA', 'DES', 'HMAC', 'EAN',
  'UPC', 'PCI', 'IEEE', 'IEC', 'EN', 'BS', 'COVID', 'MPEG', 'MP', 'WCAG', 'ASCII', 'GMT', 'UTC', 'ES', 'ECMA', 'CRC', 'PKCS', 'X'])
const TICKET = /\b([A-Z][A-Z0-9]{1,11})-(\d{1,6})\b/g
const OTHER = [
  [/\bTC\d{3,}\b/g, 'test-case id'],
  [/https?:\/\/[\w.-]*atlassian\.net\S*|\/wiki\/spaces\/\S+|\bconfluence\.[\w.-]+/gi, 'Confluence / Atlassian link'],
  [/\b172\.16\.\d{1,3}\.\d{1,3}\b|\b[\w-]+\.alepo\.(?:local|lan|internal)\b/g, 'internal host'],
]

const TEST_PATH = /(^|[\\/])(tests?|__tests__|e2e|atdd|spec|specs|mocks?|fixtures?|test-data|playwright|cypress)([\\/]|$)|\.(spec|test|e2e|stories)\.[a-z]+$|Tests?\.java$|IT\.java$/i
const DOC_PATH = /\.(md|mdx|txt|adoc|rst)$|(^|[\\/])(docs?|kb|\.claude|\.agents?|\.github)([\\/]|$)|CLAUDE\.md$/i
const I18N_PATH = /(^|[\\/])(i18n|locales?|lang|translations?|messages?)([\\/]|$)|\.(arb)$|(Language|Error_Messages|messages|ValidationMessages)[\w-]*\.properties$/i
const SEED_PATH = /(^|[\\/])(seeds?|seed-data|customdata)([\\/]|$)|customdata[\w-]*\.json$/i
const LIQUIBASE_PATH = /(^|[\\/])(changelog|changelogs|liquibase|db[\\/]changelog)([\\/]|$)/i
const TEMPLATE_EXT = /\.(html|vue|svelte|ftl|vm|hbs|mustache|jsp|jspf)$/i
const FRONTEND_EXT = /\.(tsx?|jsx?|mjs)$/i
const FRONTEND_PATH = /(^|[\\/])(frontend|ui|web|client|console|portal|app|src[\\/]app|pages|components|widgets|views|screens)([\\/]|$)/i

/** Which part of the file a user can read: 'strings' | 'json' | 'properties' | 'liquibase' | 'template' | 'apidoc' | null. */
export function surface(path) {
  const p = String(path || '')
  if (!p || TEST_PATH.test(p) || DOC_PATH.test(p)) return null
  if (/\.java$/i.test(p)) return 'apidoc'
  if (/\.properties$/i.test(p)) return I18N_PATH.test(p) ? 'properties' : null
  if (/\.(xml|ya?ml)$/i.test(p) && LIQUIBASE_PATH.test(p)) return 'liquibase'
  if (/\.(json|arb)$/i.test(p)) return I18N_PATH.test(p) || SEED_PATH.test(p) ? 'json' : null
  if (TEMPLATE_EXT.test(p)) return 'template'
  if (FRONTEND_EXT.test(p) && FRONTEND_PATH.test(p)) return 'strings'
  return null
}

const stripCodeComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
const stringLiterals = (s) => [...s.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map(m => m[0])

/** Argument text of every API-doc annotation, with parentheses inside strings and nested annotations handled. */
function annotationArgs(s) {
  const out = []
  for (const m of s.matchAll(/@(Schema|Operation|ApiResponse|Parameter|Tag|ApiModelProperty|ApiOperation)\s*\(/g)) {
    let depth = 1, i = m.index + m[0].length, quote = null
    for (; i < s.length && depth; i++) {
      const c = s[i]
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null }
      else if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')') depth--
    }
    out.push(s.slice(m.index + m[0].length, i - 1))
  }
  return out
}

/** The user-readable text of `content` for a surface. */
export function readableText(kind, content) {
  const s = String(content || '')
  switch (kind) {
    case 'strings': return stringLiterals(stripCodeComments(s)).join('\n')
    case 'json': return stringLiterals(s).filter(v => !/^"[\w.$-]+"\s*$/.test(v) || /\s/.test(v)).join('\n')
    case 'properties': return s.split('\n').filter(l => !/^\s*[#!]/.test(l)).map(l => l.replace(/^[^=:]*[=:]/, '')).join('\n')
    case 'template': return s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\{\{!--[\s\S]*?--\}\}|<#--[\s\S]*?-->|#\*[\s\S]*?\*#/g, ' ')
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, js) => stringLiterals(stripCodeComments(js)).join(' '))
    case 'liquibase': return [...s.replace(/<!--[\s\S]*?-->/g, ' ')
      .matchAll(/name=["'][^"']*(desc|help|label|message|text|title|tooltip|caption)[^"']*["'][^>]*?\bvalue=["']([^"']*)["']/gi)].map(m => m[2]).join('\n')
    case 'apidoc': return annotationArgs(stripCodeComments(s)).map(a => stringLiterals(a).join(' ')).join('\n')
    default: return ''
  }
}

/** Internal references in a piece of readable text, as a count per token. */
export function findRefs(text) {
  const found = new Map()
  const add = (tok) => found.set(tok, (found.get(tok) || 0) + 1)
  for (const m of text.matchAll(TICKET)) if (!NOT_TICKETS.has(m[1])) add(m[0])
  for (const [rx] of OTHER) for (const m of text.matchAll(rx)) add(m[0])
  return found
}

/** References present in `after` more often than in `before` (only what this change adds). */
export function addedRefs(kind, before, after) {
  const was = findRefs(readableText(kind, before))
  return [...findRefs(readableText(kind, after))].filter(([tok, n]) => n > (was.get(tok) || 0)).map(([tok]) => tok)
}

export function denyReason(call) {
  const tool = call.tool_name
  const input = call.tool_input ?? {}
  const path = input.file_path ?? input.path ?? ''
  const kind = surface(path)
  if (!kind) return null
  let before = ''
  let after = ''
  if (tool === 'Write') {
    before = existsSync(path) ? readFileSync(path, 'utf8') : ''
    after = input.content ?? ''
  } else if (tool === 'Edit') {
    before = input.old_string ?? ''
    after = input.new_string ?? ''
  } else if (tool === 'MultiEdit') {
    before = (input.edits ?? []).map(e => e.old_string ?? '').join('\n')
    after = (input.edits ?? []).map(e => e.new_string ?? '').join('\n')
  } else return null
  const refs = addedRefs(kind, before, after)
  if (!refs.length) return null
  return `${path} is user-facing, and this change puts ${refs.slice(0, 5).map(r => `"${r}"`).join(', ')} into text a user can read. `
    + 'Product text is written for the operator or customer: what the screen, field or setting does and what to enter. Jira keys, task and test-case ids, '
    + 'people or team names, Confluence links, internal hosts and design rationale belong in a code comment, the commit message or the PR, never in a string. '
    + 'Rephrase the text without the reference (move it to a comment if it is useful for developers).'
}

function main() {
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { process.exit(0) }
  let call
  try { call = JSON.parse(raw) } catch { process.exit(0) }
  const reason = denyReason(call)
  if (reason) {
    console.error(`Blocked by the internal-references guard (T1): ${reason}`)
    process.exit(2)
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))
if (isMain) {
  try { main() } catch { process.exit(0) }
}
