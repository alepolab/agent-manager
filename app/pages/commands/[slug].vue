<script setup lang="ts">
const { promoting, promote } = usePromote()
import type { Command, CommandFrontmatter } from '~/types'
import InstructionEditor from '~/components/studio/InstructionEditor.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { fetchOne, update, remove } = useCommands()
const { reveal } = useReveal()
const { localDesktop } = useClaudeDir()
const { prefillSkill } = useChat()

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

const { hasDraft, draftAge, loadDraft, clearDraft, scheduleSave } = useDraftRecovery(`command:${slug}`)

watch([frontmatter, body], () => {
  if (command.value && isDirty.value) scheduleSave(frontmatter.value, body.value)
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

onMounted(async () => {
  try {
    command.value = await fetchOne(slug)
    frontmatter.value = { ...command.value.frontmatter }
    body.value = command.value.body
    allowedToolsStr.value = (command.value.frontmatter['allowed-tools'] || []).join(', ')
  } catch {
    toast.add({ title: 'Command not found', color: 'error' })
    router.push('/commands')
  }
})

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
    const payload = {
      frontmatter: {
        ...frontmatter.value,
        'allowed-tools': tools.length > 0 ? tools : undefined,
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
    else toast.add({ title: 'Failed to save', description: e.data?.message || e.message, color: 'error' })
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
    || allowedToolsStr.value !== (command.value.frontmatter['allowed-tools'] || []).join(', ')
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
          class="font-mono text-[10px] font-medium px-1.5 py-px rounded-full badge badge-subtle"
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
        <UButton
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
          label="Delete"
          icon="i-lucide-trash-2"
          size="sm"
          variant="ghost"
          color="error"
          @click="() => { showDeleteConfirm = true }"
        />
        <UButton 
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
          <div
            v-if="hasDraft"
            class="rounded-xl px-4 py-3 flex items-center gap-3"
            style="background: rgba(59, 130, 246, 0.06); border: 1px solid rgba(59, 130, 246, 0.12);"
          >
            <UIcon name="i-lucide-archive-restore" class="size-4 shrink-0" style="color: var(--info, #3b82f6);" />
            <span class="text-[12px] flex-1" style="color: var(--text-secondary);">
              You have an unsaved draft from {{ draftAge }}.
            </span>
            <button class="text-[12px] font-medium px-2 py-1 rounded hover-bg" style="color: var(--info, #3b82f6);" @click="restoreDraft">Restore</button>
            <button class="text-[12px] px-2 py-1 rounded hover-bg text-meta" @click="clearDraft">Dismiss</button>
          </div>
        </ClientOnly>

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
          <summary class="text-[10px] cursor-pointer list-none flex items-center gap-1.5 text-meta hover:text-label transition-colors">
            <UIcon name="i-lucide-file" class="size-3" />
            Show file location
          </summary>
          <div class="mt-2 font-mono text-[10px] pl-4.5 text-meta break-all select-all py-1.5 px-2 rounded bg-card border border-subtle">
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
          <p class="text-[13px] text-body">
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
