import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { requireCapability } from '../utils/session'

const execAsync = promisify(exec)

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  await requireCapability(event, 'configure')
  // Only meaningful when the browser and the server share a desktop.
  if (process.env.LOCAL_DESKTOP !== '1') throw createError({ statusCode: 404, message: 'Not available on a shared server' })
  const { path } = await readBody<{ path: string }>(event)

  if (!path) {
    throw createError({ statusCode: 400, message: 'Path is required' })
  }

  // If it's a file, open the containing directory
  const targetPath = existsSync(path) ? dirname(path) : path

  if (!existsSync(targetPath)) {
    throw createError({ statusCode: 404, message: 'Path not found' })
  }

  const platform = process.platform
  let command = ''

  if (platform === 'darwin') {
    command = `open "${targetPath}"`
  } else if (platform === 'win32') {
    command = `explorer "${targetPath}"`
  } else {
    command = `xdg-open "${targetPath}"`
  }

  try {
    await execAsync(command)
    return { success: true }
  } catch (err: any) {
    throw createError({ statusCode: 500, message: `Failed to open directory: ${err.message}` })
  }
})
