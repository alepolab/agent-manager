/**
 * SDK Proof-of-concept: verify @anthropic-ai/claude-agent-sdk works,
 * streams responses, and uses the user's existing Claude auth.
 *
 * Run: node scripts/test-sdk.mjs
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

// This makes a REAL API call, so it needs the ambient Claude credentials a
// developer machine has and a CI runner does not. Skip rather than fail there:
// a suite that is red for a reason unrelated to the code teaches everyone to
// ignore it, and then a genuine failure hides in the noise.
//
// Exit 0 with a clear notice — "cannot run here" is not "the code is broken".
const hasCredentials = !!process.env.ANTHROPIC_API_KEY
  || existsSync(join(homedir(), '.claude', '.credentials.json'))
  || existsSync(join(homedir(), '.claude', '.credentials'))
if (!hasCredentials) {
  console.log('SKIP scripts/test-sdk.mjs — no ambient Claude credentials (expected on CI).')
  console.log('     This probe makes a real API call; run it on a machine that is signed in.')
  process.exit(0)
}

async function main() {
  console.log('Starting Claude Agent SDK test...\n')

  let sessionId = null

  for await (const message of query({
    prompt: 'Say "Hello from the Agent SDK!" and nothing else.',
    options: {
      maxTurns: 1,
      allowedTools: [],
    },
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id
      console.log(`Session ID: ${sessionId}`)
    }

    if ('result' in message) {
      console.log(`\nResult: ${message.result}`)
      console.log(`Stop reason: ${message.stop_reason}`)
    }
  }

  console.log('\nSDK test complete!')
}

main().catch((err) => {
  console.error('SDK test failed:', err.message)
  process.exit(1)
})
