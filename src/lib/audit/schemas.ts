import { z } from 'zod'

export const severitySchema = z.enum(['error', 'warning', 'info'])
export type Severity = z.infer<typeof severitySchema>

export const findingSchema = z.object({
  severity: severitySchema,
  code: z.string().min(1),
  mark: z.string().optional(),
  message: z.string().min(1),
})
export type Finding = z.infer<typeof findingSchema>

export const partListRowSchema = z.object({
  part: z.string().min(1),
  qty: z.number().int().nonnegative().nullable(),
  profile: z.string(),
  grade: z.string(),
  length: z.number().nonnegative().nullable(),
  weight: z.number().nonnegative().nullable(),
})
export type PartListRow = z.infer<typeof partListRowSchema>

/**
 * The nine fixed Weihong `.nc1` header fields, coerced from raw text. Passing
 * this schema is what "the NC header is usable" means.
 */
export const ncHeaderSchema = z.object({
  programCode: z.string().min(1),
  mark: z.string().min(1),
  markAlt: z.string().min(1),
  profileCode: z.string().min(1),
  grade: z.string().regex(/^[A-Za-z]+\d+/, 'grade not recognised'),
  quantity: z.coerce.number().int().positive(),
  profile: z.string().min(1),
  orientation: z.string().min(1),
  length: z.coerce.number().positive(),
})
export type NcHeader = z.infer<typeof ncHeaderSchema>

export const severityFilterSchema = z.enum(['all', 'error', 'warning', 'info'])
export type SeverityFilter = z.infer<typeof severityFilterSchema>

export const preflightSearchSchema = z.object({
  severity: severityFilterSchema.optional().catch(undefined),
})
export type PreflightSearch = z.infer<typeof preflightSearchSchema>
