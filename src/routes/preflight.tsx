import { createFileRoute } from '@tanstack/react-router'
import { ProjectsPage } from '@/features/preflight/ProjectsPage'

export const Route = createFileRoute('/preflight')({
  component: ProjectsPage,
})
