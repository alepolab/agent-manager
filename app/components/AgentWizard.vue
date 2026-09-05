<script setup lang="ts">
import type { Agent, AgentFrontmatter, AgentMemory, AgentTool } from '~/types'
import { MODEL_OPTIONS, DEFAULT_MODEL } from '~/utils/models'

const emit = defineEmits<{
  saved: [agent: Agent]
  cancel: []
}>()

const { create } = useAgents()
const { fetchAll: fetchAllSkills, skills: allSkills } = useSkills()
const toast = useToast()

const step = ref(1)
const saving = ref(false)
const totalSteps = 4

const frontmatter = ref<AgentFrontmatter>({
  name: '',
  description: '',
  model: DEFAULT_MODEL,
  skills: [],
  tools: [],
})
const body = ref('')

onMounted(() => {
  fetchAllSkills()
})

// Validation
const nameError = computed(() => {
  const name = frontmatter.value.name.trim()
  if (!name) return 'Give your agent a name'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return 'Use lowercase letters, numbers, and hyphens (e.g., email-helper)'
  return null
})

const descError = computed(() => {
  if (!frontmatter.value.description.trim()) return 'Describe what this agent does'
  return null
})

const canProceed = computed(() => {
  if (step.value === 1) return !nameError.value && !descError.value
  return true
})

function next() {
  if (!canProceed.value) return
  if (step.value < totalSteps) step.value++
}

function back() {
  if (step.value > 1) step.value--
}

async function finish() {
  saving.value = true
  try {
    const agent = await create({ frontmatter: frontmatter.value, body: body.value })
    toast.add({ title: `${frontmatter.value.name} created`, color: 'success' })
    emit('saved', agent)
  } catch (e: any) {
    toast.add({ title: 'Failed to create agent', description: e.data?.message || e.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

const memoryOptions: { value: AgentMemory; label: string; desc: string }[] = [
  { value: 'user', label: 'User Scope', desc: 'Accumulates insights at ~/.claude/agent-memory/.' },
  { value: 'project', label: 'Project Scope', desc: "Remembers codebase patterns for this project." },
  { value: 'local', label: 'Local Scope', desc: 'Stores learnings in the current directory.' },
  { value: 'none', label: 'None', desc: 'Starts fresh every time. No persistent learnings.' },
]

const toolOptions: { label: string; value: AgentTool; icon: string; desc: string }[] = [
  { label: 'Read', value: 'Read', icon: 'i-lucide-book-open', desc: 'Read file contents' },
  { label: 'Grep', value: 'Grep', icon: 'i-lucide-search', desc: 'Search inside files' },
  { label: 'Glob', value: 'Glob', icon: 'i-lucide-files', desc: 'Find files by pattern' },
  { label: 'Bash', value: 'Bash', icon: 'i-lucide-terminal', desc: 'Execute shell commands' },
  { label: 'Write', value: 'Write', icon: 'i-lucide-pencil-line', desc: 'Create or overwrite files' },
  { label: 'Edit', value: 'Edit', icon: 'i-lucide-file-text', desc: 'Edit specific lines in files' },
]

function toggleTool(tool: AgentTool) {
  const tools = [...(frontmatter.value.tools || [])]
  const idx = tools.indexOf(tool)
  if (idx === -1) tools.push(tool)
  else tools.splice(idx, 1)
  frontmatter.value.tools = tools
}
</script>


<template>
  <div class="p-6 space-y-5 bg-overlay w-[480px] max-w-full">
    <!-- Header with step indicator -->
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-page-title">New Agent</h3>
        <span class="text-[11px] font-mono text-meta">{{ step }}/{{ totalSteps }}</span>
      </div>
      <!-- Progress bar -->
      <div class="h-1 rounded-full overflow-hidden" style="background: var(--badge-subtle-bg);">
        <div
          class="h-full rounded-full transition-all duration-300"
          style="background: var(--accent);"
          :style="{ width: `${(step / totalSteps) * 100}%` }"
        />
      </div>
    </div>

    <!-- Step 1: Name & Purpose -->
    <div v-if="step === 1" class="space-y-4">
      <p class="text-[12px] text-label leading-relaxed">
        What should this agent be called, and what will it help you with?
      </p>

      <div class="field-group">
        <label class="field-label" data-required>Name</label>
        <input
          v-model="frontmatter.name"
          class="field-input"
          :class="{ 'field-input--error': frontmatter.name && nameError }"
          placeholder="email-helper"
        />
        <span v-if="frontmatter.name && nameError" class="field-error">{{ nameError }}</span>
        <span v-else class="field-hint">A short identifier. You'll use this to call the agent.</span>
      </div>

      <div class="field-group">
        <label class="field-label" data-required>
          What does it do?
          <HelpTip title="Good descriptions" body="A good description helps you remember what this agent does, and helps Claude know when to use it." />
        </label>
        <textarea
          v-model="frontmatter.description"
          rows="4"
          class="field-textarea"
          placeholder="Helps me draft and polish professional emails..."
        />
        <span v-if="frontmatter.description && descError" class="field-error">{{ descError }}</span>
        <span v-else class="field-hint">This helps you (and Claude) know when to use this agent.</span>
      </div>
    </div>

    <!-- Step 2: Model & Memory -->
    <div v-else-if="step === 2" class="space-y-5">
      <div class="space-y-3">
        <label class="field-label">
          Which AI model should it use?
          <HelpTip title="Which model?" body="'Fast & efficient' is great for simple tasks. 'Balanced' works for most things. 'Most capable' handles complex reasoning." />
        </label>
        <div class="space-y-1.5">
          <button
            v-for="opt in MODEL_OPTIONS"
            :key="opt.label"
            type="button"
            class="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-all duration-150"
            :style="{
              background: frontmatter.model === opt.value ? 'var(--accent-muted)' : 'transparent',
              border: frontmatter.model === opt.value ? '1px solid rgba(229, 169, 62, 0.15)' : '1px solid var(--border-subtle)',
            }"
            @click="frontmatter.model = opt.value"
          >
            <div
              class="size-4 rounded-full shrink-0 mt-0.5 flex items-center justify-center"
              :style="{
                border: frontmatter.model === opt.value ? '2px solid var(--accent)' : '2px solid var(--border-default)',
              }"
            >
              <div
                v-if="frontmatter.model === opt.value"
                class="size-2 rounded-full"
                style="background: var(--accent);"
              />
            </div>
            <div>
              <span class="text-[13px] font-medium">{{ opt.label }}</span>
              <p class="text-[11px] text-label mt-0.5">{{ opt.desc }}</p>
            </div>
          </button>
        </div>
      </div>

      <ExampleBlock title="See what a good agent looks like">
        <div class="space-y-1.5 text-[11px]" style="color: var(--text-secondary);">
          <p><strong>Name:</strong> email-drafter</p>
          <p><strong>Instructions:</strong> "You are an email drafting assistant. Help the user write clear, professional emails. Before drafting, ask about the recipient, goal, and tone..."</p>
          <p class="text-[10px]" style="color: var(--text-tertiary);">Good instructions are specific about behavior, tone, and rules.</p>
        </div>
      </ExampleBlock>

      <div class="space-y-3">
        <label class="field-label">Should it remember things?</label>
        <div class="space-y-1.5">
          <button
            v-for="opt in memoryOptions"
            :key="opt.label"
            type="button"
            class="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-all duration-150"
            :style="{
              background: frontmatter.memory === opt.value ? 'var(--accent-muted)' : 'transparent',
              border: frontmatter.memory === opt.value ? '1px solid rgba(229, 169, 62, 0.15)' : '1px solid var(--border-subtle)',
            }"
            @click="frontmatter.memory = opt.value"
          >
            <div
              class="size-4 rounded-full shrink-0 mt-0.5 flex items-center justify-center"
              :style="{
                border: frontmatter.memory === opt.value ? '2px solid var(--accent)' : '2px solid var(--border-default)',
              }"
            >
              <div
                v-if="frontmatter.memory === opt.value"
                class="size-2 rounded-full"
                style="background: var(--accent);"
              />
            </div>
            <div>
              <span class="text-[13px] font-medium">{{ opt.label }}</span>
              <p class="text-[11px] text-label mt-0.5">{{ opt.desc }}</p>
            </div>
          </button>
        </div>
      </div>

      <!-- Tools sub-section -->
      <div class="space-y-3 pt-2 border-t" style="border-color: var(--border-subtle);">
        <label class="field-label">Allowed Tools</label>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="tool in toolOptions"
            :key="tool.value"
            type="button"
            class="flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-all border text-left"
            :style="{
              background: frontmatter.tools?.includes(tool.value) ? 'var(--accent-muted)' : 'transparent',
              borderColor: frontmatter.tools?.includes(tool.value) ? 'var(--accent)' : 'var(--border-subtle)',
            }"
            @click="toggleTool(tool.value)"
          >
            <div 
              class="size-7 rounded-lg flex items-center justify-center shrink-0"
              :style="{ 
                background: frontmatter.tools?.includes(tool.value) ? 'rgba(229, 169, 62, 0.1)' : 'var(--surface-raised)',
                color: frontmatter.tools?.includes(tool.value) ? 'var(--accent)' : 'var(--text-tertiary)'
              }"
            >
              <UIcon :name="tool.icon" class="size-3.5" />
            </div>
            <div class="text-[12px] font-medium" :style="{ color: frontmatter.tools?.includes(tool.value) ? 'var(--text-primary)' : 'var(--text-secondary)' }">
              {{ tool.label }}
            </div>
            <UIcon v-if="frontmatter.tools?.includes(tool.value)" name="i-lucide-check" class="size-3 ml-auto" style="color: var(--accent);" />
          </button>
        </div>
      </div>
    </div>

    <!-- Step 3: Capabilities (Skills) -->
    <div v-else-if="step === 3" class="space-y-4">
      <p class="text-[12px] text-label leading-relaxed">
        Preload specific skills to give this agent domain knowledge and specialized capabilities from the start.
      </p>

      <div class="field-group">
        <label class="field-label">Skills</label>
        <UMultiSelectDropdown
          v-model="frontmatter.skills"
          :options="allSkills.map(s => ({
            value: s.slug,
            label: s.frontmatter.name || s.slug,
            description: s.frontmatter.description
          }))"
          placeholder="Select skills to preload..."
          search-placeholder="Search skills..."
          icon="i-lucide-sparkles"
        />
        <span class="field-hint">
          These skills will be injected into the subagent's context at startup.
        </span>
      </div>

      <div
        class="rounded-lg p-3 space-y-2 bg-info-subtle border border-info/10"
      >
        <div class="flex items-center gap-2 text-info">
          <UIcon name="i-lucide-info" class="size-3.5" />
          <span class="text-[11px] font-medium uppercase tracking-wider">Tip</span>
        </div>
        <p class="text-[11px] leading-relaxed text-info/80">
          Preloading skills is better than having the agent discover them during execution. It makes the agent faster and more reliable for specific tasks.
        </p>
      </div>
    </div>

    <!-- Step 4: Instructions -->
    <div v-else-if="step === 4" class="space-y-4">
      <p class="text-[12px] text-label leading-relaxed">
        Tell <strong class="text-body">{{ frontmatter.name }}</strong> how to behave. What tone should it use? What rules should it follow? You can always edit this later.
      </p>

      <div class="field-group">
        <textarea
          v-model="body"
          class="editor-textarea editor-textarea--standalone"
          style="min-height: 200px;"
          spellcheck="false"
          :placeholder="`You are ${frontmatter.name}. ${frontmatter.description}\n\nGuidelines:\n- ...\n- ...`"
        />
        <span class="field-hint">
          Tip: Be specific about what the agent should and shouldn't do. You can leave this blank and fill it in later.
        </span>
      </div>
    </div>

    <!-- Navigation -->
    <div class="flex items-center justify-between pt-2">
      <div>
        <UButton
          v-if="step > 1"
          label="Back"
          variant="ghost"
          color="neutral"
          size="sm"
          icon="i-lucide-arrow-left"
          @click="back"
        />
      </div>
      <div class="flex items-center gap-2">
        <UButton
          label="Cancel"
          variant="ghost"
          color="neutral"
          size="sm"
          @click="emit('cancel')"
        />
        <UButton
          v-if="step < totalSteps"
          label="Next"
          size="sm"
          :disabled="!canProceed"
          @click="next"
        />
        <UButton
          v-else
          label="Create Agent"
          size="sm"
          :loading="saving"
          icon="i-lucide-sparkles"
          @click="finish"
        />
      </div>
    </div>
  </div>
</template>
