/**
 * Split a Bash string into the commands it actually runs.
 *
 * Both guards used to match their pattern against the whole string and their
 * path against any token in it, then deny on the coincidence. Nothing tied the
 * two to the same command, so unrelated commands on one line convicted each
 * other:
 *
 *   git checkout -q -b feat/x origin/main
 *   git add engineering/scripts/test-secrets-guard.mjs
 *
 * denied as "git restore of a test path", because the rule's `[^|;&]*` matches
 * newlines and reached from the first command into the second. Same shape as
 *
 *   docker compose ... --env-file .env up -d 2>&1 | tail -6
 *
 * where `tail` reads compose's stdout and never touches the file it was
 * convicted for.
 *
 * Splitting is deliberately naive — separators, not a shell grammar. It does
 * not understand quoting, so a separator inside a quoted string splits too.
 * That direction is safe for these guards: an extra split can only produce
 * smaller segments, and a rule that needs its pattern and its path in the SAME
 * segment gets stricter, never looser, when a segment is cut short.
 */

/** Separators between commands: pipes, both boolean forms, sequencing, newlines. */
const SEPARATORS = /\|\||&&|[|;&\n]/

export function commandSegments(command) {
  if (!command) return []
  return String(command)
    .split(SEPARATORS)
    .map(s => s.trim())
    .filter(Boolean)
}

/** Tokens of one segment, quotes stripped, ready for a path test. */
export function segmentTokens(segment) {
  return String(segment).split(/[\s'"]+/).filter(Boolean)
}
