import { useTranslation } from 'react-i18next'
import { ETCH_COLOR, MARKING_COLOR, THICKNESS_COLORS } from '@/lib/parsers/ncProject'

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function Chip({ color, label }: { color: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block size-3 rounded-sm border border-border"
        style={{ background: hex(color) }}
      />
      {label}
    </span>
  )
}

/**
 * Profile key for the projected NC: cut lines are coloured by wall thickness, and etch / weld
 * markings are separate profiles.
 */
export function NcLegend({ thicknesses = [] }: { thicknesses?: number[] }) {
  const { t } = useTranslation()
  return (
    <>
      {thicknesses.map((thickness, index) => (
        <Chip
          key={thickness}
          color={THICKNESS_COLORS[index % THICKNESS_COLORS.length] ?? 0x9ca3af}
          label={`${thickness} mm`}
        />
      ))}
      <Chip color={ETCH_COLOR} label={t('viewer.profileEtch')} />
      <Chip color={MARKING_COLOR} label={t('viewer.profileMarking')} />
    </>
  )
}
