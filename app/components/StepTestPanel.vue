<script setup lang="ts">
import type { EffectScope } from 'vue'
import type { WorkflowStep } from '~/types'
import { isLiveStatus, type WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR, runStatusLabel } from '~/utils/runStatus'
import { stepUsageLabel, verdictColor } from '~/utils/runStack'

/**
 * The drawer's Test tab: run this one step again against a finished run's
 * outputs (on a throwaway branch when the run has code), with the drawer's current (possibly unsaved)
 * config. The server does the isolating; this picks the run and shows the result.
 */
const props = defineProps<{
  workflowSlug: string
  step: WorkflowStep
  /** The Test tab is showing. The panel stays mounted across tabs, so this is when its run list is read again. */
  active: boolean
}>()
const { can } = useUser()
const toast = useToast()
const mayTest = computed(() => can('runEngine'))

const sources = ref<WorkflowRun[]>([])
const loaded = ref(false)
const selected = ref('')
/** Keeps the picked run while it is still offered; otherwise picks the newest. */
async function loadSources() {
  try {
    const all = await $fetch<WorkflowRun[]>('/api/runs')
    sources.value = all
      .filter(r => r.workflowSlug === props.workflowSlug && !isLiveStatus(r.status) && r.steps.some(s => s.stepId === props.step.id))
      .sort((a, b) => b.startedAt - a.startedAt)
    if (!sources.value.some(r => r.id === selected.value)) selected.value = sources.value[0]?.id ?? ''
  } catch (e: any) {
    toast.add({ title: 'Could not load runs', description: e.data?.message || e.message, color: 'error' })
  } finally { loaded.value = true }
}
onMounted(loadSources)

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
// A POST still in flight when the panel goes away must not open a stream nobody will close.
let disposed = false
onScopeDispose(() => { disposed = true; scope?.stop() })

async function runTest() {
  if (!selected.value) return
  testing.value = true
  try {
    const { id: _id, next: _next, position: _position, ...stepOverride } = props.step
    const run = await $fetch<WorkflowRun>(`/api/runs/${selected.value}/test`, { method: 'POST', body: { stepId: props.step.id, stepOverride } })
    if (disposed) return
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

// Back on the tab: a run that finished meanwhile is one to test against. Not
// while a test is starting, which is reading the list's selection.
watch(() => props.active, (active, was) => { if (active && !was && !testing.value) void loadSources() })

const testRun = computed(() => result.value?.run.value ?? null)
const tested = computed(() => testRun.value?.steps.find(s => s.stepId === (testRun.value?.testOf?.stepId ?? props.step.id)))
/** Where the agent works. Known once a test run exists: a source run with no
 *  code folder gets no test/ branch, and its test works in the Claude config
 *  directory as the source did. */
const isolation = computed(() => {
  const t = testRun.value
  if (t?.branch?.startsWith('test/')) return `on its own throwaway branch (${t.branch})`
  // A live test may not have made its worktree yet: say nothing it could contradict.
  if (!t || isLiveStatus(t.status)) return 'on its own throwaway branch when the run has code'
  if (!t.projectDir) return 'in ~/.claude, as the run it tests did, since that run had no code folder'
  return 'on its own throwaway branch when the run has code'
})
const lastCheck = computed(() => tested.value?.checks?.at(-1))
const tail = computed(() => (result.value?.logs.value[tested.value?.stepId ?? ''] ?? []).slice(-20))
const usage = computed(() => stepUsageLabel(tested.value?.usage))
</script>

<template>
  <div class="space-y-3 t-small" data-testid="step-test-panel">
    <p v-if="!mayTest" class="text-label">Testing a step needs permission to run the pipeline.</p>
    <template v-else>
      <p class="text-label">Runs this step again, as configured here, against a finished run's outputs. A Jira, channel or loop step only records what it would do. An agent step runs as it would in a real run, {{ isolation }}, and is told it is a test.</p>
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

      <div v-if="testRun" class="group-card p-3! space-y-2" data-testid="step-test-result">
        <div class="flex items-center gap-2">
          <StatusLabel :status="testRun.status" :label="runStatusLabel(testRun.status)" data-testid="step-test-status" />
          <span v-if="usage" class="text-label tabular-nums">{{ usage }}</span>
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
