// Route result card: the "sakay guide" a commuter actually reads on the street — total fare and
// time up top, then a vertical, tappable timeline of every ride with its signboard, where to get
// off, and the exact Tagalog phrase to say to the driver.
//
// Motion follows the motion-design skill: spring (stiffness 300 / damping 30) for entry, step
// expansion and the show-driver overlay, `layout` + `layoutId` on the expanding elements, and
// quick easeOut (<=150ms) for anything leaving. Palette follows uiux-promax: Emerald = jeepney,
// Amber = bus / UV Express, Sky = tricycle, neutral zinc for walking legs.

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "framer-motion"
import {
  Bike,
  Bus,
  CarFront,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Flag,
  Footprints,
  Info,
  MapPin,
  Maximize2,
  Megaphone,
  Repeat,
  ShieldCheck,
  Truck,
  X,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { FARE_CLASSES, discountedFare, discountedTotalFare, fareClassOption, type FareClass } from "@/utils/fares"
import type { RoutePriority, RouteResult, RouteStep, TransitMode } from "@/utils/routingEngine"

export interface RouteResultCardProps {
  route: RouteResult
  /** Defaults to the priority the engine solved for, so the badge can't disagree with the route. */
  priority?: RoutePriority
  onClose?: () => void
  /** Overrides `route.confidence` when a better score is available. */
  confidence?: number
  /** Controlled fare class. Leave unset to let the card own the toggle. */
  fareClass?: FareClass
  defaultFareClass?: FareClass
  onFareClassChange?: (fareClass: FareClass) => void
  /** Fires with the expanded step's index (or null) so the map can highlight the same leg. */
  onStepSelect?: (stepIndex: number | null) => void
  /** Adds a grab handle and swipe-down-to-dismiss. Needs `onClose` to do anything. */
  dismissible?: boolean
  className?: string
}

// ---------------------------------------------------------------------------
// Mode + priority presentation tables
// ---------------------------------------------------------------------------

interface ModeStyle {
  label: string
  Icon: LucideIcon
  /** Icon puck: tinted fill + sub-pixel ring, per the uiux-promax border rule. */
  puck: string
  /** Signboard badge + fare chip tint. */
  chip: string
  /** Vertical dashed connector rail. */
  rail: string
  /** Solid accent, for the selected-step marker. */
  solid: string
}

const MODE_STYLES: Record<TransitMode, ModeStyle> = {
  jeepney: {
    label: "Jeepney",
    Icon: Truck,
    puck: "bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:bg-emerald-500/15 dark:text-emerald-400 dark:ring-emerald-400/25",
    chip: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-400/20",
    rail: "border-emerald-500/35 dark:border-emerald-400/30",
    solid: "bg-emerald-500",
  },
  bus: {
    label: "Bus",
    Icon: Bus,
    puck: "bg-amber-500/12 text-amber-600 ring-amber-500/25 dark:bg-amber-500/15 dark:text-amber-400 dark:ring-amber-400/25",
    chip: "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300 dark:ring-amber-400/20",
    rail: "border-amber-500/35 dark:border-amber-400/30",
    solid: "bg-amber-500",
  },
  uv_express: {
    label: "UV Express",
    Icon: CarFront,
    puck: "bg-amber-500/12 text-amber-600 ring-amber-500/25 dark:bg-amber-500/15 dark:text-amber-400 dark:ring-amber-400/25",
    chip: "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300 dark:ring-amber-400/20",
    rail: "border-amber-500/35 dark:border-amber-400/30",
    solid: "bg-amber-500",
  },
  tricycle: {
    label: "Tricycle",
    Icon: Bike,
    puck: "bg-sky-500/12 text-sky-600 ring-sky-500/25 dark:bg-sky-500/15 dark:text-sky-400 dark:ring-sky-400/25",
    chip: "bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300 dark:ring-sky-400/20",
    rail: "border-sky-500/35 dark:border-sky-400/30",
    solid: "bg-sky-500",
  },
  walk: {
    label: "Lakad (Walk)",
    Icon: Footprints,
    puck: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-400/10 dark:text-zinc-300 dark:ring-white/10",
    chip: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/15 dark:text-zinc-300 dark:ring-white/10",
    rail: "border-zinc-400/40 dark:border-white/15",
    solid: "bg-zinc-400",
  },
}

interface PriorityStyle {
  emoji: string
  label: string
  /** Header badge accent: Emerald cheapest, Amber fastest, Sky easiest. */
  badge: string
  /** Faint accent wash behind the header. */
  wash: string
}

const PRIORITY_STYLES: Record<RoutePriority, PriorityStyle> = {
  cheapest: {
    emoji: "\u{1F4B0}",
    label: "Cheapest",
    badge:
      "bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/25",
    wash: "from-emerald-500/10",
  },
  fastest: {
    emoji: "\u{26A1}",
    label: "Fastest",
    badge: "bg-amber-500/12 text-amber-700 ring-amber-500/25 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/25",
    wash: "from-amber-500/10",
  },
  easiest: {
    emoji: "\u{1F9D8}",
    label: "Easiest",
    badge: "bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/25",
    wash: "from-sky-500/10",
  },
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatFare(amount: number): string {
  return `₱${amount.toFixed(2)}`
}

function formatDuration(minutes: number): string {
  const whole = Math.round(minutes)
  if (whole < 60) return `${whole} min${whole === 1 ? "" : "s"}`
  const hours = Math.floor(whole / 60)
  const rest = whole % 60
  const hourPart = `${hours} hr${hours === 1 ? "" : "s"}`
  return rest === 0 ? hourPart : `${hourPart} ${rest} min${rest === 1 ? "" : "s"}`
}

function confidenceDot(score: number): string {
  if (score >= 90) return "\u{1F7E2}"
  if (score >= 75) return "\u{1F7E1}"
  return "\u{1F7E0}"
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function RouteResultCard({
  route,
  priority,
  onClose,
  confidence,
  fareClass,
  defaultFareClass = "regular",
  onFareClassChange,
  onStepSelect,
  dismissible = false,
  className,
}: RouteResultCardProps) {
  // Expand the first leg by default: it's the one the commuter needs before they start walking.
  const [expandedStep, setExpandedStep] = useState<number | null>(route.steps.length > 0 ? 0 : null)
  const [ownFareClass, setOwnFareClass] = useState<FareClass>(defaultFareClass)
  const [driverPhrase, setDriverPhrase] = useState<string | null>(null)
  const reduceMotion = useReducedMotion()

  const activeFareClass = fareClass ?? ownFareClass
  const fareOption = fareClassOption(activeFareClass)
  const resolvedPriority = priority ?? route.priority
  const priorityStyle = PRIORITY_STYLES[resolvedPriority]
  const score = confidence ?? route.confidence

  const payable = discountedTotalFare(route, activeFareClass)
  const isDiscounted = payable < route.totalFare

  // Emil Kowalski standard: one spring for entry and layout, a fast easeOut for anything leaving.
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30 }
  const exit = reduceMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" as const }

  const origin = route.steps[0]?.from ?? ""
  const destination = route.steps[route.steps.length - 1]?.to ?? ""

  // Deliberately not notifying from inside the state updater: React can run updaters during
  // render, and calling the parent's setState from there is the "cannot update a component while
  // rendering a different component" warning.
  const selectStep = useCallback(
    (index: number) => {
      const next = expandedStep === index ? null : index
      setExpandedStep(next)
      onStepSelect?.(next)
    },
    [expandedStep, onStepSelect]
  )

  const chooseFareClass = useCallback(
    (next: FareClass) => {
      if (fareClass === undefined) setOwnFareClass(next)
      onFareClassChange?.(next)
    },
    [fareClass, onFareClassChange]
  )

  // Swipe down past a threshold — or flick hard enough — dismisses, the way a bottom sheet should.
  const handleDragEnd = useCallback(
    (_event: unknown, info: PanInfo) => {
      if (info.offset.y > 120 || info.velocity.y > 600) onClose?.()
    },
    [onClose]
  )

  const canDrag = dismissible && onClose !== undefined

  // One root element, deliberately: an <AnimatePresence> parent keys and animates a single child,
  // and the show-driver overlay is portaled out rather than made a sibling here.
  return (
      <motion.article
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.99, transition: exit }}
        transition={spring}
        drag={canDrag ? "y" : false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.02, bottom: 0.5 }}
        onDragEnd={canDrag ? handleDragEnd : undefined}
        aria-label={`${priorityStyle.label} route from ${origin} to ${destination}`}
        className={cn(
          "relative w-full max-w-md overflow-hidden rounded-3xl",
          "bg-zinc-50/90 ring-1 ring-black/[0.06] backdrop-blur-md",
          "dark:bg-zinc-900/85 dark:ring-white/10",
          "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-12px_rgba(0,0,0,0.25)]",
          className
        )}
      >
        {canDrag && (
          <div className="flex cursor-grab justify-center pt-2 active:cursor-grabbing" aria-hidden>
            <span className="h-1 w-9 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          </div>
        )}

        {/* -------------------------------------------------------------- Header */}
        <header className={cn("relative isolate px-5 pb-4", canDrag ? "pt-3" : "pt-5")}>
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 -z-10 h-32 bg-gradient-to-b to-transparent",
              priorityStyle.wash
            )}
          />

          <div className="flex items-start justify-between gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1",
                "text-[11px] font-semibold uppercase tracking-[0.12em]",
                priorityStyle.badge
              )}
            >
              <span aria-hidden>{priorityStyle.emoji}</span>
              {priorityStyle.label}
            </span>

            {onClose !== undefined && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close route"
                className={cn(
                  "-mt-1 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full",
                  "text-zinc-500 transition-colors duration-150 hover:bg-black/5 hover:text-zinc-900",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20",
                  "dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-50 dark:focus-visible:ring-white/25"
                )}
              >
                <X className="size-5" />
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <motion.p
              key={activeFareClass}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring}
              className="text-[34px] leading-none font-bold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50"
            >
              {formatFare(payable)}
            </motion.p>
            {isDiscounted && (
              <span className="text-sm font-medium text-zinc-400 line-through tabular-nums dark:text-zinc-500">
                {formatFare(route.totalFare)}
              </span>
            )}
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">total pamasahe</p>
          </div>

          {origin !== "" && (
            <p className="mt-1.5 truncate text-sm text-zinc-500 dark:text-zinc-400">
              {origin} <span aria-hidden>&rarr;</span> {destination}
            </p>
          )}

          {/* Fares in the seed data are computed from the corridor spec, not surveyed on the road.
              Saying so is the difference between a helpful estimate and a wrong promise. */}
          <p className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              Tantiya lang — {fareOption.description.toLowerCase()}. Maaaring mag-iba ang singil ng driver.
            </span>
          </p>

          {/* --------------------------------------------------- Fare class toggle */}
          <div role="group" aria-label="Fare class" className="mt-3 flex gap-1.5">
            {FARE_CLASSES.map((option) => {
              const isActive = option.id === activeFareClass
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => chooseFareClass(option.id)}
                  aria-pressed={isActive}
                  className={cn(
                    "relative min-h-11 flex-1 rounded-2xl px-2 text-xs font-semibold transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 dark:focus-visible:ring-white/25",
                    isActive
                      ? "text-zinc-50 dark:text-zinc-900"
                      : "text-zinc-600 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="fare-class-pill"
                      transition={spring}
                      className="absolute inset-0 -z-10 rounded-2xl bg-zinc-900 dark:bg-zinc-50"
                    />
                  )}
                  {option.label}
                </button>
              )
            })}
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2">
            <Stat Icon={Clock} label="Biyahe" value={formatDuration(route.totalDurationMin)} />
            <Stat
              Icon={Repeat}
              label="Lipat"
              value={route.transferCount === 0 ? "Direkta" : `${route.transferCount}x`}
            />
            <Stat
              Icon={Footprints}
              label="Lakad"
              value={route.walkingMinutes === 0 ? "Wala" : formatDuration(route.walkingMinutes)}
            />
          </dl>

          <div className="mt-3 flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1",
                "text-[11px] font-semibold uppercase tracking-[0.12em]",
                "bg-black/[0.04] text-zinc-600 ring-black/[0.06]",
                "dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10"
              )}
              title="How much of this route's landmark data is verified against the corridor spec"
            >
              <span aria-hidden>{confidenceDot(score)}</span>
              {score}% Verified
              <ShieldCheck className="size-3" aria-hidden />
            </span>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              {route.steps.length} leg{route.steps.length === 1 ? "" : "s"}
            </span>
          </div>
        </header>

        <div className="h-px bg-black/[0.06] dark:bg-white/[0.08]" />

        {/* ------------------------------------------------------------ Timeline */}
        <motion.ol layout className="px-5 py-4">
          {route.steps.map((step, index) => (
            <StepRow
              key={`${step.serviceId}-${step.from}-${index}`}
              step={step}
              index={index}
              isLast={index === route.steps.length - 1}
              isExpanded={expandedStep === index}
              onToggle={() => selectStep(index)}
              onShowDriver={() => setDriverPhrase(step.driverPhrase)}
              fareClass={activeFareClass}
              spring={spring}
              exit={exit}
            />
          ))}

          {/* Arrival pin closes the dashed rail so the timeline reads as ending somewhere real. */}
          {destination !== "" && (
            <li className="flex items-center gap-3 pt-1">
              <span className="flex size-11 shrink-0 items-center justify-center">
                <span className="flex size-7 items-center justify-center rounded-full bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">
                  <Flag className="size-3.5" aria-hidden />
                </span>
              </span>
              <p className="min-w-0 flex-1 truncate text-base font-bold text-zinc-900 dark:text-zinc-50">{destination}</p>
            </li>
          )}
        </motion.ol>

        <ShowDriverOverlay phrase={driverPhrase} onDismiss={() => setDriverPhrase(null)} spring={spring} exit={exit} />
      </motion.article>
  )
}

// ---------------------------------------------------------------------------
// Header stat tile
// ---------------------------------------------------------------------------

function Stat({ Icon, label, value }: { Icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-black/[0.03] px-3 py-2 ring-1 ring-black/[0.05] dark:bg-white/[0.04] dark:ring-white/10">
      <dt className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.1em] text-zinc-500 dark:text-zinc-400">
        <Icon className="size-3" aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline step
// ---------------------------------------------------------------------------

interface StepRowProps {
  step: RouteStep
  index: number
  isLast: boolean
  isExpanded: boolean
  onToggle: () => void
  onShowDriver: () => void
  fareClass: FareClass
  spring: Record<string, unknown>
  exit: Record<string, unknown>
}

function StepRow({ step, index, isLast, isExpanded, onToggle, onShowDriver, fareClass, spring, exit }: StepRowProps) {
  const mode = MODE_STYLES[step.mode]
  const panelId = `route-step-panel-${index}`
  const payable = discountedFare(step.fare, fareClass)

  return (
    <motion.li layout transition={spring} className="relative flex gap-3">
      {/* Dashed landmark rail connecting one mode puck to the next. */}
      <div className="relative flex w-11 shrink-0 flex-col items-center">
        <span
          className={cn("z-10 flex size-11 items-center justify-center rounded-full ring-1", "bg-zinc-50 dark:bg-zinc-900", mode.puck)}
        >
          <mode.Icon className="size-5" aria-hidden />
        </span>
        <motion.span layout aria-hidden className={cn("w-0 flex-1 border-l-2 border-dashed", mode.rail, isLast && "opacity-0")} />
      </div>

      <div className={cn("min-w-0 flex-1", isLast ? "pb-2" : "pb-5")}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-controls={panelId}
          className={cn(
            "group flex min-h-11 w-full items-start gap-3 rounded-2xl px-2 py-1.5 text-left",
            "transition-colors duration-150 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 dark:focus-visible:ring-white/25"
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                {mode.label}
              </span>
              {step.mode !== "walk" && (
                <span
                  className={cn(
                    "inline-flex items-center rounded-md px-1.5 py-0.5 ring-1",
                    "text-[11px] font-bold uppercase tracking-[0.16em]",
                    mode.chip
                  )}
                >
                  {step.signboard}
                </span>
              )}
            </span>

            {/* Board and drop-off both live in the collapsed row: scanning the closed timeline
                should already answer "saan ako sasakay, saan ako bababa". */}
            <span className="mt-1 block truncate text-base font-bold text-zinc-900 dark:text-zinc-50">
              {step.mode === "walk" ? "Lakad mula " : "Sakay sa "}
              {step.from}
            </span>
            <span className="mt-0.5 flex items-center gap-1 text-sm text-zinc-600 dark:text-zinc-300">
              <MapPin className="size-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
              <span className="truncate">Baba sa {step.to}</span>
            </span>

            <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              <span className={cn("rounded-full px-2 py-0.5 font-semibold tabular-nums ring-1", mode.chip)}>
                {payable === 0 ? "Libre" : formatFare(payable)}
              </span>
              <span className="tabular-nums">{formatDuration(step.durationMin)}</span>
              {step.viaStops.length > 0 && (
                <span className="tabular-nums">
                  {step.viaStops.length} hinto{step.viaStops.length === 1 ? "" : "s"} sa daan
                </span>
              )}
            </span>
          </span>

          <motion.span
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="mt-1 flex size-6 shrink-0 items-center justify-center text-zinc-400 dark:text-zinc-500"
          >
            <ChevronDown className="size-4" aria-hidden />
          </motion.span>
        </button>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              id={panelId}
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0, transition: exit }}
              transition={spring}
              className="overflow-hidden"
            >
              <motion.div layout className="mt-2 space-y-2 px-2">
                {/* The line the commuter says out loud — the single most useful thing on the card. */}
                <motion.div
                  layoutId={`manong-${index}`}
                  transition={spring}
                  className={cn(
                    "rounded-2xl px-3 py-2.5 ring-1",
                    "bg-zinc-900 text-zinc-50 ring-black/10",
                    "dark:bg-zinc-50 dark:text-zinc-900 dark:ring-white/10"
                  )}
                >
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] opacity-60">
                    <Megaphone className="size-3" aria-hidden />
                    Sabihin kay Manong
                  </p>
                  <p className="mt-1 text-base font-bold leading-snug">
                    <span className="opacity-60">Sabihin: </span>
                    &ldquo;{step.driverPhrase}&rdquo;
                  </p>

                  {/* On a moving jeepney, reading a phrase aloud beats scrolling — and when it's
                      too loud to be heard, the big-text view is something you just hold up. */}
                  <div className="mt-2.5 flex gap-2">
                    <button
                      type="button"
                      onClick={onShowDriver}
                      className={cn(
                        "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold",
                        "bg-white/10 transition-colors duration-150 hover:bg-white/20",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
                        "dark:bg-zinc-900/10 dark:hover:bg-zinc-900/20 dark:focus-visible:ring-zinc-900/30"
                      )}
                    >
                      <Maximize2 className="size-4" aria-hidden />
                      Ipakita kay Manong
                    </button>
                    <CopyPhraseButton phrase={step.driverPhrase} />
                  </div>
                </motion.div>

                {step.viaStops.length > 0 && (
                  <motion.div
                    layout
                    className="rounded-2xl bg-black/[0.03] px-3 py-2.5 ring-1 ring-black/[0.05] dark:bg-white/[0.04] dark:ring-white/10"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                      Dadaan sa
                    </p>
                    <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-200">{step.viaStops.join(" → ")}</p>
                  </motion.div>
                )}

                {step.landmarkCues.length > 0 && (
                  <motion.div
                    layout
                    className="rounded-2xl bg-black/[0.03] px-3 py-2.5 ring-1 ring-black/[0.05] dark:bg-white/[0.04] dark:ring-white/10"
                  >
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                      <MapPin className="size-3" aria-hidden />
                      Babaan / Landmark
                    </p>
                    <p className="mt-1 text-base font-bold leading-snug text-zinc-900 dark:text-zinc-50">{step.to}</p>
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {step.landmarkCues.map((cue) => (
                        <li
                          key={cue}
                          className="rounded-full bg-black/[0.04] px-2 py-0.5 text-xs text-zinc-600 ring-1 ring-black/[0.05] dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10"
                        >
                          {cue}
                        </li>
                      ))}
                    </ul>
                    {!step.landmarkVerified && (
                      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                        Hindi pa na-veverify ang babaan na ito — tanungin si Manong para sigurado.
                      </p>
                    )}
                  </motion.div>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.li>
  )
}

// ---------------------------------------------------------------------------
// Copy + show-driver
// ---------------------------------------------------------------------------

function CopyPhraseButton({ phrase }: { phrase: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(phrase)
      setCopied(true)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard is blocked on insecure origins and in some in-app browsers. The phrase is still
      // on screen and can be read aloud, so a failed copy isn't worth interrupting anyone over.
    }
  }, [phrase])

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Phrase copied" : "Copy phrase"}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-xl",
        "bg-white/10 transition-colors duration-150 hover:bg-white/20",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        "dark:bg-zinc-900/10 dark:hover:bg-zinc-900/20 dark:focus-visible:ring-zinc-900/30"
      )}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
    </button>
  )
}

interface ShowDriverOverlayProps {
  phrase: string | null
  onDismiss: () => void
  spring: Record<string, unknown>
  exit: Record<string, unknown>
}

/**
 * Full-screen, hold-it-up view of the phrase — for when the jeepney is too loud to talk over.
 * Portaled to <body> because the card animates with a transform, and a transformed ancestor makes
 * `position: fixed` behave like `absolute` — the overlay would be trapped inside the card.
 */
function ShowDriverOverlay({ phrase, onDismiss, spring, exit }: ShowDriverOverlayProps) {
  useEffect(() => {
    if (phrase === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [phrase, onDismiss])

  return createPortal(
    <AnimatePresence>
      {phrase !== null && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Ipakita kay Manong"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: exit }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          onClick={onDismiss}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-zinc-900 p-8 text-zinc-50"
        >
          <motion.p
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98, transition: exit }}
            transition={spring}
            className="text-center text-4xl font-bold leading-tight tracking-tight sm:text-5xl"
          >
            &ldquo;{phrase}&rdquo;
          </motion.p>
          <p className="text-sm text-zinc-400">Tapikin kahit saan para isara</p>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

export default RouteResultCard
