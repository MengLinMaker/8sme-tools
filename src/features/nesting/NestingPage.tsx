import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function NestingPage() {
  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">Beam Nesting</h1>
        <p className="text-muted-foreground">
          Planned: pack a cut list into stock beams of fixed lengths, minimising bars and offcuts.
        </p>
      </section>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Not built yet</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
            <li>
              Input: part marks with profile, grade, length and quantity (from a part list or NC
              headers).
            </li>
            <li>Stock: configurable bar lengths (e.g. 6 / 9 / 12 m), kerf, and end trim.</li>
            <li>
              Strategy: first-fit-decreasing with kerf, then local improvement per profile + grade
              group.
            </li>
            <li>Special case: T-parts are nested as their parent UB, then split.</li>
            <li>Output: cutting plan per bar, waste %, and a stock order list.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
