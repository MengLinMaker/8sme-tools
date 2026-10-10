import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Tool {
  to: string
  titleKey: string
  descriptionKey: string
  status: 'ready' | 'planned'
}

const TOOLS: Tool[] = [
  {
    to: '/preflight',
    titleKey: 'hub.tools.preflight.title',
    descriptionKey: 'hub.tools.preflight.description',
    status: 'ready',
  },
  {
    to: '/nesting',
    titleKey: 'hub.tools.nesting.title',
    descriptionKey: 'hub.tools.nesting.description',
    status: 'ready',
  },
]

export function HubPage() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">{t('hub.title')}</h1>
        <p className="text-muted-foreground">{t('hub.subtitle')}</p>
      </section>

      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((tool) => (
          <Link key={tool.to} to={tool.to} className="group">
            <Card className="h-full transition-colors group-hover:border-primary/40">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">{t(tool.titleKey)}</CardTitle>
                  <Badge variant={tool.status === 'ready' ? 'success' : 'muted'}>
                    {t(`hub.status.${tool.status}`)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{t(tool.descriptionKey)}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
