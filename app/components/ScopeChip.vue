<script setup lang="ts">
/**
 * How far a setting reaches.
 *
 * /profile and /settings looked identical and were not: one holds your own
 * Jira token, the other holds the host every run on the instance talks to.
 * Nothing on either page said which, so every save asked the same unanswered
 * question about blast radius.
 */
const props = defineProps<{ scope: 'yours' | 'instance' | 'server' }>()

const LABEL = {
  yours: 'Yours only',
  instance: 'Everyone on this instance',
  server: 'Set by the server',
} as const

const CLASS = { yours: 'badge-accent', instance: 'badge-subtle', server: 'badge-subtle' } as const
</script>

<template>
  <span class="badge" :class="CLASS[props.scope]">{{ LABEL[props.scope] }}</span>
</template>
