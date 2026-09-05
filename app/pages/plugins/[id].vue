<script setup lang="ts">
import type { PluginDetail, SkillFrontmatter } from '~/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { fetchOne, updateSkill, toggleEnabled, uninstall } = usePlugins()

const id = decodeURIComponent(route.params.id as string)
const plugin = ref<PluginDetail | null>(null)
const loading = ref(true)

// Track editable skill state
const editingSkill = ref<string | null>(null)
const skillFrontmatters = ref<Record<string, SkillFrontmatter>>({})
const skillBodies = ref<Record<string, string>>({})
const savingSkill = ref(false)

// Uninstall
const showUninstallConfirm = ref(false)
const uninstalling = ref(false)

onMounted(async () => {
  try {
    plugin.value = await fetchOne(id)
    for (const skill of plugin.value.skillDetails) {
      skillFrontmatters.value[skill.slug] = { ...skill.frontmatter }
      skillBodies.value[skill.slug] = skill.body
    }
  } catch {
    toast.add({ title: 'Plugin not found', color: 'error' })
    router.push('/plugins')
  } finally {
    loading.value = false
  }
})

/**
 * Editable state for one skill, created on demand.
 *
 * `skillFrontmatters` / `skillBodies` are keyed by slug, and under
 * noUncheckedIndexedAccess every lookup is `T | undefined` - which the template
 * cannot narrow, so eight bindings here read a possibly-undefined object. These
 * accessors give the template a value that always exists, and seed the record
 * the first time a skill is opened rather than relying on it having been
 * pre-populated.
 */
function frontmatterFor(slug: string): SkillFrontmatter {
  const existing = skillFrontmatters.value[slug]
  if (existing) return existing
  const seeded = { name: '', description: '' } as SkillFrontmatter
  skillFrontmatters.value[slug] = seeded
  return seeded
}

function bodyFor(slug: string): string {
  return skillBodies.value[slug] ?? ''
}

/** Assignment expressions evaluate to the assigned value, so an inline
 *  `@click="closeUninstallConfirm"` infers a handler returning boolean
 *  where the typed emit requires void. A named function returns void. */
function closeUninstallConfirm() {
  showUninstallConfirm.value = false
}

function toggleSkillEditor(slug: string) {
  editingSkill.value = editingSkill.value === slug ? null : slug
}

async function saveSkill(slug: string) {
  savingSkill.value = true
  try {
    await updateSkill(id, slug, frontmatterFor(slug), bodyFor(slug))
    const skill = plugin.value?.skillDetails.find(s => s.slug === slug)
    if (skill) {
      skill.frontmatter = { ...frontmatterFor(slug) }
      skill.body = bodyFor(slug)
    }
    toast.add({ title: 'Skill saved', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Failed to save', description: e.message, color: 'error' })
  } finally {
    savingSkill.value = false
  }
}

async function onToggle(enabled: boolean) {
  try {
    await toggleEnabled(id, enabled)
    if (plugin.value) plugin.value.enabled = enabled
    toast.add({ title: `Plugin ${enabled ? 'enabled' : 'disabled'}`, color: 'success' })
  } catch {
    toast.add({ title: 'Failed to update', color: 'error' })
  }
}

async function onUninstall() {
  uninstalling.value = true
  try {
    await uninstall(id)
    toast.add({ title: 'Plugin uninstalled', color: 'success' })
    router.push('/plugins')
  } catch (e: any) {
    toast.add({ title: 'Failed to uninstall', description: e.message, color: 'error' })
  } finally {
    uninstalling.value = false
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Cmd+S to save current skill
if (import.meta.client) {
  const onKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && editingSkill.value) {
      e.preventDefault()
      saveSkill(editingSkill.value)
    }
  }
  onMounted(() => document.addEventListener('keydown', onKeydown))
  onUnmounted(() => document.removeEventListener('keydown', onKeydown))
}
</script>

<template>
  <div>
    <PageHeader :title="plugin?.name || id">
      <template #leading>
        <NuxtLink to="/plugins" class="focus-ring rounded p-1.5 -m-1.5" aria-label="Back to plugins">
          <UIcon name="i-lucide-arrow-left" class="size-4 text-label" />
        </NuxtLink>
      </template>
      <template #trailing>
        <div
          class="size-2.5 rounded-full shrink-0"
          :style="{ background: plugin?.enabled ? 'var(--success, #22c55e)' : 'var(--text-disabled)' }"
        />
      </template>
      <template #right>
        <button
          class="text-[12px] px-2 py-1 rounded focus-ring text-label"
          @click="showUninstallConfirm = true"
        >
          Uninstall
        </button>
        <label v-if="plugin" class="field-toggle" title="Enable/disable plugin">
          <input
            type="checkbox"
            :checked="plugin.enabled"
            @change="onToggle(($event.target as HTMLInputElement).checked)"
          />
          <span class="field-toggle__track">
            <span class="field-toggle__thumb" />
          </span>
        </label>
      </template>
    </PageHeader>

    <div v-if="loading" class="flex justify-center py-16">
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-meta" />
    </div>

    <div v-else-if="plugin" class="px-6 py-5 space-y-6">
      <!-- Plugin info card -->
      <div
        class="rounded-xl overflow-hidden"
        style="border: 1px solid var(--border-subtle);"
      >
        <div class="relative px-5 pt-6 pb-5" style="background: var(--surface-raised);">
          <!-- Top accent bar -->
          <div
            class="absolute inset-x-0 top-0 h-[3px]"
            :style="{ background: plugin.enabled ? 'var(--success, #22c55e)' : 'var(--text-disabled)' }"
          />

          <div class="flex items-start gap-4">
            <div
              class="size-11 rounded-xl flex items-center justify-center shrink-0"
              style="background: var(--badge-subtle-bg); border: 1px solid var(--border-subtle);"
            >
              <UIcon name="i-lucide-puzzle" class="size-5" style="color: var(--accent);" />
            </div>

            <div class="flex-1 min-w-0 pt-0.5">
              <div class="flex items-center gap-2.5 flex-wrap">
                <span class="text-[15px] font-semibold tracking-tight truncate">
                  {{ plugin.name }}
                </span>
                <span
                  class="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full shrink-0 badge badge-subtle"
                >
                  v{{ plugin.version }}
                </span>
                <span
                  class="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full shrink-0 badge"
                  :class="plugin.enabled ? 'badge-success' : 'badge-subtle'"
                >
                  {{ plugin.enabled ? 'enabled' : 'disabled' }}
                </span>
              </div>
              <p v-if="plugin.description" class="text-[12px] mt-1 leading-relaxed text-label">
                {{ plugin.description }}
              </p>
            </div>
          </div>
        </div>

        <!-- Metadata -->
        <div class="px-5 py-3 flex items-center gap-6 flex-wrap" style="background: var(--surface-base); border-top: 1px solid var(--border-subtle);">
          <div class="flex items-center gap-1.5">
            <span class="text-[12px] text-meta">Marketplace</span>
            <span class="font-mono text-[12px] text-body">{{ plugin.marketplace }}</span>
          </div>
          <div v-if="plugin.author" class="flex items-center gap-1.5">
            <span class="text-[12px] text-meta">Author</span>
            <span class="font-mono text-[12px] text-body">{{ plugin.author.name }}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="text-[12px] text-meta">Installed</span>
            <span class="font-mono text-[12px] text-body">{{ formatDate(plugin.installedAt) }}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="text-[12px] text-meta">Skills</span>
            <span class="font-mono text-[12px] text-body">{{ plugin.skillDetails.length }}</span>
          </div>
        </div>
      </div>

      <!-- Skills -->
      <div v-if="plugin.skillDetails.length">
        <h3 class="text-section-label mb-3">Skills</h3>
        <div class="space-y-2">
          <div
            v-for="skill in plugin.skillDetails"
            :key="skill.slug"
            class="rounded-xl overflow-hidden"
            style="border: 1px solid var(--border-subtle);"
          >
            <!-- Skill header (clickable) -->
            <button
              class="w-full flex items-center gap-3 px-4 py-3 text-left hover-bg"
              :style="{ background: editingSkill === skill.slug ? 'var(--surface-raised)' : undefined }"
              @click="toggleSkillEditor(skill.slug)"
            >
              <UIcon
                :name="editingSkill === skill.slug ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                class="size-3.5 shrink-0 text-meta"
              />
              <span class="text-[13px] font-medium w-40 shrink-0 truncate">
                {{ skill.frontmatter.name }}
              </span>
              <span
                v-if="skill.frontmatter.context"
                class="text-[10px] font-mono px-1.5 py-px rounded-full shrink-0 badge badge-subtle"
              >
                {{ skill.frontmatter.context }}
              </span>
              <span
                v-if="skill.frontmatter.agent"
                class="text-[10px] font-mono px-1.5 py-px rounded-full shrink-0 badge badge-agent"
              >
                agent: {{ skill.frontmatter.agent }}
              </span>
              <span class="flex-1 text-[12px] truncate text-label">
                {{ skill.frontmatter.description }}
              </span>
              <span class="font-mono text-[10px] shrink-0 text-meta">
                {{ Math.round(skill.body.length / 100) / 10 }}k chars
              </span>
            </button>

            <!-- Expanded editor -->
            <div v-if="editingSkill === skill.slug" style="border-top: 1px solid var(--border-subtle);">
              <!-- Skill frontmatter fields -->
              <div class="px-5 py-4 space-y-4" style="background: var(--surface-base);">
                <h4 class="text-section-label">Configuration</h4>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div class="field-group">
                    <label class="field-label">Name</label>
                    <input v-model="frontmatterFor(skill.slug).name" class="field-input" />
                  </div>
                  <div class="field-group">
                    <label class="field-label">Context</label>
                    <input v-model="frontmatterFor(skill.slug).context" class="field-input" placeholder="e.g. fork" />
                  </div>
                  <div class="field-group sm:col-span-2">
                    <label class="field-label">Description</label>
                    <input v-model="frontmatterFor(skill.slug).description" class="field-input" />
                  </div>
                  <div class="field-group">
                    <label class="field-label">Agent</label>
                    <input v-model="frontmatterFor(skill.slug).agent" class="field-input" placeholder="Optional agent name" />
                  </div>
                </div>
              </div>

              <!-- Body editor -->
              <div style="border-top: 1px solid var(--border-subtle);">
                <div class="flex items-center justify-between px-4 py-2.5" style="background: var(--surface-raised); border-bottom: 1px solid var(--border-subtle);">
                  <h4 class="text-section-label">Instructions</h4>
                  <div class="flex items-center gap-3">
                    <span class="font-mono text-[10px] text-meta">
                      {{ bodyFor(skill.slug).split('\n').length }} lines
                    </span>
                    <span class="font-mono text-[10px] text-meta">
                      {{ bodyFor(skill.slug).length.toLocaleString() }} chars
                    </span>
                  </div>
                </div>
                <textarea
                  v-model="skillBodies[skill.slug]"
                  class="editor-textarea"
                  style="min-height: 300px;"
                  spellcheck="false"
                  placeholder="Skill prompt..."
                />
              </div>

              <!-- Save bar -->
              <div class="flex items-center justify-between px-4 py-3" style="background: var(--surface-raised); border-top: 1px solid var(--border-subtle);">
                <span class="font-mono text-[10px] truncate text-meta">
                  {{ skill.filePath }}
                </span>
                <UButton label="Save Skill" icon="i-lucide-save" size="sm" :loading="savingSkill" @click="saveSkill(skill.slug)" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- No skills -->
      <div v-else class="flex flex-col items-center justify-center py-12 space-y-3">
        <UIcon name="i-lucide-puzzle" class="size-8 text-meta" />
        <p class="text-[13px] text-label">This plugin has no skills.</p>
      </div>

      <!-- File location (collapsed) -->
      <details class="group">
        <summary class="text-[10px] cursor-pointer list-none flex items-center gap-1.5 text-meta">
          <UIcon name="i-lucide-file" class="size-3" />
          Show file location
        </summary>
        <div class="mt-1 font-mono text-[10px] pl-4.5 text-meta">
          {{ plugin.installPath }}
        </div>
      </details>
    </div>

    <!-- Uninstall confirmation -->
    <UModal v-model:open="showUninstallConfirm">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Uninstall Plugin</h3>
          <p class="text-[13px] text-body">
            Uninstall <strong>{{ plugin?.name }}</strong>? The plugin will be removed but its files will remain on your computer.
          </p>
          <div class="flex justify-end gap-2">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="closeUninstallConfirm" />
            <UButton label="Uninstall" color="error" size="sm" :loading="uninstalling" @click="onUninstall" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
