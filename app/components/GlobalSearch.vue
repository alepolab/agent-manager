<script setup lang="ts">
import { getAgentColor } from '~/utils/colors'
import { getModelBadgeClasses } from '~/utils/models'

const router = useRouter()
const { agents } = useAgents()
const { commands } = useCommands()
const { plugins } = usePlugins()
const { skills } = useSkills()

/**
 * Owned by the parent as well as by the keyboard.
 *
 * This was a private ref, so the sidebar's Search button — which sets its own
 * `showSearch` and passes nothing — did nothing at all. The button even
 * renders the correct shortcut inside itself, so a user learned "the click is
 * broken but the key works", and intermittent reinforcement of that kind is
 * the hardest model to unlearn. `defineModel` gives the click and the key one
 * piece of state to agree about.
 */
const open = defineModel<boolean>('open', { default: false })
const query = ref('')
const selectedIndex = ref(0)

/**
 * The first line of the body that contains the query, so a body hit says WHY
 * it matched rather than just that it did.
 *
 * Search reached `name` and `description` only, so "which of these 32 agents
 * mentions `mise run`?" had no answer in the product and the honest path was
 * to leave and grep ~/.claude. The bodies are already loaded — the CRUD
 * endpoints return them — so this costs a substring test, not a fetch.
 */
function bodyHit(body: string | undefined, q: string): string | null {
  if (!body) return null
  const at = body.toLowerCase().indexOf(q)
  if (at === -1) return null
  const start = body.lastIndexOf('\n', at) + 1
  const end = body.indexOf('\n', at)
  const line = body.slice(start, end === -1 ? undefined : end).trim()
  return line.length > 140 ? `${line.slice(0, 137)}…` : line
}

const results = computed(() => {
  const q = query.value.toLowerCase().trim()
  if (!q) return []

  const items: { type: string; label: string; sublabel: string; to: string; icon: string; color?: string; model?: string }[] = []

  for (const agent of agents.value) {
    const inBody = bodyHit((agent as { body?: string }).body, q)
    if (agent.frontmatter.name.toLowerCase().includes(q) || agent.frontmatter.description?.toLowerCase().includes(q) || inBody) {
      items.push({
        type: 'Agent',
        // A body match shows the matching line: the name alone would leave the
        // reader guessing which of 32 agents mentions the thing they typed.
        label: agent.frontmatter.name,
        sublabel: inBody || agent.frontmatter.description || '',
        to: `/agents/${agent.slug}`,
        icon: 'i-lucide-cpu',
        color: getAgentColor(agent.frontmatter.color),
        model: agent.frontmatter.model,
      })
    }
  }

  for (const cmd of commands.value) {
    const inBodyCommand = bodyHit((cmd as { body?: string }).body, q)
    if (cmd.frontmatter.name.toLowerCase().includes(q) || cmd.frontmatter.description?.toLowerCase().includes(q) || inBodyCommand) {
      items.push({
        type: 'Command',
        label: `/${cmd.frontmatter.name}`,
        sublabel: inBodyCommand || cmd.frontmatter.description || '',
        to: `/commands/${cmd.slug}`,
        icon: 'i-lucide-terminal',
      })
    }
  }

  for (const skill of skills.value) {
    const inBodySkill = bodyHit((skill as { body?: string }).body, q)
    if (skill.frontmatter.name.toLowerCase().includes(q) || skill.frontmatter.description?.toLowerCase().includes(q) || inBodySkill) {
      items.push({
        type: 'Skill',
        label: skill.frontmatter.name,
        sublabel: inBodySkill || skill.frontmatter.description || '',
        to: `/skills/${skill.slug}`,
        icon: 'i-lucide-sparkles',
      })
    }
  }

  for (const plugin of plugins.value) {
    if (plugin.name.toLowerCase().includes(q) || plugin.description?.toLowerCase().includes(q)) {
      items.push({
        type: 'Plugin',
        label: plugin.name,
        sublabel: plugin.description || '',
        to: `/plugins/${encodeURIComponent(plugin.id)}`,
        icon: 'i-lucide-puzzle',
      })
    }
  }

  // Runs are the app's actual unit of work and were not indexed at all, so
  // typing a ticket key returned "No results found" — indistinguishable from
  // "that ticket does not exist". /runs already accepts ?q=, so hand the
  // query over rather than duplicating a run index here.
  items.push({
    type: 'Runs',
    label: `Search runs for "${query.value.trim()}"`,
    sublabel: 'by ticket, workflow, product or person',
    to: `/runs?q=${encodeURIComponent(query.value.trim())}`,
    icon: 'i-lucide-play',
  })
  return items.slice(0, 10)
})

watch(query, () => { selectedIndex.value = 0 })

function navigate(to: string) {
  router.push(to)
  open.value = false
  query.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, results.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  } else if (e.key === 'Enter') {
    const hit = results.value[selectedIndex.value]
    if (!hit) return
    e.preventDefault()
    navigate(hit.to)
  }
}

// Global Cmd+K
if (import.meta.client) {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      open.value = !open.value
      if (!open.value) query.value = ''
    }
  }
  onMounted(() => document.addEventListener('keydown', handler))
  onUnmounted(() => document.removeEventListener('keydown', handler))
}
</script>

<template>
  <UModal v-model:open="open" title="Search"
    description="Search agents, skills, commands, workflows and runs.">
    <template #content>
      <div style="min-height: 120px; max-height: 420px;" class="bg-overlay rounded-xl overflow-hidden flex flex-col">
        <!-- Search input -->
        <div class="flex items-center gap-3 px-4 py-3" style="border-bottom: 1px solid var(--border-subtle);">
          <UIcon name="i-lucide-search" class="size-4 shrink-0 text-meta" />
          <input
            v-model="query"
            class="flex-1 bg-transparent t-ui outline-none"
            placeholder="Search runs, agents, skills, commands…"
            autofocus
            @keydown="onKeydown"
          />
          <kbd class="t-small font-mono px-1.5 py-0.5 rounded badge badge-subtle">ESC</kbd>
        </div>

        <!-- Results -->
        <div class="flex-1 overflow-auto py-1">
          <div v-if="query && !results.length" class="flex flex-col items-center justify-center py-8">
            <p class="t-ui text-label">No results found</p>
          </div>

          <div v-if="!query" class="flex flex-col items-center justify-center py-8">
            <p class="t-small text-meta">Type to search across all items</p>
          </div>

          <button
            v-for="(result, idx) in results"
            :key="result.to"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
            :style="{
              background: idx === selectedIndex ? 'var(--surface-hover)' : 'transparent',
            }"
            @mouseenter="selectedIndex = idx"
            @click="navigate(result.to)"
          >
            <div
              v-if="result.color"
              class="size-2 rounded-full shrink-0"
              :style="{ background: result.color }"
            />
            <UIcon v-else :name="result.icon" class="size-4 shrink-0 text-meta" />

            <span class="font-mono t-ui font-medium w-40 shrink-0 truncate">
              {{ result.label }}
            </span>

            <span
              v-if="result.model"
              class="t-small font-mono font-medium px-1 py-px rounded-full shrink-0"
              :class="[getModelBadgeClasses(result.model).bg, getModelBadgeClasses(result.model).text]"
            >
              {{ result.model }}
            </span>

            <span class="flex-1 t-small truncate text-label">
              {{ result.sublabel }}
            </span>

            <span class="t-small font-mono shrink-0 text-meta">
              {{ result.type }}
            </span>
          </button>
        </div>
      </div>
    </template>
  </UModal>
</template>
