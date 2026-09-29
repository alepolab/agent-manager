/**
 * A Jira step passes on what it was given; it does not replace it with its one
 * status line.
 *
 * Runbook A's intake follows "Jira: In Progress", and for every run its whole
 * input was 'Moved ASECRM-223 to "In Progress"' - the ticket never reached it.
 * ASECRM-223's intake asked a person what the ticket was about. The verifier,
 * which follows "Jira: QA In Progress", likewise received a status line in
 * place of the fix's report.
 *
 *   node scripts/test-jira-step-passes-input-on.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'passon-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'passon-artifacts-'))
delete process.env.JIRA_POST_ENABLED

const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TICKET = 'ASECRM-999: NotificationConfigService silently swallows config errors\n\n**What was found** getInt() swallows NumberFormatException.'
const inputs = {}
runner.setAgentCaller(async (slug, input) => {
  inputs[slug] = input
  return slug === 'agent-fix' ? 'FIX REPORT: getInt now logs and rethrows; 3 tests added.' : `out ${slug}`
})

const workflow = {
  slug: 'passon', name: 'Pass on',
  steps: [
    { id: 'j1', agentSlug: 'sdlc-jira-tracker', label: 'Jira: In Progress', next: ['intake'], jira: { transition: 'In Progress' } },
    { id: 'intake', agentSlug: 'agent-intake', label: 'Ticket Intake', next: ['fix'] },
    { id: 'fix', agentSlug: 'agent-fix', label: 'Implement Fix', next: ['j2'] },
    { id: 'j2', agentSlug: 'sdlc-jira-tracker', label: 'Jira: Dev Done', next: ['j3'], jira: { transition: 'Dev Done' } },
    { id: 'j3', agentSlug: 'sdlc-jira-tracker', label: 'Jira: QA In Progress', next: ['verify'], jira: { transition: 'QA In Progress' } },
    { id: 'verify', agentSlug: 'agent-verify', label: 'Verify', next: [] },
  ],
}

const started = await runner.startRun({ workflow, initialPrompt: TICKET, watch: 'direct-invocation', autoRun: true, ticketKey: 'ASECRM-999' })
const run = await runner.waitForSettled(started.id, 8000)
assert.equal(run.status, 'completed', run.error)

assert.ok(inputs['agent-intake'].includes('**What was found** getInt() swallows NumberFormatException.'),
  `intake receives the ticket, not only the Jira line:\n${inputs['agent-intake'].slice(-400)}`)
assert.match(inputs['agent-intake'], /In Progress/, 'and the Jira step\'s own line after it')

assert.ok(inputs['agent-verify'].includes('FIX REPORT: getInt now logs and rethrows'),
  `the verifier receives the fix's report through two Jira steps:\n${inputs['agent-verify'].slice(-400)}`)
assert.match(inputs['agent-verify'], /Dev Done[\s\S]*QA In Progress/, 'with both status lines, in order')

console.log('ok - Jira steps pass on what they were given')
