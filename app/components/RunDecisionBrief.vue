<script setup lang="ts">
import type { DecisionBrief } from '~~/shared/utils/decisionBrief'

/**
 * A step's question, laid out so a person who has not read the ticket, the
 * repository or the step's report can answer it: the situation, the criteria
 * it refers to in full, what was found, and each option with what it leads to.
 *
 * The inbox used to show the one `PIPELINE-ASK:` line. ASECRM-220's named
 * "criteria 2-3", a "trouble-ticket ratchet breach" and three lettered options,
 * and the developer reading it had no way to know what any of those were.
 */
const props = defineProps<{ brief: DecisionBrief, canAnswer: boolean }>()
const emit = defineEmits<{ choose: [text: string] }>()

const recommended = computed(() => props.brief.recommendation?.option.replace(/[()]/g, '').trim().toLowerCase())
const isRecommended = (key: string) => key.replace(/[()]/g, '').trim().toLowerCase() === recommended.value
</script>

<template>
  <div class="rounded-lg t-small" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
    <div class="px-3 py-2 space-y-3">
      <section>
        <h4 class="t-label mb-1" style="color: var(--text-secondary);">The situation</h4>
        <p class="m-0 whitespace-pre-wrap" style="color: var(--text-primary);">{{ brief.situation }}</p>
      </section>

      <section v-if="brief.criteria?.length">
        <h4 class="t-label mb-1" style="color: var(--text-secondary);">Acceptance criteria it refers to</h4>
        <ol class="m-0 pl-0 list-none space-y-1">
          <li v-for="c in brief.criteria" :key="c.ref" class="flex gap-2">
            <span class="font-mono shrink-0 text-label">{{ c.ref }}</span>
            <span style="color: var(--text-primary);">{{ c.text }}</span>
          </li>
        </ol>
      </section>

      <section v-if="brief.findings?.length">
        <h4 class="t-label mb-1" style="color: var(--text-secondary);">What the step found</h4>
        <ul class="m-0 pl-4 list-disc space-y-1" style="color: var(--text-primary);">
          <li v-for="(f, i) in brief.findings" :key="i" class="whitespace-pre-wrap">{{ f }}</li>
        </ul>
      </section>

      <section>
        <h4 class="t-label mb-1" style="color: var(--text-secondary);">Your options</h4>
        <div class="space-y-2">
          <div
            v-for="o in brief.options" :key="o.key"
            class="rounded p-2 space-y-1"
            :style="{ background: 'var(--surface-base)', border: `1px solid ${isRecommended(o.key) ? 'var(--accent)' : 'var(--border-subtle)'}` }"
          >
            <div class="flex items-start gap-2">
              <span class="font-mono font-medium shrink-0" style="color: var(--text-primary);">({{ o.key.replace(/[()]/g, '') }})</span>
              <span class="font-medium flex-1" style="color: var(--text-primary);">{{ o.label }}</span>
              <span v-if="isRecommended(o.key)" class="t-small font-mono uppercase px-1.5 rounded shrink-0" style="background: var(--accent-muted); color: var(--accent);">Recommended</span>
            </div>
            <dl class="m-0 grid gap-x-2 gap-y-0.5" style="grid-template-columns: max-content 1fr;">
              <dt class="text-label">Next</dt><dd class="m-0">{{ o.next }}</dd>
              <dt class="text-label">Ticket gets</dt><dd class="m-0">{{ o.delivers }}</dd>
              <dt class="text-label">Left undone</dt><dd class="m-0">{{ o.leaves }}</dd>
              <template v-if="o.risk"><dt class="text-label">Risk</dt><dd class="m-0">{{ o.risk }}</dd></template>
            </dl>
            <UButton
              v-if="canAnswer" size="xs" variant="soft" color="neutral"
              :label="`Choose (${o.key.replace(/[()]/g, '')})`"
              @click="emit('choose', `(${o.key.replace(/[()]/g, '')}) ${o.label}`)"
            />
          </div>
        </div>
      </section>

      <p v-if="brief.recommendation" class="m-0">
        <span class="text-label">The step recommends ({{ brief.recommendation.option.replace(/[()]/g, '') }}):</span>
        {{ brief.recommendation.why }}
      </p>
    </div>
  </div>
</template>
