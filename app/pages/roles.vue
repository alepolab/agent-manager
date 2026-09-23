<script setup lang="ts">
import type { Role } from '~~/shared/types/role'
import { errorToast } from '~/utils/errorToast'

/**
 * Who holds which role on this instance.
 *
 * The roles system was complete on the server and unreachable from the app:
 * `/api/roles` had no caller, so the only way to give a colleague a role was to
 * hand-edit ~/.claude/roles.json on the box. That made `DEFAULT_ROLE` -
 * operator - the role everyone actually had, and the whole persona model
 * invisible.
 *
 * Reading the roster is open to anyone signed in, matching /api/roles: knowing
 * who answers the verification gate is how a team works. Changing it needs
 * `configure`, which the server enforces either way.
 */
interface ProfileSummary { login: string, name?: string, avatar?: string, lastSeenAt: number }
interface RolesResponse {
  roles: Record<string, Role>
  profiles: ProfileSummary[]
  default: Role
  available: Role[]
  labels: Record<Role, string>
}

const { can, me } = useUser()
const toast = useToast()

const data = ref<RolesResponse | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
/** The login currently being written, so one row spins rather than the page. */
const saving = ref<string | null>(null)
const addLogin = ref('')

async function refresh() {
  loading.value = true
  try {
    data.value = await $fetch<RolesResponse>('/api/roles')
    error.value = null
  } catch (e) {
    error.value = (e as { data?: { message?: string }, message?: string })?.data?.message
      || (e as { message?: string })?.message || 'Could not load roles'
  } finally {
    loading.value = false
  }
}
onMounted(refresh)

/**
 * Every login this instance knows about, whether or not it holds a role.
 * Someone absent from roles.json is not missing from the team - they are an
 * operator, because that is the default - and a roster that showed only the
 * listed people would hide exactly the ones with the most power.
 */
const rows = computed(() => {
  const d = data.value
  if (!d) return []
  const logins = new Set([...d.profiles.map(p => p.login), ...Object.keys(d.roles)])
  return [...logins].sort((a, b) => a.localeCompare(b)).map(login => ({
    login,
    profile: d.profiles.find(p => p.login === login) ?? null,
    role: d.roles[login] ?? null,
  }))
})

const unlistedCount = computed(() => rows.value.filter(r => r.role === null).length)

async function setRole(login: string, next: string) {
  const role = next === '' ? null : next as Role
  saving.value = login
  try {
    const res = await $fetch<{ roles: Record<string, Role> }>('/api/roles', { method: 'PUT', body: { login, role } })
    if (data.value) data.value.roles = res.roles
    toast.add({
      title: role ? `${login} is now ${role}` : `${login} has no role set - acting as operator`,
      color: 'success',
    })
  } catch (e) {
    // The server already refuses self-demotion with a message that says what to
    // do instead. Surfacing it verbatim beats a second guess on the client.
    toast.add(errorToast(`Could not change ${login}'s role`, e))
    await refresh()
  } finally {
    saving.value = null
  }
}

/** AUTH_DISABLED=1 writes no profile, so in local mode this is the only way to
 *  name a login. Adds a row; the role select on it does the actual write. */
function addByLogin() {
  const login = addLogin.value.trim()
  if (!login || !data.value) return
  if (!rows.value.some(r => r.login === login)) {
    data.value.profiles = [...data.value.profiles, { login, lastSeenAt: 0 }]
  }
  addLogin.value = ''
}

const card = 'rounded-xl p-5'
const cardStyle = 'background: var(--surface-raised); border: 1px solid var(--border-subtle);'

function seen(at: number) {
  if (!at) return 'never signed in here'
  return `last seen ${new Date(at).toLocaleDateString()}`
}
</script>

<template>
  <div>
    <PageHeader title="Roles">
      <template #right>
        <ReadOnlyBadge v-if="!can('configure')" reason="assigning roles" />
      </template>
    </PageHeader>

    <div class="px-6 py-4 space-y-5 max-w-4xl">
      <p class="t-ui leading-relaxed text-label">
        A role decides what this console offers a person: which pages are in their sidebar, whether they can
        drive a run, and which gates are theirs to answer. Anyone not listed here is an operator, because that
        is the default - a missing roles file must never lock the team out of its own pipeline.
      </p>

      <div v-if="error" class="rounded-xl px-4 py-3 flex items-center gap-3" style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);">
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" style="color: var(--error);" />
        <span class="t-small flex-1" style="color: var(--error);">{{ error }}</span>
        <NuxtLink v-if="/sign in/i.test(error)" to="/login" class="t-small underline focus-ring">Sign in</NuxtLink>
        <UButton v-else size="xs" variant="ghost" color="neutral" label="Try again" :loading="loading" @click="refresh" />
      </div>

      <div v-else-if="loading && !data" class="space-y-2"><SkeletonCard v-for="i in 2" :key="i" /></div>

      <template v-else-if="data">
        <div v-if="unlistedCount" class="rounded-xl px-4 py-3 flex items-center gap-3" style="background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.14);">
          <UIcon name="i-lucide-shield-alert" class="size-4 shrink-0" style="color: var(--warning);" />
          <span class="t-small flex-1" style="color: var(--text-secondary);">
            {{ unlistedCount }} {{ unlistedCount === 1 ? 'person has' : 'people have' }} no role set, so
            {{ unlistedCount === 1 ? 'they are' : 'they are' }} acting as an operator with every control in the app.
          </span>
        </div>

        <div :class="card" :style="cardStyle">
          <table class="w-full t-small">
            <thead>
              <tr class="text-label">
                <th class="text-left font-normal pb-2">Person</th>
                <th class="text-left font-normal pb-2">Role</th>
                <th class="text-left font-normal pb-2 hidden md:table-cell">What they can do</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.login" style="border-top: 1px solid var(--border-subtle);">
                <td class="py-2.5 pr-3">
                  <div class="flex items-center gap-2 min-w-0">
                    <img v-if="r.profile?.avatar" :src="r.profile.avatar" alt="" class="size-6 rounded-full shrink-0" />
                    <UIcon v-else name="i-lucide-user" class="size-5 shrink-0 text-meta" />
                    <div class="min-w-0">
                      <div class="truncate" style="color: var(--text-primary);">
                        {{ r.profile?.name || r.login }}
                        <span v-if="r.login === me?.login" class="text-label">(you)</span>
                      </div>
                      <div class="t-label text-meta truncate">@{{ r.login }} · {{ seen(r.profile?.lastSeenAt ?? 0) }}</div>
                    </div>
                  </div>
                </td>
                <td class="py-2.5 pr-3">
                  <select
                    v-if="can('configure')"
                    class="field-select"
                    :value="r.role ?? ''"
                    :disabled="saving === r.login"
                    @change="setRole(r.login, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">No role set - operator</option>
                    <option v-for="role in data.available" :key="role" :value="role">{{ role }}</option>
                  </select>
                  <span v-else :style="{ color: r.role ? 'var(--text-primary)' : 'var(--warning)' }">
                    {{ r.role ?? 'No role set - acting as operator' }}
                  </span>
                </td>
                <td class="py-2.5 text-label hidden md:table-cell">
                  {{ data.labels[r.role ?? data.default] }}
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="3" class="py-4 text-label">
                  Nobody has signed in on this instance yet.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="can('configure')" :class="card" :style="cardStyle">
          <div class="field-group">
            <label class="field-label" for="roles-add-login">Add someone by GitHub login</label>
            <div class="flex flex-wrap items-center gap-2">
              <input
                id="roles-add-login"
                v-model="addLogin"
                class="field-input flex-1 min-w-[12rem]"
                placeholder="octocat"
                autocomplete="off"
                @keydown.enter.prevent="addByLogin"
              />
              <UButton label="Add" size="sm" variant="soft" :disabled="!addLogin.trim()" @click="addByLogin" />
            </div>
            <p class="field-hint">
              For someone who has not signed in yet, or for local mode where no profile is written. Adding a
              row only puts them in the table - pick a role to actually write it.
            </p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
