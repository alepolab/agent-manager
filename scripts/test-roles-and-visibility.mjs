#!/usr/bin/env node
/**
 * The roles system was built on the server and unreachable from the app.
 *
 * `/api/roles` was complete — GET readable by anyone signed in, PUT guarded by
 * `configure`, self-demotion already refused — and had ZERO callers in app/.
 * The only way to give a colleague a role was to hand-edit
 * ~/.claude/roles.json on the box, so `DEFAULT_ROLE` (operator) was the role
 * everybody actually held and the whole persona model was invisible.
 *
 * The other half of the same problem: 90 server routes called
 * `requireCapability` and six front-end files called `can()`. Every editor page
 * rendered identically for every role, so a developer was offered Agents in the
 * sidebar, given a full editor, and handed a 403 on save.
 *
 * These are source assertions, in the style of test-routes-are-guarded.mjs: the
 * route handlers use Nitro auto-imports and cannot be imported by plain node.
 *
 *   node scripts/test-roles-and-visibility.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

// ---- the roster has a data source and a caller ----

const rolesGet = read('server/api/roles.get.ts')
check('GET /api/roles returns the people, not only the assignments',
  /profiles/.test(rolesGet) && /listProfiles/.test(rolesGet),
  'the roster page needs everyone who has signed in, not just the logins already in roles.json')
check('GET /api/roles stays readable by anyone signed in',
  /requireUser/.test(rolesGet) && !/requireCapability/.test(rolesGet),
  'knowing who answers the verification gate is how a team works; it is not privileged')

const rolesPut = read('server/api/roles.put.ts')
check('PUT /api/roles still demands configure',
  /requireCapability\(event, 'configure'\)/.test(rolesPut),
  'reading the roster is open; writing it is not')

const users = read('server/utils/users.ts')
check('listProfiles never throws on a missing directory',
  /if \(!existsSync\(dir\)\) return \[\]/.test(users),
  'same contract as listRoles: a broken roster that hides who holds what is worse than a short one')

const rolesPage = read('app/pages/roles.vue')
check('the roles page exists and calls the endpoint',
  /\/api\/roles/.test(rolesPage),
  'the endpoints had no caller at all before this')
check('someone with no entry is shown as an acting operator',
  /acting as operator/.test(rolesPage),
  'finding A2: unlisted is not "absent", it is the most powerful role, and it has to say so')
check('assigning a role is gated client-side too',
  /can\('configure'\)/.test(rolesPage),
  'the server refuses it anyway; the UI should not offer it first')

// ---- the sidebar tells the truth about what it offers ----

const app = read('app/app.vue')
const navByRole = app.match(/const NAV_BY_ROLE[^}]+}/s)?.[0] ?? ''
check('a manager is offered the Dashboard, which carries the board',
  /manager: \['\/'/.test(navByRole) && !/\/board/.test(navByRole),
  'the board is the top of the Dashboard now; /board only redirects there')
const index = read('app/pages/index.vue')
check('the dashboard shows a manager the board and none of the verbs',
  /<PipelineBoard/.test(index) && /v-if="!boardOnly"/.test(index) && !/navigateTo\('\/board'\)/.test(index),
  'a manager holds no gate and starts no run, so the queue under the board is not theirs')

check('Settings is offered to every role',
  !/l\.to !== '\/settings' \|\| can\('configure'\)/.test(app),
  'its reads were always open; the values on it are what a developer or manager came for')

check('the view-as control survives a collapsed sidebar',
  !/realRole === 'operator' && !sidebarCollapsed/.test(app),
  'it was the only way to check what a developer sees, and it vanished under 768px')

check('the impersonation banner is app-level',
  /viewingAs/.test(app),
  'an operator who forgets they are impersonating reads a missing control as a broken one')

check('labs is a per-developer preference',
  /me\.value\?\.profile\?\.labs/.test(app),
  'an instance-wide switch on an operator-only page meant nobody else could find out the pages existed')

// ---- editor pages no longer offer work the API will refuse ----

const GATED = [
  ['app/pages/agents/[slug].vue', 'changing an agent'],
  ['app/pages/skills/[slug].vue', 'changing a skill'],
  ['app/pages/commands/[slug].vue', 'changing a command'],
  ['app/pages/mcp/[name].vue', 'changing an MCP server'],
  ['app/pages/registry/[key].vue', 'editing a product'],
  ['app/pages/watches.vue', 'managing watches'],
  ['app/pages/schedules.vue', 'managing schedules'],
  ['app/pages/team.vue', 'applying team standards'],
]
for (const [path, reason] of GATED) {
  const src = read(path)
  check(`${path} gates its mutating controls`,
    /can\('configure'\)/.test(src) && src.includes(reason),
    'it rendered a full editor for every role and 403d on save')
  check(`${path} does not redirect on a missing capability`,
    !/navigateTo\([^)]*\)[^\n]*can\(/.test(src),
    'a page reached by a colleague\'s link should explain itself, not bounce')
}

// ---- a draft that can never be saved is not armed ----

for (const path of ['app/pages/agents/[slug].vue', 'app/pages/skills/[slug].vue', 'app/pages/commands/[slug].vue']) {
  const src = read(path)
  check(`${path} only arms draft recovery when it could be saved`,
    /isDirty\.value && can\('configure'\)\) scheduleSave/.test(src),
    'otherwise the unsaveable edit is persisted and offered back forever')
  check(`${path} uses the shared draft banner`,
    /<DraftRecoveryBanner/.test(src),
    'the same 14 lines were copy-pasted into three files')
}

// ---- the settings split ----

let settingsMonolith = true
try { read('app/pages/settings.vue'); } catch { settingsMonolith = false }
check('the old 1,130-line settings page is gone',
  !settingsMonolith,
  'if it coexists with app/pages/settings/, Nuxt treats it as an outlet-less parent and the children never render')

for (const r of ['pipeline', 'claude-code', 'integrations', 'instance']) {
  const src = read(`app/pages/settings/${r}.vue`)
  check(`settings/${r} carries the shared sub-nav`, /<SettingsNav/.test(src), 'each route is reachable from the others')
}

const pipeline = read('app/pages/settings/pipeline.vue')
check('a viewer without configure still sees the values',
  /v-else/.test(pipeline) && /agentModelLabel/.test(pipeline),
  'on a settings page the values are the content; hiding them leaves a page that answers nothing')
check('an env-pinned field reads as pinned, not as broken',
  /Pinned by AGENT_RUN_MAX_TOKENS/.test(pipeline) && /badge-warning/.test(pipeline),
  'a greyed input with fine print looks exactly like a failure')

console.log(failures ? `\nroles + visibility: ${failures} failure(s)` : '\nroles + visibility: all assertions passed')
process.exit(failures ? 1 : 0)
