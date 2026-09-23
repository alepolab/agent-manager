<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { oversightReason, needsJustification } from '~~/shared/utils/oversight'
import { parseJunit, junitLabel, junitPassed } from '~/utils/junit'

/**
 * What a reviewer is actually approving.
 *
 * The gate used to render a step label and one line of agent prose — which is
 * how a money-path change to tax arithmetic came to be approved in a single
 * click. Everything below was already on disk in the run's own evidence bundle
 * and the reviewer was expected to go and find it in a file tree.
 *
 * Two rules this card holds to:
 *
 * - It never summarises prose into a verdict. Where the record holds a verdict
 *   (`security.verdict`), it shows it; where the record holds only a report
 *   (`security-review.md`), it says the report exists and links it. Inventing a
 *   "looks fine" from a document nobody read is the failure mode the gate exists
 *   to prevent.
 * - Missing evidence reads as missing, never as zero. A bundle that has not been
 *   written yet says so; it does not render "0 files changed".
 */
const props = defineProps<{ run: WorkflowRun }>()

interface FixRepo { repo?: string, commits?: string[], pr?: string }
interface Meta {
  blast_radius?: string
  work_type?: string
  class?: string
  fix?: { files_changed?: number, lines_changed?: number, tests_added?: number, repos?: FixRepo[] }
  oracle?: { kind?: string, runs?: number, rows?: number, path?: string }
  oracle_after?: { kind?: string, runs?: number, rows?: number, path?: string }
  security?: { verdict?: string, high?: number, medium?: number, low?: number }
  adversarial?: unknown
  deployment?: { migration_changed?: boolean, rollback?: string }
}

const meta = ref<Meta | null>(null)
const metaMissing = ref(false)
const files = ref<string[]>([])
const tests = ref<{ label: string, passed: boolean, from: string } | null>(null)
const loading = ref(true)

/** Reports the bundle writes as prose. Linked, never summarised into a verdict. */
const REPORTS: { file: string, label: string }[] = [
  { file: 'security-review.md', label: 'Security review' },
  { file: 'deploy-report.md', label: 'Deploy report' },
  { file: 'oracle-report.md', label: 'Oracle report' },
  { file: 'plan.md', label: 'Plan' },
  { file: 'pr-body.md', label: 'PR body' },
]
const presentReports = computed(() => REPORTS.filter(r => files.value.includes(r.file)))

async function load() {
  loading.value = true
  metaMissing.value = false
  meta.value = null
  tests.value = null
  const id = props.run.id
  try {
    meta.value = JSON.parse(await $fetch<string>(`/api/runs/${id}/artifacts/meta.json`, { responseType: 'text' }))
  } catch {
    metaMissing.value = true
  }
  try {
    files.value = (await $fetch<{ name: string }[]>(`/api/runs/${id}/artifacts`)).map(f => f.name)
  } catch {
    files.value = []
  }
  // The test report the reviewer should be judging: the run AFTER the fix.
  // oracle-before proves the bug reproduced, which is a different question.
  for (const name of ['oracle-after.xml', 'fix-full-suite.xml', 'regression.xml']) {
    if (!files.value.includes(name)) continue
    try {
      const xml = await $fetch<string>(`/api/runs/${id}/artifacts/${name}`, { responseType: 'text' })
      const j = parseJunit(xml)
      if (j) { tests.value = { label: junitLabel(j), passed: junitPassed(j), from: name }; break }
    } catch { /* try the next one */ }
  }
  loading.value = false
}
watch(() => [props.run.id, props.run.question?.stepId], load, { immediate: true })

const gatedStep = computed(() => props.run.steps.find(s => s.stepId === props.run.question?.stepId))

/**
 * What approving actually causes. Taken from the step the gate is holding, not
 * from its label: "Push + PR" and "Jira: Dev Done" both read as routine until
 * you know one opens a pull request and the other tells a customer's ticket the
 * work is done.
 */
const effect = computed(() => {
  const s = gatedStep.value
  if (!s) return 'Runs the next step.'
  const slug = s.agentSlug
  if (slug.includes('jira')) return `Moves ${props.run.ticketKey ?? 'the ticket'} to Dev Done, comments on it and attaches the evidence bundle. Visible to its reporter and watchers.`
  if (slug.includes('ship') || slug.includes('evidence-and-pr')) return `Pushes ${props.run.branch ?? 'the branch'} and opens a pull request against ${props.run.baseBranch ?? 'its base branch'}.`
  if (slug.includes('stack')) return 'Rebuilds the stack from this change and redeploys it in place.'
  if (slug.includes('ce-work') || slug.includes('fix')) return 'Lets an agent implement the plan, editing source in the run checkout.'
  return `Runs "${s.label}".`
})

/**
 * An owner-gated change whose bundle carries no adversarial report. The
 * evidence-bundle schema requires one for `money` and `protocol`, so its absence
 * at this gate is a real finding rather than a presentation detail.
 */
const adversarialMissing = computed(() =>
  ['money', 'protocol'].includes(props.run.blastRadius ?? '')
  && !!meta.value && meta.value.adversarial === undefined)

const repos = computed(() => meta.value?.fix?.repos ?? [])
const mustJustify = computed(() => needsJustification(props.run.blastRadius))
</script>

<template>
  <div class="rounded-lg t-small" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
    <div class="px-3 py-2 flex items-center gap-2" style="border-bottom: 1px solid var(--border-subtle);">
      <span class="t-small font-mono uppercase tracking-wider text-label">What you are approving</span>
      <span
        v-if="run.blastRadius"
        class="ml-auto t-small font-mono uppercase px-1.5 py-0.5 rounded"
        :style="{ background: 'var(--accent-muted)', color: 'var(--accent)' }"
        :title="oversightReason(run.blastRadius)"
      >{{ run.blastRadius }}</span>
      <span v-else class="ml-auto t-small font-mono uppercase text-label">unclassified</span>
    </div>

    <div class="px-3 py-2 space-y-2">
      <!-- 1. The outward effect, in one sentence. -->
      <p class="m-0" style="color: var(--text-primary);">{{ effect }}</p>

      <p v-if="mustJustify" class="m-0 t-small" style="color: var(--warning);">
        Owner-gated: approving needs a written reason.
      </p>

      <div v-if="loading" class="t-small text-label">Reading the evidence bundle…</div>

      <!-- Missing is missing. A bundle that was never written must not render as zeros. -->
      <div v-else-if="metaMissing" class="t-small" style="color: var(--warning);">
        No evidence bundle written yet, so there is nothing measured to show. Approving here means
        approving the step on its description alone.
      </div>

      <template v-else>
        <!-- 2. The change, measured by the runner rather than reported by the agent. -->
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <span v-if="meta?.fix?.files_changed !== undefined">
            <b class="font-mono tabular-nums">{{ meta.fix.files_changed }}</b> <span class="text-label">files</span>
          </span>
          <span v-if="meta?.fix?.lines_changed !== undefined">
            <b class="font-mono tabular-nums">{{ meta.fix.lines_changed }}</b> <span class="text-label">lines</span>
          </span>
          <span v-if="meta?.fix?.tests_added !== undefined">
            <b class="font-mono tabular-nums">{{ meta.fix.tests_added }}</b> <span class="text-label">tests added</span>
          </span>
          <span v-if="repos.length">
            <b class="font-mono tabular-nums">{{ repos.reduce((n, r) => n + (r.commits?.length ?? 0), 0) }}</b>
            <span class="text-label"> commits across {{ repos.length }} repo(s)</span>
          </span>
        </div>
        <div v-if="repos.length" class="space-y-0.5">
          <div v-for="r in repos" :key="r.repo" class="flex gap-2 t-small">
            <span class="font-mono truncate">{{ r.repo }}</span>
            <a v-if="r.pr" :href="r.pr" target="_blank" rel="noopener" class="underline shrink-0" style="color: var(--accent);">
              {{ r.pr.replace(/^https?:\/\/(www\.)?github\.com\//, '') }}
            </a>
            <span v-else class="text-label shrink-0">no pull request yet</span>
          </div>
        </div>

        <!-- 3. Did it reproduce, and does it pass now. -->
        <div class="flex flex-wrap gap-x-4 gap-y-1 t-small">
          <span v-if="meta?.oracle?.kind">
            <span class="text-label">Oracle</span> {{ meta.oracle.kind }}<template v-if="meta.oracle.runs">, {{ meta.oracle.runs }} run(s)</template><template v-if="meta.oracle.rows">, {{ meta.oracle.rows }} row(s)</template>
          </span>
          <span v-if="tests" :style="{ color: tests.passed ? 'var(--success)' : 'var(--error)' }" :title="`from ${tests.from}`">
            Tests after the fix: {{ tests.label }}
          </span>
          <span v-else-if="!loading" class="text-label">No machine-readable test report in the bundle.</span>
        </div>

        <!-- 4. Security and deployment, as the record holds them. -->
        <div class="flex flex-wrap gap-x-4 gap-y-1 t-small">
          <span v-if="meta?.security?.verdict">
            <span class="text-label">Security</span>
            <span :style="{ color: meta.security.verdict.toLowerCase().includes('pass') || meta.security.verdict.toLowerCase().includes('clean') ? 'var(--success)' : 'var(--warning)' }">
              {{ meta.security.verdict }}
            </span>
            <span v-if="meta.security.high" style="color: var(--error);"> · {{ meta.security.high }} high</span>
            <span v-if="meta.security.medium" class="text-label"> · {{ meta.security.medium }} medium</span>
          </span>
          <span v-if="meta?.deployment?.migration_changed" style="color: var(--warning);">
            Changes a database migration<template v-if="meta.deployment.rollback"> · rollback: {{ meta.deployment.rollback }}</template>
          </span>
        </div>

        <p v-if="adversarialMissing" class="m-0 t-small" style="color: var(--error);">
          This change is <span class="font-mono">{{ run.blastRadius }}</span>, which the evidence-bundle
          schema requires an adversarial report for — and the bundle has none.
        </p>

        <!-- 5. What the pipeline thought of itself on the way here. -->
        <div class="flex flex-wrap gap-x-4 gap-y-1 t-small text-label">
          <span v-for="s in run.steps.filter(st => st.monitorVerdict && st.monitorVerdict !== 'CONTINUE')" :key="s.stepId" :title="s.monitorNote || ''">
            <span class="font-mono">{{ s.monitorVerdict }}</span> at {{ s.label }}
          </span>
          <span v-for="s in run.steps.filter(st => st.visits > 1)" :key="`v-${s.stepId}`">
            {{ s.label }} ran {{ s.visits }}×
          </span>
        </div>

        <!-- Actually linked. This block's own contract, forty lines up, says
             reports are "Linked, never summarised into a verdict" — and they
             were rendered as inert text. At the highest-stakes read in the
             product, "Security review" was a word: to read it a reviewer had
             to leave the gate, cross to the artifact pane, and recognise
             `security-review.md` among a couple of hundred filenames. This
             card exists to stop one-click approvals; that was the hole it
             left open. -->
        <div v-if="presentReports.length" class="flex flex-wrap gap-x-3 gap-y-1 t-small">
          <span class="text-label">Reports:</span>
          <a
            v-for="r in presentReports" :key="r.file"
            :href="`/api/runs/${run.id}/artifacts/${r.file}`"
            target="_blank" rel="noopener"
            class="font-mono underline focus-ring"
            style="color: var(--accent);"
            :title="`Open ${r.file}`"
          >{{ r.label }}</a>
        </div>
      </template>
    </div>
  </div>
</template>
