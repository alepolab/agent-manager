import { existsSync } from 'node:fs'
import { runArtifactsDir } from '../../../../utils/runArtifacts'
import { listArtifactFiles } from '../../../../utils/artifactListing'
import { requireRunAccess } from '../../../../utils/runAccess'
import { reopenForServer } from '../../../../utils/osUsers'
import { getRun } from '../../../../utils/workflowRunStore'

/** Every file under a run's artifacts directory, as relative paths with sizes. */
export default defineEventHandler(async (event) => {
  // Yours, your team's, or - unplaced - anyone's: see runAccess.ts.
  await requireRunAccess(event)
  const id = getRouterParam(event, 'id')!
  const root = runArtifactsDir(id)
  if (!existsSync(root)) return []
  try {
    return await listArtifactFiles(root)
  } catch (err: any) {
    // A folder the agent made as the developer's user, before the server was
    // named in its ACL or with a mode that shut it out: let it back in once.
    if (err?.code !== 'EACCES') throw err
    await reopenForServer(root, (await getRun(id))?.startedBy)
    return await listArtifactFiles(root)
  }
})
