<script setup lang="ts">
/**
 * The product registry: what a ticket routes to, and why.
 *
 * The routing preview is at the top rather than tucked away, because the rule
 * that decides most ambiguous tickets - file order - is the one nothing shows.
 * A ticket routed to the wrong product looks exactly like one routed to the
 * right product, and until now the only way to find out otherwise was to start
 * a run and watch it clone the wrong repository. Rows carry their position for
 * the same reason.
 */
import type { Problem } from '~~/shared/registry/rules'

const { registry, loading, error, load, validate, importProducts } = useProducts()
const toast = useToast()

onMounted(() => load())
useAutoRefresh(() => (checking.value ? null : load({ silent: true })))

// ── Routing preview ────────────────────────────────────────────────────────
interface Why { winner: string | null, tier: string, reason: string, ticketKey: string | null }
interface Preflight { product: { name: string, suite: string | null, repos: string[], recipe: boolean } | null, why: Why | null }
const ticket = ref('')
const preflight = ref<Preflight | null>(null)
const routing = ref(false)
let routeTimer: ReturnType<typeof setTimeout> | null = null
watch(ticket, (t) => {
  if (routeTimer) clearTimeout(routeTimer)
  if (!t.trim()) { preflight.value = null; return }
  routing.value = true
  routeTimer = setTimeout(async () => {
    try { preflight.value = await $fetch<Preflight>('/api/registry/preflight', { query: { q: t.trim().slice(0, 2000) } }) }
    catch { preflight.value = null }
    finally { routing.value = false }
  }, 350)
})

// ── Validate ───────────────────────────────────────────────────────────────
const checking = ref(false)
const checkResult = ref<{ ok: boolean, problems: Problem[] } | null>(null)
async function runValidate() {
  checking.value = true
  try {
    checkResult.value = await validate()
    toast.add({
      title: checkResult.value.ok ? 'The registry is valid' : 'The registry has problems',
      description: checkResult.value.problems.length ? `${checkResult.value.problems.length} reported below` : 'Nothing to report',
      color: checkResult.value.ok ? 'success' : 'error',
    })
  } catch (e: any) {
    toast.add({ title: 'Could not check the registry', description: e?.data?.message || e?.message, color: 'error' })
  } finally {
    checking.value = false
  }
}

// ── Drift against the plugin ───────────────────────────────────────────────
interface TeamRegistry { drift: { newInSource: string[], changedInSource: string[], removedInSource: string[] } }
const drift = ref<TeamRegistry['drift'] | null>(null)
const importing = ref(false)
onMounted(async () => {
  try { drift.value = (await $fetch<{ registry: TeamRegistry }>('/api/team/status')).registry.drift }
  catch { drift.value = null }
})
async function importMissing() {
  if (!drift.value?.newInSource.length) return
  importing.value = true
  try {
    const { imported } = await importProducts(drift.value.newInSource)
    toast.add({ title: `Imported ${imported.length} product${imported.length === 1 ? '' : 's'}`, description: imported.join(', '), color: 'success' })
    await load()
    drift.value = (await $fetch<{ registry: TeamRegistry }>('/api/team/status')).registry.drift
  } catch (e: any) {
    toast.add({ title: 'Import failed', description: e?.data?.message || e?.message, color: 'error' })
  } finally {
    importing.value = false
  }
}

// ── Row helpers ────────────────────────────────────────────────────────────
const errorsOf = (p: Problem[]) => p.filter(x => x.severity === 'error')
const warningsOf = (p: Problem[]) => p.filter(x => x.severity === 'warning')
/** CONFIRM is a drafted field, not a value. It is greppable on purpose, so the page shows it. */
const unconfirmed = (product: Record<string, any>) => JSON.stringify(product).includes('CONFIRM')

const sourceLabel = computed(() => ({
  override: 'an AGENT_REGISTRY_PATH override',
  store: 'this instance\'s own store',
  plugin: 'the installed plugin',
  shipped: 'the copy shipped in the product',
  none: 'nowhere — nothing could be read',
}[registry.value?.source ?? 'none']))
</script>

<template>
  <div>
    <PageHeader title="Products" subtitle="What a ticket routes to: repos, branch policy, stack profile and test commands.">
      <template #right>
        <UButton label="Check the registry" icon="i-lucide-shield-check" size="sm" variant="soft" :loading="checking" @click="runValidate" />
        <UButton label="Add product" icon="i-lucide-plus" size="sm" to="/registry/new" />
      </template>
    </PageHeader>

    <div class="px-6 py-4 space-y-4">
      <div v-if="error" class="rounded-lg p-3 text-[13px]" style="color: var(--error); background: var(--surface-base);">{{ error }}</div>

      <!-- A store that does not parse routes every ticket on the seed instead. -->
      <div v-if="registry?.degraded" class="rounded-lg p-3 text-[13px]" style="color: var(--error); background: var(--surface-base);">
        The registry at <code>{{ registry.path }}</code> does not parse, so routing is running on the seed instead.
        Fix the file, or restore <code>{{ registry.path }}.bak</code>.
      </div>

      <!-- Routing preview -->
      <div class="rounded-xl p-5 space-y-3 bg-card">
        <div>
          <h3 class="text-section-title">Where would a ticket go?</h3>
          <p class="text-[12px] text-meta mt-1">
            Paste a ticket key or summary. A project key is the strongest signal, then a label, then a component
            word; where two products claim the same text, the longer term wins, and where nothing separates them
            the one earlier in this list does.
          </p>
        </div>
        <input v-model="ticket" type="text" class="field-input" placeholder="AAA-56 EMS Admin page fails to load" aria-label="Ticket to route" />
        <div v-if="routing" class="text-[12px] text-label">Resolving…</div>
        <div v-else-if="preflight?.product" class="text-[13px]">
          <span style="color: var(--success);">Routes to <strong>{{ preflight.product.name }}</strong></span>
          <span class="text-label">{{ preflight.product.suite ? ` (${preflight.product.suite})` : '' }} — {{ preflight.product.repos.join(', ') || 'no repos listed' }}</span>
          <div v-if="preflight.why" class="text-[12px] text-meta mt-1">{{ preflight.why.reason }}</div>
          <div v-if="preflight.why?.tier === 'order'" class="text-[12px] mt-1" style="color: var(--warning);">
            This one was decided by file order alone. Reorder the products below to change it.
          </div>
        </div>
        <div v-else-if="ticket.trim()" class="text-[13px]" style="color: var(--warning);">
          Nothing in the registry claims this text, so a run would have no product — no repos, no branch policy, no stack.
          <span v-if="preflight?.why" class="text-meta block text-[12px] mt-1">{{ preflight.why.reason }}</span>
        </div>
      </div>

      <!-- Check results -->
      <div v-if="checkResult" class="rounded-xl p-5 space-y-2 bg-card">
        <h3 class="text-section-title">{{ checkResult.ok ? 'Valid' : 'Problems' }}</h3>
        <p v-if="!checkResult.problems.length" class="text-[12px] text-meta">Nothing to report.</p>
        <div v-for="(p, i) in checkResult.problems" :key="i" class="text-[12px] flex gap-2">
          <span :style="{ color: p.severity === 'error' ? 'var(--error)' : 'var(--warning)' }">{{ p.severity === 'error' ? '✗' : '!' }}</span>
          <span><code>{{ p.where }}</code> {{ p.message }}</span>
        </div>
      </div>

      <!-- Drift against the plugin: reported, imported only on request -->
      <div v-if="drift?.newInSource.length" class="rounded-xl p-5 space-y-2 bg-card">
        <h3 class="text-section-title">The team ships products this instance does not have</h3>
        <p class="text-[12px] text-meta">
          {{ drift.newInSource.join(', ') }}. A ticket for any of them resolves to nothing here until it is imported.
          Nothing is copied automatically — an automatic import is one step from an automatic overwrite, and a
          registry that rewrote itself at boot would hand back every routing change made on this page.
        </p>
        <UButton :label="`Import ${drift.newInSource.length} product${drift.newInSource.length === 1 ? '' : 's'}`" size="sm" variant="soft" :loading="importing" @click="importMissing" />
      </div>

      <!-- The registry -->
      <div class="rounded-xl p-5 space-y-3 bg-card">
        <div class="flex items-baseline justify-between gap-4">
          <h3 class="text-section-title">{{ registry?.products.length ?? 0 }} products</h3>
          <span class="text-[11px] text-meta">
            Read from {{ sourceLabel }}<template v-if="registry?.seed">, seeded once from <code>{{ registry.seed.seededFrom }}</code></template>
          </span>
        </div>
        <p v-if="registry?.path" class="text-[11px] text-meta font-mono">{{ registry.path }}</p>

        <div v-if="loading && !registry" class="space-y-2"><SkeletonRow v-for="i in 6" :key="i" /></div>
        <div v-else class="space-y-1">
          <div class="flex items-center gap-3 text-[11px] font-mono uppercase tracking-wider text-meta px-2">
            <span style="flex: 0 0 2rem;">#</span>
            <span style="flex: 1 1 0%;">Product</span>
            <span style="flex: 2 1 0%;">Repos</span>
            <span style="flex: 0 0 12rem;" />
          </div>
          <NuxtLink
            v-for="row in registry?.products ?? []" :key="row.key"
            :to="`/registry/${row.key}`"
            class="flex items-center gap-3 px-2 py-2 rounded-lg hover-lift focus-ring text-[13px]"
            style="border: 1px solid var(--border-subtle);"
          >
            <span class="text-meta font-mono text-[11px]" style="flex: 0 0 2rem;">{{ row.position + 1 }}</span>
            <span style="flex: 1 1 0%; min-width: 0;" class="truncate">
              <strong>{{ row.key }}</strong>
              <span v-if="row.product.suite" class="text-label text-[11px] ml-2">{{ row.product.suite }}</span>
            </span>
            <span style="flex: 2 1 0%; min-width: 0;" class="truncate text-label font-mono text-[11px]">{{ (row.product.repos ?? []).join(', ') }}</span>
            <span class="flex items-center gap-1.5 justify-end" style="flex: 0 0 12rem;">
              <span
                v-if="errorsOf(row.problems).length" class="text-[10px] px-1.5 py-0.5 rounded"
                :style="{ color: 'var(--error)', background: 'var(--surface-base)' }"
                :title="errorsOf(row.problems).map(p => p.message).join('; ')"
              >{{ errorsOf(row.problems).length }} error{{ errorsOf(row.problems).length === 1 ? '' : 's' }}</span>
              <span
                v-if="warningsOf(row.problems).length" class="text-[10px] px-1.5 py-0.5 rounded"
                :style="{ color: 'var(--warning)', background: 'var(--surface-base)' }"
                :title="warningsOf(row.problems).map(p => p.message).join('; ')"
              >{{ warningsOf(row.problems).length }}</span>
              <span
                v-if="unconfirmed(row.product)" class="text-[10px] px-1.5 py-0.5 rounded"
                :style="{ color: 'var(--warning)', background: 'var(--surface-base)' }"
                title="Carries a CONFIRM placeholder: a field somebody drafted and nobody has confirmed"
              >unconfirmed</span>
              <span
                class="text-[10px] px-1.5 py-0.5 rounded"
                :style="{ color: row.recipe ? 'var(--success)' : 'var(--warning)', background: 'var(--surface-base)' }"
                :title="row.recipe ? `recipes/${row.key}.md tells the stack step how to bring this product up` : `No recipes/${row.key}.md; the stack step improvises for this product`"
              >{{ row.recipe ? 'recipe' : 'no recipe' }}</span>
            </span>
          </NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>
