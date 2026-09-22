/**
 * What this instance is configured to do, for the read-only Instance section
 * of the Settings page.
 *
 * Three jobs, and the third is the one that matters:
 *
 * 1. `pinned` names every environment variable that is currently overriding a
 *    field a person can edit on that page. Without it the Settings form lies:
 *    the run-budget inputs accepted a number, toasted "Settings saved", and
 *    then every run used the env var's value instead, with nothing anywhere
 *    saying which had won.
 * 2. `automations` reports the boot switches AS BOOTED. Every one of them is
 *    an early `return` in a server plugin, read once before any timer exists
 *    (see server/plugins/*.ts), so none of them can be a toggle - a control
 *    that saves cleanly and changes nothing until a restart is worse than no
 *    control, and the failure mode here is "nothing scheduled ever ran",
 *    which looks exactly like a quiet board.
 * 3. `secrets` reports NAMES AND PRESENCE ONLY, never a value. This module is
 *    served to the browser; a secret that reaches it is a secret in a page, a
 *    devtools log and a screenshot.
 *
 * Lives in utils/ rather than behind the route so a plain-node test can import
 * it without Nitro - the same reason watchRunStarter.ts does.
 */
import { getClaudeDir } from './claudeDir.ts'
import { workspaceRoot } from './workspace.ts'
import { agentRunsRoot } from './runArtifacts.ts'
import { usersDir } from './users.ts'
import { DEFAULT_CI_POLL_SECONDS } from './ciPoller.ts'

/** Environment variables that override a field editable on the Settings page. */
export const PINNABLE_VARS = [
  'AGENT_RUN_MAX_TOKENS',
  'AGENT_RUN_MAX_MINUTES',
  'JIRA_POST_ENABLED',
  'JIRA_BASE_URL',
  'JIRA_DEFAULT_PROJECT',
  'JIRA_COMMENT_FOR_VIS_NAME',
] as const

/**
 * Secrets, by name. Presence is reported; the value never leaves the server.
 * Adding one here is how it becomes visible as "set" without becoming visible.
 */
const SECRET_VARS = [
  'AGENT_MANAGER_SECRET',
  'GITHUB_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'AGENT_MANAGER_API_TOKEN',
  'JIRA_API_TOKEN',
  'SLACK_WEBHOOK_URL',
  'AGENT_GH_TOKEN',
] as const

export interface InstanceInfo {
  /** Env var name -> its value, for the vars currently overriding a saved setting. */
  pinned: Record<string, string>
  automations: { name: string, envVar: string, enabled: boolean, detail?: string }[]
  paths: { claudeDir: string, agentRunsDir: string, workspaceRoot: string, usersDir: string }
  secrets: { name: string, set: boolean }[]
  identity: { authDisabled: boolean, githubOrg: string | null, managerUrl: string | null, clientIdSet: boolean }
}

/** An env var counts as set only when it is non-empty once trimmed: `.env.sample`
 *  ships these as bare `NAME=` lines, and dotenv turns those into `''`. Treating
 *  present-but-empty as set would pin every field for everyone who copied it. */
export function envValue(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  return raw ? raw : undefined
}

export function instanceInfo(): InstanceInfo {
  const pinned: Record<string, string> = {}
  for (const name of PINNABLE_VARS) {
    const value = envValue(name)
    if (value !== undefined) pinned[name] = value
  }

  const pollSeconds = Number(envValue('CI_POLL_SECONDS')) || DEFAULT_CI_POLL_SECONDS
  const ciPoller = envValue('CI_POLLER_DISABLED') !== '1'

  return {
    pinned,
    automations: [
      { name: 'Ticket watches', envVar: 'WATCHER_DISABLED', enabled: envValue('WATCHER_DISABLED') !== '1' },
      { name: 'Schedules', envVar: 'SCHEDULER_DISABLED', enabled: envValue('SCHEDULER_DISABLED') !== '1' },
      { name: 'Run queue', envVar: 'RUN_QUEUE_DISABLED', enabled: envValue('RUN_QUEUE_DISABLED') !== '1' },
      { name: 'CI check poller', envVar: 'CI_POLLER_DISABLED', enabled: ciPoller, detail: ciPoller ? `every ${pollSeconds}s (CI_POLL_SECONDS)` : undefined },
      { name: 'Resume interrupted runs at boot', envVar: 'RESUME_ON_BOOT', enabled: envValue('RESUME_ON_BOOT') !== '0' },
      { name: 'Apply team standards at boot', envVar: 'TEAM_SEED_ON_BOOT', enabled: envValue('TEAM_SEED_ON_BOOT') !== '0' },
    ],
    paths: {
      claudeDir: getClaudeDir(),
      agentRunsDir: agentRunsRoot(),
      workspaceRoot: workspaceRoot(),
      usersDir: usersDir(),
    },
    secrets: SECRET_VARS.map(name => ({ name, set: envValue(name) !== undefined })),
    identity: {
      authDisabled: process.env.AUTH_DISABLED === '1',
      githubOrg: envValue('GITHUB_ORG') ?? null,
      managerUrl: envValue('AGENT_MANAGER_URL') ?? null,
      clientIdSet: envValue('GITHUB_CLIENT_ID') !== undefined,
    },
  }
}
