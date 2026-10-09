import { createFileRoute } from '@tanstack/react-router'
import { PreflightPage } from '@/features/preflight/PreflightPage'
import { preflightSearchSchema } from '@/lib/audit/schemas'

export const Route = createFileRoute('/')({
  validateSearch: preflightSearchSchema,
  component: PreflightPage,
})
