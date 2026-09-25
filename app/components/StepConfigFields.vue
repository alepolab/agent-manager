<script setup lang="ts">
import type { WorkflowStep } from '~/types'
import type { StepKind } from '~~/shared/utils/workflowStack'
import { DEFAULT_MAX_VISITS } from '~~/shared/utils/workflowGraph'
import { producesError } from '~/utils/produces'

/**
 * The fields for one step's kind, moved out of the builder's old step-settings
 * modal. Each field reads `step` and emits the patch the modal's setter wrote,
 * with the same clearing rules: an emptied field removes its key rather than
 * writing an empty value.
 */
const props = defineProps<{
  step: WorkflowStep
  kind: StepKind
  /** The monitor picker's choices: any agent can review a step. */
  agents: { slug: string, name: string, description?: string }[]
  /** As `/api/channels` returns them; only the name is stored on the step. */
  channels: { name: string, kind: string, host?: string }[]
  /** The workflow's declared, non-empty input names. */
  parameterNames: string[]
  readOnly: boolean
}>()
const emit = defineEmits<{ patch: [Partial<WorkflowStep>] }>()
const patch = (changes: Partial<WorkflowStep>) => emit('patch', changes)

// Agent descriptions run to whole paragraphs here - clip them or the picker is unreadable.
const summarise = (text?: string) => {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine
}
const monitorOptions = computed(() => [
  { value: undefined, label: 'No monitor', description: 'Run this step unsupervised' },
  ...props.agents.map(a => ({ value: a.slug, label: a.name, description: summarise(a.description) })),
])

const contextModeOptions = [
  { value: 'predecessors', label: 'Only the steps just before it', description: 'The default: immediate forward predecessors' },
  { value: 'ancestors', label: 'Every step upstream', description: 'The full ancestry, budgeted and truncation-marked' },
]

const settingsMonitor = computed({
  get: () => props.step.monitorSlug,
  set: (value?: string) => patch({ monitorSlug: value || undefined }),
})
const settingsRunWhen = computed({
  get: () => props.step.runWhen?.artifact ?? '',
  set: (value: string) => {
    const artifact = value.trim()
    patch({ runWhen: artifact ? { artifact } : undefined })
  },
})
/** The files this step must leave behind, edited one per line - the same shape
 *  as the routing table below, and for the same reason: a JSON array in a text
 *  box is a worse thing to type than one entry per line. */
const settingsProduces = computed({
  get: () => (props.step.produces ?? []).join('\n'),
  set: (value: string) => {
    const names = value.split('\n').map(n => n.trim()).filter(Boolean)
    patch({ produces: names.length ? names : undefined })
  },
})
const settingsProducesError = computed(() => producesError(props.step.produces))
/** `predecessors` is never persisted: computeInput only tests for 'ancestors',
 *  so writing the default would be a key that says nothing. */
const settingsContextMode = computed({
  get: () => props.step.contextMode ?? 'predecessors',
  set: (value?: string) => patch({ contextMode: value === 'ancestors' ? 'ancestors' : undefined }),
})
/** The channel a notify step posts to. Emptying it removes the whole notify
 *  block, for the same reason emptying a dispatch source removes that one: a
 *  message with no destination is config that can never fire. */
const settingsNotifyChannel = computed({
  get: () => props.step.notify?.channel ?? '',
  set: (value: string) => {
    const channel = value.trim()
    const current = props.step.notify
    patch({ notify: channel ? { ...current, channel } : undefined })
  },
})
const settingsNotifyMessage = computed({
  get: () => props.step.notify?.message ?? '',
  set: (value: string) => {
    const message = value.trim()
    const current = props.step.notify
    if (!current) return
    patch({ notify: { ...current, message: message || undefined } })
  },
})

/** The artifact a dispatch step fans out over. Emptying it removes the whole
 *  triggerWorkflow block - a step with a routing table and no source to read it
 *  against is config that can never fire - unless the step fans out over a run
 *  parameter instead, which is the other half of the same field.
 *
 *  Setting one source clears the other rather than leaving both: naming both is
 *  a step the runner refuses, and a step cannot be saved into a state whose
 *  only outcome is a failure at run time. */
const settingsTriggerSource = computed({
  get: () => props.step.triggerWorkflow?.source ?? '',
  set: (value: string) => {
    const source = value.trim()
    const current = props.step.triggerWorkflow
    const rest = { ...current, fromParameter: undefined }
    patch({
      triggerWorkflow: source
        ? { ...rest, source }
        : (current?.fromParameter ? { ...current, source: undefined } : undefined),
    })
  },
})
/** The run parameter a dispatch step fans out over, one item per line. A picker
 *  rather than a text box, for the reason the notify channel is one: a mistyped
 *  name is a fan-out that silently dispatches nothing. */
const settingsTriggerFromParameter = computed({
  get: () => props.step.triggerWorkflow?.fromParameter ?? '',
  set: (value: string) => {
    const fromParameter = value.trim()
    const current = props.step.triggerWorkflow
    const rest = { ...current, source: undefined }
    patch({
      triggerWorkflow: fromParameter
        ? { ...rest, fromParameter }
        : (current?.source ? { ...current, fromParameter: undefined } : undefined),
    })
  },
})
/** The input each child is given its own item as. Required with a parameter
 *  source, and checked against every target workflow before anything starts. */
const settingsTriggerItemParameter = computed({
  get: () => props.step.triggerWorkflow?.itemParameter ?? '',
  set: (value: string) => {
    const itemParameter = value.trim()
    const current = props.step.triggerWorkflow
    if (!current) return
    patch({ triggerWorkflow: { ...current, itemParameter: itemParameter || undefined } })
  },
})
/** Whether the run waits for its children before going on. */
const settingsTriggerJoin = computed({
  get: () => props.step.triggerWorkflow?.join === true,
  set: (value: boolean) => {
    const current = props.step.triggerWorkflow
    if (!current) return
    patch({ triggerWorkflow: { ...current, join: value || undefined } })
  },
})
const settingsTriggerSlug = computed({
  get: () => props.step.triggerWorkflow?.slug ?? '',
  set: (value: string) => {
    const slug = value.trim()
    const current = props.step.triggerWorkflow
    if (!current) return
    patch({ triggerWorkflow: { ...current, slug: slug || undefined } })
  },
})
const settingsTriggerRouteBy = computed({
  get: () => props.step.triggerWorkflow?.routeBy ?? '',
  set: (value: string) => {
    const routeBy = value.trim()
    const current = props.step.triggerWorkflow
    if (!current) return
    patch({ triggerWorkflow: { ...current, routeBy: routeBy || undefined } })
  },
})
/** The routing table, edited as `value: workflow-slug` lines. A JSON object in
 *  a text box is a worse thing to type than one pair per line, and this is the
 *  only place a person writes it. */
const settingsTriggerRoutes = computed({
  get: () => Object.entries(props.step.triggerWorkflow?.routes ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
  set: (value: string) => {
    const current = props.step.triggerWorkflow
    if (!current) return
    const routes: Record<string, string> = {}
    for (const line of value.split('\n')) {
      const at = line.indexOf(':')
      if (at < 1) continue
      const key = line.slice(0, at).trim()
      const slug = line.slice(at + 1).trim()
      if (key && slug) routes[key] = slug
    }
    patch({ triggerWorkflow: { ...current, routes: Object.keys(routes).length ? routes : undefined } })
  },
})
const settingsMaxVisits = computed({
  get: () => props.step.maxVisits ?? DEFAULT_MAX_VISITS,
  set: (value: number) => {
    const clamped = Math.max(1, Math.min(20, Math.floor(Number(value) || DEFAULT_MAX_VISITS)))
    patch({ maxVisits: clamped })
  },
})

/** The approved-drafts file a create step reads. Emptying it drops the key but
 *  keeps `action: 'create'`, which is what makes this a create step at all. */
function setJiraSource(value: string) {
  patch({ jira: { ...(props.step.jira ?? {}), action: 'create', source: value.trim() || undefined } })
}
</script>

<template>
  <fieldset :disabled="readOnly" class="space-y-4 min-w-0">
    <template v-if="kind === 'agent'">
      <div class="field-group">
        <label class="field-label">Files this step must leave behind, one per line</label>
        <textarea
          v-model="settingsProduces" rows="3" class="field-input font-mono text-xs"
          placeholder="plan.md&#10;qa-plan.json"
        />
        <span v-if="settingsProducesError" class="field-hint" style="color: var(--error);">{{ settingsProducesError }}</span>
        <span class="field-hint">
          Filenames in the run's artifacts directory. Checked before the monitor runs, so a step
          that left one out is sent back for that exact file instead of paying for a model to
          notice — which costs it a visit. A step with no visits left fails instead, and a step
          that skipped itself is exempt. Leave empty to check nothing.
        </span>
      </div>

      <div class="field-group">
        <label class="field-label">What this step is shown from upstream</label>
        <USelectDropdown v-model="settingsContextMode" :options="contextModeOptions" />
        <span class="field-hint">
          By default a step receives only the steps immediately before it. "Every step upstream"
          is for a step that must see evidence produced several hops back — it is not free: the
          input is capped at 60,000 characters shared evenly between the contributors, and what
          does not fit is cut with the truncation marked.
        </span>
      </div>

      <div class="field-group">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" :checked="step.testsUnlocked === true" @change="(e) => { patch({ testsUnlocked: (e.target as HTMLInputElement).checked || undefined }) }">
          <span class="field-label mb-0">This step writes tests and code together</span>
          <HelpTip
            title="Lifting the test lock"
            body="The plugin's test lock denies test edits once source has been edited, so a step cannot quietly rewrite the test that was meant to catch it. A step that owns both by design needs that lock lifted: the runner writes .agent/test-unlock.json into the checkout with the reason before the step starts, and preflight checks the lock against this step before the run spends a token. Tick it only for a step whose whole job is test-and-code in one pass."
          />
        </label>
        <span class="field-hint">
          The runner lifts the plugin's test lock for this step and records why. Leave it off for
          any step that edits source without owning the tests that cover it.
        </span>
      </div>

      <div class="field-group">
        <label class="field-label">Max visits per run</label>
        <input
          :value="settingsMaxVisits"
          type="number"
          min="1"
          max="20"
          class="field-input w-24"
          @change="(e) => { settingsMaxVisits = (e.target as HTMLInputElement).valueAsNumber }"
        >
        <span class="field-hint">
          How many times a loop or a monitor retry may bring this step back. Default {{ DEFAULT_MAX_VISITS }}.
        </span>
      </div>

      <div class="field-group">
        <label class="field-label">Monitor agent</label>
        <USelectDropdown v-model="settingsMonitor" :options="monitorOptions" placeholder="No monitor" />
        <span class="field-hint">
          Reviews this step's output and replies CONTINUE, RETRY or ABORT. RETRY re-runs the step
          with the monitor's feedback. Doubles the agent calls for this step.
        </span>
      </div>

      <div class="field-group">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" :checked="step.continuesSession === true" @change="(e) => { patch({ continuesSession: (e.target as HTMLInputElement).checked || undefined }) }">
          <span class="field-label mb-0">Continue the previous step's session</span>
        </label>
        <span class="field-hint">
          Resumes the single step before this one's conversation instead of starting cold, so the
          next phase keeps everything the last one learned. Wrong wherever a fresh pair of eyes is
          the point, such as review or QA. Ignored, with a cold start, when the step has more than
          one predecessor or that transcript is not on disk.
        </span>
      </div>
    </template>

    <div v-else-if="kind === 'jira'" class="field-group">
      <label class="field-label">Move the ticket to</label>
      <input
        :value="step.jira?.transition ?? ''" type="text" class="field-input" placeholder="In Progress"
        @change="(e) => { patch({ jira: { ...(step.jira ?? {}), transition: (e.target as HTMLInputElement).value.trim() || undefined } }) }"
      >
      <label class="flex items-center gap-2 cursor-pointer mt-2">
        <input type="checkbox" :checked="step.jira?.comment === true" @change="(e) => { patch({ jira: { ...(step.jira ?? {}), comment: (e.target as HTMLInputElement).checked || undefined } }) }">
        <span class="field-label mb-0">Post the outcome comment</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer mt-2">
        <input type="checkbox" :checked="step.jira?.attach === true" @change="(e) => { patch({ jira: { ...(step.jira ?? {}), attach: (e.target as HTMLInputElement).checked || undefined } }) }">
        <span class="field-label mb-0">Attach the run's evidence files</span>
      </label>
      <span class="field-hint">Runner-executed, no model call. The status is matched to the ticket's own workflow (with synonyms), so "Dev Done" lands even where the project calls it "Ready for Review"; when nothing matches, the output lists what the ticket offers. Writes reach Jira only when JIRA_POST_ENABLED=1 on the instance.</span>
    </div>

    <div v-else-if="kind === 'jira-create'" class="field-group">
      <label class="field-label">Source artifact</label>
      <input
        :value="step.jira?.source ?? ''" type="text" class="field-input" placeholder="approved-drafts.json"
        @change="(e) => { setJiraSource((e.target as HTMLInputElement).value) }"
      >
      <span class="field-hint">The approved drafts file, e.g. approved-drafts.json</span>
    </div>

    <div v-else-if="kind === 'notify'" class="field-group">
      <label class="field-label">Post to channel</label>
      <select v-model="settingsNotifyChannel" class="field-input">
        <option value="">Choose a channel…</option>
        <option v-for="c in channels" :key="c.name" :value="c.name">{{ c.name }} ({{ c.kind }}{{ c.host ? ` · ${c.host}` : '' }})</option>
      </select>
      <span v-if="!channels.length" class="field-hint">
        No channels are configured on this instance yet. Add one under
        <NuxtLink to="/settings" class="underline">Settings</NuxtLink>, then choose it here.
      </span>
      <template v-if="settingsNotifyChannel">
        <label class="field-label mt-2">Message</label>
        <textarea v-model="settingsNotifyMessage" rows="3" class="field-input" placeholder="{count} drafts need a decision." />
      </template>
      <span class="field-hint">
        Runner-executed, no model call. Posts one message and completes. <code>{{ '{count}' }}</code> is
        the number of entries in this step's "Run only when this file has content" file below, and the
        entries are named the same way the review panel names them; a link to the run is appended. The
        channel's webhook is never stored in this workflow — only its name. A delivery failure is recorded
        in the step's output and never fails the run, so verify a new channel with "Send test" in Settings
        rather than on the branch that matters.
        Beside a step that waits for approval is fine: only the gated step waits, so this one sends
        before the run stops on the person.
      </span>
    </div>

    <div v-else-if="kind === 'loop'" class="field-group">
      <template v-if="!settingsTriggerFromParameter">
        <label class="field-label">Dispatch one run per entry in</label>
        <input v-model="settingsTriggerSource" type="text" class="field-input" placeholder="created-tickets.json">
      </template>
      <template v-if="!settingsTriggerSource">
        <label class="field-label" :class="{ 'mt-2': !settingsTriggerFromParameter }">
          {{ settingsTriggerFromParameter ? 'Dispatch one run per line of' : 'or one run per line of a run input' }}
        </label>
        <select v-model="settingsTriggerFromParameter" class="field-input">
          <option value="">Choose a run input…</option>
          <option v-for="name in parameterNames" :key="name" :value="name">{{ name }}</option>
        </select>
        <span v-if="!parameterNames.length" class="field-hint">
          This workflow declares no inputs yet. Add one under <strong>Inputs</strong> above, then choose it here.
        </span>
      </template>
      <template v-if="settingsTriggerSource || settingsTriggerFromParameter">
        <label class="field-label mt-2">Give each child this input</label>
        <input v-model="settingsTriggerItemParameter" type="text" class="field-input" placeholder="repo">
        <label class="field-label mt-2 flex items-center gap-2">
          <input v-model="settingsTriggerJoin" type="checkbox" class="rounded">
          <span>Wait for every child before the next step</span>
        </label>
        <template v-if="settingsTriggerSource">
          <label class="field-label mt-2">Route on this field</label>
          <input v-model="settingsTriggerRouteBy" type="text" class="field-input" placeholder="work_type">
          <label class="field-label mt-2">Routes, one <code>value: workflow-slug</code> per line</label>
          <textarea v-model="settingsTriggerRoutes" rows="5" class="field-input font-mono text-xs" placeholder="bug: runbook-a-ticket-to-evidence-backed-pr&#10;feature: runbook-b-feature-request-to-evidence-backed-pr" />
        </template>
        <label class="field-label mt-2">
          {{ settingsTriggerFromParameter ? 'Workflow every item goes to' : 'Workflow for anything the routes miss' }}
        </label>
        <input v-model="settingsTriggerSlug" type="text" class="field-input" placeholder="runbook-a-ticket-to-evidence-backed-pr">
      </template>
      <span class="field-hint">Runner-executed, no model call. Starts one run per item, each in its own checkout, from either an artifact this run's earlier steps wrote or a run input holding one item per line. The input is the way to fan out over a list somebody types when they start the run — scanning five repositories needs no step to produce a file first — and it has no field to route on, so it goes to one workflow. <strong>Every target workflow must declare the input you name above</strong>, or the step fails before starting anything: a child that was not told which item it is for would work on whatever its checkout contained. An entry nobody can route fails the step and starts nothing, so a batch is never half-dispatched. Each child counts against its own workflow's concurrency group; children over that group's cap are queued as real runs and start as slots free up. <strong>Waiting</strong> holds this run at <code>JOINING</code> until every child has settled, then writes <code>children.json</code> — one entry per child with its status — so one step downstream can report on the whole fan-out. A joining run spends no slot in its group, so a group that dispatches and receives can be capped at 1; without waiting, this step completes as soon as the children exist and each reports to its own run, and this run holds a slot while it dispatches, so such a group needs a cap of at least 2.</span>
    </div>

    <div class="field-group">
      <label class="field-label">Run only when this file has content</label>
      <input
        v-model="settingsRunWhen" type="text" class="field-input" placeholder="approved-drafts.json"
      >
      <span class="field-hint">
        A filename in the run's artifacts directory, for a step that consumes what an
        earlier step wrote. Leave empty and the step always runs. When the file is not
        written, or holds an empty array or object, the step is skipped and everything
        downstream still runs. When it exists but is not valid JSON the step fails, so a
        step that crashed mid-write is never mistaken for one with nothing to do.
      </span>
    </div>
  </fieldset>
</template>
