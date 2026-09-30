<script setup lang="ts">
/**
 * A ticket key that opens the ticket in Jira, in a new tab. Plain text until the
 * instance's Jira address is known, and for anything that is not a Jira key.
 * Not for use inside a row that is itself a link or a button: an anchor cannot
 * sit inside either.
 */
const props = defineProps<{ ticketKey: string }>()
const { ticketUrl } = useJiraLink()
const href = computed(() => ticketUrl(props.ticketKey))
</script>

<template>
  <a
    v-if="href" :href="href" target="_blank" rel="noopener"
    class="ticket-link font-mono focus-ring" :title="`Open ${ticketKey} in Jira`" @click.stop
  >{{ ticketKey }}<UIcon name="i-lucide-arrow-up-right" class="size-3 shrink-0" aria-hidden="true" /><span class="sr-only"> (opens Jira)</span></a>
  <span v-else class="font-mono">{{ ticketKey }}</span>
</template>

<style scoped>
.ticket-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--accent);
  border-radius: 4px;
  white-space: nowrap;
}
.ticket-link:hover { text-decoration: underline; text-underline-offset: 2px; }
</style>
