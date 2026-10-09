import { createFileRoute } from '@tanstack/react-router'
import { NestingPage } from '@/features/nesting/NestingPage'

export const Route = createFileRoute('/nesting')({
  component: NestingPage,
})
