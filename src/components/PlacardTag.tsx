// The signboard badge: what is actually painted on the vehicle a commuter has to flag down.
//
// This is the only element in the app allowed to use bold uppercase wide-tracked type, and it is
// deliberately styled as a physical object rather than a UI chip: an amber acrylic plate with a
// heavy black rule around it and black hand-painted caps inside. That treatment is held constant
// across light and dark mode on purpose. A real signboard does not repaint itself at night, and
// keeping it light-on-dark-text in both themes also keeps its contrast far above AA either way.

import { cn } from "@/lib/utils"
import { RADIUS } from "@/utils/presentation"

export type PlacardSize = "sm" | "lg"

export interface PlacardTagProps {
  /** Board text, exactly as painted. Rendered uppercase regardless of how it is stored. */
  text: string
  size?: PlacardSize
  className?: string
}

const SIZE_CLASSES: Record<PlacardSize, string> = {
  sm: "border-2 px-2 py-0.5 text-xs tracking-[0.08em]",
  lg: "border-[3px] px-3.5 py-2 text-lg tracking-[0.06em] sm:text-xl",
}

export function PlacardTag({ text, size = "sm", className }: PlacardTagProps) {
  if (text.trim().length === 0) return null

  return (
    <span
      // Announced as a quoted sign rather than as loose shouting capitals, which is what a screen
      // reader would otherwise spell out letter by letter.
      aria-label={`Signboard: ${text}`}
      className={cn(
        "inline-flex max-w-full items-center border-zinc-900 bg-amber-100",
        "font-extrabold text-zinc-900 uppercase",
        "shadow-[0_1px_0_rgba(24,24,27,0.35)]",
        RADIUS.placard,
        SIZE_CLASSES[size],
        className
      )}
    >
      <span className="truncate">{text}</span>
    </span>
  )
}

export default PlacardTag
