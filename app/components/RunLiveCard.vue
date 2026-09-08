<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'
import { currentStep, stepsDone, quietSeconds, isQuiet, shortDuration } from '~/utils/runActivity'

/**
 * One live run, answering "what is happening right now" without opening it.
 *
 * Every field here is already on the run record — the runner flattens the SDK
 * message loop's telemetry onto the step it is executing (assistantMessages,
 * lastTool, lastActivityAt), so the list endpoint carries it and this needs no
 * request of its own. The decisions behind the display live in
 * ~/utils/runActivity, where they can be tested.
 */
const props = defineProps<{ run: WorkflowRun, now: number }>()

const current = computed(() => currentStep(props.run))
const done = computed(() => stepsDone(props.run))
const elapsed = computed(() => shortDuration(props.now - props.run.startedAt))
const quiet = computed(() => isQuiet(props.run, current.value, props.now))
const quietLabel = computed(() => {
  const s = quietSeconds(current.value, props.now)
  return s === null ? null : shortDuration(s * 1000)
})

/** A paused run is not slow, it is waiting on a person — say so, and say what for. */
const question = computed(() => props.run.question?.text ?? null)

const headline = computed(() => props.run.ticketKey || props.run.initialPrompt.split('\n')[0]?.slice(0, 70) || 'Untitled run')
</script>

<template>
  <div class="px-4 py-3 flex flex-col gap-2" style="border-top: 1px solid var(--border-subtle);">
    <!-- Identity and the numbers that place the run, on one line. -->
    <div class="flex items-baseline gap-3 flex-wrap">
      <NuxtLink :to="`/runs/${run.id}`" class="text-[13px] font-medium hover:underline">{{ headline }}</NuxtLink>
      <span class="text-[11px] text-meta">{{ run.workflowName }}</span>
      <span v-if="run.product?.name" class="text-[11px] text-meta">{{ run.product.name }}</span>
      <span class="ml-auto flex items-center gap-3 text-[11px] text-label font-mono tabular-nums">
        <span>{{ elapsed }}</span>
        <span v-if="run.usage">${{ run.usage.usd.toFixed(2) }}</span>
        <span>{{ done }}/{{ run.steps.length }} steps</span>
      </span>
    </div>

    <RunProgressBar :steps="run.steps" />

    <!-- What the agent is doing. This is the whole point of the card. -->
    <div v-if="question" class="flex items-center gap-2 text-[12px]">
      <UIcon name="i-lucide-hand" class="size-3.5 shrink-0" :style="{ color: RUN_STATUS_COLOR.paused }" />
      <span :style="{ color: RUN_STATUS_COLOR.paused }">Waiting for you:</span>
      <span class="text-label truncate">{{ question }}</span>
      <UButton size="xs" variant="soft" label="Answer" :to="`/runs/${run.id}`" class="ml-auto shrink-0" />
    </div>

    <div v-else-if="current" class="flex items-center gap-2 text-[12px] min-w-0">
      <UIcon
        :name="run.status === 'running' ? 'i-lucide-play' : 'i-lucide-pause'"
        class="size-3.5 shrink-0"
        :style="{ color: RUN_STATUS_COLOR[run.status] }"
      />
      <span class="font-medium truncate">{{ current.label }}</span>
      <span class="text-meta font-mono text-[11px] truncate">{{ current.agentSlug }}</span>
      <span v-if="current.visits > 1" class="text-meta text-[11px]">visit {{ current.visits }}</span>
    </div>

    <!-- The moving parts, kept on their own line so the step name stays readable. -->
    <div v-if="current && !question" class="flex items-center gap-3 text-[11px] text-meta font-mono">
      <span v-if="current.lastTool" class="truncate">{{ current.lastTool }}</span>
      <span v-if="current.assistantMessages">{{ current.assistantMessages }} msgs</span>
      <span v-if="quietLabel" :style="quiet ? { color: RUN_STATUS_COLOR.paused } : undefined">
        <template v-if="quiet">⚠ quiet {{ quietLabel }}</template>
        <template v-else>{{ quietLabel }} ago</template>
      </span>
      <span v-else>no activity reported yet</span>
    </div>
  </div>
</template>
