<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { oversightReason, needsJustification } from '~~/shared/utils/oversight'
import { parseJunit, junitLabel, junitPassed } from '~/utils/junit'
import { CHANGE_BRIEF_FILE, CHANGE_BRIEF_PENDING, parseDecisionBrief, riskDetail, riskLevel, unresolvedQuestions, type DecisionBrief } from '~~/shared/utils/decisionBrief'

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
  blast_radius_reason?: string
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
/** Which files and commits, measured from git - see server/utils/gitFacts.ts computeChangeSummary. */
/** The implementer's brief for whoever approves the change: what it gains and what it risks. */
const brief = ref<DecisionBrief | null>(null)
/** The runner is having the brief written (workflowRunner ensureChangeBrief); checked again until it lands. */
const briefPending = ref(false)
let briefPoll: ReturnType<typeof setTimeout> | null = null
watch(briefPending, (on) => {
  if (briefPoll) clearTimeout(briefPoll)
  briefPoll = on ? setTimeout(() => load(true), 15_000) : null
})
onUnmounted(() => { if (briefPoll) clearTimeout(briefPoll) })
const changes = ref<{ commits: { sha: string, subject: string }[], files: { path: string, added: number | null, removed: number | null }[] } | null>(null)
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
/** The report open in the drawer: read beside the decision, not in another tab. */
const openReport = ref<{ file: string, label: string } | null>(null)
const reportOpen = computed({ get: () => !!openReport.value, set: (v) => { if (!v) openReport.value = null } })

/** `quiet`: re-read for a brief being written, without blanking the card meanwhile. */
async function load(quiet = false) {
  if (!quiet) {
    loading.value = true
    metaMissing.value = false
    meta.value = null
    tests.value = null
  }
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
  if (!quiet) brief.value = null
  briefPending.value = files.value.includes(CHANGE_BRIEF_PENDING)
  if (files.value.includes(CHANGE_BRIEF_FILE)) {
    try {
      const parsed = parseDecisionBrief(await $fetch<string>(`/api/runs/${id}/artifacts/${CHANGE_BRIEF_FILE}`, { responseType: 'text' }))
      if ('brief' in parsed) brief.value = parsed.brief
    } catch { /* the measured facts below still stand */ }
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
  try {
    changes.value = await $fetch(`/api/runs/${id}/changes`)
  } catch {
    changes.value = null
  }
  loading.value = false
}
watch(() => [props.run.id, props.run.question?.stepId], () => load(), { immediate: true })

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
const commitCount = computed(() => repos.value.reduce((n, r) => n + (r.commits?.length ?? 0), 0))
const securityOk = computed(() => /pass|clean/i.test(meta.value?.security?.verdict ?? ''))
const pipelineNotes = computed(() => [
  ...props.run.steps.filter(st => st.monitorVerdict && st.monitorVerdict !== 'CONTINUE').map(st => ({ key: st.stepId, text: `${st.monitorVerdict} at ${st.label}`, title: st.monitorNote || '' })),
  ...props.run.steps.filter(st => st.visits > 1).map(st => ({ key: `v-${st.stepId}`, text: `${st.label} ran ${st.visits}×`, title: '' })),
])
/** The change brief's options, read as what approving and sending back each lead to. */
const RISK_WORD = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' } as const
const situationOpen = ref(false)
/** Intake's questions the change could not settle: the only ones that are the reviewer's to weigh. */
const openQuestions = computed(() => unresolvedQuestions(brief.value))
const briefOptions = computed(() => (brief.value?.options ?? []).map(o => ({ ...o, name: o.title ?? o.label, level: riskLevel(o.risk), riskText: riskDetail(o.risk) })))
const mustJustify = computed(() => needsJustification(props.run.blastRadius))
</script>

<template>
  <div class="space-y-4 t-small">
    <!-- What approving lets happen, in one sentence, and why it stopped here. -->
    <div class="group-card space-y-1">
      <h3 class="t-ui font-semibold m-0" style="color: var(--text-primary);">What approving does</h3>
      <p class="m-0 text-label">{{ effect }}</p>
    </div>
    <div v-if="run.blastRadius" class="group-card space-y-1">
      <h3 class="t-ui font-semibold m-0" style="color: var(--text-primary);">Why this stopped for you</h3>
      <p class="m-0 text-label">
        Classed <b class="font-mono" style="color: var(--text-primary);" :title="oversightReason(run.blastRadius)">{{ run.blastRadius }}</b><template v-if="meta?.blast_radius_reason">: {{ meta.blast_radius_reason }}</template><template v-else-if="!loading">. Intake recorded no reason for the class.</template>
      </p>
      <p v-if="mustJustify" class="m-0" style="color: var(--warning);">Owner-gated: approving needs a written reason.</p>
    </div>

    <p v-if="loading" class="m-0 text-label">Reading the evidence bundle…</p>

    <!-- Missing is missing. A bundle that was never written must not render as zeros. -->
    <p v-else-if="metaMissing" class="m-0" style="color: var(--warning);">
      No evidence bundle written yet, so there is nothing measured to show. Approving here means
      approving the step on its description alone.
    </p>

    <template v-else>
      <!-- The change, measured by the runner rather than reported by the agent. -->
      <div class="verdict-stats" role="list">
        <div v-if="meta?.fix?.files_changed !== undefined" role="listitem"><b>{{ meta.fix.files_changed }}</b><span>{{ meta.fix.files_changed === 1 ? 'file' : 'files' }}</span></div>
        <div v-if="meta?.fix?.lines_changed !== undefined" role="listitem"><b>{{ meta.fix.lines_changed }}</b><span>lines changed</span></div>
        <div v-if="meta?.fix?.tests_added !== undefined" role="listitem"><b>{{ meta.fix.tests_added }}</b><span>tests added</span></div>
        <div v-if="repos.length" role="listitem"><b>{{ commitCount }}</b><span>{{ commitCount === 1 ? 'commit' : 'commits' }} in {{ repos.length }} {{ repos.length === 1 ? 'repo' : 'repos' }}</span></div>
      </div>

      <!-- Did it pass, as the record holds it. -->
      <div class="flex flex-wrap gap-x-4 gap-y-1.5">
        <StatusLabel v-if="tests" :status="tests.passed ? 'completed' : 'failed'" :label="`Tests after the fix: ${tests.label}`" :title="`from ${tests.from}`" />
        <span v-else class="text-label">No machine-readable test report in the bundle</span>
        <StatusLabel
          v-if="meta?.security?.verdict" :status="securityOk ? 'completed' : 'paused'"
          :label="`Security ${meta.security.verdict}${meta.security.high ? ` · ${meta.security.high} high` : ''}${meta.security.medium ? ` · ${meta.security.medium} medium` : ''}`"
        />
        <StatusLabel v-if="meta?.deployment?.migration_changed" status="paused" :label="`Changes a database migration${meta.deployment.rollback ? ` · rollback: ${meta.deployment.rollback}` : ''}`" />
        <span v-if="meta?.oracle?.kind" class="text-label">Oracle {{ meta.oracle.kind }}<template v-if="meta.oracle.runs">, {{ meta.oracle.runs }} run(s)</template></span>
      </div>
      <p v-if="adversarialMissing" class="m-0" style="color: var(--error);">
        This change is <span class="font-mono">{{ run.blastRadius }}</span>, which the evidence-bundle
        schema requires an adversarial report for — and the bundle has none.
      </p>

      <!-- What approving gains and risks, in the implementer's words. -->
      <div v-if="brief" class="space-y-2">
        <p class="verdict-gist" :class="{ 'verdict-gist--open': situationOpen }">{{ brief.situation }}</p>
        <button v-if="brief.situation.length > 260" class="t-small focus-ring rounded" style="color: var(--accent);" :aria-expanded="situationOpen" @click="situationOpen = !situationOpen">
          {{ situationOpen ? 'Show less' : 'Show more' }}
        </button>
        <div v-if="openQuestions.length" class="group-card p-3! space-y-2">
          <h3 class="t-ui font-semibold m-0 text-strong">Intake questions still open</h3>
          <dl class="m-0 space-y-2">
            <div v-for="(q, i) in openQuestions" :key="i"><dt class="font-medium text-strong">{{ q.question }}</dt><dd class="m-0 text-label whitespace-pre-wrap">{{ q.answer }}</dd></div>
          </dl>
        </div>
        <div class="verdict-options">
          <details v-for="o in briefOptions" :key="o.key">
            <summary class="focus-ring">
              <UIcon name="i-lucide-chevron-right" class="chev" />
              <span class="min-w-0 flex-1">
                <span class="block font-semibold line-clamp-2" style="color: var(--text-primary);">{{ o.name }}</span>
                <span class="block text-label line-clamp-2">{{ o.delivers }}</span>
              </span>
              <span v-if="o.level" class="verdict-risk" :class="`verdict-risk--${o.level}`"><i aria-hidden="true" />{{ RISK_WORD[o.level] }}</span>
            </summary>
            <dl class="verdict-facts">
              <dt>What happens</dt><dd>{{ o.next }}</dd>
              <dt>Left open</dt><dd>{{ o.leaves }}</dd>
              <template v-if="o.riskText"><dt>Risk</dt><dd>{{ o.riskText }}</dd></template>
            </dl>
          </details>
        </div>
        <p v-if="brief.recommendation" class="m-0 text-label">
          <b style="color: var(--text-primary);">The step recommends ({{ brief.recommendation.option.replace(/[()]/g, '') }}):</b> {{ brief.recommendation.why }}
        </p>
      </div>
      <p v-else-if="briefPending" class="m-0 text-label flex items-center gap-1.5">
        <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
        The step that made this change is writing what approving gains and risks. It shows here when it is done.
      </p>

      <!-- The change itself, and the reports, folded. -->
      <div class="verdict-options">
        <details v-if="changes?.commits.length || changes?.files.length || repos.length">
          <summary class="focus-ring">
            <UIcon name="i-lucide-chevron-right" class="chev" /><span class="flex-1" style="color: var(--text-primary);">The change</span>
            <span class="text-label">{{ changes?.files.length ?? meta?.fix?.files_changed ?? 0 }} files</span>
          </summary>
          <div class="verdict-body space-y-2">
            <div v-for="r in repos" :key="r.repo" class="flex gap-2">
              <span class="font-mono truncate">{{ r.repo }}</span>
              <a v-if="r.pr && !r.pr.includes('example.invalid')" :href="r.pr" target="_blank" rel="noopener" class="underline shrink-0" style="color: var(--accent);">
                {{ r.pr.replace(/^https?:\/\/(www\.)?github\.com\//, '') }}
              </a>
              <span v-else class="text-label shrink-0">no pull request yet</span>
            </div>
            <div v-for="c in changes?.commits ?? []" :key="c.sha" class="flex gap-2">
              <span class="font-mono text-label shrink-0">{{ c.sha.slice(0, 9) }}</span>
              <span style="color: var(--text-primary);">{{ c.subject }}</span>
            </div>
            <div v-for="f in changes?.files ?? []" :key="f.path" class="flex gap-2 font-mono">
              <span class="tabular-nums shrink-0" style="color: var(--success);">+{{ f.added ?? '?' }}</span>
              <span class="tabular-nums shrink-0" style="color: var(--error);">−{{ f.removed ?? '?' }}</span>
              <span class="truncate" :title="f.path">{{ f.path }}</span>
            </div>
          </div>
        </details>
        <details v-if="presentReports.length">
          <summary class="focus-ring">
            <UIcon name="i-lucide-chevron-right" class="chev" /><span class="flex-1" style="color: var(--text-primary);">Reports</span>
            <span class="text-label">{{ presentReports.length }}</span>
          </summary>
          <div class="verdict-body flex flex-wrap gap-x-3 gap-y-1">
            <button
              v-for="r in presentReports" :key="r.file" type="button"
              class="underline focus-ring" style="color: var(--accent);" @click="openReport = r"
            >{{ r.label }}</button>
          </div>
        </details>
        <details v-if="pipelineNotes.length">
          <summary class="focus-ring">
            <UIcon name="i-lucide-chevron-right" class="chev" /><span class="flex-1" style="color: var(--text-primary);">What the pipeline noted on the way</span>
            <span class="text-label">{{ pipelineNotes.length }}</span>
          </summary>
          <ul class="verdict-body space-y-1"><li v-for="n in pipelineNotes" :key="n.key" :title="n.title">{{ n.text }}</li></ul>
        </details>
      </div>
    </template>
    <USlideover v-model:open="reportOpen" :title="openReport?.label ?? 'Report'" :ui="{ content: 'max-w-3xl' }">
      <template #body><RunArtifacts v-if="openReport" :run-id="run.id" :initial="openReport.file" only /></template>
    </USlideover>
  </div>
</template>

<style scoped>
.verdict-gist { margin: 0; font-size: 13px; color: var(--text-secondary); white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.verdict-gist--open { display: block; }
.verdict-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); background: var(--surface-raised); border-radius: 12px; box-shadow: 0 0 0 0.5px var(--border-default); overflow: hidden; }
.verdict-stats > div { padding: 10px 14px; border-left: 0.5px solid var(--border-subtle); }
.verdict-stats > div:first-child { border-left: 0; }
.verdict-stats b { display: block; font-size: 17px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.verdict-stats span { font-size: 12px; color: var(--text-tertiary); }
.verdict-options { background: var(--surface-raised); border-radius: 12px; box-shadow: 0 0 0 0.5px var(--border-default); overflow: hidden; }
.verdict-options:empty { display: none; }
.verdict-options details { border-top: 0.5px solid var(--border-subtle); }
.verdict-options details:first-child { border-top: 0; }
.verdict-options summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; }
.verdict-options summary::-webkit-details-marker { display: none; }
.verdict-options summary:hover { background: var(--surface-hover); }
.verdict-options .chev { width: 14px; height: 14px; color: var(--text-tertiary); flex: none; transition: transform 0.15s; }
.verdict-options details[open] > summary .chev { transform: rotate(90deg); }
.verdict-body { padding: 0 14px 12px 38px; margin: 0; color: var(--text-secondary); }
.verdict-facts { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 6px 12px; margin: 0; padding: 0 14px 12px 38px; }
.verdict-facts dt { color: var(--text-tertiary); }
.verdict-facts dd { margin: 0; color: var(--text-primary); }
.verdict-risk { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.verdict-risk i { width: 7px; height: 7px; border-radius: 2px; background: currentColor; }
.verdict-risk--low { color: var(--success); }
.verdict-risk--medium { color: var(--warning); }
.verdict-risk--high { color: var(--error); }
@media (max-width: 640px) {
  .verdict-facts { grid-template-columns: minmax(0, 1fr); gap: 2px; padding-left: 14px; }
}
</style>
