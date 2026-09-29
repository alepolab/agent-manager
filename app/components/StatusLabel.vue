<script setup lang="ts">
import { statusKind, statusWord } from '~/utils/runStatus'

/**
 * A run or step status as a glyph and a word, never a colour alone. Six
 * statuses share three hues; the glyph and the word are what tell "paused"
 * from "awaiting review", and they are what a colour-blind reader gets.
 */
const props = defineProps<{
  status: string
  /** Override the word, e.g. "Your turn" for a gate that is yours. */
  label?: string
  /** Glyph only; the word moves into the accessible name. */
  iconOnly?: boolean
}>()

const kind = computed(() => statusKind(props.status))
const word = computed(() => props.label ?? statusWord(props.status))
const ICON: Record<string, string> = {
  now: 'i-lucide-loader-circle',
  wait: 'i-lucide-hand',
  fail: 'i-lucide-circle-x',
  done: 'i-lucide-circle-check',
  idle: 'i-lucide-circle-dashed',
}
</script>

<template>
  <span class="status-label" :class="`status-label--${kind}`" :title="iconOnly ? word : undefined">
    <UIcon :name="ICON[kind]!" class="status-label__icon" :class="{ 'status-label__icon--spin': kind === 'now' }" aria-hidden="true" />
    <span :class="{ 'sr-only': iconOnly }">{{ word }}</span>
  </span>
</template>
