import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Tool {
  to: string
  title: string
  description: string
  status: 'ready' | 'planned'
}

const TOOLS: Tool[] = [
  {
    to: '/preflight',
    title: 'WiseCAM Preflight',
    description:
      'Drop a job .zip and validate NC, STEP and PDF files: openability, quantities, and cross-checks against the part list.',
    status: 'ready',
  },
  {
    to: '/nesting',
    title: 'T Nesting',
    description:
      'Detect T-sections (halved UB), identify the parent UB, and nest pieces into stock beams with cut lines — short parts at the front.',
    status: 'ready',
  },
]

export function HubPage() {
  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">8SME Tools</h1>
        <p className="text-muted-foreground">
          Browser tools for the tube laser workflow. Everything runs locally — nothing is uploaded.
        </p>
      </section>

      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((tool) => (
          <Link key={tool.to} to={tool.to} className="group">
            <Card className="h-full transition-colors group-hover:border-primary/40">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">{tool.title}</CardTitle>
                  <Badge variant={tool.status === 'ready' ? 'success' : 'muted'}>
                    {tool.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{tool.description}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
