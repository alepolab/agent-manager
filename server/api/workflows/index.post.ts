import { requireCapability } from '../../utils/session'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import type { WorkflowPayload, Workflow } from '~/types'

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow'
}

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody<WorkflowPayload>(event)
  if (!body.name?.trim()) {
    throw createError({ statusCode: 400, message: 'name is required' })
  }

  const dir = resolveClaudePath('workflows')
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })

  let slug = slugify(body.name)
  let filePath = join(dir, `${slug}.json`)
  let counter = 2
  while (existsSync(filePath)) {
    slug = `${slugify(body.name)}-${counter}`
    filePath = join(dir, `${slug}.json`)
    counter++
  }

  const workflow: Omit<Workflow, 'slug' | 'filePath'> = {
    name: body.name.trim(),
    description: body.description || '',
    steps: body.steps || [],
    createdAt: new Date().toISOString(),
  }

  await writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8')
  return { slug, filePath, ...workflow } as Workflow
})
