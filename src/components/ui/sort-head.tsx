import { TableHead } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export type SortDir = 1 | -1

/** The column a table is sorted by, and which way. */
export interface ColumnSort<K extends string> {
  key: K
  dir: SortDir
}

/** First click on a new column sorts ascending; clicking the active column flips it. */
export function toggleColumnSort<K extends string>(current: ColumnSort<K>, key: K): ColumnSort<K> {
  return current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }
}

/**
 * A sortable column header: the label is the button, and the active column carries an arrow.
 * Value columns pass `align="right"` so the control sits over their numbers.
 */
export function SortHead<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align,
  width,
}: {
  label: string
  sortKey: K
  sort: ColumnSort<K>
  onSort: (key: K) => void
  /** Value columns sit at the right edge, over their numbers. */
  align?: 'right'
  /** Fixed width, so the column never moves as its values change. */
  width?: string
}) {
  const active = sort.key === sortKey
  return (
    <TableHead
      aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      className={cn(width, align === 'right' ? 'text-right' : 'text-left')}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground"
      >
        {label}
        <span className="text-[9px] leading-none">
          {active ? (sort.dir === 1 ? '▲' : '▼') : ''}
        </span>
      </button>
    </TableHead>
  )
}
