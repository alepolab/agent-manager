// Automation reaches the API with a bearer token configured on the instance,
// as a named developer; anything else still needs the signed-in session.
import assert from 'node:assert/strict'

process.env.AUTH_DISABLED = '0'
process.env.AGENT_MANAGER_SECRET = 'test-secret-long-enough-for-the-store-0000'
process.env.AGENT_MANAGER_API_TOKEN = 'api-token-that-is-at-least-thirty-two-chars'
process.env.AGENT_MANAGER_API_LOGIN = 'sandeep'

const { currentUser } = await import('../server/utils/session.ts')
const event = (authorization) => ({ node: { req: { headers: authorization ? { authorization } : {} }, res: {} }, context: {} })

const ok = await currentUser(event('Bearer api-token-that-is-at-least-thirty-two-chars'))
assert.deepEqual(ok, { login: 'sandeep', name: 'API token' }, 'the configured token acts as the configured developer')

assert.equal(await currentUser(event('Bearer wrong-token-of-the-same-length-as-the-r')), null, 'a wrong token is a stranger')
assert.equal(await currentUser(event('Bearer short')), null)
assert.equal(await currentUser(event(undefined)), null, 'no header, no cookie: signed out')

process.env.AGENT_MANAGER_API_TOKEN = 'short'
assert.equal(await currentUser(event('Bearer short')), null, 'a token under 32 characters is never honoured')

console.log('api token: all checks passed')
