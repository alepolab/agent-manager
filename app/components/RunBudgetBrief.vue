<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import type { BudgetBrief } from '~~/shared/utils/budgetBrief'

/**
 * A budget pause, laid out for the decision it asks for: what the run spent
 * and on what, what is left and what that usually takes, and what Continue
 * and Stop each lead to. The pause used to show one line - "182 min over the
 * 180 min cap" - and nothing to decide it by.
 */
const props = defineProps<{ run: WorkflowRun }>()
const brief = ref<BudgetBrief | null>(null)
const failed = ref(false)
watch(() => [props.run.id, props.run.question?.askedAt], async () => {
  failed.value = false
  try { brief.value = await $fetch<BudgetBrief>(`/api/runs/${props.run.id}/budget`) } catch { failed.value = true }
}, { immediate: true })

const m = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h ${Math.round(n % 60)}m` : `${Math.round(n)}m`)
const t = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
/** Whether the fresh allowance covers what is left, on the typical figures. */
const enough = computed(() => brief.value?.estimateMinutes == null ? null : brief.value.estimateMinutes <= brief.value.grant.minutes)
</script>

<template>
  <div class="group-card p-0! t-small">
    <div class="px-3 py-2 t-ui font-semibold text-strong" style="border-bottom: 0.5px solid var(--border-default);">What granting more buys</div>
    <p v-if="failed" class="px-3 py-2 m-0 text-label">Could not read this run's spend.</p>
    <p v-else-if="!brief" class="px-3 py-2 m-0 text-label">Reading this run's spend…</p>
    <div v-else class="px-3 py-2 space-y-3">
      <section>
        <h4 class="t-ui font-semibold mb-1 text-strong">Spent</h4>
        <p class="m-0 text-strong">
          <b :style="{ color: brief.over.includes('minutes') ? 'var(--warning)' : undefined }">{{ m(brief.minutesUsed) }}</b> of {{ m(brief.maxMinutes) }}
          · <b :style="{ color: brief.over.includes('tokens') ? 'var(--warning)' : undefined }">{{ t(brief.tokensUsed) }}</b> of {{ t(brief.maxTokens) }} tokens
          <template v-if="brief.costUsd != null"> · ${{ brief.costUsd.toFixed(2) }}</template>
        </p>
        <table class="mt-1 w-full t-small">
          <tr v-for="s in brief.spent" :key="s.label">
            <td class="pr-3 text-strong">{{ s.label }}</td>
            <td class="pr-3 tabular-nums text-right">{{ m(s.minutes) }}</td>
            <td class="pr-3 tabular-nums text-right text-label">{{ s.tokens != null ? `${t(s.tokens)} tokens` : '' }}</td>
            <td class="text-label" :style="{ color: s.visits > 1 ? 'var(--warning)' : undefined }">{{ s.visits > 1 ? `ran ${s.visits}×` : '' }}</td>
          </tr>
        </table>
      </section>

      <section>
        <h4 class="t-ui font-semibold mb-1 text-strong">Still to run</h4>
        <p v-if="!brief.remaining.length" class="m-0 text-label">Nothing: every step has run.</p>
        <table v-else class="w-full t-small">
          <tr v-for="r in brief.remaining" :key="r.label">
            <td class="pr-3 text-strong">{{ r.label }}</td>
            <td class="tabular-nums text-right text-label">
              {{ r.typicalMinutes != null ? `typically ${m(r.typicalMinutes)}` : 'no finished run to compare' }}
            </td>
          </tr>
        </table>
        <p v-if="brief.remaining.length" class="m-0 mt-1 text-label">
          <template v-if="brief.estimateMinutes != null">
            About {{ m(brief.estimateMinutes) }} in all, the median of {{ brief.comparedRuns }} finished run(s) of this workflow.
          </template>
          <template v-else>No estimate: a step still to run has not finished on any run of this workflow.</template>
        </p>
      </section>

      <section>
        <h4 class="t-ui font-semibold mb-1 text-strong">Your options</h4>
        <dl class="m-0 grid gap-x-2 gap-y-1" style="grid-template-columns: max-content 1fr;">
          <dt class="text-label">Continue</dt>
          <dd class="m-0">
            Grants {{ m(brief.grant.minutes) }} and {{ t(brief.grant.tokens) }} tokens more and runs the steps above.
            <template v-if="enough === true"> On the typical figures that is enough to finish.</template>
            <template v-else-if="enough === false"> On the typical figures that may not be enough: it could pause here again.</template>
          </dd>
          <dt class="text-label">Stop</dt>
          <dd class="m-0">
            Ends the run here.
            <template v-if="brief.keeps.pr">Its pull request stays open: <a :href="brief.keeps.pr" target="_blank" rel="noopener" class="underline">{{ brief.keeps.pr.replace(/^https?:\/\/(www\.)?github\.com\//, '') }}</a>.</template>
            <template v-else-if="brief.keeps.branch">Its work stays on <span class="font-mono">{{ brief.keeps.branch }}</span>; no pull request has been opened, and the steps above do not run.</template>
            <template v-else>Nothing it did is kept on a branch.</template>
          </dd>
        </dl>
      </section>
    </div>
  </div>
</template>
