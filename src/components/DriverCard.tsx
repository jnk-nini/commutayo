// The phrase to show the driver, big enough to hold up inside a noisy jeepney.
//
// The phrase itself stays in Tagalog. It is not UI copy -- it is the sentence the commuter
// says out loud to a Filipino jeepney driver, and translating it would break the one thing
// this screen exists to do. Everything around it is English.
//
// This used to be a full-screen blackout. That version worked as a sign and failed as an interface:
// the map, the route and every other control vanished, so a commuter who opened it mid-ride lost
// all sense of where they were and had to dismiss it to get their bearings back. It also gave a
// screen reader nothing to anchor to and no way out but a tap anywhere.
//
// It is now a bottom drawer over a light scrim. The map stays visible and legible above it, the
// phrase is set at text-2xl bold on a high-contrast surface so it reads at arm's length across a
// vehicle, and there is a real close button, an Escape handler and a swipe-down, so the gesture is
// never the only way out.

import { useCallback, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "framer-motion"
import { MapPin, Megaphone, X } from "lucide-react"

import PlacardTag from "@/components/PlacardTag"
import { cn } from "@/lib/utils"
import { FOCUS, ICON, PRESS, RADIUS, Z } from "@/utils/presentation"

export interface DriverCardContent {
  /** The line to say out loud or hold up. */
  phrase: string
  /** Board text of the vehicle this phrase is for. Empty for walking legs. */
  placardText: string
  /** Where the commuter is getting off, for the smaller supporting line. */
  dropOff: string
}

export interface DriverCardProps {
  content: DriverCardContent | null
  onDismiss: () => void
}

export function DriverCard({ content, onDismiss }: DriverCardProps) {
  const reduceMotion = useReducedMotion()
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const open = content !== null

  // Remember who opened this so focus lands back on that button, not on document.body, which would
  // drop a keyboard user at the top of the page every time they closed the card.
  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      returnFocusRef.current?.focus?.()
    }
  }, [open, onDismiss])

  const handleDragEnd = useCallback(
    (_event: unknown, info: PanInfo) => {
      if (info.offset.y > 90 || info.velocity.y > 500) onDismiss()
    },
    [onDismiss]
  )

  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30 }
  const exit = reduceMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" as const }

  return createPortal(
    <AnimatePresence>
      {content !== null && (
        <motion.div
          key="driver-card"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: exit }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          onClick={onDismiss}
          // A light scrim, not a blackout. Enough separation to read the drawer as modal, weak
          // enough that the route on the map behind it is still followable.
          className={cn("fixed inset-0 flex items-end justify-center bg-zinc-950/35 backdrop-blur-[2px]", Z.drawer)}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="driver-card-phrase"
            tabIndex={-1}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%", transition: exit }}
            transition={spring}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={handleDragEnd}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "w-full max-w-lg outline-none",
              "rounded-t-3xl border-t border-x border-white/10",
              "bg-zinc-950 text-zinc-50 shadow-2xl shadow-black/50",
              // Clear of the home indicator on a gesture-navigation phone.
              "pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            )}
          >
            <div className="flex justify-center pt-2.5" aria-hidden>
              <span className="h-1 w-10 rounded-full bg-white/25" />
            </div>

            <div className="flex items-start justify-between gap-3 px-5 pt-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-zinc-400">
                <Megaphone className={ICON.sm} aria-hidden />
                Show this to the driver, or say it
              </p>
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Close"
                className={cn(
                  "-mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center text-zinc-400",
                  "hover:bg-white/10 hover:text-zinc-50",
                  RADIUS.pill,
                  PRESS,
                  FOCUS
                )}
              >
                <X className={ICON.md} aria-hidden />
              </button>
            </div>

            {/* The reason this screen exists. Everything else on it is supporting text. */}
            <p
              id="driver-card-phrase"
              className="px-5 pt-3 text-2xl leading-snug font-bold tracking-tight text-balance sm:text-3xl"
            >
              &ldquo;{content.phrase}&rdquo;
            </p>

            <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
              {content.placardText.length > 0 && <PlacardTag text={content.placardText} size="sm" />}
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-300">
                <MapPin className={cn(ICON.xs, "text-zinc-500")} aria-hidden />
                Get off at {content.dropOff}
              </span>
            </div>

            <p className="px-5 pt-4 text-xs text-zinc-400">
              The map is still visible behind this. Swipe down or press X to go back.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

export default DriverCard
