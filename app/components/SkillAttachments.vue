<script setup lang="ts">
import type { SkillAttachment } from '~/types'
import { errorToast } from '~/utils/errorToast'

const props = defineProps<{
  slug: string
  workingDir?: string
  /** The person may change this skill. Without it the list is download-only. */
  editable: boolean
  /** The editor holds unsaved changes. An upload rewrites SKILL.md, so it waits for a save. */
  dirty: boolean
}>()

const emit = defineEmits<{
  /** SKILL.md was rewritten on disk; the page reloads it and adopts the new timestamp. */
  changed: [lastModified: number]
  /** Put a reference to this attachment into the prompt where the person is writing. */
  insert: [attachment: SkillAttachment]
}>()

const MAX_BYTES = 25 * 1024 * 1024

const toast = useToast()
const attachments = ref<SkillAttachment[]>([])
// null until the first list returns; false when the skill cannot hold attachments (GitHub, plugin).
const supported = ref<boolean | null>(null)
const uploading = ref(false)
const removing = ref<string | null>(null)
const dragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// Import a skill folder on this machine (e.g. a project's .claude/skills/<name>): preview, then apply.
interface ImportPreview { added: string[], changed: string[], unchanged: number, skillFileDiffers: boolean, skillFileUpdated: boolean, applied: boolean }
const importOpen = ref(false)
const importSource = ref('')
const importSkillFile = ref(false)
const importPreview = ref<ImportPreview | null>(null)
const importing = ref(false)

const base = computed(() => `/api/skills/${encodeURIComponent(props.slug)}/attachments`)
const query = computed(() => props.workingDir ? { workingDir: props.workingDir } : {})
const queryString = computed(() => props.workingDir ? `?workingDir=${encodeURIComponent(props.workingDir)}` : '')
const blockedReason = computed(() => props.dirty ? 'Save your changes first: attaching a file updates SKILL.md.' : '')

async function load() {
  try {
    const res = await $fetch<{ attachments: SkillAttachment[] }>(base.value, { query: query.value })
    attachments.value = res.attachments
    supported.value = true
  } catch {
    supported.value = false
  }
}
onMounted(load)

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  if (e.dataTransfer?.files.length) upload(Array.from(e.dataTransfer.files))
}

function onFileSelect(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (files?.length) upload(Array.from(files))
}

async function upload(files: File[]) {
  if (!props.editable || uploading.value) return
  if (blockedReason.value) {
    toast.add({ title: 'Unsaved changes', description: blockedReason.value, color: 'warning' })
    return
  }
  const tooBig = files.filter(f => f.size > MAX_BYTES)
  if (tooBig.length) {
    toast.add({ title: 'File too large', description: `${tooBig.map(f => f.name).join(', ')}: the limit is 25 MB per file.`, color: 'error' })
    return
  }

  const form = new FormData()
  for (const f of files) form.append('files', f, f.name)
  uploading.value = true
  try {
    const res = await $fetch<{ attachments: SkillAttachment[], lastModified: number }>(base.value, { method: 'POST', body: form, query: query.value })
    attachments.value = res.attachments
    emit('changed', res.lastModified)
    toast.add({ title: files.length === 1 ? 'File attached' : `${files.length} files attached`, color: 'success' })
  } catch (e) {
    toast.add(errorToast('Failed to attach', e))
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function removeAttachment(a: SkillAttachment) {
  if (blockedReason.value) {
    toast.add({ title: 'Unsaved changes', description: blockedReason.value, color: 'warning' })
    return
  }
  removing.value = a.path
  try {
    const res = await $fetch<{ attachments: SkillAttachment[], lastModified: number }>(fileUrl(a), { method: 'DELETE', query: query.value })
    attachments.value = res.attachments
    emit('changed', res.lastModified)
    toast.add({ title: 'Attachment removed', color: 'success' })
  } catch (e) {
    toast.add(errorToast('Failed to remove attachment', e))
  } finally {
    removing.value = null
  }
}

/** A skill path as a URL path: each segment encoded, the slashes kept for the catch-all route. */
function fileUrl(a: SkillAttachment) {
  return `${base.value}/${a.path.split('/').map(encodeURIComponent).join('/')}`
}

function folderOf(a: SkillAttachment) {
  const i = a.path.lastIndexOf('/')
  return i === -1 ? '' : a.path.slice(0, i + 1)
}

async function runImport(apply: boolean) {
  if (!importSource.value.trim() || importing.value) return
  if (apply && blockedReason.value) {
    toast.add({ title: 'Unsaved changes', description: blockedReason.value, color: 'warning' })
    return
  }
  importing.value = true
  try {
    const res = await $fetch<ImportPreview & { attachments: SkillAttachment[], lastModified: number }>(`${base.value}/import`, {
      method: 'POST', query: query.value, body: { source: importSource.value.trim(), apply, skillFile: importSkillFile.value },
    })
    importPreview.value = res
    if (apply) {
      attachments.value = res.attachments
      emit('changed', res.lastModified)
      const n = res.added.length + res.changed.length
      toast.add({ title: `${n} file${n === 1 ? '' : 's'} imported${res.skillFileUpdated ? ', SKILL.md updated' : ''}`, color: 'success' })
      importOpen.value = false
      importPreview.value = null
    }
  } catch (e) {
    toast.add(errorToast(apply ? 'Import failed' : 'Could not read that folder', e))
  } finally {
    importing.value = false
  }
}

function pickFiles() {
  if (blockedReason.value) {
    toast.add({ title: 'Unsaved changes', description: blockedReason.value, color: 'warning' })
    return
  }
  fileInput.value?.click()
}
</script>

<template>
  <div
    v-if="supported"
    class="rounded-xl"
    :style="{
      background: 'var(--surface-raised)',
      border: dragOver ? '1px dashed var(--accent)' : '1px solid var(--border-subtle)',
    }"
    @dragover.prevent="editable && (dragOver = true)"
    @dragleave="dragOver = false"
    @drop.prevent="editable && onDrop($event)"
  >
    <div class="flex items-center gap-3 px-4 py-3">
      <UIcon name="i-lucide-paperclip" class="size-4 text-label" />
      <div class="flex-1 min-w-0">
        <h3 class="text-section-label">Skill files</h3>
        <p class="t-small text-meta">
          References, scripts and other files this skill uses, at their paths in the skill's folder. They are listed in SKILL.md so Claude knows they exist.
        </p>
      </div>
      <template v-if="editable">
        <input ref="fileInput" type="file" multiple class="hidden" @change="onFileSelect" />
        <UButton
          label="Attach files"
          icon="i-lucide-upload"
          size="sm"
          color="neutral"
          variant="soft"
          :loading="uploading"
          :disabled="uploading"
          :title="blockedReason || 'Attach files to this skill (up to 25 MB each)'"
          @click="pickFiles"
        />
        <UButton
          label="Import folder"
          icon="i-lucide-folder-input"
          size="sm"
          color="neutral"
          variant="soft"
          title="Copy a skill folder on this machine into this skill, keeping its scripts/ and references/ paths"
          @click="importOpen = !importOpen; importPreview = null"
        />
      </template>
    </div>

    <div v-if="editable && importOpen" class="px-4 pb-3 flex flex-col gap-2" style="border-top: 1px solid var(--border-subtle);">
      <p class="t-small text-meta pt-3">
        Absolute path of a skill folder, e.g. a project's <code>.claude/skills/{{ slug }}</code>. Files are added or updated at the same paths; files only this skill has are kept.
      </p>
      <div class="flex items-center gap-2">
        <UInput v-model="importSource" size="sm" class="flex-1 font-mono" placeholder="/home/me/repo/.claude/skills/my-skill" @keydown.enter="runImport(false)" />
        <UButton label="Preview" size="sm" color="neutral" variant="soft" :loading="importing && !importPreview" :disabled="!importSource.trim() || importing" @click="runImport(false)" />
      </div>
      <template v-if="importPreview">
        <p class="t-small">
          {{ importPreview.added.length }} new, {{ importPreview.changed.length }} changed, {{ importPreview.unchanged }} already the same.
          <span v-if="importPreview.skillFileDiffers">The source's SKILL.md differs from this one.</span>
        </p>
        <ul v-if="importPreview.added.length || importPreview.changed.length" class="t-small font-mono max-h-48 overflow-auto">
          <li v-for="p in importPreview.added" :key="`a-${p}`">+ {{ p }}</li>
          <li v-for="p in importPreview.changed" :key="`c-${p}`">~ {{ p }}</li>
        </ul>
        <label v-if="importPreview.skillFileDiffers" class="t-small flex items-center gap-2">
          <input v-model="importSkillFile" type="checkbox" />
          Also replace SKILL.md with the source's (the file list section is kept)
        </label>
        <div>
          <UButton
            label="Import"
            icon="i-lucide-check"
            size="sm"
            :loading="importing"
            :disabled="importing || (!importPreview.added.length && !importPreview.changed.length && !(importSkillFile && importPreview.skillFileDiffers))"
            :title="blockedReason || 'Copy these files into this skill'"
            @click="runImport(true)"
          />
        </div>
      </template>
    </div>

    <div v-if="attachments.length" style="border-top: 1px solid var(--border-subtle);">
      <div
        v-for="a in attachments"
        :key="a.path"
        class="flex items-center gap-3 px-4 py-2"
      >
        <UIcon name="i-lucide-file" class="size-3.5 shrink-0 text-meta" />
        <span class="t-small font-mono truncate flex-1" :title="a.path"><span class="text-meta">{{ folderOf(a) }}</span>{{ a.name }}</span>
        <span class="t-small text-meta shrink-0">{{ formatSize(a.size) }}</span>
        <UButton
          v-if="editable"
          icon="i-lucide-text-cursor-input"
          size="xs"
          variant="ghost"
          color="neutral"
          :title="`Insert a reference to ${a.path} into the prompt`"
          :aria-label="`Insert reference to ${a.name}`"
          @click="emit('insert', a)"
        />
        <UButton
          icon="i-lucide-download"
          size="xs"
          variant="ghost"
          color="neutral"
          :to="`${fileUrl(a)}${queryString}`"
          external
          :title="`Download ${a.name}`"
          :aria-label="`Download ${a.name}`"
        />
        <UButton
          v-if="editable"
          icon="i-lucide-trash-2"
          size="xs"
          variant="ghost"
          color="neutral"
          :loading="removing === a.path"
          :disabled="!!removing"
          :title="blockedReason || `Remove ${a.path}`"
          :aria-label="`Remove ${a.path}`"
          @click="removeAttachment(a)"
        />
      </div>
    </div>
    <p v-else-if="editable" class="t-small text-meta px-4 pb-3">
      No files yet. Drop files here, use Attach files, or import a skill folder.
    </p>
  </div>
</template>
