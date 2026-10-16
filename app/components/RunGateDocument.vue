<script setup lang="ts">
import DOMPurify from 'dompurify'
import { renderMarkdownWithHighlighting } from '~/utils/markdown'

/**
 * The document a gated step names as what its reviewer reads (`reviewDoc`),
 * shown in the gate itself. It used to sit under the Artifacts tab, so the
 * gate offered Approve beside a one-line "Runs Fix each group" while what was
 * being approved - five fixes, their evidence and screenshots - was a tab away
 * and easy to never open.
 */
const props = defineProps<{ runId: string, name: string }>()

const html = ref('')
const error = ref('')
const loading = ref(true)

const fileUrl = (name: string) => `/api/runs/${props.runId}/artifacts/${name.split('/').map(encodeURIComponent).join('/')}`

/** Agent-written, so sanitised before v-html, as RunArtifacts does. */
const clean = (fragment: string) => DOMPurify.sanitize(fragment, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] })

/**
 * A relative image or link in the document names another artifact of the same
 * run, next to the document: pointed at the artifact route, so a screenshot
 * shows inline and a linked log opens.
 */
function resolveRelative(fragment: string): string {
  const doc = new DOMParser().parseFromString(`<div>${fragment}</div>`, 'text/html')
  const base = props.name.includes('/') ? props.name.slice(0, props.name.lastIndexOf('/') + 1) : ''
  const local = (v: string | null) => !!v && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(v)
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src')
    if (local(src)) img.setAttribute('src', fileUrl(base + src!.replace(/^\.\//, '')))
    img.setAttribute('loading', 'lazy')
  }
  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href')
    if (local(href)) a.setAttribute('href', fileUrl(base + href!.replace(/^\.\//, '')))
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
  }
  return doc.body.firstElementChild?.innerHTML ?? ''
}

async function load() {
  if (import.meta.server) return
  loading.value = true
  error.value = ''
  try {
    const raw = await $fetch<string>(fileUrl(props.name), { responseType: 'text' })
    html.value = resolveRelative(clean(await renderMarkdownWithHighlighting(raw)))
  } catch (err: any) {
    error.value = err?.statusCode === 404
      ? `${props.name} was not written, so there is nothing here to review. Check the step's report before approving.`
      : `${props.name} could not be loaded: ${err?.data?.message || err?.message || 'unknown error'}`
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.runId, props.name], load)
</script>

<template>
  <details open class="group-card p-3! t-small" data-testid="run-gate-document">
    <summary class="cursor-pointer font-medium flex items-center gap-2" style="color: var(--text-primary);">
      <UIcon name="i-lucide-file-text" class="size-4 shrink-0" />
      What you are reviewing
      <span class="font-mono font-normal text-label">{{ name }}</span>
      <a :href="fileUrl(name)" target="_blank" rel="noopener" class="ml-auto font-normal text-link" @click.stop>Open on its own</a>
    </summary>
    <p v-if="loading" class="mt-2 text-label">Loading…</p>
    <p v-else-if="error" class="mt-2" style="color: var(--error);">{{ error }}</p>
    <div
      v-else
      class="gate-doc prose prose-sm max-w-none t-ui leading-relaxed break-words evidence-prose mt-2 max-h-[70vh] overflow-y-auto pr-1"
      v-html="html"
    />
  </details>
</template>

<style scoped>
.gate-doc :deep(img) { max-width: 100%; border: 1px solid var(--border-subtle); border-radius: 6px; margin: 0.4em 0; }
.gate-doc :deep(h2) { font-size: 1.1em; font-weight: 600; margin: 1.2em 0 0.4em; }
.gate-doc :deep(hr) { border: 0; border-top: 1px solid var(--border-subtle); margin: 1em 0; }
.gate-doc :deep(code) { font-family: var(--font-mono); font-size: 0.9em; }
</style>
