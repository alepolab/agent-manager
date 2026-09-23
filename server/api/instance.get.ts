import { instanceInfo } from '../utils/instanceInfo'

/**
 * What this instance is configured to do. Not public: `server/middleware/auth.ts`
 * requires a signed-in developer for every `/api/` path `isPublicApiPath` does
 * not name, and this is deliberately not one of them - it reports the paths the
 * instance reads and writes, and which credentials are configured.
 *
 * It reports secrets by NAME and presence only. See instanceInfo.ts.
 */
export default defineEventHandler(() => instanceInfo())
