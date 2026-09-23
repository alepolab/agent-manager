<script setup lang="ts">
const { promoting, promote } = usePromote()
import type { Command, CommandFrontmatter } from '~/types'
import InstructionEditor from '~/components/studio/InstructionEditor.vue'
import { errorToast } from '~/utils/errorToast'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { fetchOne, update, remove } = useCommands()
const { reveal } = useReveal()
const { localDesktop } = useClaudeDir()
const { prefillSkill } = useChat()
const { can } = useUser()

const slug = route.params.slug as string
const command = ref<Command | null>(null)
const saving = ref(false)
const lastModified = ref<number | null>(null)

const frontmatter = ref<CommandFrontmatter>({
  name: '',
  description: '',
})
const body = ref('')
const allowedToolsStr = ref('')

function toolsToText(tools: CommandFrontmatter['allowed-tools']): string {
  if (Array.isArray(tools)) return tools.join(', ')
  return tools?.trim() ?? ''
}

const { hasDraft, draftAge, loadDraft, clearDraft, scheduleSave } = useDraftRecovery(`command:${slug}`)

// Arm the draft only for someone who could save it; recovering one stays open
// so a role change under a person does not eat their work.
watch([frontmatter, body], () => {
  if (command.value && isDirty.value && can('configure')) scheduleSave(frontmatter.value, body.value)
}, { deep: true })

function restoreDraft() {
  const draft = loadDraft()
  if (draft) {
    frontmatter.value = draft.frontmatter as unknown as CommandFrontmatter
    body.value = draft.body
    clearDraft()
    toast.add({ title: 'Draft restored', color: 'success' })
  }
}

function applyCommand(item: Command) {
  command.value = item
  frontmatter.value = { ...item.frontmatter }
  body.value = item.body
  allowedToolsStr.value = toolsToText(item.frontmatter['allowed-tools'])
  // Without it the first save skips the server's changed-on-disk check.
  lastModified.value = (item as any).lastModified ?? null
}

onMounted(async () => {
  try {
    applyCommand(await fetchOne(slug))
  } catch {
    toast.add({ title: 'Command not found', color: 'error' })
    router.push('/commands')
  }
})

const { pending: externalPending, ...external } = useExternalChange({
  fetch: () => fetchOne(slug),
  baseline: () => command.value && { frontmatter: command.value.frontmatter, body: command.value.body },
  content: (item: Command) => ({ frontmatter: item.frontmatter, body: item.body }),
  isDirty: () => isDirty.value,
  apply: applyCommand,
  paused: () => !command.value || saving.value,
})
function reloadExternal() {
  external.reload()
  clearDraft()
}
function keepMine() {
  // Adopting their timestamp is what lets the next save overwrite instead of failing with 409.
  const theirs = external.keepMine()
  if (theirs) lastModified.value = (theirs as any).lastModified ?? null
}

async function save() {
  if (!frontmatter.value.name.trim()) {
    toast.add({ title: 'Name is required', color: 'error' })
    return
  }
  saving.value = true
  try {
    const tools = allowedToolsStr.value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    // Write back the shape the file already used, so saving doesn't reformat it
    const wasString = typeof command.value?.frontmatter['allowed-tools'] === 'string'
    const payload = {
      frontmatter: {
        ...frontmatter.value,
        'allowed-tools': tools.length === 0 ? undefined : wasString ? tools.join(', ') : tools,
      },
      body: body.value,
    }
    const updated = await update(slug, { ...payload, lastModified: lastModified.value ?? undefined } as any)
    command.value = updated
    lastModified.value = (updated as any).lastModified ?? null
    lastModified.value = (updated as any).lastModified ?? null
    clearDraft()
    toast.add({ title: 'Saved', color: 'success' })

    if (updated.slug !== slug) {
      router.push(`/commands/${updated.slug}`)
    }
  } catch (e: any) {
    if (e?.statusCode === 409 || e?.data?.statusCode === 409) toast.add({ title: 'Changed by someone else', description: (e.data?.message || 'Reload to see the latest version before saving again.') + (e.data?.data?.lastModified ? ` Last saved ${new Date(e.data.data.lastModified).toLocaleTimeString()}.` : ''), color: 'warning' })
    else toast.add(errorToast('Failed to save command', e))
  } finally {
    saving.value = false
  }
}

const showDeleteConfirm = ref(false)

async function deleteCommand() {
  try {
    await remove(slug)
    toast.add({ title: 'Deleted', color: 'success' })
    router.push('/commands')
  } catch {
    toast.add({ title: 'Failed to delete', color: 'error' })
  }
}

// Cmd+S to save
if (import.meta.client) {
  const onKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      save()
    }
  }
  onMounted(() => document.addEventListener('keydown', onKeydown))
  onUnmounted(() => document.removeEventListener('keydown', onKeydown))
}

const charCount = computed(() => body.value.length)
const lineCount = computed(() => body.value.split('\n').length)

const isDirty = computed(() => {
  if (!command.value) return false
  return JSON.stringify(frontmatter.value) !== JSON.stringify(command.value.frontmatter)
    || body.value !== command.value.body
    || allowedToolsStr.value !== toolsToText(command.value.frontmatter['allowed-tools'])
})

const isDraftComputed = computed(() => {
  if (!command.value) return false
  return body.value !== command.value.body || JSON.stringify(frontmatter.value) !== JSON.stringify(command.value.frontmatter)
})

useUnsavedChanges(isDirty)
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader :title="command?.frontmatter.name || slug">
      <template #leading>
        <NuxtLink to="/commands" class="focus-ring rounded p-1.5 -m-1.5" aria-label="Back to commands">
          <UIcon name="i-lucide-arrow-left" class="size-4 text-label" />
        </NuxtLink>
      </template>
      <template #trailing>
        <span
          v-if="command"
          class="font-mono t-small font-medium px-1.5 py-px rounded-full badge badge-subtle"
        >
          {{ command.directory }}
        </span>
      </template>
      <template #right>
        <UButton
          icon="i-lucide-message-square"
          size="sm"
          variant="ghost"
          color="neutral"
          title="Use Command in Chat"
          :disabled="!command"
          @click="prefillSkill(command!.frontmatter.name)"
        />
        <UButton
          v-if="localDesktop && command?.filePath"
          icon="i-lucide-folder-open"
          size="sm"
          variant="ghost"
          color="neutral"
          title="Open in Finder"
          @click="reveal(command.filePath)"
        />
        <ReadOnlyBadge v-if="!can('configure')" reason="changing a command" />
        <UButton
          v-if="can('configure')"
          label="Promote to team"
          icon="i-lucide-git-pull-request"
          size="sm"
          variant="ghost"
          color="neutral"
          title="Open a pull request that adds this command to the alepo-engineering plugin"
          :loading="promoting"
          :disabled="!command || isDirty || promoting"
          @click="promote('command', slug)"
        />
        <UButton
          v-if="can('configure')"
          label="Delete"
          icon="i-lucide-trash-2"
          size="sm"
          variant="ghost"
          color="error"
          @click="() => { showDeleteConfirm = true }"
        />
        <UButton 
          v-if="can('configure')"
          label="Save" 
          icon="i-lucide-save" 
          size="sm" 
          :loading="saving" 
          :variant="isDirty ? 'solid' : 'soft'" 
          :color="isDirty ? 'primary' : 'neutral'" 
          :disabled="!isDirty || saving"
          @click="save" 
        />
      </template>
    </PageHeader>

    <div v-if="command" class="px-6 py-5 space-y-6">
      <div class="flex flex-col space-y-6">
        <!-- Draft recovery banner -->
        <ClientOnly>
          <DraftRecoveryBanner v-if="hasDraft" :age="draftAge" @restore="restoreDraft" @dismiss="clearDraft" />
        </ClientOnly>
        <ExternalChangeBanner v-if="externalPending" @reload="reloadExternal" @keep="keepMine" />

        <!-- Configuration -->
        <div class="rounded-xl p-5 space-y-4 bg-card">
          <h3 class="text-section-label">Configuration</h3>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="field-group">
              <label class="field-label">Name</label>
              <input v-model="frontmatter.name" class="field-input" />
              <span class="field-hint">The slash command name (e.g., "deploy" becomes /deploy)</span>
            </div>
            <div class="field-group">
              <label class="field-label">Expected Input</label>
              <input v-model="frontmatter['argument-hint']" class="field-input" placeholder="file name or topic" />
              <span class="field-hint">Shown as a hint when users type this command</span>
            </div>
          </div>

          <div class="field-group">
            <label class="field-label">Description</label>
            <textarea v-model="frontmatter.description" rows="4" class="field-textarea" />
            <span class="field-hint">Helps Claude understand when to suggest this command</span>
          </div>

          <div class="field-group">
            <label class="field-label">Tool Permissions</label>
            <input v-model="allowedToolsStr" class="field-input" placeholder="Read, Write, Bash" />
            <span class="field-hint">Restrict what Claude can do. Leave blank to allow all. Options: Read, Write, Edit, Bash, Glob, Grep</span>
          </div>
        </div>

        <!-- Command Body Editor -->
        <div class="rounded-xl overflow-hidden bg-card flex flex-col" style="border: 1px solid var(--border-subtle); height: 500px;">
          <InstructionEditor
            v-model="body"
            :agent-name="frontmatter.name"
            :agent-description="frontmatter.description"
          />
        </div>

        <!-- File location (collapsed) -->
        <details class="group">
          <summary class="t-small cursor-pointer list-none flex items-center gap-1.5 text-meta hover:text-label transition-colors">
            <UIcon name="i-lucide-file" class="size-3" />
            Show file location
          </summary>
          <div class="mt-2 font-mono t-small pl-4.5 text-meta break-all select-all py-1.5 px-2 rounded bg-card border border-subtle">
            {{ command.filePath }}
          </div>
        </details>
      </div>
    </div>

    <div v-else class="flex justify-center py-16">
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-meta" />
    </div>

    <!-- Delete confirmation -->
    <UModal v-model:open="showDeleteConfirm">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Delete Command</h3>
          <p class="t-ui text-body">
            Permanently delete <strong>/{{ command?.frontmatter.name }}</strong>? This action cannot be undone.
          </p>
          <div class="flex justify-end gap-2">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showDeleteConfirm = false }" />
            <UButton label="Delete" color="error" size="sm" @click="deleteCommand" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
