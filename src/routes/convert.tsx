import { createFileRoute } from '@tanstack/react-router'
import { ConvertPage } from '@/features/convert/ConvertPage'

export const Route = createFileRoute('/convert')({
  component: ConvertPage,
})
