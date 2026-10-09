import { createFileRoute } from '@tanstack/react-router'
import { HubPage } from '@/features/hub/HubPage'

export const Route = createFileRoute('/')({
  component: HubPage,
})
