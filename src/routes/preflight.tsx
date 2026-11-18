import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/preflight')({
  component: PreflightLayout,
})

/** `/preflight` has two children (the list and a project); the parent only provides the outlet. */
function PreflightLayout() {
  return <Outlet />
}
