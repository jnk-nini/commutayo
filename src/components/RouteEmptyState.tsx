// The states a route search lands in when there is no card to show. Every one of them says what
// happened and what to do next. A blank panel leaves the commuter guessing whether the app is
// broken or the trip is impossible.

import { motion, useReducedMotion } from "framer-motion"
import { MapPin, Route, TriangleAlert, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { FOCUS, GLASS, ICON, PRESS, RADIUS } from "@/utils/presentation"

export type RouteEmptyReason = "pick-places" | "same-place" | "no-route"

interface EmptyCopy {
  Icon: LucideIcon
  title: string
  body: string
  tone: string
}

const EMPTY_COPY: Record<RouteEmptyReason, EmptyCopy> = {
  "pick-places": {
    Icon: MapPin,
    title: "Saan ka galing, saan ka pupunta?",
    body: "Pumili ng simula at destinasyon sa itaas para makita ang ruta, pamasahe, at oras ng biyahe.",
    tone: "bg-zinc-500/10 text-zinc-700 ring-zinc-500/25 dark:text-zinc-300 dark:ring-white/15",
  },
  "same-place": {
    Icon: Route,
    title: "Pareho ang simula at destinasyon",
    body: "Nandiyan ka na! Pumili ng ibang destinasyon para makabuo ng ruta.",
    tone: "bg-sky-500/12 text-sky-800 ring-sky-600/25 dark:text-sky-300 dark:ring-sky-400/30",
  },
  "no-route": {
    Icon: TriangleAlert,
    title: "Walang nahanap na ruta",
    body: "Wala pang koneksyon sa pagitan ng dalawang lugar na ito sa pilot corridor. Subukan ang ibang terminal na malapit, o baligtarin ang direksyon.",
    tone: "bg-amber-500/12 text-amber-800 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-400/30",
  },
}

export interface RouteEmptyStateProps {
  reason: RouteEmptyReason
  /** Optional escape hatch, e.g. "Baligtarin" (swap origin and destination). */
  actionLabel?: string
  onAction?: () => void
  className?: string
}

export function RouteEmptyState({ reason, actionLabel, onAction, className }: RouteEmptyStateProps) {
  const reduceMotion = useReducedMotion()
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30 }
  const { Icon, title, body, tone } = EMPTY_COPY[reason]

  return (
    <motion.div
      key={reason}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, transition: { duration: 0.15, ease: "easeOut" } }}
      transition={spring}
      className={cn(
        "w-full max-w-md px-5 py-8 text-center",
        RADIUS.panel,
        GLASS,
        className
      )}
    >
      <span className={cn("mx-auto flex size-12 items-center justify-center rounded-full ring-1", tone)}>
        <Icon className={ICON.md} aria-hidden />
      </span>
      <h2 className="mt-3 text-base font-bold text-zinc-900 dark:text-zinc-50">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{body}</p>

      {actionLabel !== undefined && onAction !== undefined && (
        <button
          type="button"
          onClick={onAction}
          className={cn(
            "mt-4 inline-flex min-h-11 items-center justify-center px-5 text-sm font-semibold",
            RADIUS.control,
            "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white",
            PRESS,
            FOCUS
          )}
        >
          {actionLabel}
        </button>
      )}
    </motion.div>
  )
}

export default RouteEmptyState
