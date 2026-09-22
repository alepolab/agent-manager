<script setup lang="ts">
import { ROLES, SHORT_ROLE, type Role } from '~~/shared/types/role'

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

/**
 * The VIEW-AS control's roles, and the short label each gets.
 *
 * Derived from `ROLES` rather than written out again: the picker used to be a
 * four-element literal with the labels in a nested ternary, so a role added to
 * the type appeared everywhere except the one control built to inspect it.
 * `operator` leads because it is the way back to yourself.
 */
// Labels come from shared/types/role.ts now, so a step's owner chip and this
// picker cannot drift apart. `operator` is the one exception: in every other
// surface it is the OPS role, and here it is the way back to being yourself.
const pickerLabel = (r: Role) => (r === 'operator' ? 'You' : SHORT_ROLE[r])
const viewAsRoles = computed<Role[]>(() => ['operator', ...ROLES.filter(r => r !== 'operator')])

/** Switching to your own role clears the impersonation rather than setting one. */
const switchingRole = ref(false)
/** The banner's exit, so it does not depend on the sidebar being expanded. */
const stopViewingAs = () => switchRole('operator')
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
  void Promise.all([fetchAgents(), fetchCommands(), fetchPlugins(), fetchSkills(), fetchWorkflows(), fetchServers()])
})

const { settings, load: loadSettings } = useSettings()
const { me, signOut, can, role, viewingAs, viewAs } = useUser()
// Unfinished pages stay reachable by URL but leave the sidebar unless labs is on.
const labs = computed(() => settings.value?.agentManager?.labs === true)
/**
 * Ordered by how often a person goes there, not by the order the app was
 * built in.
 *
 * It was Dashboard, Agents, Workflows, Runs, Board… — which is the build
 * order, and CLAUDE.md records why: this began as "a GUI layer on top of the
 * ~/.claude directory" and the pipeline was added later. So the six file-type
 * browsers outranked the three screens the job actually uses, and Runs, Board
 * and Watches — daily, daily, weekly — sat at positions 4, 5 and 6, the
 * serial-position trough where recall is worst and where primacy and recency
 * protect nothing.
 *
 * The groups are the job, in order: decide, then supervise, then author.
 * `navSections` below draws a rule between them, so the grouping is legible
 * rather than implied by adjacency.
 */
const navTopAll = [
  // Decide — many times a day.
  { label: 'Dashboard', icon: 'i-lucide-layout-dashboard', to: '/', group: 'decide' },
  { label: 'Runs', icon: 'i-lucide-play-circle', to: '/runs', group: 'decide' },
  { label: 'Board', icon: 'i-lucide-gauge', to: '/board', group: 'decide' },
  // Supervise — weekly to monthly.
  { label: 'Watches', icon: 'i-lucide-radio', to: '/watches', group: 'supervise' },
  { label: 'Workflows', icon: 'i-lucide-git-branch', to: '/workflows', group: 'supervise' },
  { label: 'Team', icon: 'i-lucide-users', to: '/team', group: 'supervise' },
  // Author — rarely, and never in the middle of a decision.
  { label: 'Agents', icon: 'i-lucide-cpu', to: '/agents', group: 'author' },
  { label: 'Skills', icon: 'i-lucide-sparkles', to: '/skills', group: 'author' },
  { label: 'Commands', icon: 'i-lucide-terminal', to: '/commands', group: 'author' },
  { label: 'Plugins', icon: 'i-lucide-puzzle', to: '/plugins', group: 'author' },
  { label: 'MCP Servers', icon: 'i-lucide-server', to: '/mcp', group: 'author' },
  { label: 'Output Styles', icon: 'i-lucide-palette', to: '/output-styles', group: 'author' },
]

/**
 * What each role has any business opening. Everything absent here is still
 * reachable by URL for an operator and refused by the API for everyone else —
 * this list decides what a person is OFFERED, which is the actual complaint
 * about the old sidebar: it showed a reviewer the whole engine.
 */
/**
 * Typed on `Role`, not `string`, so the compiler refuses this file until every
 * role has an entry.
 *
 * It was `Record<string, string[]>`, and three roles added later —
 * product-owner, security and cto — silently had none. The lookup below
 * treats a miss as "no filter", so the three newest roles were each offered
 * the FULL operator sidebar: a CTO whose job is threshold escalations was
 * shown Plugins and MCP Servers. A restriction that fails open is not a
 * restriction, and the whole stated purpose of this map is that "a console
 * which shows an actor controls they must not use is describing the system
 * rather than their job".
 */
const NAV_BY_ROLE: Record<Role, string[]> = {
  developer: ['/', '/runs', '/agents', '/skills', '/commands'],
  qa: ['/', '/runs'],
  // Decides whether a story is ready and what "done" means. They start change
  // requests, so they need the dashboard's start panel; they author nothing.
  'product-owner': ['/', '/runs', '/board'],
  // Reaches a run because it touched authz, crypto, data or a dependency —
  // never to browse the estate's configuration.
  security: ['/', '/runs'],
  // Only what crosses the escalation threshold, plus the view that shows
  // whether the threshold is set right.
  cto: ['/', '/runs', '/board'],
  // An architect reads across runs rather than inside one, so they are offered
  // the board and the relationship graph. Both are read-only and the API
  // refuses the writes regardless, so offering them costs nothing.
  architect: ['/', '/runs', '/board', '/graph'],
  // A designer reviews what a run produced. Artifacts are in `navMid` for
  // everyone, which is where their evidence lives until a design surface exists.
  designer: ['/', '/runs'],
  // A manager's screen is the board, not the run list with its buttons removed.
  manager: ['/', '/board', '/runs'],
  // Explicit rather than implied by absence. The full sidebar is a CHOICE for
  // the one role that configures the pipeline, not the accident of a missing
  // key — which is what it used to be, and what let three roles inherit it.
  operator: [],
}

const navTop = computed(() => {
  // An unknown role gets the NARROWEST sidebar, not the widest. `operator`
  // holds its full list explicitly; anything unrecognised is a bug, and a bug
  // must not grant reach.
  // `operator` declares an empty list meaning "no restriction"; every other
  // role restricts, and an unrecognised one gets the narrowest set rather
  // than the widest, because a bug must not grant reach.
  const entry = role.value ? (NAV_BY_ROLE[role.value] ?? ['/', '/runs']) : undefined
  const allowed = entry && entry.length ? entry : undefined
  return navTopAll
    .filter(l => labs.value || l.to !== '/output-styles')
    // No role entry means operator: the full sidebar, exactly as before.
    .filter(l => !allowed || allowed.includes(l.to))
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
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
]
// Settings is configuration, so it goes with the rest of it: only an operator
// is offered it, and /api/settings refuses the write regardless.
const navBottom = computed(() => navBottomAll
  .filter(l => labs.value || !['/explore', '/graph'].includes(l.to))
  .filter(l => l.to !== '/settings' || can('configure')))

function isActive(to: string) {
  if (to === '/') return route.path === '/'
  // Exact match or sub-route
  return route.path === to || route.path.startsWith(to + '/')
}

/**
 * One badge, on the only number that changes and the only one that asks for
 * an act: how many decisions are waiting on you.
 *
 * There were six, all counting files in a directory — Agents 32, Commands 39,
 * Skills, Plugins, Workflows, MCP — fetched once at mount and never refreshed.
 * A signal with no variance carries no information: Agents was 32 yesterday
 * and will be 32 tomorrow, and no one opens Agents *because* there are 32.
 *
 * The damage was not the six wasted rows, it was the channel. Habituation
 * generalises across a class of signal, so six permanently-static numbers
 * teach the eye that a small number on the right of a nav row means nothing —
 * and then the one that does mean something is invisible when it arrives.
 * Deleting them is what makes this one work.
 */
const waitingOnMe = ref(0)
async function refreshWaiting() {
  try {
    const runs = await $fetch<{ status: string, dismissed?: boolean, question?: { role?: string } }[]>('/api/runs')
    waitingOnMe.value = runs.filter(r => !r.dismissed && r.status === 'paused'
      && (!r.question?.role || !role.value || role.value === 'operator' || role.value === r.question.role)).length
  } catch { /* the dashboard reports the failure; a badge must not */ }
}

function badgeFor(to: string) {
  return to === '/' && waitingOnMe.value ? waitingOnMe.value : null
}
onMounted(() => {
  refreshWaiting()
  // Ten seconds, matching the dashboard's own poll: a badge that updates less
  // often than the page it points at would send someone to an empty queue.
  const t = setInterval(refreshWaiting, 10_000)
  onUnmounted(() => clearInterval(t))
})
// A role change narrows or widens which gates are yours, so the count has to
// move with it — otherwise viewing-as shows another role's backlog as your own.
watch(role, refreshWaiting)
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
          <!-- Top Section -->
          <template v-for="(link, i) in navTop" :key="link.to">
            <!-- A rule where the job changes, so the grouping is a fact on
                 screen rather than an inference from adjacency. Drawn from
                 the data, so it cannot drift out of step with the order. -->
            <div
              v-if="i > 0 && link.group !== navTop[i - 1]?.group"
              class="my-1.5" :class="sidebarCollapsed ? 'mx-1' : 'mx-2'"
              style="border-top: 1px solid var(--border-subtle);"
              aria-hidden="true"
            />
          <NuxtLink
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
                :style="{ color: 'var(--accent)', fontWeight: 700 }"
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
             Lives here rather than on the dashboard because it is an occasional
             operator tool that was occupying the best line of the busiest page,
             and because a gate or a run list is often what you want to inspect. -->
        <div v-if="me?.realRole === 'operator' && !sidebarCollapsed" class="px-2.5 pb-1">
          <div class="t-label mb-1" style="color: var(--text-disabled);">View as</div>
          <!-- Three columns, two rows: six roles in a single strip would give
               each label ~30px in a 200px sidebar and truncate every one. -->
          <div
            class="grid grid-cols-3 rounded-lg overflow-hidden"
            style="border: 1px solid var(--border-subtle); gap: 1px; background: var(--border-subtle);"
          >
            <button
              v-for="r in viewAsRoles" :key="r"
              class="py-1 t-label focus-ring transition-colors"
              :style="{
                background: role === r ? 'var(--accent-muted)' : 'var(--surface-raised)',
                color: role === r ? 'var(--accent)' : 'var(--text-tertiary)',
              }"
              :title="r === 'operator' ? 'Your own role' : `See the app as a ${r}`"
              :aria-pressed="role === r"
              :disabled="switchingRole"
              @click="switchRole(r)"
            >{{ pickerLabel(r) }}</button>
          </div>
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
      <main class="flex-1 min-w-0 h-full overflow-y-auto custom-scrollbar" style="background: var(--surface-base); scrollbar-gutter: stable;">
        <!-- Setup wizard when directory doesn't exist -->
        <SetupWizard
          v-if="initialized && !claudeDirExists"
          @complete="onOnboardingComplete"
        />

        <!-- View-as is a MODE, and a mode needs its indicator where the user
             is looking — not 800px away in the sidebar. This banner lived
             inside app/pages/index.vue, so on the other twenty-nine routes the
             only evidence you were impersonating was one tinted 3-letter chip.

             The mode is subtractive: it REMOVES controls. `can()` also returns
             false while loading, so a missing Restart button is indistinguishable
             from "still loading" and from "this run cannot be restarted" — an
             operator who forgets reads a working gate as a broken one.

             The exit lives here too. The sidebar picker is hidden when the
             sidebar is collapsed, and it force-collapses below 767px, so on a
             phone an impersonating operator previously had no way out except
             navigating back to Home and knowing that is where it lives. -->
        <div
          v-if="viewingAs"
          class="flex flex-wrap items-center gap-2 t-small px-4 py-2"
          style="background: var(--accent-muted); border-bottom: 1px solid var(--accent);"
          role="status"
        >
          <UIcon name="i-lucide-eye" class="size-4 shrink-0" style="color: var(--accent);" />
          <span style="color: var(--text-primary);">Viewing as <span class="font-mono">{{ role }}</span> — controls you normally have are hidden.</span>
          <button class="ml-auto underline focus-ring" :disabled="switchingRole" @click="stopViewingAs">Back to your own view</button>
        </div>
        <div v-show="initialized && claudeDirExists" class="h-full">
          <NuxtPage />
        </div>
        <div v-if="!initialized" class="flex items-center justify-center h-full">
          <UIcon name="i-lucide-loader-2" class="size-5 animate-spin" style="color: var(--text-disabled);" />
        </div>
      </main>
    </div>
    <template v-if="!isLogin">
      <GlobalSearch v-model:open="showSearch" />
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
