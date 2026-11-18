import { createFileRoute } from '@tanstack/react-router'
import { PreflightPage } from '@/features/preflight/PreflightPage'
import { preflightSearchSchema } from '@/lib/audit/schemas'

export const Route = createFileRoute('/preflight/$projectId')({
  validateSearch: preflightSearchSchema,
  component: PreflightProjectRoute,
})

function PreflightProjectRoute() {
  const { projectId } = Route.useParams()
  return <PreflightPage projectId={projectId} />
}
