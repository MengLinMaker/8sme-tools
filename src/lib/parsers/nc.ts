import type { ZodError } from 'zod'
import { ncHeaderSchema } from '@/lib/audit/schemas'
import type { NcFile } from '@/lib/audit/types'

const FIELD_COUNT = 9

function issueMessages(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.join('.')
    return field ? `${field}: ${issue.message}` : issue.message
  })
}

/**
 * Parses a Weihong tube-laser `.nc1` text file.
 *
 * Layout (after the leading `ST` marker):
 *   programCode, mark, markAlt, profileCode, grade, quantity, profile, orientation, length,
 *   then cross-section dimensions until the first geometry block (`AK`).
 *
 * The nine header fields are validated with `ncHeaderSchema`; failing it yields a
 * null quantity/length and descriptive problems so the audit can still cross-check.
 */
export function parseNcFile(path: string, text: string): NcFile {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\r$/, '').trim())
  const problems: string[] = []

  let first = 0
  while (first < lines.length && lines[first] === '') first++
  let last = lines.length - 1
  while (last >= 0 && lines[last] === '') last--

  if (lines[first] !== 'ST') problems.push('missing ST header')
  if (last < 0 || lines[last] !== 'EN') problems.push('missing EN terminator')

  let index = first + 1
  if (lines[index]?.startsWith('**')) index++

  const fields: string[] = []
  while (fields.length < FIELD_COUNT && index < lines.length) {
    const token = lines[index]
    if (token === 'AK' || token === 'EN') break
    if (token !== '') fields.push(token)
    index++
  }
  if (fields.length < FIELD_COUNT) {
    problems.push(`unexpected header length (${fields.length}/${FIELD_COUNT})`)
  }

  const [programCode = '', mark = '', markAlt = '', profileCode = '', grade = ''] = fields
  const quantityRaw = fields[5] ?? ''
  const profile = fields[6] ?? ''
  const orientation = fields[7] ?? ''
  const lengthRaw = fields[8] ?? ''

  const parsed = ncHeaderSchema.safeParse({
    programCode,
    mark,
    markAlt,
    profileCode,
    grade,
    quantity: quantityRaw,
    profile,
    orientation,
    length: lengthRaw,
  })

  let quantity: number | null = null
  let length: number | null = null
  if (parsed.success) {
    quantity = parsed.data.quantity
    length = parsed.data.length
  } else {
    problems.push(...issueMessages(parsed.error))
  }

  const dimensions: number[] = []
  let hasGeometry = false
  for (; index < lines.length; index++) {
    const token = lines[index]
    if (token === 'EN') break
    if (token === 'AK') {
      hasGeometry = true
      continue
    }
    if (token === '') continue
    const n = Number(token)
    if (Number.isFinite(n) && !hasGeometry) dimensions.push(n)
  }
  if (!hasGeometry) problems.push('no geometry blocks (AK) found')

  if (mark !== markAlt) problems.push('duplicate mark fields differ')

  return {
    path,
    programCode,
    mark,
    markAlt,
    profileCode,
    grade,
    quantity,
    profile,
    orientation,
    length,
    dimensions,
    valid: problems.length === 0,
    problems,
  }
}
