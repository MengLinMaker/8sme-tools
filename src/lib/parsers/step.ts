import type { StepFile } from '@/lib/audit/types'

export function parseStepFile(path: string, text: string): StepFile {
  const problems: string[] = []
  const body = text.replace(/^\uFEFF/, '')

  if (!body.trimStart().startsWith('ISO-10303-21;')) {
    problems.push('missing ISO-10303-21 header')
  }
  if (!/(^|\n)\s*HEADER\s*;/.test(body)) problems.push('missing HEADER section')
  if (!/(^|\n)\s*DATA\s*;/.test(body)) problems.push('missing DATA section')
  if (!/END-ISO-10303-21\s*;\s*$/.test(body.trimEnd())) {
    problems.push('missing END-ISO-10303-21 terminator (possibly truncated)')
  }

  const schemaMatch = body.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/)
  const schema = schemaMatch ? schemaMatch[1] : null
  if (!schema) problems.push('missing FILE_SCHEMA')

  const entityCount = (body.match(/^\s*#\d+\s*=/gm) ?? []).length
  if (entityCount === 0) problems.push('no STEP entities found')

  return {
    path,
    valid: problems.length === 0,
    schema,
    entityCount,
    problems,
  }
}
