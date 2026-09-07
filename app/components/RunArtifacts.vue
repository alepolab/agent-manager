<script setup lang="ts">
/**
 * The evidence bundle, browsable: every file the run wrote, grouped by
 * directory, with the selected one shown large. JSON is pretty-printed.
 */
const props = defineProps<{ runId: string, live?: boolean }>()
const files = ref<{ name: string, size: number }[]>([])
const selected = ref<string | null>(null)
const text = ref('')
const loading = ref(false)
async function refresh() {
  try { files.value = await $fetch<{ name: string, size: number }[]>(`/api/runs/${props.runId}/artifacts`) } catch { files.value = [] }
}
async function open(name: string) {
  selected.value = name
  loading.value = true
  try {
    const raw = await $fetch<string>(`/api/runs/${props.runId}/artifacts/${name.split('/').map(encodeURIComponent).join('/')}`, { responseType: 'text' })
    text.value = name.endsWith('.json') ? (() => { try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw } })() : raw
  } catch (e: any) { text.value = e.data?.message || e.message } finally { loading.value = false }
}
const groups = computed(() => {
  const g: Record<string, { name: string, size: number }[]> = {}
  for (const f of files.value) { const dir = f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/')) : '.'; (g[dir] ??= []).push(f) }
  return Object.entries(g).sort(([a], [b]) => a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b))
})
const size = (n: number) => n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { refresh(); timer = setInterval(() => { if (props.live) refresh() }, 10_000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
watch(() => props.runId, () => { selected.value = null; text.value = ''; refresh() })
defineExpose({ refresh })
</script>

<template>
  <div class="grid gap-3 h-full min-h-0" style="grid-template-columns: 16rem minmax(0, 1fr);">
    <div class="overflow-y-auto text-[11px] space-y-2 pr-1">
      <div class="flex items-center justify-between"><span class="text-section-label">Evidence files</span><button class="text-label underline focus-ring" @click="refresh">Refresh</button></div>
      <p v-if="!files.length" class="text-label">Nothing written yet.</p>
      <div v-for="[dir, list] in groups" :key="dir">
        <div v-if="dir !== '.'" class="font-mono text-[10px] text-label mt-1">{{ dir }}/</div>
        <button v-for="f in list" :key="f.name" class="w-full flex items-center gap-2 px-2 py-1 rounded text-left focus-ring" :style="{ background: selected === f.name ? 'var(--accent-muted)' : 'transparent', color: selected === f.name ? 'var(--text-primary)' : 'var(--text-secondary)' }" @click="open(f.name)">
          <span class="font-mono truncate">{{ f.name.slice(f.name.lastIndexOf('/') + 1) }}</span>
          <span class="ml-auto text-label whitespace-nowrap">{{ size(f.size) }}</span>
        </button>
      </div>
    </div>
    <div class="min-h-0 flex flex-col rounded-lg" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <div class="px-3 py-1.5 text-[11px] font-mono flex items-center gap-2" style="border-bottom: 1px solid var(--border-subtle);">
        <span class="truncate">{{ selected ?? 'Select a file' }}</span>
        <a v-if="selected" :href="`/api/runs/${runId}/artifacts/${selected.split('/').map(encodeURIComponent).join('/')}`" target="_blank" rel="noopener" class="ml-auto underline text-label">Open raw</a>
      </div>
      <pre class="flex-1 min-h-0 overflow-auto p-3 text-[11px] whitespace-pre-wrap">{{ loading ? 'Loading…' : text }}</pre>
    </div>
  </div>
</template>
