<script setup lang="ts">
const props = defineProps<{
  modelValue: string | undefined
  options: Array<{
    value: string | undefined
    label: string
    description?: string
  }>
  placeholder?: string
  icon?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | undefined): void
}>()

const isOpen = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)

const selectedOption = computed(() => {
  return props.options.find((o) => o.value === props.modelValue)
})

function selectOption(value: string | undefined) {
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
  <div ref="dropdownRef" class="relative inline-block w-full">
    <button
      type="button"
      class="field-input flex items-center gap-2 text-left"
      @click="isOpen = !isOpen"
    >
      <UIcon v-if="icon" :name="icon" class="size-3.5 text-meta" />
      <span 
        class="flex-1 truncate"
        :style="!selectedOption ? 'color: var(--text-disabled); font-family: var(--font-sans);' : ''"
      >
        {{ selectedOption?.label || placeholder || 'Select...' }}
      </span>
      <UIcon
        :name="isOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        class="size-3.5 text-meta"
      />
    </button>

    <!-- Dropdown -->
    <Transition name="dropdown">
      <div
        v-if="isOpen"
        class="absolute top-full left-0 mt-1 w-full min-w-[200px] rounded-xl overflow-hidden z-50 flex flex-col max-h-[320px]"
        style="background: var(--surface-overlay); border: 1px solid var(--border-default); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15), 0 0 0 1px var(--border-subtle);"
      >
        <div class="flex-1 overflow-y-auto custom-scrollbar py-1">
          <button
            v-for="option in options"
            :key="String(option.value)"
            type="button"
            class="w-full px-3 py-2 text-left transition-all"
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
              <span class="text-[12px] font-medium" style="color: var(--text-primary);">
                {{ option.label }}
              </span>
            </div>
            <div v-if="option.description" class="text-[10px] mt-0.5 ml-5.5" style="color: var(--text-secondary);">
              {{ option.description }}
            </div>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: var(--border-subtle);
  border-radius: 10px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: var(--meta);
}

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
