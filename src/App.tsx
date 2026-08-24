// CommuTayo MVP shell for the Aguinaldo Highway pilot corridor.
//
// Two layouts, one state tree:
//   Desktop (>= lg) — a fixed planner column (header + search + sakay guide) beside a full-height map.
//   Mobile          — the map fills the screen and the planner rides in a draggable bottom sheet.
//
// Everything the commuter changes (origin, destination, priority, open step) lives here so the map
// and the guide can never disagree about which trip is on screen.

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react"
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
  type PanInfo,
} from "framer-motion"
import { ChevronUp, CircleCheck, CircleX, Megaphone, Moon, RefreshCw, Sun, TriangleAlert, Zap } from "lucide-react"

import CommuterMap from "@/components/CommuterMap"
import RouteEmptyState, { type RouteEmptyReason } from "@/components/RouteEmptyState"
import RouteResultCard from "@/components/RouteResultCard"
import RouteSearch from "@/components/RouteSearch"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { CAVITE_PILOT_NODES, findRoutes, type RoutePriority, type RouteResult } from "@/utils/routingEngine"

// The brief asked for "sm_dasma" -> "lpu_cavite"; the engine's real ids are hyphenated and the
// General Trias stop is "lpu-gentri". These are the same two places, spelled the way the graph does.
const DEFAULT_ORIGIN = "sm-dasma"
const DEFAULT_DEST = "lpu-gentri"

const NODE_NAME = new Map(CAVITE_PILOT_NODES.map((node) => [node.id, node.name]))

/** How much of the bottom sheet stays on screen when it is collapsed. Enough for the search bar. */
const SHEET_PEEK_PX = 228

// ---------------------------------------------------------------------------
// Crowdsourced verification
// ---------------------------------------------------------------------------

type FeedbackKind = "fare-ok" | "fare-changed" | "route-inactive"

interface FeedbackOption {
  id: FeedbackKind
  emoji: string
  label: string
  /** Plain Tagalog line under the label, so the choice needs no explaining. */
  hint: string
  /** Confirmation copy for the toast. */
  toast: string
  /** Ring + wash for the button, and the toast's accent. */
  tone: string
  toastTone: string
  Icon: typeof CircleCheck
}

const FEEDBACK_OPTIONS: FeedbackOption[] = [
  {
    id: "fare-ok",
    emoji: "\u{1F7E2}",
    label: "Tama ang pamasahe",
    hint: "Ganito rin ang binayaran ko kanina.",
    toast: "Salamat! Nadagdagan ang kumpiyansa sa rutang ito.",
    tone: "ring-emerald-500/25 bg-emerald-500/[0.07] hover:bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-300",
    toastTone: "text-emerald-600 dark:text-emerald-400",
    Icon: CircleCheck,
  },
  {
    id: "fare-changed",
    emoji: "\u{26A0}\u{FE0F}",
    label: "Nagbago ang pamasahe",
    hint: "Iba ang siningil sa akin ng drayber.",
    toast: "Naitala ang pagbabago ng pamasahe. Salamat sa ulat!",
    tone: "ring-amber-500/25 bg-amber-500/[0.07] hover:bg-amber-500/[0.12] text-amber-700 dark:text-amber-300",
    toastTone: "text-amber-600 dark:text-amber-400",
    Icon: TriangleAlert,
  },
  {
    id: "route-inactive",
    emoji: "\u{274C}",
    label: "Wala nang ganitong biyahe",
    hint: "Hindi na bumibiyahe ang sasakyang ito.",
    toast: "Naitala na wala nang biyahe rito. Titingnan namin ito.",
    tone: "ring-rose-500/25 bg-rose-500/[0.07] hover:bg-rose-500/[0.12] text-rose-700 dark:text-rose-300",
    toastTone: "text-rose-600 dark:text-rose-400",
    Icon: CircleX,
  },
]

interface ToastState {
  id: number
  message: string
  tone: string
  Icon: typeof CircleCheck
}

// ---------------------------------------------------------------------------
// Small hooks
// ---------------------------------------------------------------------------

const DESKTOP_QUERY = "(min-width: 1024px)"

function subscribeToDesktopQuery(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

/**
 * True from the `lg` breakpoint up. Drives which of the two layouts renders.
 *
 * Read through `useSyncExternalStore` rather than an effect, so the very first render already
 * knows the width instead of flashing the mobile sheet on a desktop screen.
 */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeToDesktopQuery, () => window.matchMedia(DESKTOP_QUERY).matches)
}

function peso(amount: number): string {
  return `₱${amount.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

interface BoundaryProps {
  children: ReactNode
  /** Rendered instead of the children when something below throws. */
  fallback: (retry: () => void) => ReactNode
}

interface BoundaryState {
  hasError: boolean
}

/**
 * Catches render-time crashes from the map and the guide so a bad trip can't blank the whole app.
 * The commuter gets a card they can retry from instead of a white screen.
 */
class AppErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false }

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("CommuTayo render error", error, info.componentStack)
  }

  retry = () => this.setState({ hasError: false })

  render() {
    if (this.state.hasError) return this.props.fallback(this.retry)
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const isDesktop = useIsDesktop()
  const reduceMotion = useReducedMotion()

  const [originId, setOriginId] = useState<string | null>(DEFAULT_ORIGIN)
  const [destId, setDestId] = useState<string | null>(DEFAULT_DEST)
  const [priority, setPriority] = useState<RoutePriority>("fastest")
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null)
  const [isDark, setIsDark] = useState(false)
  const [sheetExpanded, setSheetExpanded] = useState(true)

  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  // Reports are session-only — there is no backend wired up yet, and the dialog says so.
  const [reportedTrips, setReportedTrips] = useState<Record<string, FeedbackKind>>({})

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark)
  }, [isDark])

  // The engine is synchronous and deterministic, so a search is just a memo — there is no real
  // loading state to show. Solving all three priorities at once lets each tab preview its own
  // fare and time. A throw here becomes an empty state instead of a crash.
  const solved = useMemo(() => {
    if (originId === null || destId === null || originId === destId) {
      return { routes: null, failed: false }
    }
    try {
      return { routes: findRoutes(originId, destId), failed: false }
    } catch (error) {
      console.error("CommuTayo routing failed", error)
      return { routes: null, failed: true }
    }
  }, [originId, destId])

  const routes = solved.routes
  const activeRoute: RouteResult | null = routes?.[priority] ?? null
  const tripKey = `${originId ?? "?"}-${destId ?? "?"}`
  const alreadyReported = reportedTrips[tripKey]

  const emptyReason: RouteEmptyReason | null = useMemo(() => {
    if (originId === null || destId === null) return "pick-places"
    if (originId === destId) return "same-place"
    if (activeRoute === null) return "no-route"
    return null
  }, [originId, destId, activeRoute])

  // --------------------------------------------------------------- Trip actions

  const swap = useCallback(() => {
    setOriginId(destId)
    setDestId(originId)
    setActiveStepIndex(null)
  }, [originId, destId])

  const chooseOrigin = useCallback((nodeId: string) => {
    setOriginId(nodeId)
    setActiveStepIndex(null)
  }, [])

  const chooseDest = useCallback((nodeId: string) => {
    setDestId(nodeId)
    setActiveStepIndex(null)
  }, [])

  const choosePriority = useCallback((next: RoutePriority) => {
    setPriority(next)
    setActiveStepIndex(null)
  }, [])

  // The pickers already drive the route as you touch them, so "search" only confirms the trip and
  // collapses any open step. It is the hook the search bar's parsed queries use to set all three
  // values at once — and on mobile it opens the sheet so the steps are immediately readable.
  const search = useCallback((nextOrigin: string, nextDest: string, nextPriority: RoutePriority) => {
    setOriginId(nextOrigin)
    setDestId(nextDest)
    setPriority(nextPriority)
    setActiveStepIndex(null)
    setSheetExpanded(true)
  }, [])

  // --------------------------------------------------------------- Feedback

  const toastTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const submitFeedback = useCallback(
    (option: FeedbackOption) => {
      setReportedTrips((current) => ({ ...current, [tripKey]: option.id }))
      setFeedbackOpen(false)
      setToast({ id: Date.now(), message: option.toast, tone: option.toastTone, Icon: option.Icon })

      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(null), 3600)
    },
    [tripKey]
  )

  // --------------------------------------------------------------- Shared pieces

  const header = (
    <AppHeader
      isDark={isDark}
      onToggleDark={() => setIsDark((current) => !current)}
      onReport={() => setFeedbackOpen(true)}
      canReport={activeRoute !== null}
      reported={alreadyReported !== undefined}
      floating={!isDesktop}
    />
  )

  const planner = (
    <>
      <RouteSearch
        nodes={CAVITE_PILOT_NODES}
        originId={originId}
        destId={destId}
        selectedPriority={priority}
        routes={routes}
        onOriginChange={chooseOrigin}
        onDestChange={chooseDest}
        onSwap={swap}
        onPriorityChange={choosePriority}
        onSearch={search}
      />

      <AnimatePresence mode="wait">
        {activeRoute !== null ? (
          <RouteResultCard
            key={`${tripKey}-${priority}`}
            route={activeRoute}
            onStepSelect={setActiveStepIndex}
            dismissible={!isDesktop}
            onClose={!isDesktop ? () => setSheetExpanded(false) : undefined}
          />
        ) : (
          emptyReason !== null && (
            <RouteEmptyState
              key={emptyReason}
              reason={emptyReason}
              actionLabel={emptyReason === "no-route" ? "Baligtarin ang direksyon" : undefined}
              onAction={emptyReason === "no-route" ? swap : undefined}
            />
          )
        )}
      </AnimatePresence>

      <p className="max-w-md px-2 pb-1 text-center text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
        {solved.failed
          ? "May aberya sa paghahanap ng ruta. Subukan ang ibang tapat o baligtarin ang direksyon."
          : "Ang pamasahe at oras dito ay tantiya mula sa corridor spec, hindi pa sinusukat sa kalsada."}
      </p>
    </>
  )

  const map = (
    <AppErrorBoundary
      fallback={(retry) => (
        <PaneFallback
          title="Hindi ma-load ang mapa"
          body="Nagka-aberya ang mapa. Nandiyan pa rin ang buong sakay guide sa tabi."
          onRetry={retry}
        />
      )}
    >
      <CommuterMap originId={originId} destId={destId} activeRoute={activeRoute} activeStepIndex={activeStepIndex} />
    </AppErrorBoundary>
  )

  // --------------------------------------------------------------- Layouts

  return (
    <div className="bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      {isDesktop ? (
        <div className="grid h-screen w-full grid-cols-[minmax(24rem,28rem)_minmax(0,1fr)]">
          <aside className="flex h-screen min-w-0 flex-col overflow-y-auto border-r border-black/[0.06] bg-zinc-100 dark:border-white/10 dark:bg-zinc-950">
            {header}
            <div className="flex min-w-0 flex-1 flex-col items-center gap-4 px-4 pb-6">{planner}</div>
          </aside>

          <div className="relative h-screen min-w-0">{map}</div>
        </div>
      ) : (
        <div className="relative h-[100dvh] w-full overflow-hidden">
          <div className="absolute inset-0">{map}</div>

          {/* Leaflet's own panes top out around z-index 800, so the chrome sits above 1000. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] px-3 pt-3">{header}</div>

          <MobileSheet expanded={sheetExpanded} onExpandedChange={setSheetExpanded} reduceMotion={reduceMotion === true}>
            <div className="flex min-w-0 flex-col items-center gap-4 px-4 pb-8">{planner}</div>
          </MobileSheet>
        </div>
      )}

      <FeedbackDialog
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        route={activeRoute}
        originName={originId === null ? null : (NODE_NAME.get(originId) ?? originId)}
        destName={destId === null ? null : (NODE_NAME.get(destId) ?? destId)}
        alreadyReported={alreadyReported}
        onSubmit={submitFeedback}
      />

      <ToastBanner toast={toast} reduceMotion={reduceMotion === true} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface AppHeaderProps {
  isDark: boolean
  onToggleDark: () => void
  onReport: () => void
  canReport: boolean
  reported: boolean
  /** Mobile: the bar floats as glass over the map, so it needs its own surface and shadow. */
  floating: boolean
}

function AppHeader({ isDark, onToggleDark, onReport, canReport, reported, floating }: AppHeaderProps) {
  return (
    <header
      className={cn(
        "pointer-events-auto flex w-full items-center gap-2",
        floating
          ? "rounded-3xl bg-zinc-50/85 px-3 py-2.5 ring-1 ring-black/[0.06] backdrop-blur-md shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-16px_rgba(0,0,0,0.3)] dark:bg-zinc-900/80 dark:ring-white/10"
          : "px-4 pt-5 pb-3"
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg leading-tight font-bold tracking-tight">
          Commu<span className="text-emerald-600 dark:text-emerald-400">Tayo</span>
        </h1>
        <span
          className={cn(
            "mt-1 inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5",
            "text-[11px] font-semibold tracking-[0.12em] uppercase",
            "bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/20 dark:text-amber-300 dark:ring-amber-400/25"
          )}
        >
          <Zap className="size-3 shrink-0" aria-hidden />
          <span className="truncate">Aguinaldo Highway Spine</span>
        </span>
      </div>

      <button
        type="button"
        onClick={onReport}
        disabled={!canReport}
        aria-label={reported ? "Report an update again for this route" : "Report an update for this route"}
        className={cn(
          "flex h-11 shrink-0 items-center gap-1.5 rounded-2xl px-3",
          "text-[13px] font-semibold transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
          "disabled:cursor-not-allowed disabled:opacity-40",
          reported
            ? "bg-emerald-500/12 text-emerald-700 ring-1 ring-emerald-500/25 dark:text-emerald-300 dark:ring-emerald-400/25"
            : "bg-zinc-900 text-zinc-50 ring-1 ring-black/[0.06] hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:ring-white/10 dark:hover:bg-white"
        )}
      >
        {reported ? <CircleCheck className="size-4" aria-hidden /> : <Megaphone className="size-4" aria-hidden />}
        <span className="hidden sm:inline">{reported ? "Na-verify" : "Report Update"}</span>
      </button>

      <button
        type="button"
        onClick={onToggleDark}
        aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        aria-pressed={isDark}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-2xl",
          "bg-white/70 text-zinc-600 ring-1 ring-black/[0.06] transition-colors duration-150 hover:text-zinc-900",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20",
          "dark:bg-zinc-900/70 dark:text-zinc-300 dark:ring-white/10 dark:hover:text-zinc-50 dark:focus-visible:ring-white/25"
        )}
      >
        {isDark ? <Sun className="size-5" aria-hidden /> : <Moon className="size-5" aria-hidden />}
      </button>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Mobile bottom sheet
// ---------------------------------------------------------------------------

interface MobileSheetProps {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  reduceMotion: boolean
  children: ReactNode
}

/**
 * A two-position sheet: fully open, or peeking with just the search bar showing.
 *
 * Dragging is bound to the grab handle (`dragListener={false}` + `dragControls`) rather than the
 * whole panel, so scrolling the steps inside — and the route card's own swipe-to-dismiss — never
 * fight the sheet for the same gesture.
 */
function MobileSheet({ expanded, onExpandedChange, reduceMotion, children }: MobileSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragControls = useDragControls()
  const y = useMotionValue(0)
  const [collapsedY, setCollapsedY] = useState(0)

  // Measure the real panel height instead of trusting `vh`: mobile browsers change the viewport as
  // their toolbars slide away, and a stale number would leave the sheet floating or clipped.
  useEffect(() => {
    const element = sheetRef.current
    if (element === null) return
    const measure = () => setCollapsedY(Math.max(0, element.offsetHeight - SHEET_PEEK_PX))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30 }

  const handleDragEnd = (_event: unknown, info: PanInfo) => {
    // Project where the flick is heading rather than reading the finger's last position, so a
    // fast short swipe still lands where the commuter meant it to.
    const projected = y.get() + info.velocity.y * 0.08
    onExpandedChange(projected < collapsedY / 2)
  }

  return (
    <motion.div
      ref={sheetRef}
      style={{ y }}
      animate={{ y: expanded ? 0 : collapsedY }}
      transition={spring}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: collapsedY }}
      dragElastic={{ top: 0.02, bottom: 0.05 }}
      onDragEnd={handleDragEnd}
      aria-label="Trip planner"
      className={cn(
        "absolute inset-x-0 bottom-0 z-[1100] flex h-[86dvh] flex-col overflow-hidden rounded-t-3xl",
        "bg-zinc-50/92 ring-1 ring-black/[0.06] backdrop-blur-md",
        "shadow-[0_-1px_2px_rgba(0,0,0,0.04),0_-16px_40px_-20px_rgba(0,0,0,0.35)]",
        "dark:bg-zinc-900/88 dark:ring-white/10"
      )}
    >
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        onPointerDown={(event) => dragControls.start(event)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse the trip planner" : "Expand the trip planner"}
        className="flex h-11 w-full shrink-0 touch-none items-center justify-center gap-2 active:cursor-grabbing"
      >
        <span className="h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" aria-hidden />
        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }}
          className="text-zinc-400 dark:text-zinc-500"
          aria-hidden
        >
          <ChevronUp className="size-4" />
        </motion.span>
      </button>

      <div className={cn("min-h-0 flex-1 overscroll-contain", expanded ? "overflow-y-auto" : "overflow-hidden")}>
        {children}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Verification dialog
// ---------------------------------------------------------------------------

interface FeedbackDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  route: RouteResult | null
  originName: string | null
  destName: string | null
  alreadyReported: FeedbackKind | undefined
  onSubmit: (option: FeedbackOption) => void
}

function FeedbackDialog({
  open,
  onOpenChange,
  route,
  originName,
  destName,
  alreadyReported,
  onSubmit,
}: FeedbackDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        className="gap-3 rounded-3xl bg-zinc-50 p-5 ring-black/[0.06] sm:max-w-md dark:bg-zinc-900 dark:ring-white/10"
      >
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-tight">Verify Route</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            Isang tap lang. Ang sagot mo ang nagpapatino ng pamasahe para sa susunod na sasakay.
          </DialogDescription>
        </DialogHeader>

        {route !== null && originName !== null && destName !== null && (
          <div className="rounded-2xl bg-zinc-100/80 px-3 py-2.5 ring-1 ring-black/[0.04] dark:bg-zinc-800/60 dark:ring-white/10">
            <p className="truncate text-[13px] font-semibold text-zinc-700 dark:text-zinc-200">
              {originName} <span className="text-zinc-400 dark:text-zinc-500">&rarr;</span> {destName}
            </p>
            <p className="mt-0.5 text-[11px] font-semibold tracking-[0.1em] text-zinc-400 uppercase dark:text-zinc-500">
              {peso(route.totalFare)} &middot; {route.totalDurationMin} min &middot; {route.confidence}% kumpiyansa
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {FEEDBACK_OPTIONS.map((option) => (
            <motion.button
              key={option.id}
              type="button"
              whileTap={{ scale: 0.985 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              onClick={() => onSubmit(option)}
              className={cn(
                "flex min-h-14 w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left",
                "ring-1 transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2",
                option.tone,
                alreadyReported === option.id && "ring-2"
              )}
            >
              <span className="text-lg leading-none" aria-hidden>
                {option.emoji}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{option.label}</span>
                <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{option.hint}</span>
              </span>
              {alreadyReported === option.id && <CircleCheck className="size-4 shrink-0" aria-hidden />}
            </motion.button>
          ))}
        </div>

        <p className="text-center text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          Sa session mo lang naitatabi ang ulat sa ngayon &mdash; wala pang server na pinapadalhan.
        </p>

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className={cn(
            "h-11 w-full rounded-2xl text-sm font-semibold",
            "bg-zinc-200/70 text-zinc-700 transition-colors duration-150 hover:bg-zinc-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20",
            "dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:focus-visible:ring-white/25"
          )}
        >
          Hindi muna
        </button>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Toast + fallback
// ---------------------------------------------------------------------------

function ToastBanner({ toast, reduceMotion }: { toast: ToastState | null; reduceMotion: boolean }) {
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30 }
  const exit = reduceMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" as const }

  return (
    <AnimatePresence>
      {toast !== null && (
        <motion.div
          key={toast.id}
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98, transition: exit }}
          transition={spring}
          className={cn(
            "fixed top-24 left-1/2 z-[1200] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-2.5",
            "rounded-2xl px-3.5 py-3 lg:top-6",
            "bg-zinc-50/95 ring-1 ring-black/[0.06] backdrop-blur-md",
            "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-20px_rgba(0,0,0,0.4)]",
            "dark:bg-zinc-900/95 dark:ring-white/10"
          )}
        >
          <toast.Icon className={cn("size-5 shrink-0", toast.tone)} aria-hidden />
          <p className="text-[13px] leading-snug font-medium text-zinc-700 dark:text-zinc-200">{toast.message}</p>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function PaneFallback({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-3xl bg-zinc-50/90 p-5 text-center ring-1 ring-black/[0.06] backdrop-blur-md dark:bg-zinc-900/85 dark:ring-white/10">
        <TriangleAlert className="mx-auto size-6 text-amber-500" aria-hidden />
        <h2 className="mt-3 text-sm font-bold tracking-tight text-zinc-800 dark:text-zinc-100">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{body}</p>
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "mt-4 inline-flex h-11 items-center gap-1.5 rounded-2xl px-4 text-sm font-semibold",
            "bg-zinc-900 text-zinc-50 transition-colors duration-150 hover:bg-zinc-800",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20",
            "dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white dark:focus-visible:ring-white/25"
          )}
        >
          <RefreshCw className="size-4" aria-hidden />
          Subukan ulit
        </button>
      </div>
    </div>
  )
}

export default App
