import { requireCapability, currentUser } from '../utils/session.ts'
import { maxUploadBytes, saveUpload } from '../utils/uploads.ts'

/**
 * One file for a workflow input of type `file`, from the run dialog. Answers
 * with the path the input then carries. See server/utils/uploads.ts.
 */
export default defineEventHandler(async (event) => {
  // Only someone who may start a run has a run to give a file to.
  await requireCapability(event, 'startRun')
  const max = maxUploadBytes()
  const tooBig = () => createError({ statusCode: 413, message: `Files up to ${Math.round(max / 1024 / 1024)} MB can be uploaded` })

  // Refused before the body is read into memory when the length says so.
  const declared = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > max + 64 * 1024) throw tooBig()

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' && p.filename)
  if (!file) throw createError({ statusCode: 400, message: 'Send one file, in a form field named "file"' })
  if (file.data.byteLength > max) throw tooBig()
  if (!file.data.byteLength) throw createError({ statusCode: 400, message: 'That file is empty' })

  const user = await currentUser(event)
  return saveUpload(user?.login, file.filename, file.data)
})
