<script setup lang="ts">
import type { PermissionMode } from '~/types'

const props = defineProps<{
  modelValue: PermissionMode
  options: Array<{
    value: PermissionMode
    label: string
    description: string
  }>
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: PermissionMode): void
}>()

const isOpen = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)

const selectedOption = computed(() => {
  return props.options.find((o) => o.value === props.modelValue)
})

function selectOption(value: PermissionMode) {
  emit('update:modelValue', value)
  isOpen.value = false
}

// Close on click outside
function handleClickOutside(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div ref="dropdownRef" class="relative z-10 min-w-0">
    <button
      class="flex items-center gap-2 px-3 py-1.5 rounded-full t-small font-medium transition-all max-w-full hover:bg-[var(--surface-hover)]"
      style="color: var(--text-secondary);"
      @click="isOpen = !isOpen"
    >
      <UIcon name="i-lucide-shield" class="size-3.5 shrink-0" />
      <span class="truncate">{{ selectedOption?.label || 'Default' }}</span>
      <UIcon
        :name="isOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
        class="size-3 shrink-0 opacity-50"
      />
    </button>

    <!-- Dropdown -->
    <Transition name="dropdown">
      <div
        v-if="isOpen"
        class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 max-w-[calc(100vw-2rem)] rounded-xl overflow-hidden z-50"
        style="background: var(--surface-overlay); border: 1px solid var(--border-default); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15), 0 0 0 1px var(--border-subtle);"
      >
        <div class="py-1">
          <button
            v-for="option in options"
            :key="option.value"
            class="w-full px-3 py-2.5 text-left transition-all"
            :style="{
              background: option.value === modelValue ? 'var(--accent-muted)' : 'transparent',
            }"
            :class="option.value !== modelValue ? 'hover:bg-[var(--surface-hover)]' : ''"
            @click="selectOption(option.value)"
          >
            <div class="flex items-center gap-2">
              <UIcon
                v-if="option.value === modelValue"
                name="i-lucide-check"
                class="size-3.5"
                style="color: var(--accent);"
              />
              <span
                v-else
                class="size-3.5"
              />
              <span class="t-small font-medium" style="color: var(--text-primary);">
                {{ option.label }}
              </span>
            </div>
            <div class="t-small mt-0.5 ml-5.5" style="color: var(--text-secondary);">
              {{ option.description }}
            </div>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.15s ease;
}

.dropdown-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}

.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
