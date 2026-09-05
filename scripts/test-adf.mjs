/**
 * Self-check for server/utils/adf.ts — the minimal ADF <-> plain text
 * conversion the Jira ticket source (decode) and notifier (encode) both
 * depend on.
 *
 *   node scripts/test-adf.mjs
 */
import assert from 'node:assert/strict'

const { adfToPlainText, plainTextToAdf } = await import('../server/utils/adf.ts')

// ── 1. A real Jira description doc flattens to readable plain text ─────────
{
  const doc = {
    type: 'doc', version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Users see a blank page after login.' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'Steps:' }, { type: 'hardBreak' },
        { type: 'text', text: '1. Log in' }, { type: 'hardBreak' },
        { type: 'text', text: '2. Observe blank page' },
      ] },
    ],
  }
  const text = adfToPlainText(doc)
  assert.match(text, /Users see a blank page after login\./)
  assert.match(text, /Steps:\n1\. Log in\n2\. Observe blank page/)
}

// ── 2. null / undefined / plain string never throw ──────────────────────────
assert.equal(adfToPlainText(null), '')
assert.equal(adfToPlainText(undefined), '')
assert.equal(adfToPlainText('already plain text'), 'already plain text')
assert.equal(adfToPlainText(42), '', 'a field shape this module does not model degrades to empty, not a crash')
assert.equal(adfToPlainText({ type: 'doc', content: [] }), '')

// ── 3. A rich node type it doesn't specifically model (e.g. a mention) is
//      skipped rather than crashing — no `text` field to extract ─────────
{
  const doc = {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Assigned to ' },
      { type: 'mention', attrs: { text: '@bob' } },
      { type: 'text', text: '.' },
    ] }],
  }
  assert.equal(adfToPlainText(doc), 'Assigned to .')
}

// ── 4. plainTextToAdf produces a valid-shaped doc a comment-create call needs
{
  const doc = plainTextToAdf('Line one\nLine two\n\nSecond paragraph')
  assert.equal(doc.type, 'doc')
  assert.equal(doc.version, 1)
  assert.equal(doc.content.length, 2, 'a blank line starts a new paragraph')
  assert.equal(doc.content[0].type, 'paragraph')
  const texts = doc.content[0].content.filter(n => n.type === 'text').map(n => n.text)
  assert.deepEqual(texts, ['Line one', 'Line two'])
  assert.ok(doc.content[0].content.some(n => n.type === 'hardBreak'), 'a single newline is a hardBreak, not a new paragraph')
}

// ── 5. Round trip: encode then decode recovers the same lines ──────────────
{
  const original = 'Pipeline run finished.\n\nA pull request is ready for review:\nhttps://example.com/pr/1'
  const roundTripped = adfToPlainText(plainTextToAdf(original))
  assert.equal(roundTripped, original)
}

// ── 6. Every paragraph is non-empty — ADF forbids empty content arrays ─────
{
  const doc = plainTextToAdf('')
  for (const para of doc.content) assert.ok(para.content.length > 0, 'a blank block still yields a valid paragraph node')
}

console.log('adf: all assertions passed')
