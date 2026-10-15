import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const toggleVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-input bg-transparent',
      },
      size: {
        xs: 'h-auto gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] leading-none',
        default: 'h-9 px-3 text-sm',
        sm: 'h-7 px-2.5 text-xs',
        lg: 'h-10 px-3 text-sm',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
)

export interface ToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'>,
    VariantProps<typeof toggleVariants> {
  pressed?: boolean
  onPressedChange?: (pressed: boolean) => void
}

export function Toggle({
  className,
  variant,
  size,
  pressed = false,
  onPressedChange,
  ...props
}: ToggleProps) {
  return (
    <button
      type="button"
      data-state={pressed ? 'on' : 'off'}
      aria-pressed={pressed}
      onClick={() => onPressedChange?.(!pressed)}
      className={cn(
        toggleVariants({ variant, size }),
        pressed ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { toggleVariants }
