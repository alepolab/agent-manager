<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{ (e: 'close'): void, (e: 'add', payload: any): void }>()

const name = ref('')
const transport = ref<'stdio' | 'sse' | 'http'>('stdio')
const command = ref('')
const argsString = ref('')
const url = ref('')
const scope = ref<'global' | 'project'>('global')
const enabled = ref(true)

const envPairs = ref<{ key: string; value: string }[]>([])
const headerPairs = ref<{ key: string; value: string }[]>([])

function addEnvRow() { envPairs.value.push({ key: '', value: '' }) }
function removeEnvRow(idx: number) { envPairs.value.splice(idx, 1) }

function addHeaderRow() { headerPairs.value.push({ key: '', value: '' }) }
function removeHeaderRow(idx: number) { headerPairs.value.splice(idx, 1) }

function submit() {
  if (!name.value.trim()) return
  if (transport.value === 'stdio' && !command.value.trim()) return
  if ((transport.value === 'sse' || transport.value === 'http') && !url.value.trim()) return

  const payload: any = {
    name: name.value.trim(),
    transport: transport.value,
    scope: scope.value,
    disabled: !enabled.value
  }

  if (transport.value === 'stdio') {
    payload.command = command.value.trim()
    payload.args = argsString.value.split(' ').map(a => a.trim()).filter(a => a.length > 0)
    const env: Record<string, string> = {}
    for (const pair of envPairs.value) {
      if (pair.key.trim() && pair.value.trim()) env[pair.key.trim()] = pair.value.trim()
    }
    payload.env = env
  } else {
    payload.url = url.value.trim()
    const headers: Record<string, string> = {}
    for (const pair of headerPairs.value) {
      if (pair.key.trim() && pair.value.trim()) headers[pair.key.trim()] = pair.value.trim()
    }
    payload.headers = headers
  }

  emit('add', payload)
}
</script>

<template>
  <div class="p-6 space-y-4 bg-overlay">
    <h3 class="text-page-title">New MCP Server</h3>
    <p class="t-small leading-relaxed text-label">
      Add a new Model Context Protocol (MCP) server to extend Claude's capabilities with custom tools and resources.
    </p>
    
    <div class="space-y-4">
      <div class="field-group">
        <label class="field-label" data-required>Server Name</label>
        <input v-model="name" type="text" class="field-input" placeholder="e.g. everything-server" />
        <span class="field-hint">Unique identifier for this server</span>
      </div>

      <div class="field-group">
        <label class="field-label">Transport Type</label>
        <div class="flex flex-wrap gap-x-6 gap-y-2 pt-1">
          <label class="flex items-center gap-2 cursor-pointer group">
            <input v-model="transport" type="radio" value="stdio" class="accent-accent" />
            <span class="t-ui text-body group-hover:text-primary transition-colors">stdio (Local)</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer group">
            <input v-model="transport" type="radio" value="http" class="accent-accent" />
            <span class="t-ui text-body group-hover:text-primary transition-colors">http (Streamable)</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer group">
            <input v-model="transport" type="radio" value="sse" class="accent-accent" />
            <div class="flex items-center gap-1.5">
              <span class="t-ui text-body group-hover:text-primary transition-colors">sse (Classic)</span>
              <span class="t-small font-mono px-1 py-0.5 rounded bg-error/10 text-error uppercase leading-none border border-error/20">Deprecated</span>
            </div>
          </label>
        </div>
      </div>

      <template v-if="transport === 'stdio'">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="field-group">
            <label class="field-label" data-required>Command</label>
            <input v-model="command" type="text" class="field-input font-mono t-ui" placeholder="e.g. npx" />
          </div>

          <div class="field-group">
            <label class="field-label">Arguments</label>
            <input v-model="argsString" type="text" class="field-input font-mono t-ui" placeholder="e.g. -y @mcp/server-everything" />
          </div>
        </div>

        <div class="field-group">
          <div class="flex items-center justify-between mb-1">
            <label class="field-label">Environment Variables</label>
            <button class="t-small font-medium transition-colors" style="color: var(--accent);" @click="addEnvRow">
              + Add Row
            </button>
          </div>
          <div v-for="(pair, idx) in envPairs" :key="idx" class="flex items-center gap-2 mb-2 group">
            <input v-model="pair.key" type="text" class="field-input flex-1 font-mono t-small" placeholder="KEY" />
            <span class="opacity-40">=</span>
            <input v-model="pair.value" type="text" class="field-input flex-1 font-mono t-small" placeholder="VALUE" />
            <button class="p-1.5 rounded-lg opacity-60 hover:opacity-100 transition-all hover:bg-error/10 text-error" @click="removeEnvRow(idx)">
              <UIcon name="i-lucide-trash-2" class="size-3.5" />
            </button>
          </div>
          <p v-if="!envPairs.length" class="t-small italic opacity-40">No environment variables configured</p>
        </div>
      </template>

      <template v-else>
        <div class="field-group">
          <label class="field-label" data-required>URL</label>
          <input v-model="url" type="text" class="field-input font-mono t-ui" placeholder="https://example.com/sse" />
        </div>

        <div class="field-group">
          <div class="flex items-center justify-between mb-1">
            <label class="field-label">Headers</label>
            <button class="t-small font-medium transition-colors" style="color: var(--accent);" @click="addHeaderRow">
              + Add Row
            </button>
          </div>
          <div v-for="(pair, idx) in headerPairs" :key="idx" class="flex items-center gap-2 mb-2 group">
            <input v-model="pair.key" type="text" class="field-input flex-1 font-mono t-small" placeholder="Name" />
            <span class="opacity-40">:</span>
            <input v-model="pair.value" type="text" class="field-input flex-1 font-mono t-small" placeholder="Value" />
            <button class="p-1.5 rounded-lg opacity-60 hover:opacity-100 transition-all hover:bg-error/10 text-error" @click="removeHeaderRow(idx)">
              <UIcon name="i-lucide-trash-2" class="size-3.5" />
            </button>
          </div>
          <p v-if="!headerPairs.length" class="t-small italic opacity-40">No custom headers configured</p>
        </div>
      </template>

      <div class="field-group">
        <label class="field-label">Scope</label>
        <select v-model="scope" class="field-input">
          <option value="global">Global (~/.claude.json)</option>
          <option value="project">Project (.mcp.json)</option>
        </select>
        <span class="field-hint">Project scope is only available in the current directory</span>
      </div>

      <div class="flex items-center gap-2 pt-2">
        <label class="field-toggle">
          <input
            type="checkbox"
            v-model="enabled"
          />
          <span class="field-toggle__track">
            <span class="field-toggle__thumb" />
          </span>
        </label>
        <div class="flex flex-col">
          <span class="t-ui font-medium" :style="{ color: !enabled ? 'var(--text-secondary)' : 'var(--text-primary)' }">
            {{ !enabled ? 'Create as Disabled' : 'Server Enabled' }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex justify-end gap-2 pt-2">
      <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="emit('close')" />
      <UButton label="Create Server" size="sm" :disabled="!name.trim()" @click="submit" />
    </div>
  </div>
</template>

<style scoped>
.accent-accent { accent-color: var(--accent); }
</style>
