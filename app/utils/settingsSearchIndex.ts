/**
 * Where each piece of configuration actually lives.
 *
 * Settings is not one page and never was: the pipeline's budget, a watch's
 * channel, a product's recipe and your own Jira token are four different
 * stores behind four different routes, and nothing told you which. A static
 * list is the honest answer - these entries change when someone moves a
 * setting, which is exactly when a hand-written line should be updated too.
 *
 * Route-level, deliberately. Landing on the right page puts the control within
 * one scroll; an anchor-and-highlight scheme would need an id convention this
 * app does not have.
 */
export interface SettingsSearchEntry {
  label: string
  sublabel: string
  to: string
  /** Extra words that should match but do not belong in the visible label. */
  keywords?: string
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  { label: 'Model for pipeline agents', sublabel: 'Which model every pipeline agent runs on', to: '/settings/pipeline', keywords: 'opus sonnet haiku fable' },
  { label: 'Run budget', sublabel: 'Token and minute caps for each new run', to: '/settings/pipeline', keywords: 'tokens minutes cost limit cap' },
  { label: 'Always Thinking', sublabel: 'Extended reasoning before responding', to: '/settings/pipeline' },
  { label: 'Task picker window', sublabel: 'How far back /tasks-picker-infra looks', to: '/settings/pipeline', keywords: 'devops lookback seconds' },
  { label: 'Jira host and project', sublabel: 'The site every Jira call goes to, and the default project key', to: '/settings/pipeline', keywords: 'atlassian baseurl ticket' },
  { label: 'Post outcomes to Jira', sublabel: 'Whether a run comments on its ticket', to: '/settings/pipeline' },
  { label: 'Status line', sublabel: "Custom status line in Claude Code's interface", to: '/settings/claude-code' },
  { label: 'Extensions', sublabel: 'Enable or disable installed plugins', to: '/settings/claude-code', keywords: 'plugins' },
  { label: 'Automations (hooks)', sublabel: 'Run a command on a Claude Code event', to: '/settings/claude-code', keywords: 'hooks pretooluse posttooluse' },
  { label: 'settings.json', sublabel: 'The raw file, edited directly', to: '/settings/claude-code', keywords: 'raw json' },
  { label: 'Notification channels', sublabel: 'Teams, Slack and email destinations', to: '/settings/integrations', keywords: 'webhook notify' },
  { label: 'SMTP relay', sublabel: 'The relay every email channel sends through', to: '/settings/integrations', keywords: 'mail email smtp' },
  { label: 'GitHub imports', sublabel: 'Repositories skills and agents were imported from', to: '/settings/integrations' },
  { label: 'Instance report', sublabel: 'Automations, paths, credentials and pinned env vars', to: '/settings/instance', keywords: 'env environment secrets paths' },
  // Configuration that has never lived on the settings page at all - the other
  // half of "which page owns this knob".
  { label: 'Your Jira credentials', sublabel: 'Your own email and API token', to: '/profile', keywords: 'token password mine personal' },
  { label: 'Labs pages', sublabel: 'Show Graph, Explore and Output styles in your sidebar', to: '/profile', keywords: 'experimental hidden' },
  { label: 'Roles', sublabel: 'Who holds which role on this instance', to: '/roles', keywords: 'permissions operator developer qa manager access' },
  { label: 'Watches', sublabel: 'The Jira queues that feed the pipeline', to: '/watches', keywords: 'polling jql queue' },
  { label: 'Schedules', sublabel: 'Cron schedules that fire workflows', to: '/schedules', keywords: 'cron timer' },
  { label: 'Products and recipes', sublabel: 'The registry a ticket resolves against', to: '/registry', keywords: 'registry repo stack recipe' },
  { label: 'Team standards', sublabel: 'Drift against the alepo-engineering plugin', to: '/team', keywords: 'sync plugin drift' },
]
