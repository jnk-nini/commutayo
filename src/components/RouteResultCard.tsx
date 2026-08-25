// The sakay guide: the card a commuter actually reads on the street.
//
// It has two faces. While planning or riding it shows the fare, the clock, and one continuous
// vertical timeline running from the origin pin to the destination flag, with every ride and every
// walk drawn on the same rail and colour-coded by mode. Once the live trip finishes it flips to a
// summary of what the trip cost and offers a way to report anything that was wrong.
//
// Design constraints this file is holding to (all defined in @/utils/presentation):
//   - glass panel, four radius tiers, one interface accent, three icon sizes;
//   - uppercase wide-tracked type appears only inside PlacardTag, never as a section label;
//   - spring (300/30) for entry and layout, easeOut <=150ms for exits;
//   - every control is at least 44px and presses without moving its neighbours.

import { useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "framer-motion"
import {
  Check,
  ChevronDown,
  CircleCheck,
  Clock,
  Copy,
  Flag,
  Footprints,
  Info,
  MapPin,
  Megaphone,
  Repeat,
  RotateCcw,
  ShieldCheck,
  Signpost,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react"

import DriverCard, { type DriverCardContent } from "@/components/DriverCard"
import PlacardTag from "@/components/PlacardTag"
import { cn } from "@/lib/utils"
import {
  FARE_CLASSES,
  discountedFare,
  discountedTotalFare,
  fareClassOption,
  formatPeso,
  type FareClass,
} from "@/utils/fares"
import {
  FOCUS,
  GLASS,
  ICON,
  INSET,
  MODE_META,
  PRESS,
  PRIORITY_META,
  RADIUS,
  VEHICLE_CLASS_LABEL,
  confidenceColor,
  formatDuration,
  formatMeters,
} from "@/utils/presentation"
import type { RoutePriority, RouteResult, RouteStep } from "@/utils/routingEngine"

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
  /** Live tracking says the commuter reached the destination. Swaps in the summary face. */
  completed?: boolean
  /** Opens the crowdsource report dialog from the summary. */
  onReportIssue?: () => void
  /** Leaves the summary and goes back to planning. */
  onPlanNewTrip?: () => void
  className?: string
}

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
  completed = false,
  onReportIssue,
  onPlanNewTrip,
  className,
}: RouteResultCardProps) {
  // Expand the first leg by default: it's the one the commuter needs before they start walking.
  const [expandedStep, setExpandedStep] = useState<number | null>(route.steps.length > 0 ? 0 : null)
  const [ownFareClass, setOwnFareClass] = useState<FareClass>(defaultFareClass)
  const [driverCard, setDriverCard] = useState<DriverCardContent | null>(null)
  const reduceMotion = useReducedMotion()

  const activeFareClass = fareClass ?? ownFareClass
  const fareOption = fareClassOption(activeFareClass)
  const resolvedPriority = priority ?? route.priority
  const priorityStyle = PRIORITY_META[resolvedPriority]
  const score = confidence ?? route.confidence

  const payable = discountedTotalFare(route, activeFareClass)
  const isDiscounted = payable < route.totalFare

  // One spring for entry and layout, a fast easeOut for anything leaving.
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30 }
  const exit = reduceMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" as const }

  const origin = route.steps[0]?.from ?? ""
  const destination = route.steps[route.steps.length - 1]?.to ?? ""
  const totalMeters = route.steps.reduce((sum, step) => sum + step.distanceMeters, 0)

  // Deliberately not notifying from inside the state updater: React can run updaters during
  // render, and calling the parent's setState from there is the "cannot update a component while
  // rendering a different component" warning.
  const selectStep = useCallback(
    (index: number) => {
      const next = expandedStep === index ? null : index
      setExpandedStep(next)
      onStepSelect?.(next)
    },
    [expandedStep, onStepSelect],
  )

  const chooseFareClass = useCallback(
    (next: FareClass) => {
      if (fareClass === undefined) setOwnFareClass(next)
      onFareClassChange?.(next)
    },
    [fareClass, onFareClassChange],
  )

  // Swipe down past a threshold, or flick hard enough, dismisses the way a bottom sheet should.
  const handleDragEnd = useCallback(
    (_event: unknown, info: PanInfo) => {
      if (info.offset.y > 120 || info.velocity.y > 600) onClose?.()
    },
    [onClose],
  )

  const canDrag = dismissible && onClose !== undefined

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99, transition: exit }}
      transition={spring}
      drag={canDrag ? "y" : false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.02, bottom: 0.5 }}
      onDragEnd={canDrag ? handleDragEnd : undefined}
      aria-label={
        completed
          ? `Tapos na ang biyahe mula ${origin} papuntang ${destination}`
          : `Rutang ${priorityStyle.hint.toLowerCase()} mula ${origin} papuntang ${destination}`
      }
      className={cn("relative w-full max-w-md overflow-hidden", RADIUS.panel, GLASS, className)}
    >
      {canDrag && (
        <div className="flex cursor-grab justify-center pt-2 active:cursor-grabbing" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-zinc-400/50 dark:bg-zinc-600" />
        </div>
      )}

      {/*
        Deliberately NOT an <AnimatePresence mode="wait"> swap. That waits for the outgoing face's
        exit animation before mounting the incoming one, and exit animations are frame-driven: a
        backgrounded tab or a locked phone gets no requestAnimationFrame at all. Arrival is exactly
        when a phone is likeliest to be in a pocket, so the summary has to appear the moment
        `completed` flips, whether or not a single frame ever renders. Keying the div still animates
        the new face in when frames are available, and the parent's `layout` smooths the resize.
      */}
      {completed ? (
        <motion.div key="summary" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
          <TripSummary
            route={route}
            fareClass={activeFareClass}
            payable={payable}
            origin={origin}
            destination={destination}
            totalMeters={totalMeters}
            onReportIssue={onReportIssue}
            onPlanNewTrip={onPlanNewTrip}
          />
        </motion.div>
      ) : (
        <motion.div key="plan" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
          {/* ------------------------------------------------------------ Header */}
          <header className={cn("relative isolate px-5 pb-4", canDrag ? "pt-3" : "pt-5")}>
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 -z-10 h-32 bg-gradient-to-b to-transparent",
                priorityStyle.wash,
              )}
            />

            <div className="flex items-start justify-between gap-3">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold ring-1",
                  RADIUS.pill,
                  priorityStyle.badge,
                )}
              >
                <priorityStyle.Icon className={ICON.xs} aria-hidden />
                {priorityStyle.hint}
              </span>

              {onClose !== undefined && (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Isara ang ruta"
                  className={cn(
                    "-mt-1 -mr-2 flex size-11 shrink-0 items-center justify-center text-zinc-500",
                    "hover:bg-zinc-900/5 hover:text-zinc-900",
                    "dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-50",
                    RADIUS.pill,
                    PRESS,
                    FOCUS,
                  )}
                >
                  <X className={ICON.md} aria-hidden />
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
                {formatPeso(payable)}
              </motion.p>
              {isDiscounted && (
                <span className="text-sm font-medium text-zinc-600 line-through tabular-nums dark:text-zinc-300">
                  {formatPeso(route.totalFare)}
                </span>
              )}
              <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">total pamasahe</p>
            </div>

            {origin !== "" && (
              <p className="mt-1.5 truncate text-sm text-zinc-600 dark:text-zinc-300">
                {origin} <span aria-hidden>&rarr;</span> {destination}
              </p>
            )}

            {/* Fares here are computed from the corridor spec, not surveyed on the road. Saying so
                  is the difference between a helpful estimate and a wrong promise. */}
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-zinc-600 dark:text-zinc-300">
              <Info className={cn(ICON.xs, "mt-px shrink-0")} aria-hidden />
              <span>Tantiya lang, {fareOption.description.toLowerCase()}. Maaaring mag-iba ang singil ng driver.</span>
            </p>

            {/* --------------------------------------------------- Fare class toggle */}
            <div role="group" aria-label="Uri ng pamasahe" className="mt-3 flex gap-1.5">
              {FARE_CLASSES.map((option) => {
                const isActive = option.id === activeFareClass
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => chooseFareClass(option.id)}
                    aria-pressed={isActive}
                    className={cn(
                      "relative min-h-11 flex-1 px-2 text-xs font-semibold",
                      RADIUS.control,
                      PRESS,
                      FOCUS,
                      isActive
                        ? "text-zinc-50 dark:text-zinc-900"
                        : "text-zinc-700 hover:bg-zinc-900/5 dark:text-zinc-300 dark:hover:bg-white/[0.06]",
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="fare-class-pill"
                        transition={spring}
                        className={cn("absolute inset-0 -z-10 bg-zinc-900 dark:bg-zinc-50", RADIUS.control)}
                      />
                    )}
                    {option.label}
                  </button>
                )
              })}
            </div>

            {/* Three numbers, no boxes. Card containers here added chrome without adding meaning. */}
            <dl className="mt-4 flex divide-x divide-zinc-900/10 dark:divide-white/10">
              <Stat Icon={Clock} label="Biyahe" value={formatDuration(route.totalDurationMin)} first />
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
                  "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold ring-1",
                  RADIUS.pill,
                  "bg-zinc-900/5 text-zinc-700 ring-zinc-900/10",
                  "dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10",
                )}
                title="Kung gaano karami sa landmark data ng rutang ito ang na-verify sa corridor spec"
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: confidenceColor(score) }}
                />
                {score}% verified
                <ShieldCheck className={ICON.xs} aria-hidden />
              </span>
              <span className="text-xs text-zinc-600 dark:text-zinc-300">
                {route.steps.length} sakay {formatMeters(totalMeters)}
              </span>
            </div>
          </header>

          <div className="h-px bg-zinc-900/[0.07] dark:bg-white/[0.08]" />

          {/* ---------------------------------------------------------- Timeline */}
          <motion.ol layout className="px-5 py-4">
            <TimelineEndpoint name={origin} kind="origin" />

            {route.steps.map((step, index) => (
              <StepRow
                key={`${step.serviceId}-${step.from}-${index}`}
                step={step}
                index={index}
                isExpanded={expandedStep === index}
                onToggle={() => selectStep(index)}
                onShowDriver={() =>
                  setDriverCard({
                    phrase: step.driverPhrase,
                    placardText: step.placardText,
                    dropOff: step.to,
                  })
                }
                fareClass={activeFareClass}
                spring={spring}
                exit={exit}
              />
            ))}

            <TimelineEndpoint name={destination} kind="destination" />
          </motion.ol>
        </motion.div>
      )}

      <DriverCard content={driverCard} onDismiss={() => setDriverCard(null)} />
    </motion.article>
  )
}

// ---------------------------------------------------------------------------
// Header stat
// ---------------------------------------------------------------------------

function Stat({
  Icon,
  label,
  value,
  first = false,
}: {
  Icon: LucideIcon
  label: string
  value: string
  first?: boolean
}) {
  return (
    <div className={cn("min-w-0 flex-1", first ? "pr-3" : "px-3")}>
      <dt className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
        <Icon className={cn(ICON.xs, "text-zinc-400 dark:text-zinc-500")} aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * The pin at the very top of the rail and the flag at the bottom. They exist so the timeline reads
 * as a single line starting somewhere real and ending somewhere real, instead of a list of legs
 * floating between two unlabelled ends.
 */
function TimelineEndpoint({ name, kind }: { name: string; kind: "origin" | "destination" }) {
  if (name === "") return null
  const isOrigin = kind === "origin"

  return (
    <li className={cn("flex items-center gap-3", isOrigin ? "pb-1" : "pt-1")}>
      <span className="flex w-11 shrink-0 justify-center">
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-full",
            isOrigin
              ? "border-2 border-zinc-400 bg-white dark:border-zinc-500 dark:bg-zinc-900"
              : "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900",
          )}
        >
          {isOrigin ? (
            <span className="size-2 rounded-full bg-zinc-900 dark:bg-zinc-50" aria-hidden />
          ) : (
            <Flag className={ICON.xs} aria-hidden />
          )}
        </span>
      </span>
      <p className="min-w-0 flex-1 truncate text-base font-bold text-zinc-900 dark:text-zinc-50">{name}</p>
    </li>
  )
}

interface StepRowProps {
  step: RouteStep
  index: number
  isExpanded: boolean
  onToggle: () => void
  onShowDriver: () => void
  fareClass: FareClass
  spring: Record<string, unknown>
  exit: Record<string, unknown>
}

function StepRow({ step, index, isExpanded, onToggle, onShowDriver, fareClass, spring, exit }: StepRowProps) {
  const mode = MODE_META[step.mode]
  const panelId = `route-step-panel-${index}`
  const payable = discountedFare(step.fare, fareClass)
  const isWalk = step.mode === "walk"

  return (
    <motion.li layout transition={spring} className="relative flex gap-3">
      {/* The rail. Solid for a ride, dashed for a walk, in that leg's own mode colour, which is
          exactly how the same leg is drawn on the map. */}
      <div className="relative flex w-11 shrink-0 flex-col items-center">
        <span
          className={cn(
            "z-10 flex size-11 items-center justify-center rounded-full ring-1",
            "bg-white dark:bg-zinc-900",
            mode.puck,
          )}
        >
          <mode.Icon className={ICON.md} aria-hidden />
        </span>
        <motion.span
          layout
          aria-hidden
          className={cn(
            "flex-1",
            isWalk ? cn("w-0 border-l-2 border-dashed", mode.railBorder) : cn("w-0.5", mode.rail),
          )}
        />
      </div>

      <div className="min-w-0 flex-1 pb-5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-controls={panelId}
          className={cn(
            "flex min-h-11 w-full items-start gap-3 px-2 py-1.5 text-left",
            RADIUS.control,
            "transition-colors duration-150 hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.04]",
            FOCUS,
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                {VEHICLE_CLASS_LABEL[step.vehicleClass]}
              </span>
              {!isWalk && <PlacardTag text={step.placardText} size="sm" />}
            </span>

            {/* Board and drop-off both live in the collapsed row: scanning the closed timeline
                should already answer "saan ako sasakay, saan ako bababa". */}
            <span className="mt-1.5 block truncate text-base font-bold text-zinc-900 dark:text-zinc-50">
              {isWalk ? "Lakad mula " : "Sakay sa "}
              {step.from}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-200">
              <MapPin className={cn(ICON.xs, "shrink-0 text-zinc-400 dark:text-zinc-500")} aria-hidden />
              <span className="truncate">Baba sa {step.to}</span>
            </span>

            <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
              <span className={cn("px-2 py-0.5 font-semibold tabular-nums ring-1", RADIUS.pill, mode.chip)}>
                {payable === 0 ? "Libre" : formatPeso(payable)}
              </span>
              <span className="tabular-nums">{formatDuration(step.durationMin)}</span>
              <span className="tabular-nums">{formatMeters(step.distanceMeters)}</span>
              {step.viaStops.length > 0 && <span className="tabular-nums">{step.viaStops.length} hinto sa daan</span>}
            </span>
          </span>

          <motion.span
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="mt-1 flex size-6 shrink-0 items-center justify-center text-zinc-400 dark:text-zinc-500"
          >
            <ChevronDown className={ICON.sm} aria-hidden />
          </motion.span>
        </button>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              id={panelId}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: exit }}
              transition={spring}
              className="overflow-hidden"
            >
              <motion.div layout className="mt-2 space-y-2 px-2">
                {/* One grouped block with hairlines instead of four stacked cards. Each of those
                    cards was a border and a shadow spent on content that was never competing. */}
                <div
                  className={cn(
                    "divide-y divide-zinc-900/[0.07] overflow-hidden dark:divide-white/10",
                    RADIUS.control,
                    INSET,
                  )}
                >
                  <DetailRow Icon={Signpost} label={isWalk ? "Saan magsisimula" : "Saan tumayo at maghintay"}>
                    <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">{step.boardingSpot}</p>
                  </DetailRow>

                  {!isWalk && (
                    <DetailRow Icon={mode.Icon} label="Hanapin ang ganitong sasakyan">
                      <PlacardTag text={step.placardText} size="lg" />
                      {step.alternatePlacards.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs text-zinc-600 dark:text-zinc-300">Pwede rin ang ganitong signboard:</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {step.alternatePlacards.map((alternate) => (
                              <PlacardTag key={alternate} text={alternate} size="sm" />
                            ))}
                          </div>
                        </div>
                      )}
                    </DetailRow>
                  )}

                  <DetailRow Icon={MapPin} label="Babaan at landmark">
                    <p className="text-base font-bold leading-snug text-zinc-900 dark:text-zinc-50">{step.to}</p>
                    {step.landmarkCues.length > 0 && (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {step.landmarkCues.map((cue) => (
                          <li
                            key={cue}
                            className={cn(
                              "px-2 py-0.5 text-xs text-zinc-700 ring-1 ring-zinc-900/10",
                              "dark:text-zinc-200 dark:ring-white/10",
                              RADIUS.pill,
                            )}
                          >
                            {cue}
                          </li>
                        ))}
                      </ul>
                    )}
                    {step.viaStops.length > 0 && (
                      <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-200">
                        Dadaan sa {step.viaStops.join(", ")}.
                      </p>
                    )}
                    {!step.landmarkVerified && (
                      <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                        <TriangleAlert className={cn(ICON.xs, "mt-px shrink-0")} aria-hidden />
                        Hindi pa na-verify ang babaan na ito. Tanungin si Manong para sigurado.
                      </p>
                    )}
                  </DetailRow>
                </div>

                {/* The line the commuter says out loud. This one earns its own elevated surface:
                    it is the primary action on the whole card. */}
                <div className={cn("px-3.5 py-3", RADIUS.control, "bg-zinc-900 text-zinc-50 dark:bg-zinc-800")}>
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
                    <Megaphone className={ICON.xs} aria-hidden />
                    Sabihin kay Manong
                  </p>
                  <p className="mt-1.5 text-base leading-snug font-bold">&ldquo;{step.driverPhrase}&rdquo;</p>

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={onShowDriver}
                      className={cn(
                        "flex min-h-11 flex-1 items-center justify-center gap-1.5 px-3 text-sm font-semibold",
                        RADIUS.control,
                        "bg-white/10 hover:bg-white/20",
                        PRESS,
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                      )}
                    >
                      <Megaphone className={ICON.sm} aria-hidden />
                      Ipakita kay Manong
                    </button>
                    <CopyPhraseButton phrase={step.driverPhrase} />
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.li>
  )
}

function DetailRow({ Icon, label, children }: { Icon: LucideIcon; label: string; children: React.ReactNode }) {
  return (
    <div className="px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
        <Icon className={cn(ICON.xs, "text-zinc-400 dark:text-zinc-500")} aria-hidden />
        {label}
      </p>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Trip summary
// ---------------------------------------------------------------------------

interface TripSummaryProps {
  route: RouteResult
  fareClass: FareClass
  payable: number
  origin: string
  destination: string
  totalMeters: number
  onReportIssue?: () => void
  onPlanNewTrip?: () => void
}

/**
 * What the card becomes once the live trip reaches its destination. It answers the two questions a
 * commuter has when they step off: what did that cost, and where do I say the app got it wrong.
 */
function TripSummary({
  route,
  fareClass,
  payable,
  origin,
  destination,
  totalMeters,
  onReportIssue,
  onPlanNewTrip,
}: TripSummaryProps) {
  const fareOption = fareClassOption(fareClass)

  return (
    <div className="px-5 pt-5 pb-5">
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 ring-1 ring-emerald-600/25 dark:bg-emerald-400/15 dark:ring-emerald-400/30">
          <CircleCheck className={cn(ICON.md, "text-emerald-700 dark:text-emerald-300")} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-tight font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Tapos na ang biyahe
          </h2>
          <p className="truncate text-sm text-zinc-600 dark:text-zinc-300">
            {origin} <span aria-hidden>&rarr;</span> {destination}
          </p>
        </div>
      </div>

      <div className={cn("mt-4 px-4 py-3.5", RADIUS.control, INSET)}>
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">Kabuuang pamasahe</p>
        <p className="mt-1 text-[34px] leading-none font-bold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50">
          {formatPeso(payable)}
        </p>
        <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-300">{fareOption.description}</p>
      </div>

      <dl className="mt-4 flex divide-x divide-zinc-900/10 dark:divide-white/10">
        <Stat Icon={Clock} label="Tagal" value={formatDuration(route.totalDurationMin)} first />
        <Stat Icon={Repeat} label="Lipat" value={route.transferCount === 0 ? "Direkta" : `${route.transferCount}x`} />
        <Stat Icon={MapPin} label="Layo" value={formatMeters(totalMeters)} />
      </dl>

      <ul className="mt-4 space-y-1.5">
        {route.steps.map((step, index) => {
          const mode = MODE_META[step.mode]
          return (
            <li
              key={`${step.serviceId}-${index}`}
              className="flex items-center gap-2.5 text-sm text-zinc-700 dark:text-zinc-200"
            >
              <mode.Icon className={cn(ICON.sm, "shrink-0")} style={{ color: mode.hex }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{step.to}</span>
              <span className="shrink-0 font-semibold tabular-nums">
                {step.fare === 0 ? "Libre" : formatPeso(discountedFare(step.fare, fareClass))}
              </span>
            </li>
          )
        })}
      </ul>

      <div className="mt-5 flex flex-col gap-2">
        {onReportIssue !== undefined && (
          <button
            type="button"
            onClick={onReportIssue}
            className={cn(
              "flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-semibold",
              RADIUS.control,
              "bg-zinc-900 text-zinc-50 hover:bg-zinc-800",
              "dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white",
              PRESS,
              FOCUS,
            )}
          >
            <TriangleAlert className={ICON.sm} aria-hidden />
            May mali sa pamasahe o ruta
          </button>
        )}

        {onPlanNewTrip !== undefined && (
          <button
            type="button"
            onClick={onPlanNewTrip}
            className={cn(
              "flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-semibold",
              RADIUS.control,
              "text-zinc-700 ring-1 ring-zinc-900/10 hover:bg-zinc-900/5",
              "dark:text-zinc-200 dark:ring-white/10 dark:hover:bg-white/[0.06]",
              PRESS,
              FOCUS,
            )}
          >
            <RotateCcw className={ICON.sm} aria-hidden />
            Maghanap ng bagong biyahe
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Copy button
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
      aria-label={copied ? "Nakopya ang parirala" : "Kopyahin ang parirala"}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center",
        RADIUS.control,
        "bg-white/10 hover:bg-white/20",
        PRESS,
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
      )}
    >
      {copied ? <Check className={ICON.sm} aria-hidden /> : <Copy className={ICON.sm} aria-hidden />}
    </button>
  )
}

export default RouteResultCard
