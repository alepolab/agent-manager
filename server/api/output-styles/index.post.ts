import { requireCapability } from '../../utils/session'
import { writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { serializeFrontmatter } from '../../utils/frontmatter'
import { getClaudeDir } from '../../utils/claudeDir'
import { resolveHome } from '../../utils/path'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody(event)
  const { id, name, description, keepCodingInstructions, content, scope, workingDir, oldId } = body

  const expandedWorkingDir = workingDir ? resolveHome(workingDir) : null
  console.log('Saving output style:', { id, name, scope, expandedWorkingDir })

  if (!id || !name || !content) {
    throw createError({ statusCode: 400, message: 'Missing required fields: id, name, or content' })
  }

  const globalDir = join(getClaudeDir(), 'output-styles')
  const projectDir = expandedWorkingDir ? join(expandedWorkingDir, '.claude', 'output-styles') : null
  
  const targetDir = scope === 'global' ? globalDir : projectDir
  if (!targetDir) {
    if (scope === 'project' && !expandedWorkingDir) {
      throw createError({ statusCode: 400, message: 'Please set a working directory in the sidebar to save project-scoped styles.' })
    }
    console.error('No target directory for scope:', scope, 'workingDir:', workingDir)
    throw createError({ statusCode: 400, message: 'Invalid target directory' })
  }

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  const fileName = `${id}.md`
  const filePath = join(targetDir, fileName)

  // Rename if id changed
  if (oldId && oldId !== id) {
    const oldPath = join(targetDir, `${oldId}.md`)
    if (existsSync(oldPath)) {
      unlinkSync(oldPath)
    }
  }

  const frontmatter = {
    name,
    description: description || '',
    'keep-coding-instructions': keepCodingInstructions === true
  }

  const serialized = serializeFrontmatter(frontmatter, content)
  writeFileSync(filePath, serialized, 'utf8')

  return { success: true, id, path: filePath }
})
