<script setup lang="ts">
const props = defineProps<{
  /** Accepts undefined because the fields bound to this are OPTIONAL on their
   *  frontmatter types (`skills?: string[]`, `tools?: AgentTool[]`) - an agent
   *  that declares none has no array at all. Requiring string[] forced every
   *  call site to invent an empty array just to satisfy the binding, which is
   *  the same as saying "declared, but empty" when the truth is "not declared".
   *  Normalised to [] internally via `selected`. */
  modelValue: string[] | undefined
  options: Array<{
    value: string
    label: string
    description?: string
  }>
  placeholder?: string
  icon?: string
  searchPlaceholder?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void
}>()

const isOpen = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)
const searchQuery = ref('')

const isSelected = (value: string) => (props.modelValue || []).includes(value)
/** One normalised count for the template: `(modelValue || []).length > 0` guards
 *  the v-if but does not narrow `modelValue` itself for the interpolation. */
const selectedCount = computed(() => props.modelValue?.length ?? 0)

const filteredOptions = computed(() => {
  const q = searchQuery.value.toLowerCase()
  if (!q) return props.options
  return props.options.filter(
    (o) =>
      o.label.toLowerCase().includes(q) ||
      o.value.toLowerCase().includes(q) ||
      o.description?.toLowerCase().includes(q)
  )
})

function toggleOption(value: string) {
  const newValue = [...(props.modelValue || [])]
  const idx = newValue.indexOf(value)
  if (idx === -1) {
    newValue.push(value)
  } else {
    newValue.splice(idx, 1)
  }
  emit('update:modelValue', newValue)
}

function removeOption(value: string) {
  emit('update:modelValue', (props.modelValue || []).filter(v => v !== value))
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
  <div ref="dropdownRef" class="relative w-full group">
    <div
      class="field-input flex flex-wrap items-center gap-1.5 min-h-[38px] py-1.5 px-3 cursor-pointer transition-all duration-200"
      :style="isOpen ? 'border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); background: var(--accent-muted);' : ''"
      @click="isOpen = !isOpen"
    >
      <UIcon 
        v-if="icon" 
        :name="icon" 
        class="size-4 text-meta shrink-0 transition-colors" 
        :style="{ color: isOpen ? 'var(--accent)' : '' }" 
      />
      
      <div v-if="(modelValue || []).length > 0" class="flex flex-wrap gap-1.5">
        <div
          v-for="val in modelValue"
          :key="val"
          class="flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-md text-[11px] font-semibold transition-colors group/tag"
          style="background: var(--accent-muted); color: var(--accent); border: 1px solid rgba(var(--accent), 0.2);"
          @click.stop
        >
          <span class="truncate max-w-[120px]">{{ options.find(o => o.value === val)?.label || val }}</span>
          <button 
            type="button" 
            class="size-4 rounded-md flex items-center justify-center transition-all remove-btn"
            aria-label="Remove"
            @click="removeOption(val)"
          >
            <UIcon name="i-lucide-x" class="size-2.5" />
          </button>
        </div>
      </div>
      
      <span 
        v-else
        class="flex-1 truncate text-[12px] text-label"
      >
        {{ placeholder || 'Select...' }}
      </span>

      <UIcon
        :name="isOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        class="size-4 text-meta shrink-0 ml-auto transition-transform duration-200"
      />
    </div>

    <!-- Dropdown -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="translate-y-1 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-if="isOpen"
        class="absolute top-full left-0 mt-2 w-full min-w-[280px] rounded-2xl overflow-hidden z-[100] flex flex-col max-h-[320px] shadow-2xl"
        style="background: var(--surface-overlay); border: 1px solid var(--border-default); box-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--border-subtle);"
      >
        <!-- Search -->
        <div class="p-3 border-b bg-surface-base" style="border-color: var(--border-subtle);">
          <div class="relative">
            <input
              v-model="searchQuery"
              class="w-full bg-surface-raised border border-border-default rounded-xl py-2 pl-9 pr-4 text-[12px] focus:outline-none transition-all placeholder:text-meta"
              :style="searchQuery ? 'border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-glow);' : ''"
              :placeholder="searchPlaceholder || 'Search skills...'"
              @click.stop
            />
            <UIcon
              name="i-lucide-search"
              class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-meta"
            />
            <button 
              v-if="searchQuery" 
              class="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-surface-hover text-meta hover:text-label transition-colors"
              @click.stop="searchQuery = ''"
            >
              <UIcon name="i-lucide-x" class="size-3" />
            </button>
          </div>
        </div>

        <!-- Options -->
        <div class="flex-1 overflow-y-auto p-1.5 custom-scrollbar">
          <div
            v-for="option in filteredOptions"
            :key="option.value"
            class="group/item flex items-start gap-3 px-3 py-2.5 rounded-xl transition-all cursor-pointer"
            :style="isSelected(option.value) ? 'background-color: var(--accent-muted);' : ''"
            :class="!isSelected(option.value) ? 'hover:bg-surface-hover' : ''"
            @click.stop="toggleOption(option.value)"
          >
            <!-- Checkbox -->
            <div
              class="mt-0.5 size-4 rounded-md border flex items-center justify-center transition-all duration-200"
              :style="
                isSelected(option.value)
                  ? 'background-color: var(--accent); border-color: var(--accent); box-shadow: 0 1px 3px var(--accent-glow);'
                  : 'background-color: var(--surface-base); border-color: var(--border-default);'
              "
            >
              <UIcon
                v-if="isSelected(option.value)"
                name="i-lucide-check"
                class="size-2.5 text-white stroke-[3px]"
              />
            </div>

            <div class="flex-1 min-w-0">
              <div 
                class="text-[12px] font-semibold leading-tight transition-colors" 
                :style="{ color: isSelected(option.value) ? 'var(--accent)' : 'var(--text-primary)' }"
              >
                {{ option.label }}
              </div>
              <div v-if="option.description" class="text-[11px] mt-1 leading-normal text-meta line-clamp-2">
                {{ option.description }}
              </div>
            </div>
          </div>
          
          <div v-if="filteredOptions.length === 0" class="px-3 py-10 text-center flex flex-col items-center gap-2">
            <UIcon name="i-lucide-search-x" class="size-8 text-meta opacity-20" />
            <span class="text-[12px] text-label">No skills match your search</span>
          </div>
        </div>
        
        <!-- Footer / Stats -->
        <div v-if="filteredOptions.length > 0" class="px-4 py-2 bg-surface-base border-t flex items-center justify-between text-[10px] text-meta font-mono" style="border-color: var(--border-subtle);">
          <span>{{ filteredOptions.length }} skills found</span>
          <span v-if="selectedCount > 0">{{ selectedCount }} selected</span>
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

.remove-btn:hover {
  background-color: var(--accent);
  color: white;
}
</style>
