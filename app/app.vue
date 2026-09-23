<script setup lang="ts">
const route = useRoute()
const { claudeDir, exists: claudeDirExists, load: loadConfig } = useClaudeDir()
const { fetchAll: fetchAgents, agents } = useAgents()
const { fetchAll: fetchCommands, commands } = useCommands()
const { fetchAll: fetchPlugins, plugins } = usePlugins()
const { fetchAll: fetchSkills, skills } = useSkills()
const { fetchAll: fetchWorkflows, workflows } = useWorkflows()
const { fetchServers, servers: mcpServers } = useMCP()
const { styles, fetchStyles } = useOutputStyles()

const initialized = ref(false)
// Signed-out visitors see only the login page: no sidebar, no list fetches that would 401.
const isLogin = computed(() => route.path === '/login')
const showSearch = ref(false)
const sidebarCollapsed = useState('sidebar-collapsed', () => false)
/**
 * The sidebar was 200px wide at every width, and its collapse control was
 * `hidden md:flex` — so on a phone it took half the screen with no way to
 * dismiss it. The app ships exactly one @media rule in 1,400 lines of CSS
 * (prefers-reduced-motion), which is the whole story of its responsive design.
 *
 * This nudges the default closed when the viewport goes narrow and then leaves
 * the person in control. Forcing it instead would make the toggle inert on a
 * phone — a control that is visible and does nothing, which is worse than the
 * hidden one it replaced.
 */
onMounted(() => {
  const mq = window.matchMedia('(max-width: 767px)')
  const sync = () => { if (mq.matches) sidebarCollapsed.value = true }
  sync()
  mq.addEventListener('change', sync)
  onUnmounted(() => mq.removeEventListener('change', sync))
})
const { isPanelOpen: chatOpen } = useChat()
const colorMode = useColorMode()

/** Switching to your own role clears the impersonation rather than setting one. */
const switchingRole = ref(false)
async function switchRole(next: string) {
  if (role.value === next) return
  switchingRole.value = true
  try { await viewAs(next === 'operator' ? null : next as any) } finally { switchingRole.value = false }
}

function toggleTheme() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

// Cmd+J to toggle chat
if (import.meta.client) {
  const chatHandler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
      // The same `configure` gate as the button and the panel. Gating only the
      // two visible affordances would leave the shortcut as an undocumented way
      // in — the panel would not render, so the key would silently do nothing,
      // which is a worse answer than the key not being ours to press.
      if (!can('configure')) return
      e.preventDefault()
      chatOpen.value = !chatOpen.value
    }
  }
  onMounted(() => document.addEventListener('keydown', chatHandler))
  onUnmounted(() => document.removeEventListener('keydown', chatHandler))
}

onMounted(async () => {
  await loadConfig()
  // Render first, fill later: every list page owns its own loading state, and
  // waiting for all six lists here made each route show a blank spinner until
  // the slowest of them (skills, several MB) had arrived.
  initialized.value = true
  if (isLogin.value) return
  if (!settings.value) void loadSettings()
  void Promise.all([fetchAgents(), fetchCommands(), fetchPlugins(), fetchSkills(), fetchWorkflows(), fetchServers(), fetchRunsAwaiting()])
})

// The shared lists live here, so pages that only read them don't refetch them too.
// Skills are several MB: refreshed on focus here, and polled only while /skills is open.
const canRefresh = () => initialized.value && claudeDirExists.value && !isLogin.value
useAutoRefresh(() => canRefresh() && Promise.all([
  fetchAgents({}, { silent: true }), fetchCommands({}, { silent: true }), fetchPlugins({ silent: true }),
  fetchWorkflows({}, { silent: true }), fetchServers({ silent: true }), fetchRunsAwaiting(),
]))
useAutoRefresh(() => canRefresh() && fetchSkills({}, { silent: true }), { interval: 0 })

const { settings, load: loadSettings } = useSettings()
const { count: runsAwaiting, fetchAll: fetchRunsAwaiting } = useRunsAwaiting()
const { me, signOut, can, role, viewingAs, viewAs } = useUser()
// Unfinished pages stay reachable by URL but leave the sidebar unless labs is on.
// Per-developer, set on /profile: wanting to look at Graph or Explore is a
// preference, and the instance-wide switch it replaced lived on a page three
// of the four roles could not open, so nobody else could even find out it existed.
const labs = computed(() => me.value?.profile?.labs === true)
/**
 * Three jobs, not one list of fourteen. Operating the pipeline and authoring
 * the things it runs are different work at different frequencies, and they were
 * interleaved: Runs, Board, Watches, Products and Schedules sat between
 * Workflows and Commands. Grouping also makes a narrowed sidebar read as
 * designed rather than truncated - a role drops whole groups instead of
 * leaving gaps in a flat list.
 */
const NAV_GROUPS: { key: string, label: string, links: { label: string, icon: string, to: string }[] }[] = [
  { key: 'operate', label: 'Operate', links: [
    { label: 'Dashboard', icon: 'i-lucide-layout-dashboard', to: '/' },
    { label: 'Runs', icon: 'i-lucide-play-circle', to: '/runs' },
    { label: 'Board', icon: 'i-lucide-gauge', to: '/board' },
    { label: 'Watches', icon: 'i-lucide-radio', to: '/watches' },
    { label: 'Schedules', icon: 'i-lucide-calendar-clock', to: '/schedules' },
  ] },
  { key: 'build', label: 'Build', links: [
    { label: 'Agents', icon: 'i-lucide-cpu', to: '/agents' },
    { label: 'Workflows', icon: 'i-lucide-git-branch', to: '/workflows' },
    { label: 'Commands', icon: 'i-lucide-terminal', to: '/commands' },
    { label: 'Skills', icon: 'i-lucide-sparkles', to: '/skills' },
    { label: 'Plugins', icon: 'i-lucide-puzzle', to: '/plugins' },
    { label: 'MCP Servers', icon: 'i-lucide-server', to: '/mcp' },
  ] },
  { key: 'instance', label: 'Instance', links: [
    { label: 'Products', icon: 'i-lucide-boxes', to: '/registry' },
    { label: 'Team', icon: 'i-lucide-users', to: '/team' },
    { label: 'Roles', icon: 'i-lucide-shield', to: '/roles' },
    { label: 'Output Styles', icon: 'i-lucide-palette', to: '/output-styles' },
  ] },
]

/**
 * What each role has any business opening. Everything absent here is still
 * reachable by URL for an operator and refused by the API for everyone else —
 * this list decides what a person is OFFERED, which is the actual complaint
 * about the old sidebar: it showed a reviewer the whole engine.
 */
const NAV_BY_ROLE: Record<string, string[]> = {
  developer: ['/', '/runs', '/agents', '/skills', '/commands'],
  qa: ['/', '/runs'],
  // A manager's screen is the board, not the run list with its buttons removed.
  // '/' is absent on purpose: index.vue sends a manager straight to /board, so
  // offering Dashboard here was advertising a page that refuses to be looked at.
  manager: ['/board', '/runs'],
}

const navTop = computed(() => {
  const allowed = role.value ? NAV_BY_ROLE[role.value] : undefined
  return NAV_GROUPS
    .map(g => ({ ...g, links: g.links
      .filter(l => labs.value || l.to !== '/output-styles')
      // No role entry means operator: the full sidebar, exactly as before.
      .filter(l => !allowed || allowed.includes(l.to)) }))
    // A labelled group with nothing under it is worse than no group.
    .filter(g => g.links.length > 0)
})

/** Reload everything the sidebar counts after onboarding finishes.
 *  Written as a named handler rather than inline: a template expression
 *  resolves bare identifiers against the component instance, so `Promise.all`
 *  was being looked up as a property of the component (it is not one) rather
 *  than the global. */
async function onOnboardingComplete() {
  await loadConfig()
  await Promise.all([
    fetchAgents(), fetchCommands(), fetchPlugins(), fetchSkills(),
    fetchWorkflows(), fetchServers(), fetchStyles(),
  ])
}

const navMidAll = [
  { key: 'artifacts', label: 'Artifacts', icon: 'i-lucide-folder-root', to: '/project-artifacts' },
  { key: 'cli', label: 'CLI', icon: 'i-lucide-terminal-square', to: '/cli' },
]
// The CLI is a Claude Code session against the working directory — the most
// powerful thing in the app, and nothing a reviewer's job needs. Artifacts are
// evidence, so they stay for everyone.
const navMid = computed(() => navMidAll.filter(l => l.key !== 'cli' || can('configure')))

const navBottomAll = [
  { label: 'Explore', icon: 'i-lucide-compass', to: '/explore' },
  { label: 'Graph', icon: 'i-lucide-workflow', to: '/graph' },
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings/pipeline' },
]
// Settings is offered to everyone now. Its reads were always open — only the
// writes are gated — and the values on it are what a developer or a manager
// actually came for: which model runs the pipeline, what a run may spend,
// where evidence lands. Each page renders its controls only under `configure`,
// and /api/settings refuses the write regardless.
const navBottom = computed(() => navBottomAll
  .filter(l => labs.value || !['/explore', '/graph'].includes(l.to)))

function isActive(to: string) {
  if (to === '/') return route.path === '/'
  // Exact match or sub-route
  return route.path === to || route.path.startsWith(to + '/')
}

function badgeFor(to: string) {
  // The one badge that means "waiting on you". Everything below it counts
  // inventory, which is why this one is coloured differently in the template.
  if (to === '/runs') return runsAwaiting.value || null
  if (to === '/agents') return agents.value.length || null
  if (to === '/commands') return commands.value.length || null
  if (to === '/skills') return skills.value.length || null
  if (to === '/plugins') return plugins.value.length || null
  if (to === '/workflows') return workflows.value.length || null
  if (to === '/mcp') return mcpServers.value.length || null
  return null
}
</script>

<template>
  <UApp>
    <NuxtPage v-if="isLogin" />
    <div v-else class="flex h-screen overflow-hidden" style="background: var(--surface-base);">
      <!-- Sidebar -->
      <aside
        class="sidebar shrink-0 flex flex-col relative h-full overflow-hidden transition-all duration-300"
        :style="{
          width: sidebarCollapsed ? '56px' : '200px',
          background: 'var(--sidebar-bg)',
          borderRight: '1px solid var(--border-subtle)',
        }"
      >
        <!-- Ambient glow at top — stronger -->
        <div
          class="absolute top-0 left-1/2 -translate-x-1/2 w-40 h-32 pointer-events-none"
          style="background: radial-gradient(ellipse, rgba(229, 169, 62, 0.1) 0%, transparent 70%);"
        />

        <!-- Brand -->
        <div class="h-[56px] flex items-center gap-2.5 relative" :class="sidebarCollapsed ? 'justify-center px-2' : 'px-4'">
          <NuxtLink to="/" class="flex items-center gap-2.5 flex-1 min-w-0 group/brand" v-if="!sidebarCollapsed">
            <div
              class="size-7 rounded-lg flex items-center justify-center relative shrink-0 transition-transform duration-200 group-hover/brand:scale-105"
              style="background: linear-gradient(135deg, rgba(229, 169, 62, 0.18) 0%, rgba(229, 169, 62, 0.06) 100%); border: 1px solid rgba(229, 169, 62, 0.15);"
            >
              <UIcon name="i-lucide-bot" class="size-3.5" style="color: var(--accent);" />
            </div>
            <div class="flex-1 flex flex-col min-w-0">
              <span class="t-small font-semibold tracking-tight group-hover/brand:text-accent transition-colors" style="color: var(--text-primary); font-family: var(--font-display);">
                Agent Manager
              </span>
              <span class="t-small font-mono tracking-wider uppercase" style="color: var(--text-disabled);">
                Claude Code
              </span>
            </div>
          </NuxtLink>
          <div v-else class="size-7 rounded-lg flex items-center justify-center relative shrink-0"
            style="background: linear-gradient(135deg, rgba(229, 169, 62, 0.18) 0%, rgba(229, 169, 62, 0.06) 100%); border: 1px solid rgba(229, 169, 62, 0.15);"
          >
            <UIcon name="i-lucide-bot" class="size-3.5" style="color: var(--accent);" />
          </div>
          <!-- Collapse toggle -->
          <button
            class="flex size-7 items-center justify-center rounded-lg transition-all duration-150 focus-ring press-scale shrink-0"
            style="color: var(--text-tertiary);"
            :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
            @mouseenter="($event.currentTarget as HTMLElement).style.background = 'var(--surface-hover)'"
            @mouseleave="($event.currentTarget as HTMLElement).style.background = 'transparent'"
            @click="sidebarCollapsed = !sidebarCollapsed"
          >
            <UIcon :name="sidebarCollapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" class="size-4" />
          </button>
        </div>

        <!-- Search shortcut -->
        <div :class="sidebarCollapsed ? 'px-1.5 pt-1 pb-1.5' : 'px-2.5 pt-1 pb-1.5'">
          <button
            class="w-full flex items-center rounded-lg transition-all duration-150 focus-ring cursor-pointer press-scale"
            :class="sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2 px-3 py-2'"
            style="color: var(--text-disabled); background: var(--input-bg); border: 1px solid var(--border-subtle);"
            :title="sidebarCollapsed ? 'Search (⌘K)' : undefined"
            @mouseenter="($event.currentTarget as HTMLElement).style.borderColor = 'var(--border-default)'; ($event.currentTarget as HTMLElement).style.color = 'var(--text-tertiary)'"
            @mouseleave="($event.currentTarget as HTMLElement).style.borderColor = 'var(--border-subtle)'; ($event.currentTarget as HTMLElement).style.color = 'var(--text-disabled)'"
            @click="showSearch = true"
          >
            <UIcon name="i-lucide-search" class="size-3.5" />
            <template v-if="!sidebarCollapsed">
              <span class="t-small flex-1 text-left" style="font-family: var(--font-sans);">Search</span>
              <kbd class="t-small font-mono px-1.5 py-0.5 rounded" style="background: var(--badge-subtle-bg); color: var(--text-disabled);">⌘K</kbd>
            </template>
          </button>
        </div>

        <!-- Primary Nav -->
        <nav class="flex-1 pt-1 space-y-0.5 overflow-y-auto" :class="sidebarCollapsed ? 'px-1.5' : 'px-2.5'">
          <!-- Top Section, grouped. The link markup below is unchanged: only the
               wrapping v-for and the group label are new, so collapsed
               icon-only mode, the active bar and the badges behave as before. -->
          <template v-for="group in navTop" :key="group.key">
          <div
            v-if="!sidebarCollapsed"
            class="t-label px-3 pt-2 pb-0.5 select-none"
            style="color: var(--text-disabled); font-family: var(--font-sans);"
          >{{ group.label }}</div>
          <div v-else class="my-2 mx-1" style="border-top: 1px solid var(--border-subtle);" />
          <NuxtLink
            v-for="link in group.links"
            :key="link.to"
            :to="link.to"
            class="nav-item group flex items-center rounded-lg t-ui transition-all duration-150 relative focus-ring"
            :class="[
              sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-[7px]',
              { 'nav-item--active': isActive(link.to) }
            ]"
            :style="{
              color: isActive(link.to) ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontWeight: isActive(link.to) ? '500' : '400',
              background: isActive(link.to) ? 'var(--accent-muted)' : undefined,
            }"
            :title="sidebarCollapsed ? link.label : undefined"
          >
            <!-- Active indicator bar -->
            <div
              v-if="isActive(link.to)"
              class="absolute left-0 top-1/2 -translate-y-1/2 w-[2.5px] h-4 rounded-r-full"
              style="background: var(--accent); box-shadow: 0 0 10px var(--accent-glow);"
            />
            <UIcon :name="link.icon" class="size-[15px] shrink-0 transition-colors duration-150" :style="{ color: isActive(link.to) ? 'var(--accent)' : undefined }" />
            <template v-if="!sidebarCollapsed">
              <span class="flex-1" style="font-family: var(--font-sans);">{{ link.label }}</span>
              <span
                v-if="badgeFor(link.to)"
                class="font-mono t-small tabular-nums transition-colors duration-150"
                :style="{ color: link.to === '/runs' ? 'var(--warning)' : isActive(link.to) ? 'var(--accent)' : 'var(--text-disabled)' }"
                :title="link.to === '/runs' ? 'Runs waiting on you' : undefined"
              >
                {{ badgeFor(link.to) }}
              </span>
            </template>
          </NuxtLink>
          </template>

          <!-- Separator 1 -->
          <div class="my-3" :class="sidebarCollapsed ? 'mx-1' : 'mx-2'" style="border-top: 1px solid var(--border-subtle);" />

          <!-- Mid Section: Projects & CLI -->
          <NuxtLink
            v-for="link in navMid"
            :key="link.key"
            :to="link.to"
            class="nav-item group flex items-center rounded-lg t-ui transition-all duration-150 relative focus-ring"
            :class="[
              sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-[7px]',
              { 'nav-item--active': isActive(link.to) }
            ]"
            :style="{
              color: isActive(link.to) ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontWeight: isActive(link.to) ? '500' : '400',
              background: isActive(link.to) ? 'var(--accent-muted)' : undefined,
            }"
            :title="sidebarCollapsed ? link.label : undefined"
          >
            <div
              v-if="isActive(link.to)"
              class="absolute left-0 top-1/2 -translate-y-1/2 w-[2.5px] h-4 rounded-r-full"
              style="background: var(--accent); box-shadow: 0 0 10px var(--accent-glow);"
            />
            <UIcon :name="link.icon" class="size-[15px] shrink-0 transition-colors duration-150" :style="{ color: isActive(link.to) ? 'var(--accent)' : undefined }" />
            <template v-if="!sidebarCollapsed">
              <span class="flex-1" style="font-family: var(--font-sans);">{{ link.label }}</span>
            </template>
          </NuxtLink>

          <!-- Separator 2 -->
          <div class="my-3" :class="sidebarCollapsed ? 'mx-1' : 'mx-2'" style="border-top: 1px solid var(--border-subtle);" />

          <!-- Bottom Section -->
          <NuxtLink
            v-for="link in navBottom"
            :key="link.to"
            :to="link.to"
            class="nav-item group flex items-center rounded-lg t-ui transition-all duration-150 relative focus-ring"
            :class="[
              sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-[7px]',
              { 'nav-item--active': isActive(link.to) }
            ]"
            :style="{
              color: isActive(link.to) ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontWeight: isActive(link.to) ? '500' : '400',
              background: isActive(link.to) ? 'var(--accent-muted)' : undefined,
            }"
            :title="sidebarCollapsed ? link.label : undefined"
          >
            <div
              v-if="isActive(link.to)"
              class="absolute left-0 top-1/2 -translate-y-1/2 w-[2.5px] h-4 rounded-r-full"
              style="background: var(--accent); box-shadow: 0 0 10px var(--accent-glow);"
            />
            <UIcon :name="link.icon" class="size-[15px] shrink-0 transition-colors duration-150" :style="{ color: isActive(link.to) ? 'var(--accent)' : undefined }" />
            <span v-if="!sidebarCollapsed" style="font-family: var(--font-sans);">{{ link.label }}</span>
          </NuxtLink>
        </nav>

        <!-- Chat with Claude. `configure` only, matching /cli in navMid above and
             the server check on /api/chat: this panel runs an agent over the
             config directory with permissions bypassed, so offering it to a
             reviewer contradicted the link we deliberately hid from them. -->
        <div v-if="can('configure')" :class="sidebarCollapsed ? 'px-1.5 pb-1' : 'px-2.5 pb-1'">
          <button
            class="w-full flex items-center rounded-lg transition-all duration-150 focus-ring cursor-pointer press-scale"
            :class="sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2 px-3 py-2'"
            :style="{
              color: chatOpen ? 'var(--accent)' : 'var(--text-tertiary)',
              background: chatOpen ? 'var(--accent-muted)' : 'transparent',
            }"
            :title="sidebarCollapsed ? 'Claude (⌘J)' : undefined"
            @click="chatOpen = !chatOpen"
          >
            <div class="size-4 relative flex items-center justify-center shrink-0">
              <UIcon name="i-lucide-zap" class="size-4" />
              <div
                v-if="chatOpen"
                class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full"
                style="background: var(--accent); box-shadow: 0 0 8px var(--accent-glow);"
              />
            </div>
            <template v-if="!sidebarCollapsed">
              <span class="t-small flex-1 text-left" style="font-family: var(--font-sans);">Claude</span>
              <kbd class="t-small font-mono px-1.5 py-0.5 rounded" style="background: var(--badge-subtle-bg); color: var(--text-disabled);">⌘J</kbd>
            </template>
          </button>
        </div>

        <!-- Signed-in developer -->
        <ClientOnly>
          <div v-if="me" :class="sidebarCollapsed ? 'px-1.5 pb-1' : 'px-2.5 pb-1'">
            <NuxtLink
              to="/profile"
              class="w-full flex items-center rounded-lg transition-all duration-150 focus-ring"
              :class="sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2 px-3 py-2'"
              style="color: var(--text-tertiary);"
              :title="`${me.name || me.login} · profile`"
            >
              <img v-if="me.avatar" :src="me.avatar" alt="" class="size-5 rounded-full" />
              <UIcon v-else name="i-lucide-user" class="size-4" />
              <span v-if="!sidebarCollapsed" class="t-small truncate flex-1 text-left" style="font-family: var(--font-sans);">{{ me.name || me.login }}</span>
              <button v-if="!sidebarCollapsed && !me.authDisabled" class="t-small underline" @click.prevent="signOut">Sign out</button>
            </NuxtLink>
          </div>
        </ClientOnly>

        <!-- Look at the app as a lesser role.
             On `realRole`, never `can('configure')`: the moment you view as a
             developer you lose `configure`, so a control gated on it would
             disappear and strand you in the role you were inspecting.
             A dropdown rather than a four-button row because the row was
             `!sidebarCollapsed` — so the one control for checking what a
             developer sees vanished on exactly the narrow screen where you
             would most want to check a layout. -->
        <div v-if="me?.realRole === 'operator'" :class="sidebarCollapsed ? 'px-1.5 pb-1' : 'px-2.5 pb-1'">
          <UDropdownMenu
            :items="[[
              { label: 'You (operator)', onSelect: () => switchRole('operator') },
              { label: 'Developer', onSelect: () => switchRole('developer') },
              { label: 'QA', onSelect: () => switchRole('qa') },
              { label: 'Manager', onSelect: () => switchRole('manager') },
            ]]"
          >
            <button
              class="w-full flex items-center rounded-lg transition-all duration-150 focus-ring press-scale"
              :class="sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2 px-3 py-2'"
              :style="{ color: viewingAs ? 'var(--accent)' : 'var(--text-tertiary)' }"
              :title="viewingAs ? `Viewing as ${role}` : 'View the app as another role'"
              :disabled="switchingRole"
            >
              <UIcon name="i-lucide-eye" class="size-4 shrink-0" />
              <span v-if="!sidebarCollapsed" class="t-small truncate flex-1 text-left" style="font-family: var(--font-sans);">
                {{ viewingAs ? `Viewing as ${role}` : 'View as' }}
              </span>
            </button>
          </UDropdownMenu>
        </div>

        <!-- Theme toggle -->
        <div :class="sidebarCollapsed ? 'px-1.5 pb-1' : 'px-2.5 pb-1'">
          <ClientOnly>
            <button
              class="w-full flex items-center rounded-lg transition-all duration-150 focus-ring press-scale"
              :class="sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2 px-3 py-2'"
              style="color: var(--text-tertiary);"
              :title="sidebarCollapsed ? (colorMode.value === 'dark' ? 'Light mode' : 'Dark mode') : undefined"
              @click="toggleTheme"
            >
              <UIcon :name="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'" class="size-4" />
              <span v-if="!sidebarCollapsed" class="t-small" style="font-family: var(--font-sans);">
                {{ colorMode.value === 'dark' ? 'Light mode' : 'Dark mode' }}
              </span>
            </button>
          </ClientOnly>
        </div>

      </aside>

      <!-- Main content -->
      <!-- A flex column, not a single scroll container: the impersonation banner
           below takes real vertical space, and pages that declare `h-full`
           manage their own internal scrolling. Leaving `overflow-y-auto` on
           <main> would give those pages a second scrollbar the moment the
           banner appeared. -->
      <main class="flex-1 min-w-0 h-full flex flex-col" style="background: var(--surface-base);">
        <!-- You are not seeing your own app. App-level, not just on the
             dashboard: an operator who forgets they are impersonating reads a
             missing control as a broken one. -->
        <div
          v-if="viewingAs"
          class="shrink-0 flex flex-wrap items-center gap-2 t-small px-4 py-2"
          style="background: var(--accent-muted); border-bottom: 1px solid var(--accent);"
        >
          <UIcon name="i-lucide-eye" class="size-4 shrink-0" style="color: var(--accent);" />
          <span style="color: var(--text-primary);">
            You are seeing this as a <span class="font-mono">{{ role }}</span>. Controls you normally have are hidden.
          </span>
          <button
            class="ml-auto underline focus-ring"
            style="color: var(--text-primary);"
            :disabled="switchingRole"
            @click="switchRole('operator')"
          >Back to your own view</button>
        </div>

        <!-- Setup wizard when directory doesn't exist -->
        <SetupWizard
          v-if="initialized && !claudeDirExists"
          @complete="onOnboardingComplete"
        />

        <div v-show="initialized && claudeDirExists" class="flex-1 min-h-0 overflow-y-auto custom-scrollbar" style="scrollbar-gutter: stable;">
          <NuxtPage />
        </div>
        <div v-if="!initialized" class="flex-1 flex items-center justify-center">
          <UIcon name="i-lucide-loader-2" class="size-5 animate-spin" style="color: var(--text-disabled);" />
        </div>
      </main>
    </div>
    <template v-if="!isLogin">
      <GlobalSearch />
      <ChatPanel v-if="can('configure')" v-model:open="chatOpen" />
      <FileEditorSidebar v-if="!route.path.startsWith('/cli')" />
    </template>
  </UApp>
</template>

<style scoped>
/* Nav item hover with smooth background reveal */
.nav-item {
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover {
  background: var(--surface-hover);
}

/* Fade transition for mobile backdrop */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
