<script setup lang="ts">
/**
 * Live-output lines, readable: the timestamp muted, a tool call named and its
 * argument shown in monospace, a result dimmed, an error red, the agent's own
 * words in the normal text colour. One line per event, wrapped, never squashed
 * into an unreadable block.
 */
const props = defineProps<{ lines: string[], filter?: string }>()
interface Row { time: string, kind: 'tool' | 'result' | 'error' | 'text' | 'system', tool?: string, text: string }
function parse(line: string): Row {
  const m = line.match(/^(\d{2}:\d{2}:\d{2}) (.*)$/s)
  const time = m ? m[1]! : ''
  const rest = m ? m[2]! : line
  const tool = rest.match(/^\[([A-Za-z_]+)\]\s?(.*)$/s)
  if (tool) return { time, kind: 'tool', tool: tool[1], text: tool[2] ?? '' }
  if (rest.startsWith('→ ')) return { time, kind: 'result', text: rest.slice(2) }
  if (rest.startsWith('✗ ')) return { time, kind: 'error', text: rest.slice(2) }
  if (/^step started/.test(rest)) return { time, kind: 'system', text: rest }
  return { time, kind: 'text', text: rest }
}
const rows = computed(() => {
  const q = props.filter?.trim().toLowerCase()
  return props.lines.map(parse).filter(r => !q || r.text.toLowerCase().includes(q) || r.tool?.toLowerCase().includes(q))
})
const color = (k: Row['kind']) => k === 'error' ? 'var(--error)' : k === 'result' ? 'var(--text-tertiary)' : k === 'system' ? 'var(--text-disabled)' : 'var(--text-primary)'
</script>

<template>
  <div class="text-[11px] leading-5 font-mono space-y-px">
    <div v-for="(r, i) in rows" :key="i" class="flex gap-2 items-start">
      <span class="shrink-0 tabular-nums" style="color: var(--text-disabled);">{{ r.time }}</span>
      <span v-if="r.kind === 'tool'" class="shrink-0 px-1 rounded text-[10px] font-semibold" style="background: var(--accent-muted); color: var(--accent);">{{ r.tool }}</span>
      <span v-else-if="r.kind === 'result'" class="shrink-0" style="color: var(--text-disabled);">→</span>
      <span v-else-if="r.kind === 'error'" class="shrink-0" style="color: var(--error);">✗</span>
      <span class="whitespace-pre-wrap break-words min-w-0" :style="{ color: color(r.kind), fontFamily: r.kind === 'text' ? 'var(--font-sans)' : undefined }">{{ r.text }}</span>
    </div>
    <p v-if="!rows.length" class="text-label font-sans">{{ filter ? 'No line matches.' : 'No output yet.' }}</p>
  </div>
</template>
