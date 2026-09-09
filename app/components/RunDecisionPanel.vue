<script setup lang="ts">
import { RUN_STATUS_COLOR } from '~/utils/runStatus'
import type { WorkflowRun } from '~~/shared/types/run'
import type { DraftDecision, ReviewEdits, ReviewQueue } from '~~/shared/types/runReview'

/**
 * The entries a run is waiting on a person to decide about, with the decision
 * taken here rather than in a slash command reading files behind the app's
 * back.
 *
 * One submission for the whole batch, not one request per draft. The server
 * applies the decisions, files the approved tickets and resumes the run in a
 * single step, and a half-submitted review would leave a run gated on an
 * artifact that had already been filtered.
 */
// No "decided" event: both pages that mount this watch the run over SSE, and
// the stream stays open through awaiting_review, so continuing the run arrives
// as the ordinary status frame that unmounts this panel.
const props = defineProps<{ run: WorkflowRun }>()

const queue = ref<ReviewQueue | null>(null)
const loadError = ref<string | null>(null)
const decisions = ref<Record<number, DraftDecision>>({})
const edits = ref<Record<number, ReviewEdits>>({})
const editing = ref<number | null>(null)
const opened = ref<number | null>(null)
const note = ref('')
const submitting = ref(false)
const toast = useToast()

async function load() {
  loadError.value = null
  try {
    queue.value = await $fetch<ReviewQueue>(`/api/runs/${props.run.id}/decisions`)
  } catch (e: any) {
    queue.value = null
    loadError.value = e.data?.message || e.message
  }
}
// Re-read on the run's id only. The entries cannot change while the run is
// gated on them — the gate is what stops anything from writing that file — so
// re-fetching on every status frame would discard decisions half-made.
watch(() => props.run.id, load, { immediate: true })

const items = computed(() => queue.value?.items ?? [])
const approved = computed(() => items.value.filter(i => decisions.value[i.index] === 'approved'))
const skipped = computed(() => items.value.filter(i => decisions.value[i.index] === 'skipped'))
const undecided = computed(() => items.value.filter(i => !decisions.value[i.index]))

function decide(index: number, decision: DraftDecision) {
  decisions.value = { ...decisions.value, [index]: decision }
  if (decision === 'skipped') {
    // A skipped draft keeps no edits: they described a ticket nobody is filing,
    // and carrying them would put changes into the audit record for an entry
    // that was never acted on.
    const { [index]: _dropped, ...rest } = edits.value
    edits.value = rest
    if (editing.value === index) editing.value = null
  }
}
function skipRest() {
  const rest = { ...decisions.value }
  for (const i of undecided.value) rest[i.index] = 'skipped'
  decisions.value = rest
  editing.value = null
}
function startEditing(index: number) {
  const item = items.value.find(i => i.index === index)
  if (!item) return
  if (!edits.value[index]) {
    edits.value = {
      ...edits.value,
      [index]: {
        summary: item.summary ?? '',
        description: item.description ?? '',
        priority: typeof item.fields?.priority === 'string' ? item.fields.priority : '',
      },
    }
  }
  editing.value = index
}
function saveEdits(index: number) {
  editing.value = null
  decide(index, 'approved')
}
function cancelEdits(index: number) {
  const { [index]: _dropped, ...rest } = edits.value
  edits.value = rest
  editing.value = null
}

/** The severity/type/component line, from whatever the producer stated. Built
 *  from what is there rather than from a fixed set: a draft that names none of
 *  them shows its key alone instead of a row of blanks.
 *
 *  Priority is deliberately absent. The drafter maps it from severity, so the
 *  two are the same word twice over ("HIGH | SECURITY | billing/charge.py |
 *  HIGH"), and it is the one facet a reviewer can change — it belongs in the
 *  Modify form, where it is editable, rather than in a label that repeats it. */
function facets(fields: Record<string, unknown> | undefined, entry: Record<string, unknown>): string[] {
  return [entry.severity, entry.scan_type, fields?.component]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

async function submit() {
  if (undecided.value.length || submitting.value) return
  submitting.value = true
  try {
    const body = {
      decisions: items.value.map(i => ({
        index: i.index,
        decision: decisions.value[i.index]!,
        ...(decisions.value[i.index] === 'approved' && edits.value[i.index] ? { edits: edits.value[i.index] } : {}),
      })),
      note: note.value.trim() || undefined,
    }
    const res = await $fetch<{ approved: number, skipped: number, created: string[], lines: string[] }>(
      `/api/runs/${props.run.id}/decisions`, { method: 'POST', body },
    )
    toast.add({
      title: res.approved ? `Approved ${res.approved}, skipped ${res.skipped}` : `Skipped all ${res.skipped}`,
      // The per-entry sentences, not a count: "approved 2" hides that one of the
      // two could not be filed, and the operator has to know before they leave.
      description: res.lines.join('\n') || 'Nothing was created; the run continues without this branch.',
      color: 'success',
    })
  } catch (e: any) {
    toast.add({ title: 'Could not record the decisions', description: e.data?.message || e.message, color: 'error' })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div
    class="rounded-lg p-3 text-[12px] space-y-3"
    style="background: var(--surface-raised); border: 1px solid var(--warning);"
    role="alert"
    data-testid="run-decision-panel"
  >
    <div class="flex items-baseline gap-2 flex-wrap">
      <UIcon name="i-lucide-gavel" class="size-3.5 shrink-0" :style="{ color: RUN_STATUS_COLOR.awaiting_review }" />
      <span class="font-medium" style="color: var(--text-primary);">
        Awaiting your decision<template v-if="items.length"> — {{ items.length }} {{ items.length === 1 ? 'draft' : 'drafts' }}</template>
      </span>
      <span v-if="queue" class="ml-auto font-mono text-[10px] text-meta">{{ queue.artifact }}</span>
    </div>

    <p v-if="loadError" class="text-[12px]" style="color: var(--error);">{{ loadError }}</p>
    <p v-else-if="!queue" class="text-label">Reading the drafts…</p>
    <p v-else-if="!items.length" class="text-label">There is nothing to decide in {{ queue.artifact }}.</p>

    <div v-for="(item, n) in items" :key="item.index" class="rounded-lg px-3 py-2 space-y-1.5" style="background: var(--surface-base); border: 1px solid var(--border-subtle);">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-mono text-[10px] text-meta">[{{ n + 1 }}/{{ items.length }}]</span>
        <span class="font-mono text-[10px] uppercase text-label">{{ [item.key, ...facets(item.fields, item.entry)].join(' | ') }}</span>
        <span
          v-if="decisions[item.index]"
          class="ml-auto font-mono text-[10px] uppercase"
          :style="{ color: decisions[item.index] === 'approved' ? 'var(--success)' : 'var(--text-disabled)' }"
        >{{ decisions[item.index] }}</span>
      </div>

      <!-- The decision gate wrote this to be answerable on its own. The full
           draft is one disclosure away for when it is not. -->
      <p v-if="item.decisionPrompt" class="whitespace-pre-wrap" style="color: var(--text-primary);">{{ item.decisionPrompt }}</p>
      <p v-else class="whitespace-pre-wrap" style="color: var(--text-primary);">{{ item.summary || 'This draft carries no decision prompt; open it to decide.' }}</p>
      <p v-if="item.reason" class="text-label">{{ item.reason }}</p>
      <p v-if="item.escalationCriteria?.length" class="font-mono text-[10px] text-meta">{{ item.escalationCriteria.join(', ') }}</p>

      <div v-if="editing !== item.index" class="flex items-center gap-2 flex-wrap pt-0.5">
        <UButton size="xs" icon="i-lucide-check" label="Approve" :variant="decisions[item.index] === 'approved' ? 'solid' : 'soft'" @click="decide(item.index, 'approved')" />
        <UButton size="xs" icon="i-lucide-pencil" label="Modify" variant="soft" color="neutral" @click="startEditing(item.index)" />
        <UButton size="xs" icon="i-lucide-x" label="Skip" :variant="decisions[item.index] === 'skipped' ? 'solid' : 'ghost'" color="neutral" @click="decide(item.index, 'skipped')" />
        <button
          class="ml-auto text-label focus-ring rounded px-1"
          :aria-expanded="opened === item.index"
          @click="opened = opened === item.index ? null : item.index"
        >{{ opened === item.index ? 'Hide draft' : 'Show draft' }}</button>
      </div>

      <!-- Modify: the three fields a reviewer actually corrects. Project and
           issue type are not editable here — a draft filed against the wrong
           project is a drafting fault to send back, not one to patch at the
           gate. -->
      <div v-else class="space-y-2 pt-1">
        <div class="field-group">
          <label :for="`sum-${item.index}`" class="field-label">Summary</label>
          <input :id="`sum-${item.index}`" v-model="edits[item.index]!.summary" class="field-input" type="text">
        </div>
        <div class="field-group">
          <label :for="`pri-${item.index}`" class="field-label">Priority</label>
          <input :id="`pri-${item.index}`" v-model="edits[item.index]!.priority" class="field-input" type="text" placeholder="e.g. High">
        </div>
        <div class="field-group">
          <label :for="`desc-${item.index}`" class="field-label">Description</label>
          <textarea :id="`desc-${item.index}`" v-model="edits[item.index]!.description" class="field-input" rows="6" />
        </div>
        <div class="flex items-center gap-2">
          <UButton size="xs" icon="i-lucide-check" label="Save and approve" @click="saveEdits(item.index)" />
          <UButton size="xs" variant="ghost" color="neutral" label="Cancel" @click="cancelEdits(item.index)" />
        </div>
      </div>

      <div v-if="opened === item.index" class="space-y-1 pt-1" style="border-top: 1px solid var(--border-subtle);">
        <p v-if="item.summary" class="font-medium pt-1" style="color: var(--text-primary);">{{ item.summary }}</p>
        <pre v-if="item.description" class="whitespace-pre-wrap text-[11px] text-label">{{ item.description }}</pre>
        <ul v-if="item.acceptanceCriteria?.length" class="list-disc pl-4 text-[11px] text-label">
          <li v-for="(c, ci) in item.acceptanceCriteria" :key="ci">{{ c }}</li>
        </ul>
      </div>
    </div>

    <div v-if="items.length" class="flex items-center gap-2 flex-wrap pt-1" style="border-top: 1px solid var(--border-subtle);">
      <UButton v-if="undecided.length" size="xs" variant="ghost" color="neutral" label="Skip all remaining" class="mt-2" @click="skipRest" />
      <span class="mt-2 text-label" aria-live="polite">
        {{ approved.length }} approved, {{ skipped.length }} skipped<template v-if="undecided.length">, {{ undecided.length }} still undecided</template>
      </span>
      <UButton
        size="xs"
        class="ml-auto mt-2"
        :icon="approved.length ? 'i-lucide-check' : 'i-lucide-skip-forward'"
        :color="approved.length ? 'primary' : 'neutral'"
        :loading="submitting"
        :disabled="!!undecided.length || submitting"
        :label="approved.length
          ? `Continue with ${approved.length} ${approved.length === 1 ? 'draft' : 'drafts'}`
          : 'Continue — create nothing'"
        @click="submit"
      />
    </div>

    <div v-if="items.length" class="field-group">
      <label for="review-note" class="field-label">Note for the step that runs next (optional)</label>
      <textarea id="review-note" v-model="note" class="field-input" rows="2" placeholder="e.g. file these against the 25.2 release" />
    </div>
  </div>
</template>
