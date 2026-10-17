import { listDelegations } from '../../utils/smeDirectory.ts'

/** Every delegation on file. Who covers for whom is not a secret on a team. */
export default defineEventHandler(async () => ({ delegations: await listDelegations() }))
