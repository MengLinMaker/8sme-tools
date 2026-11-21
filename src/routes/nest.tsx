import { createFileRoute } from '@tanstack/react-router'
import { NestPage } from '@/features/nest/NestPage'

export const Route = createFileRoute('/nest')({
  component: NestPage,
})
