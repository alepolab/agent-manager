import { existsSync } from 'node:fs'
import { runArtifactsDir } from '../../../../utils/runArtifacts'
import { listArtifactFiles } from '../../../../utils/artifactListing'

/** Every file under a run's artifacts directory, as relative paths with sizes. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const root = runArtifactsDir(id)
  if (!existsSync(root)) return []
  return await listArtifactFiles(root)
})
