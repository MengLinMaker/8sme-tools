import { createFileRoute } from '@tanstack/react-router'
import { PreflightPage } from '@/features/preflight/PreflightPage'
import { preflightSearchSchema } from '@/lib/audit/schemas'

export const Route = createFileRoute('/preflight')({
  validateSearch: preflightSearchSchema,
  component: PreflightPage,
})
