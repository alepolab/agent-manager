// Against a running instance: a stale save is refused with 409 and malformed
// settings with 400. Neither request writes anything, so it is safe on a
// shared instance. AGENT_MANAGER_URL selects the instance (default local).
import assert from 'node:assert/strict'

const base = (process.env.AGENT_MANAGER_URL || 'http://localhost:3030').replace(/\/$/, '')
const json = async (path, init) => {
  const res = await fetch(base + path, { headers: { 'content-type': 'application/json' }, ...init })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const commands = (await json('/api/commands')).body
assert.ok(Array.isArray(commands) && commands.length, 'instance has at least one command')
const one = (await json(`/api/commands/${commands[0].slug}`)).body
assert.equal(typeof one.lastModified, 'number', 'command read carries lastModified')

const stale = await json(`/api/commands/${commands[0].slug}`, {
  method: 'PUT',
  body: JSON.stringify({ frontmatter: one.frontmatter, body: one.body, lastModified: one.lastModified - 60_000 }),
})
assert.equal(stale.status, 409, `stale save refused (got ${stale.status})`)
assert.equal(typeof stale.body?.data?.lastModified, 'number', '409 carries the current lastModified')

const bad = await json('/api/settings', { method: 'PUT', body: JSON.stringify({ hooks: 'not-an-object' }) })
assert.equal(bad.status, 400, `malformed settings refused (got ${bad.status})`)

console.log(`ok: 409 on stale save of ${commands[0].slug}, 400 on malformed settings (${base})`)
