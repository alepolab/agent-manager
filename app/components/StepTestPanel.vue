<script setup lang="ts">
import type { EffectScope } from 'vue'
import type { WorkflowStep } from '~/types'
import { isLiveStatus, type WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR, runStatusLabel } from '~/utils/runStatus'

/**
 * The drawer's Test tab: run this one step again against a finished run's
 * outputs, on a throwaway branch, with the drawer's current (possibly unsaved)
 * config. The server does the isolating; this picks the run and shows the result.
 */
const props = defineProps<{ workflowSlug: string, step: WorkflowStep }>()
const { can } = useUser()
const toast = useToast()
const mayTest = computed(() => can('runEngine'))

const sources = ref<WorkflowRun[]>([])
const loaded = ref(false)
const selected = ref('')
onMounted(async () => {
  try {
    const all = await $fetch<WorkflowRun[]>('/api/runs')
    sources.value = all
      .filter(r => r.workflowSlug === props.workflowSlug && !isLiveStatus(r.status) && r.steps.some(s => s.stepId === props.step.id))
      .sort((a, b) => b.startedAt - a.startedAt)
    selected.value = sources.value[0]?.id ?? ''
  } catch (e: any) {
    toast.add({ title: 'Could not load runs', description: e.data?.message || e.message, color: 'error' })
  } finally { loaded.value = true }
})

function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}
const optionLabel = (r: WorkflowRun) => `#${r.id.slice(0, 6)} · ${runStatusLabel(r.status)} · ${ago(r.startedAt)}`

// The result streams through useRun, which takes its id up front: one scope per test started.
const testing = ref(false)
const testRunId = ref('')
const result = shallowRef<ReturnType<typeof useRun> | null>(null)
let scope: EffectScope | null = null
onScopeDispose(() => scope?.stop())

async function runTest() {
  if (!selected.value) return
  testing.value = true
  try {
    const { id: _id, next: _next, position: _position, ...stepOverride } = props.step
    const run = await $fetch<WorkflowRun>(`/api/runs/${selected.value}/test`, { method: 'POST', body: { stepId: props.step.id, stepOverride } })
    scope?.stop()
    scope = effectScope()
    const r = scope.run(() => useRun(run.id))!
    r.run.value = run
    testRunId.value = run.id
    result.value = r
    await r.load()
  } catch (e: any) {
    toast.add({ title: 'Could not start the test', description: e.data?.message || e.message, color: 'error' })
  } finally { testing.value = false }
}

const testRun = computed(() => result.value?.run.value ?? null)
const tested = computed(() => testRun.value?.steps.find(s => s.stepId === (testRun.value?.testOf?.stepId ?? props.step.id)))
const lastCheck = computed(() => tested.value?.checks?.at(-1))
const tail = computed(() => (result.value?.logs.value[tested.value?.stepId ?? ''] ?? []).slice(-20))
const tokens = computed(() => {
  const u = tested.value?.usage
  return u ? (u.input_tokens + u.output_tokens).toLocaleString() : ''
})
const usd = computed(() => (tested.value?.usage?.usd != null ? `$${tested.value.usage.usd.toFixed(2)}` : ''))
const verdictColor = (v: string) => v === 'CONTINUE' ? RUN_STATUS_COLOR.completed : v === 'ABORT' ? RUN_STATUS_COLOR.failed : 'var(--warning)'
</script>

<template>
  <div class="space-y-3 t-small" data-testid="step-test-panel">
    <p v-if="!mayTest" class="text-label">Testing a step needs permission to run the pipeline.</p>
    <template v-else>
      <p class="text-label">Runs this step again, as configured here, against a finished run's outputs, on its own throwaway branch. Nothing is posted, pushed or ticketed.</p>
      <p v-if="!loaded" class="text-label" aria-busy="true">Loading runs…</p>
      <p v-else-if="!sources.length" class="text-label">Run this workflow once, then test its steps here.</p>
      <template v-else>
        <div class="field-group">
          <label class="field-label" for="step-test-source">Test against</label>
          <select id="step-test-source" v-model="selected" class="field-input">
            <option v-for="r in sources" :key="r.id" :value="r.id">{{ optionLabel(r) }}</option>
          </select>
        </div>
        <UButton size="sm" icon="i-lucide-flask-conical" :loading="testing" :disabled="testing || !selected" :label="testing ? 'Testing…' : 'Test step'" @click="() => { runTest() }" />
      </template>

      <div v-if="testRun" class="rounded-lg p-3 space-y-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);" data-testid="step-test-result">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono" :style="{ color: RUN_STATUS_COLOR[testRun.status], background: 'var(--surface-inset)' }" data-testid="step-test-status">
            <span class="w-2 h-2 rounded-full" :class="{ 'animate-pulse': isLiveStatus(testRun.status) }" :style="{ background: RUN_STATUS_COLOR[testRun.status] }" />
            {{ runStatusLabel(testRun.status) }}
          </span>
          <span v-if="tokens" class="font-mono text-label tabular-nums">{{ tokens }} tok{{ usd ? ` · ${usd}` : '' }}</span>
          <NuxtLink :to="`/runs/${testRun.id}`" class="ml-auto underline focus-ring">Open test run</NuxtLink>
        </div>
        <p v-if="testRun.testOf?.codeNote" style="color: var(--warning);">{{ testRun.testOf.codeNote }}</p>
        <details v-if="lastCheck" class="rounded p-2" style="background: var(--surface-base);">
          <summary class="cursor-pointer focus-ring">Check · <span class="font-mono" :style="{ color: verdictColor(lastCheck.verdict) }">{{ lastCheck.verdict }}</span></summary>
          <pre class="whitespace-pre-wrap mt-1 max-h-48 overflow-auto">{{ lastCheck.note }}</pre>
        </details>
        <p v-if="tested?.error" :style="{ color: RUN_STATUS_COLOR.failed }">{{ tested.error }}</p>
        <div v-if="step.produces?.length">
          <p class="t-label text-label mb-1">Produces</p>
          <ul class="space-y-0.5"><li v-for="f in step.produces" :key="f" class="font-mono">{{ f }}</li></ul>
        </div>
        <div v-if="tail.length" class="max-h-72 overflow-auto rounded p-2" style="background: var(--surface-base); border: 1px solid var(--border-subtle);"><LogLines :lines="tail" /></div>
        <p v-else class="text-label">No output yet.</p>
      </div>
    </template>
  </div>
</template>
