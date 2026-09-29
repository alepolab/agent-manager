<script setup lang="ts">
import { NAV_PRIMARY, NAV_LIBRARY, NAV_BY_ROLE, itemActive, type NavItem } from '~/utils/navigation'

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
const showSearch = useState('global-search-open', () => false)
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
/** Switching to your own role clears the impersonation rather than setting one. */
const switchingRole = ref(false)
async function switchRole(next: string) {
  if (role.value === next) return
  switchingRole.value = true
  try { await viewAs(next === 'operator' ? null : next as any) } finally { switchingRole.value = false }
}

// Cmd+, opens Settings, as it does in every desktop app
if (import.meta.client) {
  const settingsHandler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault()
      navigateTo('/settings/pipeline')
    }
  }
  onMounted(() => document.addEventListener('keydown', settingsHandler))
  onUnmounted(() => document.removeEventListener('keydown', settingsHandler))
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
  void Promise.all([fetchAgents(), fetchCommands(), fetchPlugins(), fetchSkills(), fetchWorkflows(), fetchServers(), fetchNotifications()])
})

// The shared lists live here, so pages that only read them don't refetch them too.
// Skills are several MB: refreshed on focus here, and polled only while /skills is open.
const canRefresh = () => initialized.value && claudeDirExists.value && !isLogin.value
useAutoRefresh(() => canRefresh() && Promise.all([
  fetchAgents({}, { silent: true }), fetchCommands({}, { silent: true }), fetchPlugins({ silent: true }),
  fetchWorkflows({}, { silent: true }), fetchServers({ silent: true }),
]))
// Its own, faster poll: a /cli permission prompt denies itself after five
// minutes, and the badge is how anyone away from that tab learns it exists.
useAutoRefresh(() => canRefresh() && fetchNotifications(), { interval: 15_000 })
useAutoRefresh(() => canRefresh() && fetchSkills({}, { silent: true }), { interval: 0 })

const { settings, load: loadSettings } = useSettings()
const { count: notificationsWaiting, fetchAll: fetchNotifications } = useNotifications()
const { me, signOut, can, role, viewingAs, viewAs } = useUser()
/**
 * Two jobs, not five bands. Operating the pipeline comes first and needs no
 * heading; the things it runs sit under Library. Sibling pages (Schedules
 * beside Watches, MCP beside Plugins) are tabs inside one item, and the
 * rarely-changed instance pages are Settings tabs — see utils/navigation.ts.
 * A role still drops whole items rather than leaving gaps.
 */
function visibleItems(items: NavItem[]) {
  const allowed = role.value ? NAV_BY_ROLE[role.value] : undefined
  return items.filter(i => !allowed || allowed.includes(i.to))
}
const navPrimary = computed(() => visibleItems(NAV_PRIMARY))
const navLibrary = computed(() => visibleItems(NAV_LIBRARY))

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

function badgeFor(to: string) {
  if (to === '/agents') return agents.value.length || null
  if (to === '/commands') return commands.value.length || null
  if (to === '/skills') return skills.value.length || null
  if (to === '/workflows') return workflows.value.length || null
  if (to === '/plugins') return (plugins.value.length + mcpServers.value.length) || null
  return null
}

/**
 * Everything about the person, in one menu at the top of the sidebar: who you
 * are, whose view you are looking through, Settings, and signing out. These
 * were five separate rows along the bottom edge, below the scroll.
 *
 * "View as" is gated on `realRole`, never `can('configure')`: the moment you
 * view as a developer you lose `configure`, so a control gated on it would
 * disappear and strand you in the role you were inspecting.
 */
const accountMenu = computed(() => {
  const groups: any[][] = [[
    { label: me.value?.name || me.value?.login || 'Profile', icon: 'i-lucide-user', to: '/profile' },
    { label: 'Settings', icon: 'i-lucide-settings', to: '/settings/pipeline', kbds: ['meta', ','] },
  ]]
  if (me.value?.realRole === 'operator') {
    groups.push([
      { type: 'label', label: 'View as' },
      ...[['operator', 'You (operator)'], ['developer', 'Developer'], ['qa', 'QA'], ['manager', 'Manager']].map(([value, label]) => ({
        label,
        icon: role.value === value ? 'i-lucide-check' : undefined,
        disabled: switchingRole.value,
        onSelect: () => switchRole(value!),
      })),
    ])
  }
  if (me.value && !me.value.authDisabled) {
    groups.push([{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut }])
  }
  return groups
})
const initials = computed(() => (me.value?.name || me.value?.login || '?')
  .split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())
</script>

<template>
  <UApp>
    <NuxtPage v-if="isLogin" />
    <div v-else class="flex h-screen overflow-hidden" style="background: var(--surface-base);">
      <!-- Sidebar -->
      <aside
        class="sidebar shrink-0 flex flex-col h-full overflow-hidden transition-[width] duration-200"
        :style="{ width: sidebarCollapsed ? '56px' : '220px' }"
      >
        <!-- Brand, account, collapse. The account menu sits at the top, not
             along the bottom edge below the scroll. -->
        <div class="h-[52px] flex items-center gap-1.5 shrink-0" :class="sidebarCollapsed ? 'justify-center px-2' : 'pl-4 pr-2'">
          <NuxtLink v-if="!sidebarCollapsed" to="/" class="flex-1 min-w-0 flex flex-col gap-0.5 focus-ring rounded" aria-label="Alepo Agent Manager — home">
            <img src="/brand/alepo-logo-light.png" alt="Alepo" class="h-[18px] w-auto self-start dark:hidden">
            <img src="/brand/alepo-logo-dark.png" alt="Alepo" class="h-[18px] w-auto self-start hidden dark:block">
            <span class="t-small truncate" style="color: var(--text-tertiary);">Agent Manager</span>
          </NuxtLink>
          <!-- Collapsed, the 56px rail has room for one control here: the mark expands it -->
          <button v-else class="size-8 flex items-center justify-center rounded-md shrink-0 focus-ring" title="Expand sidebar" @click="sidebarCollapsed = false">
            <img src="/favicon.svg" alt="Alepo" class="size-7 dark:hidden">
            <img src="/brand/alepo-mark-dark.svg" alt="Alepo" class="size-7 hidden dark:block">
          </button>
          <template v-if="!sidebarCollapsed">
            <ClientOnly>
              <UDropdownMenu v-if="me" :items="accountMenu" :content="{ align: 'end' }">
                <button class="sidebar-icon-btn" :title="viewingAs ? `Viewing as ${role}` : (me.name || me.login)">
                  <img v-if="me.avatar" :src="me.avatar" alt="" class="size-6 rounded-full">
                  <span v-else class="sidebar-avatar">{{ initials }}</span>
                </button>
              </UDropdownMenu>
            </ClientOnly>
            <button class="sidebar-icon-btn" title="Collapse sidebar" @click="sidebarCollapsed = true">
              <UIcon name="i-lucide-panel-left-close" class="size-4" />
            </button>
          </template>
        </div>

        <!-- Search and Claude -->
        <div class="flex gap-1 shrink-0 pb-2" :class="sidebarCollapsed ? 'flex-col items-center px-2' : 'px-2.5'">
          <ClientOnly>
            <UDropdownMenu v-if="me && sidebarCollapsed" :items="accountMenu" :content="{ side: 'right', align: 'start' }">
              <button class="sidebar-icon-btn" :title="me.name || me.login">
                <img v-if="me.avatar" :src="me.avatar" alt="" class="size-6 rounded-full">
                <span v-else class="sidebar-avatar">{{ initials }}</span>
              </button>
            </UDropdownMenu>
          </ClientOnly>
          <button
            class="sidebar-search focus-ring"
            :class="sidebarCollapsed ? 'sidebar-icon-btn' : 'flex-1'"
            :title="sidebarCollapsed ? 'Search (⌘K)' : undefined"
            @click="showSearch = true"
          >
            <UIcon name="i-lucide-search" class="size-3.5 shrink-0" />
            <template v-if="!sidebarCollapsed">
              <span class="flex-1 text-left">Search</span>
              <kbd class="t-small">⌘K</kbd>
            </template>
          </button>
          <!-- `configure` only, matching the server check on /api/chat: this
               panel runs an agent over the config directory with permissions
               bypassed. -->
          <button
            v-if="can('configure')"
            class="sidebar-icon-btn"
            :class="{ 'sidebar-icon-btn--on': chatOpen }"
            title="Claude (⌘J)"
            :aria-pressed="chatOpen"
            @click="chatOpen = !chatOpen"
          >
            <UIcon name="i-lucide-sparkle" class="size-4" />
          </button>
        </div>

        <nav class="flex-1 overflow-y-auto pb-3" :class="sidebarCollapsed ? 'px-2' : 'px-2.5'" aria-label="Main">
          <template v-for="(section, i) in [{ label: '', items: navPrimary }, { label: 'Library', items: navLibrary }]" :key="i">
            <template v-if="section.items.length">
              <div v-if="section.label && !sidebarCollapsed" class="sidebar-heading">{{ section.label }}</div>
              <div v-else-if="section.label" class="my-2 mx-1" style="border-top: 0.5px solid var(--border-default);" />
              <NuxtLink
                v-for="item in section.items"
                :key="item.to"
                :to="item.to"
                class="sidebar-item focus-ring"
                :class="{ 'sidebar-item--on': itemActive(item, route.path), 'justify-center': sidebarCollapsed }"
                :aria-current="itemActive(item, route.path) ? 'page' : undefined"
                :title="sidebarCollapsed ? item.label : undefined"
              >
                <span class="relative shrink-0 flex">
                  <UIcon :name="item.icon" class="size-4" />
                  <span v-if="sidebarCollapsed && item.to === '/notifications' && notificationsWaiting" class="sidebar-dot" />
                </span>
                <template v-if="!sidebarCollapsed">
                  <span class="flex-1 truncate">{{ item.label }}</span>
                  <span
                    v-if="item.to === '/notifications' && notificationsWaiting"
                    class="sidebar-pill"
                    title="Decisions waiting on you"
                  >{{ notificationsWaiting }}</span>
                  <span v-else-if="badgeFor(item.to)" class="sidebar-count">{{ badgeFor(item.to) }}</span>
                </template>
              </NuxtLink>
            </template>
          </template>
        </nav>
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
/* A source list: flat, quiet, one tint for "selected". */
.sidebar {
  background: var(--sidebar-bg);
  border-right: 0.5px solid var(--border-default);
}

.sidebar-heading {
  padding: 14px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  margin-bottom: 1px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-primary);
}
.sidebar-item :deep(.iconify) { color: var(--accent); }
.sidebar-item:hover { background: var(--surface-hover); }
.sidebar-item--on { background: var(--accent-muted); font-weight: 600; }

.sidebar-count {
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.router-link-active > .sidebar-count { color: var(--text-secondary); }

.sidebar-pill {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: var(--accent);
  color: var(--on-accent);
}

.sidebar-dot {
  position: absolute;
  top: -2px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1.5px var(--sidebar-bg);
}

.sidebar-icon-btn {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-tertiary);
}
.sidebar-icon-btn:hover { background: var(--surface-hover); color: var(--text-primary); }
.sidebar-icon-btn--on { background: var(--accent-muted); color: var(--accent); }

.sidebar-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  /* #8e8e93 put the white initials at 3.3:1. */
  background: #636366;
}

.sidebar-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--text-tertiary);
  background: rgba(120, 120, 128, 0.12);
}
.sidebar-search.sidebar-icon-btn { padding: 0; background: transparent; }
.sidebar-search kbd { font-family: var(--font-sans); color: var(--text-tertiary); }
</style>
