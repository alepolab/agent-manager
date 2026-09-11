<script setup lang="ts">
import DOMPurify from 'dompurify'
import { highlightCode, renderMarkdownWithHighlighting } from '~/utils/markdown'

/** Evidence is written by agents from ticket text nobody here vetted: every rendered fragment is sanitised before it reaches v-html. */
const clean = (html: string) => DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] })

/**
 * The evidence bundle, readable: markdown rendered, JSON as a document whose
 * strings keep their line breaks, JUnit XML summarised before it is shown,
 * code highlighted with line numbers, logs coloured. Search, wrap and copy on
 * every file; raw is always one click away.
 */
const props = defineProps<{ runId: string, live?: boolean }>()
const files = ref<{ name: string, size: number }[]>([])
const selected = ref<string | null>(null)
const raw = ref('')
const loading = ref(false)
const mode = ref<'rendered' | 'raw'>('rendered')
const wrap = ref(true)
const search = ref('')
const rendered = ref('')
const copied = ref(false)
const HIGHLIGHT_MAX = 200 * 1024

async function refresh() {
  try { files.value = await $fetch<{ name: string, size: number }[]>(`/api/runs/${props.runId}/artifacts`) } catch { files.value = [] }
}
const ext = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()
/** Evidence a reviewer looks at rather than reads. Fetching one as text produced
 *  mojibake and the console highlighted it as source; a QA run's four
 *  screenshots were unviewable. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const kind = computed(() => {
  const n = selected.value ?? ''
  const e = ext(n)
  if (e === 'md' || e === 'markdown') return 'markdown'
  if (e === 'json') return 'json'
  if (e === 'xml') return 'xml'
  if (e === 'log') return 'log'
  if (IMAGE_EXT.has(e)) return 'image'
  return 'code'
})
const LANG: Record<string, string> = { java: 'java', py: 'python', ts: 'typescript', js: 'javascript', sh: 'bash', yml: 'yaml', yaml: 'yaml', xml: 'xml', json: 'json', diff: 'diff', sql: 'sql', vue: 'vue', txt: 'text' }

const fileUrl = (name: string) => `/api/runs/${props.runId}/artifacts/${name.split('/').map(encodeURIComponent).join('/')}`

async function open(name: string) {
  selected.value = name
  loading.value = true
  search.value = ''
  // An image is served as itself; the browser fetches it from the same route.
  if (IMAGE_EXT.has(ext(name))) { raw.value = ''; rendered.value = ''; loading.value = false; return }
  try {
    raw.value = await $fetch<string>(fileUrl(name), { responseType: 'text' })
    await render()
  } catch (e: any) { raw.value = e.data?.message || e.message; rendered.value = '' } finally { loading.value = false }
}
async function render() {
  const k = kind.value
  jsonRendered.value = {}
  if (k === 'markdown') { rendered.value = clean(await renderMarkdownWithHighlighting(raw.value)); return }
  if (k === 'json') void renderJsonMarkdown(jsonRows.value)
  if (raw.value.length > HIGHLIGHT_MAX) { rendered.value = ''; return }
  if (k === 'json' || k === 'xml' || k === 'code') {
    const text = k === 'json' ? pretty(raw.value) : raw.value
    rendered.value = clean(await highlightCode(text, LANG[ext(selected.value ?? '')] ?? 'text'))
  }
}
const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s } }

/** JSON as a document: every leaf on its own row, strings with their real line breaks. */
/** Values that read like markdown (a step's input or output, a report) are rendered as such; the row's raw text is one click away in Raw mode. */
const jsonRendered = ref<Record<string, string>>({})
const looksLikeMarkdown = (v: string) => v.length > 60 && /(^|\n)(#{1,6} |\|.*\||- |\d+\. |```)/.test(v)
async function renderJsonMarkdown(rows: { path: string, value: string }[]) {
  const out: Record<string, string> = {}
  for (const r of rows) if (looksLikeMarkdown(r.value)) out[r.path] = clean(await renderMarkdownWithHighlighting(r.value))
  jsonRendered.value = out
}
const jsonRows = computed(() => {
  if (kind.value !== 'json') return []
  let data: unknown
  try { data = JSON.parse(raw.value) } catch { return [] }
  const rows: { path: string, value: string, long: boolean }[] = []
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      if (!v.length) rows.push({ path, value: '[]', long: false })
      else if (v.every(x => x === null || typeof x !== 'object')) rows.push({ path, value: v.map(String).join('\n'), long: v.length > 1 })
      else v.forEach((x, i) => walk(x, `${path}[${i}]`))
    } else if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>)
      if (!entries.length) rows.push({ path, value: '{}', long: false })
      for (const [k, x] of entries) walk(x, path ? `${path}.${k}` : k)
    } else {
      const s = v === null ? 'null' : String(v)
      rows.push({ path, value: s, long: s.includes('\n') || s.length > 120 })
    }
  }
  walk(data, '')
  return rows
})

/** JUnit XML, summarised: suites, counts and every failed case with its message. */
const junit = computed(() => {
  if (kind.value !== 'xml' || import.meta.server) return null
  try {
    const doc = new DOMParser().parseFromString(raw.value, 'application/xml')
    const suites = [...doc.querySelectorAll('testsuite')]
    if (!suites.length) return null
    const n = (el: Element, a: string) => Number(el.getAttribute(a) ?? 0)
    const total = suites.reduce((acc, s) => ({ tests: acc.tests + n(s, 'tests'), failures: acc.failures + n(s, 'failures'), errors: acc.errors + n(s, 'errors'), skipped: acc.skipped + n(s, 'skipped') }), { tests: 0, failures: 0, errors: 0, skipped: 0 })
    const failed = [...doc.querySelectorAll('testcase')].filter(tc => tc.querySelector('failure, error')).map(tc => ({
      name: `${tc.getAttribute('classname') ?? ''}${tc.getAttribute('classname') ? '.' : ''}${tc.getAttribute('name') ?? ''}`,
      message: (tc.querySelector('failure, error')?.getAttribute('message') ?? tc.querySelector('failure, error')?.textContent ?? '').trim().slice(0, 400),
    }))
    return { suites: suites.map(s => s.getAttribute('name') ?? ''), total, failed }
  } catch { return null }
})

const logLines = computed(() => kind.value === 'log' ? raw.value.split('\n').filter(Boolean) : [])
const rawLines = computed(() => {
  const q = search.value.trim().toLowerCase()
  const lines = (kind.value === 'json' ? pretty(raw.value) : raw.value).split('\n')
  return lines.map((text, i) => ({ n: i + 1, text })).filter(l => !q || l.text.toLowerCase().includes(q))
})
const showRaw = computed(() => kind.value !== 'image' && (mode.value === 'raw' || (kind.value !== 'markdown' && kind.value !== 'json' && kind.value !== 'log' && !rendered.value && !junit.value) || !!search.value.trim()))

async function copy() {
  try { await navigator.clipboard.writeText(raw.value); copied.value = true; setTimeout(() => { copied.value = false }, 1500) } catch { /* clipboard unavailable */ }
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
watch(() => props.runId, () => { selected.value = null; raw.value = ''; rendered.value = ''; refresh() })
watch(mode, () => { if (mode.value === 'rendered' && !rendered.value) render() })
defineExpose({ refresh })
</script>

<template>
  <div class="grid gap-3 h-full min-h-0" style="grid-template-columns: 15rem minmax(0, 1fr);">
    <div class="overflow-y-auto text-[11px] space-y-2 pr-1 min-h-0">
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
      <div class="px-3 py-1.5 text-[11px] flex items-center gap-2 flex-wrap" style="border-bottom: 1px solid var(--border-subtle);">
        <span class="font-mono truncate max-w-[40%]" :title="selected ?? ''">{{ selected ?? 'Select a file' }}</span>
        <template v-if="selected">
          <div class="flex items-center rounded overflow-hidden" style="border: 1px solid var(--border-subtle);">
            <button class="px-2 py-0.5" :style="{ background: mode === 'rendered' ? 'var(--accent-muted)' : 'transparent' }" @click="mode = 'rendered'">Rendered</button>
            <button class="px-2 py-0.5" :style="{ background: mode === 'raw' ? 'var(--accent-muted)' : 'transparent' }" @click="mode = 'raw'">Raw</button>
          </div>
          <input v-model="search" class="field-input text-[11px] py-0.5 w-40" placeholder="Search in file" aria-label="Search in file" />
          <label class="flex items-center gap-1 text-label"><input v-model="wrap" type="checkbox" /> wrap</label>
          <button class="text-label underline" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
          <a :href="`/api/runs/${runId}/artifacts/${selected.split('/').map(encodeURIComponent).join('/')}`" target="_blank" rel="noopener" class="underline text-label">Open raw</a>
        </template>
      </div>

      <div class="flex-1 min-h-0 overflow-auto p-3 text-[12px]">
        <p v-if="!selected" class="text-label">Pick a file on the left. Markdown renders, JSON reads as a document, test results are summarised, code is highlighted.</p>
        <p v-else-if="loading" class="text-label">Loading…</p>

        <!-- raw, with line numbers and search -->
        <div v-else-if="showRaw" class="font-mono text-[11px] leading-5">
          <div v-for="l in rawLines" :key="l.n" class="flex gap-3">
            <span class="shrink-0 w-10 text-right select-none tabular-nums" style="color: var(--text-disabled);">{{ l.n }}</span>
            <span :class="wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'" class="min-w-0">{{ l.text }}</span>
          </div>
          <p v-if="!rawLines.length" class="text-label font-sans">No line matches.</p>
        </div>

        <!-- a screenshot is looked at, not read -->
        <div v-else-if="kind === 'image'" class="p-2">
          <a :href="fileUrl(selected!)" target="_blank" rel="noopener">
            <img :src="fileUrl(selected!)" :alt="selected!" class="max-w-full h-auto rounded" style="border: 1px solid var(--border-subtle);">
          </a>
          <p class="text-[11px] text-label mt-2">{{ selected }} — click to open full size</p>
        </div>

        <!-- markdown -->
        <div v-else-if="kind === 'markdown'" class="prose prose-sm max-w-none text-[13px] leading-relaxed break-words evidence-prose" v-html="rendered" />

        <!-- json as a document -->
        <div v-else-if="kind === 'json'" class="space-y-1.5">
          <div v-for="r in jsonRows" :key="r.path" class="grid gap-3" style="grid-template-columns: 14rem minmax(0, 1fr);">
            <span class="font-mono text-[11px] truncate" style="color: var(--text-tertiary);" :title="r.path">{{ r.path || '(root)' }}</span>
            <div v-if="jsonRendered[r.path]" class="prose prose-sm max-w-none text-[12px] leading-relaxed break-words evidence-prose min-w-0 rounded p-2" style="background: var(--surface-base); border: 1px solid var(--border-subtle);" v-html="jsonRendered[r.path]" />
            <span v-else class="whitespace-pre-wrap break-words min-w-0" :style="{ color: 'var(--text-primary)', fontFamily: r.long ? 'var(--font-sans)' : 'var(--font-mono)' }">{{ r.value }}</span>
          </div>
        </div>

        <!-- junit summary then the xml -->
        <div v-else-if="kind === 'xml' && junit" class="space-y-3">
          <div class="flex flex-wrap gap-4 text-[12px]">
            <span><b>{{ junit.total.tests }}</b> tests</span>
            <span :style="{ color: junit.total.failures ? 'var(--error)' : 'var(--success)' }"><b>{{ junit.total.failures }}</b> failures</span>
            <span :style="{ color: junit.total.errors ? 'var(--error)' : undefined }"><b>{{ junit.total.errors }}</b> errors</span>
            <span class="text-label"><b>{{ junit.total.skipped }}</b> skipped</span>
            <span class="text-label font-mono truncate" :title="junit.suites.join(', ')">{{ junit.suites.join(', ') }}</span>
          </div>
          <div v-if="junit.failed.length" class="space-y-1">
            <div v-for="f in junit.failed" :key="f.name" class="rounded p-2 text-[11px]" style="background: var(--surface-base); border-left: 3px solid var(--error);">
              <div class="font-mono" style="color: var(--text-primary);">{{ f.name }}</div>
              <div class="whitespace-pre-wrap break-words" style="color: var(--text-secondary);">{{ f.message }}</div>
            </div>
          </div>
          <p v-else class="text-[11px]" style="color: var(--success);">Every case passed.</p>
          <div class="evidence-code text-[11px]" v-html="rendered" />
        </div>

        <!-- log lines -->
        <LogLines v-else-if="kind === 'log'" :lines="logLines" :filter="search" />

        <!-- highlighted code -->
        <div v-else class="evidence-code text-[11px]" :class="wrap ? 'evidence-wrap' : ''" v-html="rendered" />
      </div>
    </div>
  </div>
</template>

<style>
.evidence-code pre { margin: 0; padding: 0.5rem 0.75rem; border-radius: 0.5rem; overflow: auto; counter-reset: line; }
.evidence-code pre code { display: block; }
.evidence-code pre .line { display: block; padding-left: 3rem; position: relative; }
.evidence-code pre .line::before { counter-increment: line; content: counter(line); position: absolute; left: 0; width: 2.5rem; text-align: right; color: var(--text-disabled); }
.evidence-wrap pre .line { white-space: pre-wrap; word-break: break-word; }
.evidence-prose { font-family: var(--font-sans); font-size: 13.5px; line-height: 1.65; color: var(--text-primary); max-width: 82ch; }
.evidence-prose h1 { font-size: 1.45em; font-weight: 600; margin: 0 0 0.6em; letter-spacing: -0.01em; }
.evidence-prose h2 { font-size: 1.2em; font-weight: 600; margin: 1.4em 0 0.5em; padding-bottom: 0.25em; border-bottom: 1px solid var(--border-subtle); }
.evidence-prose h3 { font-size: 1.05em; font-weight: 600; margin: 1.2em 0 0.4em; }
.evidence-prose h4 { font-size: 1em; font-weight: 600; margin: 1em 0 0.3em; color: var(--text-secondary); }
.evidence-prose p { margin: 0 0 0.8em; }
.evidence-prose ul, .evidence-prose ol { margin: 0 0 0.9em 1.4em; padding: 0; }
.evidence-prose li { margin: 0.2em 0; }
.evidence-prose li > ul, .evidence-prose li > ol { margin-bottom: 0.3em; }
.evidence-prose strong { font-weight: 600; color: var(--text-primary); }
.evidence-prose a { color: var(--accent); text-decoration: underline; }
.evidence-prose blockquote { margin: 0.8em 0; padding: 0.4em 0.9em; border-left: 3px solid var(--accent); background: var(--surface-base); color: var(--text-secondary); }
.evidence-prose hr { border: 0; border-top: 1px solid var(--border-subtle); margin: 1.2em 0; }
.evidence-prose code { font-family: var(--font-mono); font-size: 0.9em; padding: 0.1em 0.35em; border-radius: 4px; background: var(--surface-base); border: 1px solid var(--border-subtle); }
.evidence-prose pre { margin: 0.6em 0 1em; padding: 0.7em 0.9em; border-radius: 8px; background: var(--surface-base); border: 1px solid var(--border-subtle); overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.5; }
.evidence-prose pre code { padding: 0; border: 0; background: transparent; font-size: inherit; }
.evidence-prose table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin: 0.6em 0 1em; display: block; overflow-x: auto; }
.evidence-prose th, .evidence-prose td { border: 1px solid var(--border-subtle); padding: 5px 9px; vertical-align: top; text-align: left; }
.evidence-prose th { background: var(--surface-base); font-weight: 600; }
.evidence-prose tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--surface-base) 55%, transparent); }
.evidence-prose img { max-width: 100%; }
</style>
