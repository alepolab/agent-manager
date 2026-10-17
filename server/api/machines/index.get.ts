import { requireUser } from '../../utils/session.ts'
import { listMachines, defaultMachineId, toPublicMachine } from '../../utils/machines.ts'

/**
 * Every registered machine, without its key. Readable by every signed-in
 * role: the run dialog and the workflow drawer offer the list to anyone who
 * may start a run, and a machine's host and paths are not secrets — the key
 * is, and it never leaves the server.
 */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  const [machines, defaultId] = await Promise.all([listMachines(), defaultMachineId()])
  return { machines: machines.map(toPublicMachine), defaultMachineId: defaultId ?? null }
})
