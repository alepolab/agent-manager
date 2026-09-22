<script setup lang="ts">
/**
 * One product entry.
 *
 * A page rather than a modal: seven sections and roughly twenty fields is past
 * what a dialog holds legibly, and this is the form that decides which
 * repository a run clones.
 *
 * Two fields are deliberately not free inputs. `multi_repo` is derived from
 * the repo count and shown read-only, because the validator refuses every
 * disagreement between the two and a control whose only possible outcome is a
 * refusal is a trap. The rationale block is a first-class field, because the
 * reasoning behind an entry is the only place certain facts exist and a form
 * that never asks for it is a form that quietly loses it.
 */
import { baseBranchFor } from '~~/shared/branchPolicy'
import { OWNER_LABELS } from '~~/shared/registry/rules'
import type { RecipeRead } from '~/composables/useProducts'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { registry, load, create, update, remove, byKey, readRecipe, saveRecipe, removeRecipe } = useProducts()

const key = computed(() => String(route.params.key))
const isNew = computed(() => key.value === 'new')

const form = reactive({
  key: '',
  suite: '',
  comment: '',
  projects: '',
  components: '',
  labels: '',
  repos: '',
  branches: { bug: '', feature: '', infra: '', docs: '', release: '', qa: '', hotfix: '', production: '' },
  stack: { compose: '', topology_default: '1node', liquibase: false },
  tests: { unit: '', atdd: '', regression: '', ui_trace: '', compose_test: '' },
  owners: Object.fromEntries(OWNER_LABELS.map(l => [l, ''])) as Record<string, string>,
  modules: '',
  version_source: '',
})

const lines = (s: string) => s.split('\n').map(v => v.trim()).filter(Boolean)
const list = (s: string) => s.split(/[\n,]/).map(v => v.trim()).filter(Boolean)

function fill() {
  const row = byKey(key.value)
  if (isNew.value || !row) return
  const p = row.product
  form.key = row.key
  form.comment = row.comment ?? ''
  form.suite = p.suite ?? ''
  form.projects = (p.match?.projects ?? []).join('\n')
  form.components = (p.match?.components ?? []).join('\n')
  form.labels = (p.match?.labels ?? []).join('\n')
  form.repos = (p.repos ?? []).join('\n')
  for (const b of Object.keys(form.branches)) form.branches[b as keyof typeof form.branches] = p.branches?.[b] ?? ''
  form.stack.compose = p.stack?.compose ?? ''
  form.stack.topology_default = p.stack?.topology_default ?? '1node'
  form.stack.liquibase = p.stack?.liquibase === true
  for (const t of Object.keys(form.tests)) form.tests[t as keyof typeof form.tests] = p.tests?.[t] ?? ''
  for (const o of OWNER_LABELS) form.owners[o] = p.owners?.[o] ?? ''
  form.modules = Object.entries(p.modules ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')
  form.version_source = p.version_source ?? ''
}

onMounted(async () => {
  if (!registry.value) await load()
  fill()
  loadRecipe()
})
watch(registry, fill)

// ── Recipe ─────────────────────────────────────────────────────────────────
//
// A separate file with its own mtime, fetched on its own, saved on its own.
// Not folded into the form: the product entry is validated fields the runner
// acts on and a bad one refuses the write, whereas the recipe is prose the
// stack agent reads, and a Save button that refused the recipe because a test
// command was blank would be the wrong coupling entirely.

const recipe = ref<RecipeRead | null>(null)
const recipeDraft = ref('')
const recipeLoading = ref(false)
const recipeSaving = ref(false)
/** "Write a recipe" was clicked on a product that has none. The badge keeps
 *  saying `no recipe` until a file actually exists — a control that renamed
 *  the state before the write is a control that lies about the filesystem. */
const recipeStarted = ref(false)
const recipeOpen = computed(() => !!recipe.value && (recipe.value.source !== 'none' || recipeStarted.value))
const recipeDirty = computed(() => recipe.value !== null && recipeDraft.value !== recipe.value.content)

async function loadRecipe() {
  if (isNew.value) return
  recipeLoading.value = true
  recipeStarted.value = false
  try {
    recipe.value = await readRecipe(key.value)
    recipeDraft.value = recipe.value.content
  } catch (e: any) {
    toast.add({ title: 'Could not read the recipe', description: e?.data?.message || e?.message, color: 'error' })
  } finally {
    recipeLoading.value = false
  }
}

/** The headings the six existing recipes share. Seeded rather than left blank
 *  because the sections are what a recipe is for: a blank box gets a paragraph
 *  about compose and nothing about the traps. */
const recipeSkeleton = () => `# ${key.value}

## Compose

Deployment repo, compose file, project name, and the command that brings it up.

## Variables

Which keys the stack needs and where they come from. Name the ones a developer's
own .env will not already have.

## Health

How to tell it actually came up, not just that the containers are running.

## Traps

What a run got wrong here before. This section is why the file exists.
`

async function persistRecipe() {
  if (recipeSaving.value) return
  recipeSaving.value = true
  try {
    const { mtimeMs } = await saveRecipe(key.value, recipeDraft.value, recipe.value?.mtimeMs ?? null)
    toast.add({ title: 'Recipe saved', description: `recipes/${key.value}.md in the config directory`, color: 'success' })
    // Re-read rather than patch: the source may have just changed from the
    // plugin's copy to a local one, and `shadows` with it.
    recipe.value = await readRecipe(key.value)
    recipeDraft.value = recipe.value.content
    if (recipe.value.mtimeMs === null) recipe.value.mtimeMs = mtimeMs
    await load({ silent: true })
  } catch (e: any) {
    toast.add({ title: 'Refused', description: e?.data?.message || e?.message, color: 'error' })
  } finally {
    recipeSaving.value = false
  }
}

const showRecipeRevert = ref(false)
async function revertRecipe() {
  showRecipeRevert.value = false
  try {
    const { fellBackTo } = await removeRecipe(key.value)
    toast.add({
      title: 'Local recipe removed',
      description: fellBackTo ? `${fellBackTo} is live again` : 'This product now has no recipe at all',
      color: 'success',
    })
    await loadRecipe()
    await load({ silent: true })
  } catch (e: any) {
    toast.add({ title: 'Could not remove it', description: e?.data?.message || e?.message, color: 'error' })
  }
}

/** The object the store will hold. Empty fields are omitted, never written as ''. */
const product = computed(() => {
  const clean = <T extends Record<string, any>>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== false))
  const match = clean({
    projects: list(form.projects).length ? list(form.projects) : '',
    components: list(form.components).length ? list(form.components) : '',
    labels: list(form.labels).length ? list(form.labels) : '',
  })
  const modules = Object.fromEntries(lines(form.modules).map((l) => {
    const at = l.indexOf(':')
    return at > 0 ? [l.slice(0, at).trim(), l.slice(at + 1).trim()] : ['', '']
  }).filter(([k, v]) => k && v))
  const repos = lines(form.repos)
  return {
    ...(form.suite.trim() ? { suite: form.suite.trim() } : {}),
    match,
    repos,
    // Derived, never typed: the validator refuses every entry where the flag
    // and the repo count disagree, so the flag is not a decision to make.
    ...(repos.length > 1 ? { multi_repo: true } : {}),
    ...(Object.keys(modules).length ? { modules } : {}),
    branches: clean(form.branches),
    stack: { ...clean(form.stack), ...(form.stack.liquibase ? { liquibase: true } : {}) },
    tests: clean(form.tests),
    owners: clean(form.owners),
    ...(form.version_source.trim() ? { version_source: form.version_source.trim() } : {}),
  }
})

/** What is still missing, which also fills the disabled button's tooltip. */
const unstated = computed(() => {
  const missing: string[] = []
  if (isNew.value && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(form.key.trim())) missing.push('a key in lowercase words')
  if (!list(form.projects).length && !list(form.components).length && !list(form.labels).length) missing.push('at least one match term')
  if (!lines(form.repos).length) missing.push('a repo')
  if (!form.branches.bug.trim()) missing.push('a bug branch')
  if (!form.branches.feature.trim()) missing.push('a feature branch')
  if (!form.stack.compose.trim()) missing.push('a compose profile')
  if (!form.tests.unit.trim()) missing.push('a unit test command')
  if (!OWNER_LABELS.some(l => form.owners[l]?.trim())) missing.push('an owner')
  return missing
})
const canSave = computed(() => unstated.value.length === 0 && !saving.value)

/** The same function the runner uses, so the preview cannot drift from the run. */
const branchPreview = computed(() => {
  const b = Object.fromEntries(Object.entries(form.branches).filter(([, v]) => v.trim()))
  return [
    { label: 'A bug found in development', choice: baseBranchFor('bug', 'development', b) },
    { label: 'A bug found in production', choice: baseBranchFor('bug', 'production', b) },
    { label: 'A bug found by QA on the release candidate', choice: baseBranchFor('bug', 'qa', b) },
    { label: 'A feature', choice: baseBranchFor('feature', 'development', b) },
  ]
})

const saving = ref(false)
async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    if (isNew.value) {
      await create(form.key.trim(), product.value, form.comment)
      toast.add({ title: `${form.key.trim()} registered`, color: 'success' })
      await load()
      router.push(`/registry/${form.key.trim()}`)
    } else {
      await update(key.value, product.value, form.comment)
      toast.add({ title: 'Product saved', color: 'success' })
      await load()
    }
  } catch (e: any) {
    toast.add({ title: 'Refused', description: e?.data?.message || e?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

const confirmKey = ref('')
const showDelete = ref(false)
async function destroy() {
  if (confirmKey.value !== key.value) return
  try {
    await remove(key.value)
    toast.add({ title: `${key.value} removed`, description: 'Every ticket that resolved through it now resolves to nothing.', color: 'success' })
    await load()
    router.push('/registry')
  } catch (e: any) {
    toast.add({ title: 'Could not remove it', description: e?.data?.message || e?.message, color: 'error' })
  }
}

const problems = computed(() => byKey(key.value)?.problems ?? [])
</script>

<template>
  <div>
    <PageHeader :title="isNew ? 'New product' : key">
      <template #right>
        <UButton label="Back" icon="i-lucide-arrow-left" size="sm" variant="ghost" color="neutral" to="/registry" />
        <UButton v-if="!isNew" label="Remove" icon="i-lucide-trash-2" size="sm" variant="ghost" color="error" @click="() => { showDelete = true }" />
        <UButton label="Save" icon="i-lucide-save" size="sm" :loading="saving" :disabled="!canSave" :title="unstated.length ? `Needs ${unstated.join(', ')}` : undefined" @click="save" />
      </template>
    </PageHeader>

    <div class="px-6 py-4 space-y-4 max-w-4xl">
      <div v-if="problems.length" class="rounded-xl p-4 space-y-1 bg-card">
        <div v-for="(p, i) in problems" :key="i" class="text-[12px] flex gap-2">
          <span :style="{ color: p.severity === 'error' ? 'var(--error)' : 'var(--warning)' }">{{ p.severity === 'error' ? '✗' : '!' }}</span>
          <span>{{ p.message }}</span>
        </div>
      </div>

      <!-- Identity -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Identity</h3>
        <div class="field-group">
          <label class="field-label">Key</label>
          <input v-if="isNew" v-model="form.key" class="field-input" placeholder="ase-crm" />
          <input v-else :value="key" class="field-input" disabled />
          <span class="field-hint">
            Lowercase words separated by hyphens. It cannot be changed: workflows, run records and recipe
            filenames all name it, so a rename is a new product plus a removal, done deliberately.
          </span>
        </div>
        <div class="field-group">
          <label class="field-label">Suite</label>
          <input v-model="form.suite" class="field-input" placeholder="bss" />
          <span class="field-hint">Informational grouping — products that share infrastructure and recipes. Routing never reads it.</span>
        </div>
        <div class="field-group">
          <label class="field-label">Why this entry looks like this</label>
          <textarea v-model="form.comment" rows="3" class="field-input editor-textarea editor-textarea--standalone" placeholder="develop is where work lands; main is four months stale." />
          <span class="field-hint">
            Written above the entry as a comment. This is the only place reasoning like "a component word here
            would be invented rather than read" survives, and a save never discards what is already there unless
            you change this box.
          </span>
        </div>
      </div>

      <!-- Match -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">What a ticket must say to reach it</h3>
        <p class="text-[12px] text-meta">One term per line. A project key outranks a label, which outranks a component word; between two products claiming the same text, the longer term wins.</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div class="field-group">
            <label class="field-label">Jira projects</label>
            <textarea v-model="form.projects" rows="3" class="field-input font-mono text-xs" placeholder="ASECRM" />
          </div>
          <div class="field-group">
            <label class="field-label">Components</label>
            <textarea v-model="form.components" rows="3" class="field-input font-mono text-xs" placeholder="CRM&#10;Customer Portal" />
          </div>
          <div class="field-group">
            <label class="field-label">Labels</label>
            <textarea v-model="form.labels" rows="3" class="field-input font-mono text-xs" placeholder="NEW_WEB_SELFCARE" />
          </div>
        </div>
      </div>

      <!-- Repos -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Repositories</h3>
        <div class="field-group">
          <label class="field-label">Repos, one <code>owner/name</code> per line</label>
          <textarea v-model="form.repos" rows="3" class="field-input font-mono text-xs" placeholder="alepolab/ase-crm" />
          <span class="field-hint">
            The first is where a run works. <strong>{{ lines(form.repos).length > 1 ? 'Multi-repo: yes' : 'Multi-repo: no' }}</strong> —
            derived from the count, not chosen: the validator refuses any entry where the two disagree.
          </span>
        </div>
        <div class="field-group">
          <label class="field-label">Modules (optional), one <code>dir: owner/name</code> per line</label>
          <textarea v-model="form.modules" rows="3" class="field-input font-mono text-xs" placeholder="modules/billing: alepolab/billing-lib" />
          <span class="field-hint">For a container repo whose real content is sibling repos. Cloning the parent does not produce these.</span>
        </div>
      </div>

      <!-- Branches -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Branch policy</h3>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div v-for="(placeholder, name) in { bug: 'develop', feature: 'develop', infra: 'develop', docs: 'develop', release: 'ci-release', qa: 'ci-release', hotfix: 'main', production: 'main' }" :key="name" class="field-group">
            <label class="field-label">{{ name }}</label>
            <input v-model="form.branches[name as keyof typeof form.branches]" class="field-input font-mono text-xs" :placeholder="placeholder" />
          </div>
        </div>
        <div class="text-[12px] text-meta space-y-0.5">
          <div v-for="row in branchPreview" :key="row.label">
            <span class="text-label">{{ row.label }}:</span> starts from <code>{{ row.choice.base }}</code>
            <template v-if="row.choice.mergeBack.length">, merged back into <code>{{ row.choice.mergeBack.join('</code>, <code>') }}</code></template>
          </div>
          <div class="mt-1">Computed by the same function the runner uses, so this preview cannot drift from what a run does.</div>
        </div>
        <div class="field-group">
          <label class="field-label">Version source (only when the bug branch contains <code>{{ '{version}' }}</code>)</label>
          <input v-model="form.version_source" class="field-input" placeholder="a Jira field or a customer profile key" />
        </div>
      </div>

      <!-- Stack -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Stack</h3>
        <div class="field-group">
          <label class="field-label">Compose profile</label>
          <input v-model="form.stack.compose" class="field-input font-mono text-xs" placeholder="alepo-dev-team-infra/ase-crm" />
          <span class="field-hint">
            Read as <code>&lt;repo&gt;/&lt;product&gt;</code>. Preflight will look for
            <code>docker-compose.{{ form.stack.compose.split('/')[1] || '&lt;product&gt;' }}.yml</code> in the deployment checkout and say so if it is missing,
            rather than standing the wrong application up.
          </span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="field-group">
            <label class="field-label">Default topology</label>
            <input v-model="form.stack.topology_default" class="field-input font-mono text-xs" placeholder="1node" />
          </div>
          <div class="field-group">
            <label class="flex items-center gap-2 cursor-pointer">
              <input v-model="form.stack.liquibase" type="checkbox" />
              <span class="field-label mb-0">Liquibase tag available</span>
            </label>
            <span class="field-hint">Without it a retry cannot roll the database back between attempts, so three attempts are not safe.</span>
          </div>
        </div>
      </div>

      <!-- Recipe -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-section-title mb-0">Recipe</h3>
          <div class="flex items-center gap-2">
            <UButton
              v-if="recipe && recipe.source === 'local'" label="Revert to the shipped copy" size="xs" variant="ghost" color="neutral"
              @click="() => { showRecipeRevert = true }"
            />
            <UButton
              v-if="recipeOpen" label="Save recipe" icon="i-lucide-save" size="xs"
              :loading="recipeSaving" :disabled="!recipeDirty || recipeSaving" @click="persistRecipe"
            />
          </div>
        </div>

        <p class="field-hint">
          What the stack step reads before it brings this product up: the compose file and profile, the variables
          it needs, how to tell it is actually healthy, and what a run got wrong here before. Prose, not fields —
          nothing validates it. With no recipe the stack step improvises the bring-up.
        </p>

        <div v-if="isNew" class="field-hint">
          A recipe is a file named after the key, so the product has to exist first. Save it and the section opens.
        </div>

        <div v-else-if="recipeLoading" class="field-hint">Reading…</div>

        <template v-else-if="recipe">
          <!-- Where the copy on screen came from, always: editing the plugin's
               copy silently forks it, and that has to be legible BEFORE the
               edit, not discovered later when a plugin update never arrives. -->
          <div class="text-[11px] flex items-start gap-2">
            <span
              class="px-1.5 py-0.5 rounded shrink-0"
              :style="{
                color: recipe.source === 'none' ? 'var(--warning)' : recipe.source === 'local' ? 'var(--info, var(--success))' : 'var(--success)',
                background: 'var(--surface-base)',
              }"
            >{{ recipe.source === 'none' ? 'no recipe' : recipe.source }}</span>
            <span class="text-meta font-mono break-all">{{ recipe.path ?? `recipes/${key}.md — nothing here yet` }}</span>
          </div>

          <div v-if="recipe.shadows" class="text-[11px] p-3 rounded-lg" :style="{ color: 'var(--warning)', background: 'var(--surface-base)' }">
            This local copy hides <span class="font-mono break-all">{{ recipe.shadows }}</span>, on this machine only.
            Nothing merges the two and nothing sends this edit back to the team: a later plugin release that corrects
            this product's bring-up will not reach you while the local copy is here.
          </div>
          <div v-else-if="recipe.source === 'plugin' || recipe.source === 'shipped'" class="field-hint">
            Saving forks this into <span class="font-mono">~/.claude/recipes/{{ key }}.md</span> and that copy wins from then on,
            here and not for the team. Revert puts the {{ recipe.source }} copy back.
          </div>

          <div v-if="!recipeOpen" class="flex items-center gap-3">
            <UButton
              label="Write a recipe" icon="i-lucide-file-plus" size="sm" variant="soft"
              @click="() => { recipeDraft = recipeSkeleton(); recipeStarted = true }"
            />
            <span class="field-hint mb-0">Starts from the headings the six existing recipes share.</span>
          </div>

          <textarea
            v-else v-model="recipeDraft" rows="18" spellcheck="false"
            class="field-input font-mono text-xs" style="line-height: 1.55;"
            :placeholder="`# ${key}`"
          />
        </template>
      </div>

      <!-- Tests -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Test commands</h3>
        <div class="field-group">
          <label class="field-label">Unit</label>
          <input v-model="form.tests.unit" class="field-input font-mono text-xs" placeholder="mvn -q test" />
        </div>
        <div class="field-group">
          <label class="field-label">ATDD</label>
          <input v-model="form.tests.atdd" class="field-input font-mono text-xs" placeholder="pytest --xunit results.xml" />
          <span class="field-hint">Must emit xunit, or the loop has to grep logs for a verdict. An entry that does not is refused.</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div class="field-group">
            <label class="field-label">Regression</label>
            <input v-model="form.tests.regression" class="field-input font-mono text-xs" />
          </div>
          <div class="field-group">
            <label class="field-label">UI trace</label>
            <input v-model="form.tests.ui_trace" class="field-input font-mono text-xs" placeholder="playwright" />
          </div>
          <div class="field-group">
            <label class="field-label">Compose test</label>
            <input v-model="form.tests.compose_test" class="field-input font-mono text-xs" />
          </div>
        </div>
      </div>

      <!-- Owners -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Owners by blast radius</h3>
        <p class="text-[12px] text-meta">
          Money and protocol changes are never auto-merged, so both must name a group a person can find.
          <code>CONFIRM</code> is the deliberate marker for a field nobody has settled yet — it reads as drafted
          rather than as a typo, and the list page flags it.
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div v-for="label in OWNER_LABELS" :key="label" class="field-group">
            <label class="field-label">{{ label }}</label>
            <input v-model="form.owners[label]" class="field-input" placeholder="a team or group name, or CONFIRM" />
          </div>
        </div>
      </div>
    </div>

    <UModal v-model:open="showDelete">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Remove {{ key }}?</h3>
          <p class="text-[13px] text-label">
            Every ticket that resolved through this product stops resolving: a run started for one would have no
            repos, no branch policy and no stack. Type the key to confirm.
          </p>
          <input v-model="confirmKey" class="field-input font-mono" :placeholder="key" />
          <div class="flex justify-end gap-2">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showDelete = false }" />
            <UButton label="Remove" color="error" size="sm" :disabled="confirmKey !== key" @click="destroy" />
          </div>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="showRecipeRevert">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Discard the local recipe for {{ key }}?</h3>
          <p class="text-[13px] text-label">
            <span class="font-mono break-all">{{ recipe?.path }}</span> is deleted and
            <template v-if="recipe?.shadows">
              <span class="font-mono break-all">{{ recipe.shadows }}</span> becomes the live recipe again.
            </template>
            <template v-else>
              this product is left with no recipe at all, so the stack step improvises its bring-up.
            </template>
            Whatever is only in the local copy is gone.
          </p>
          <div class="flex justify-end gap-2">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showRecipeRevert = false }" />
            <UButton label="Discard" color="error" size="sm" @click="revertRecipe" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
