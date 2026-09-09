#!/usr/bin/env node
/**
 * PreToolUse hook — the secrets guard (S1).
 *
 * The provisioner prompt says "never copy a developer's .env". A prompt is a
 * request; this is the control. It denies the two ways a secret reaches a
 * transcript or an artifacts directory that lives outside ~/.claude and is
 * kept as evidence:
 *
 *   - Read of a dotenv-style file (.env, .env.local, .env.docker) or a
 *     credentials file. Example and template files stay readable: they hold
 *     placeholders by contract.
 *   - Bash commands that print, copy or encode such a file, dump the whole
 *     environment, or render a compose file with interpolation, which prints
 *     every variable the environment holds.
 *
 * Contract: tool call as JSON on stdin; exit 0 allows; exit 2 with a printed
 * reason denies. Internal errors allow — a broken hook must not wedge the estate.
 */
import { readFileSync } from 'node:fs'

const SECRET_FILE = /(^|[\\/])(\.env(\.[A-Za-z0-9_-]+)?|\.credentials(\.json)?|credentials\.json|\.netrc|\.npmrc|id_(rsa|ed25519|ecdsa))$/
const ALLOWED_SUFFIX = /\.(example|sample|template|dist)$/i

export function isSecretPath(p) {
  if (!p) return false
  const s = String(p).replace(/^['"]|['"]$/g, '')
  if (ALLOWED_SUFFIX.test(s)) return false
  return SECRET_FILE.test(s)
}

/** Commands that would put a secret file's contents on stdout or into another file. */
const READERS = /\b(cat|less|more|head|tail|bat|cp|scp|rsync|base64|xxd|od|strings|tee|sed|awk|grep|rg|source|\.)\b/

export function denyReason(call) {
  const tool = call.tool_name
  const input = call.tool_input ?? {}
  if (tool === 'Read') {
    const p = input.file_path ?? input.path ?? ''
    return isSecretPath(p) ? `Reading ${p} is denied: it is a secrets file. Compose can interpolate it via --project-directory without you seeing it; ask for specific values through the operator if a run truly needs them.` : null
  }
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    if (/(^|[;&|]\s*)(env|printenv|set)\s*($|[;&|>])/.test(cmd)) {
      return 'Dumping the whole environment is denied: it prints every secret the process holds into your output, which is kept as evidence.'
    }
    if (/\bcompose\b[^|;&]*\bconfig\b/.test(cmd) && !/--no-interpolate/.test(cmd)) {
      return 'docker compose config without --no-interpolate is denied: the interpolated form prints every secret the environment holds. Add --no-interpolate; the structure you need is still rendered.'
    }
    const tokens = cmd.split(/\s+/)
    // `--env-file <path>` hands the file to compose, which is the interpolation
    // this hook's own denial message tells you to use. Nothing is printed:
    // compose reads the file and substitutes into what it applies.
    //
    // Without this exemption the guard denied the invocation written in the
    // team's own compose headers - "--profile sso-stack --env-file .env up -d" -
    // because `.env` appears as a token and some reader-shaped word appears
    // anywhere else on the line, a trailing "| tail -6" being enough. Nothing
    // required the reader to actually take the secret file as its argument. A
    // control that denies the documented happy path gets worked around, and a
    // worked-around control protects nothing.
    //
    // Narrow on purpose: only on a compose invocation, and only the single
    // token after the flag. `cat --env-file .env` is not compose and stays
    // denied; so does a second, non-exempt `.env` later in the same line. The
    // interpolation rule above runs first and never consults this.
    const isCompose = /\b(docker|podman)\s+compose\b|\bdocker-compose\b/.test(cmd)
    const exempt = new Set()
    if (isCompose) {
      tokens.forEach((t, i) => { if (t === '--env-file' && tokens[i + 1]) exempt.add(i + 1) })
    }
    const offending = tokens.findIndex((t, i) => !exempt.has(i) && isSecretPath(t))
    if (READERS.test(cmd) && offending !== -1) {
      return `Printing or copying a secrets file is denied (${tokens[offending]}). Pass values through compose interpolation or shell environment, never through your output or a file you write.`
    }
  }
  return null
}

function main() {
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { process.exit(0) }
  let call
  try { call = JSON.parse(raw) } catch { process.exit(0) }
  const reason = denyReason(call)
  if (reason) {
    console.error(`Blocked by the secrets guard (S1): ${reason}`)
    process.exit(2)
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))
if (isMain) {
  try { main() } catch { process.exit(0) }
}
