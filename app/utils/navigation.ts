/**
 * Where every page lives: the sidebar, and the sibling pages each sidebar item
 * switches between.
 *
 * The sidebar offered twenty destinations in five bands. It now offers nine,
 * and nothing was deleted: a page is either a sidebar item, a tab inside one
 * (Schedules sits beside Watches, MCP beside Plugins), or a Settings tab —
 * Products, Team and Roles are configuration people rarely change, which is
 * what Settings is for. `PageHeader` renders a section's tabs on every page in
 * it, so a page never has to know which section it belongs to.
 */

export interface NavTab {
  label: string
  to: string
  /** Shown only to people with the Labs flag on their profile. */
  labs?: boolean
}

export interface NavItem {
  label: string
  icon: string
  to: string
  /** Sibling pages this item switches between. The item is active on any of them. */
  tabs?: NavTab[]
}

export const NAV_PRIMARY: NavItem[] = [
  { label: 'Home', icon: 'i-lucide-house', to: '/' },
  { label: 'Notifications', icon: 'i-lucide-inbox', to: '/notifications' },
  { label: 'Runs', icon: 'i-lucide-circle-play', to: '/runs', tabs: [
    { label: 'Runs', to: '/runs' },
    { label: 'Artifacts', to: '/project-artifacts' },
  ] },
  { label: 'Triggers', icon: 'i-lucide-radio', to: '/watches', tabs: [
    { label: 'Watches', to: '/watches' },
    { label: 'Schedules', to: '/schedules' },
  ] },
]

export const NAV_LIBRARY: NavItem[] = [
  { label: 'Agents', icon: 'i-lucide-cpu', to: '/agents' },
  { label: 'Workflows', icon: 'i-lucide-git-branch', to: '/workflows', tabs: [
    { label: 'Workflows', to: '/workflows' },
    { label: 'Graph', to: '/graph', labs: true },
  ] },
  { label: 'Skills', icon: 'i-lucide-sparkles', to: '/skills' },
  { label: 'Commands', icon: 'i-lucide-square-slash', to: '/commands' },
  { label: 'Extensions', icon: 'i-lucide-puzzle', to: '/plugins', tabs: [
    { label: 'Plugins', to: '/plugins' },
    { label: 'MCP Servers', to: '/mcp' },
    { label: 'Explore', to: '/explore', labs: true },
  ] },
]

/** Settings has no sidebar item: it opens from the account menu, the gear, or ⌘,. */
export const SETTINGS_TABS: NavTab[] = [
  { label: 'Pipeline', to: '/settings/pipeline' },
  { label: 'Claude Code', to: '/settings/claude-code' },
  { label: 'Integrations', to: '/settings/integrations' },
  { label: 'Instance', to: '/settings/instance' },
  { label: 'Products', to: '/registry' },
  { label: 'Team', to: '/team' },
  { label: 'Roles', to: '/roles' },
  { label: 'Output Styles', to: '/output-styles', labs: true },
]

/**
 * What each role has any business opening. Everything absent here is still
 * reachable by URL for an operator and refused by the API for everyone else —
 * this list decides what a person is OFFERED.
 */
export const NAV_BY_ROLE: Record<string, string[]> = {
  developer: ['/', '/notifications', '/runs', '/agents', '/skills', '/commands'],
  qa: ['/', '/notifications', '/runs'],
  manager: ['/', '/runs'],
}

/** `/runs/abc` is inside `/runs`; `/` only matches itself. */
export function routeIn(path: string, to: string) {
  if (to === '/') return path === '/'
  return path === to || path.startsWith(to + '/')
}

/** The tab strip for the page at `path`, or null when it has no siblings. */
export function tabsFor(path: string): NavTab[] | null {
  if (SETTINGS_TABS.some(t => routeIn(path, t.to))) return SETTINGS_TABS
  const item = [...NAV_PRIMARY, ...NAV_LIBRARY].find(i => i.tabs?.some(t => routeIn(path, t.to)))
  return item?.tabs ?? null
}

/** Whether a sidebar item should read as selected for the page at `path`. */
export function itemActive(item: NavItem, path: string) {
  return item.tabs ? item.tabs.some(t => routeIn(path, t.to)) : routeIn(path, item.to)
}
