<script setup lang="ts">
import { parseUnifiedDiff, type FileDiff } from '~~/shared/utils/unifiedDiff'

/**
 * A changed file's diff, the way a pull request shows it: old and new line
 * numbers, removed lines red, added lines green, the hunk headers between.
 * Opened from "The change" at a gate, so a reviewer reads what they approve
 * without leaving the decision.
 */
const props = defineProps<{ runId: string, files: string[] }>()
const path = defineModel<string | null>('path', { required: true })

const diff = ref<FileDiff | null>(null)
const truncated = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)

async function load(p: string) {
  loading.value = true
  error.value = null
  diff.value = null
  try {
    const r = await $fetch<{ diff: string, truncated: boolean }>(`/api/runs/${props.runId}/changes/diff`, { query: { path: p } })
    if (path.value !== p) return
    diff.value = parseUnifiedDiff(r.diff)
    truncated.value = r.truncated
  } catch (e: any) {
    if (path.value === p) error.value = e.data?.message || e.message || 'Could not load the diff'
  } finally {
    if (path.value === p) loading.value = false
  }
}
watch(path, (p) => { if (p) void load(p) }, { immediate: true })

const index = computed(() => (path.value ? props.files.indexOf(path.value) : -1))
const go = (step: number) => { const next = props.files[index.value + step]; if (next) path.value = next }
const open = computed({ get: () => !!path.value, set: (v) => { if (!v) path.value = null } })
</script>

<template>
  <UModal v-model:open="open" :title="path ?? ''" :ui="{ content: 'max-w-6xl w-[96vw]' }">
    <template #content>
      <div class="flex flex-col max-h-[88vh] bg-overlay rounded-lg overflow-hidden">
        <div class="shrink-0 flex items-center gap-2 px-4 py-2.5" style="border-bottom: 0.5px solid var(--border-default);">
          <UIcon name="i-lucide-file-diff" class="size-4 shrink-0" style="color: var(--text-tertiary);" />
          <span class="font-mono t-small truncate flex-1" :title="path ?? ''" style="color: var(--text-primary);">{{ path }}</span>
          <template v-if="diff && !diff.binary">
            <span class="t-small tabular-nums" style="color: var(--success);">+{{ diff.added }}</span>
            <span class="t-small tabular-nums" style="color: var(--error);">−{{ diff.removed }}</span>
          </template>
          <span v-if="files.length > 1" class="t-small text-label tabular-nums">{{ index + 1 }} of {{ files.length }}</span>
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-chevron-left" aria-label="Previous file" :disabled="index <= 0" @click="go(-1)" />
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-chevron-right" aria-label="Next file" :disabled="index < 0 || index >= files.length - 1" @click="go(1)" />
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" aria-label="Close" @click="() => { path = null }" />
        </div>

        <div class="flex-1 min-h-0 overflow-auto" data-testid="file-diff">
          <p v-if="loading" class="p-4 t-small text-label flex items-center gap-2" role="status">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" style="color: var(--accent);" /> Loading diff…
          </p>
          <p v-else-if="error" class="p-4 t-small" style="color: var(--error);">{{ error }}</p>
          <p v-else-if="diff?.binary" class="p-4 t-small text-label">Binary file - no line changes to show.</p>
          <p v-else-if="diff && !diff.rows.length" class="p-4 t-small text-label">No line changes: the file was renamed or its mode changed.</p>
          <table v-else-if="diff" class="diff">
            <tbody>
              <tr v-for="(r, i) in diff.rows" :key="i" :class="`diff__row--${r.kind}`">
                <template v-if="r.kind === 'hunk'">
                  <td colspan="3" class="diff__hunk">{{ r.text }}</td>
                </template>
                <template v-else-if="r.kind === 'note'">
                  <td class="diff__num" /><td class="diff__num" />
                  <td class="diff__code diff__note">{{ r.text }}</td>
                </template>
                <template v-else>
                  <td class="diff__num">{{ r.old ?? '' }}</td>
                  <td class="diff__num">{{ r.new ?? '' }}</td>
                  <td class="diff__code"><span class="diff__sign" aria-hidden="true">{{ r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' ' }}</span>{{ r.text }}</td>
                </template>
              </tr>
            </tbody>
          </table>
          <p v-if="truncated" class="p-3 t-small text-label">The diff is cut here: the file changed by more than 512 KB.</p>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.diff { width: 100%; border-collapse: collapse; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; line-height: 20px; }
.diff__num {
  width: 1%; min-width: 3.25rem; padding: 0 8px; text-align: right; vertical-align: top;
  color: var(--text-tertiary); user-select: none; white-space: nowrap;
  border-right: 0.5px solid var(--border-subtle);
}
.diff__code { padding: 0 12px 0 6px; white-space: pre-wrap; word-break: break-word; color: var(--text-primary); }
.diff__sign { display: inline-block; width: 1.25em; user-select: none; color: var(--text-tertiary); }
.diff__hunk {
  padding: 4px 12px; color: var(--text-secondary);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.diff__note { color: var(--text-tertiary); font-style: italic; }
.diff__row--add { background: color-mix(in srgb, var(--success) 12%, transparent); }
.diff__row--add .diff__num { background: color-mix(in srgb, var(--success) 18%, transparent); }
.diff__row--add .diff__sign { color: var(--success); }
.diff__row--del { background: color-mix(in srgb, var(--error) 12%, transparent); }
.diff__row--del .diff__num { background: color-mix(in srgb, var(--error) 18%, transparent); }
.diff__row--del .diff__sign { color: var(--error); }
@media (forced-colors: active) {
  .diff__row--add .diff__sign, .diff__row--del .diff__sign { color: CanvasText; }
}
</style>
