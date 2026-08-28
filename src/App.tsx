// CommuTayo MVP shell for the Aguinaldo Highway pilot corridor.
//
// Two layouts, one state tree:
//   Desktop (>= lg) a fixed planner column (header, search, ride guide) beside a full-height map.
//   Mobile          the map fills the screen and the planner rides in a draggable bottom sheet.
//
// Everything the commuter changes (origin, destination, priority, open step, live trip) lives here
// so the map and the guide can never disagree about which trip is on screen.

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
import {
  ChevronUp,
  CircleCheck,
  CircleX,
  Flag,
  LoaderCircle,
  MapPin,
  Megaphone,
  Moon,
  Navigation,
  RefreshCw,
  Square,
  Sun,
  TriangleAlert,
  Zap,
} from "lucide-react"

import CommuterMap from "@/components/CommuterMap"
import PlacardTag from "@/components/PlacardTag"
import RouteEmptyState, { type RouteEmptyReason } from "@/components/RouteEmptyState"
import RouteResultCard from "@/components/RouteResultCard"
import RouteSearch from "@/components/RouteSearch"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useDynamicTransitNetwork } from "@/hooks/useDynamicTransitNetwork"
import { useGeolocation, type GeolocationStatus } from "@/hooks/useGeolocation"
import {
  useTripProgress,
  vibrateArrivalPattern,
  type ProximityEvent,
  type TripProgress,
} from "@/hooks/useTripProgress"
import { cn } from "@/lib/utils"
import { DYNAMIC_NETWORK_ENABLED, selectableNodes } from "@/utils/dynamicRoutingEngine"
import { formatPeso } from "@/utils/fares"
import {
  FOCUS,
  GLASS,
  GLASS_STRONG,
  ICON,
  INSET,
  MODE_META,
  PRESS,
  RADIUS,
  Z,
  formatDuration,
  formatMeters,
} from "@/utils/presentation"
import CAVITE_PILOT_NETWORK, {
  CAVITE_PILOT_NODES,
  findRoute,
  type RoutePriority,
  type RouteResult,
  type TransitNetwork,
} from "@/utils/routingEngine"

// Only meaningful against the pilot corridor: these are hand-authored node ids, and the Cavite-wide
// network keys stops by UUID, where no such id exists. Dynamic mode opens with nothing picked and
// leans on the "pick-places" empty state, rather than inventing a default trip from imported data.
const DEFAULT_ORIGIN = DYNAMIC_NETWORK_ENABLED ? null : "sm-dasma"
const DEFAULT_DEST = DYNAMIC_NETWORK_ENABLED ? null : "lpu-gentri"

/** How much of the bottom sheet stays on screen when it is collapsed. Enough for the search bar. */
const SHEET_PEEK_PX = 236

// ---------------------------------------------------------------------------
// Crowdsourced verification
// ---------------------------------------------------------------------------

type FeedbackKind = "fare-ok" | "fare-changed" | "route-inactive"

interface FeedbackOption {
  id: FeedbackKind
  label: string
  /** Plain line under the label, so the choice needs no explaining. */
  hint: string
  /** Confirmation copy for the toast. */
  toast: string
  /** Ring and wash for the button. */
  tone: string
  toastTone: string
  Icon: typeof CircleCheck
}

const FEEDBACK_OPTIONS: FeedbackOption[] = [
  {
    id: "fare-ok",
    label: "The fare was right",
    hint: "This is what I paid too.",
    toast: "Thanks. This route is now a little more trusted.",
    tone: "ring-emerald-600/25 bg-emerald-500/[0.07] hover:bg-emerald-500/[0.12] text-emerald-800 dark:text-emerald-300",
    toastTone: "text-emerald-700 dark:text-emerald-400",
    Icon: CircleCheck,
  },
  {
    id: "fare-changed",
    label: "The fare has changed",
    hint: "The driver charged me something different.",
    toast: "Fare change recorded. Thanks for the report.",
    tone: "ring-amber-600/25 bg-amber-500/[0.07] hover:bg-amber-500/[0.12] text-amber-800 dark:text-amber-300",
    toastTone: "text-amber-700 dark:text-amber-400",
    Icon: TriangleAlert,
  },
  {
    id: "route-inactive",
    label: "This ride no longer runs",
    hint: "This vehicle does not travel here any more.",
    toast: "Recorded as no longer running. We will look into it.",
    tone: "ring-rose-600/25 bg-rose-500/[0.07] hover:bg-rose-500/[0.12] text-rose-800 dark:text-rose-300",
    toastTone: "text-rose-700 dark:text-rose-400",
    Icon: CircleX,
  },
]

/**
 * `alert` is the high-contrast treatment, and it is spent on exactly one thing: the 250 m warning
 * that a drop-off is coming up. Everything else is a quiet `info` banner, so when the loud one
 * appears it still means something.
 */
type ToastKind = "info" | "alert" | "celebration"

interface ToastState {
  id: number
  message: string
  /** Optional second line, used for the alert's distance and the arrival's closing note. */
  detail?: string
  tone: string
  Icon: typeof CircleCheck
  kind: ToastKind
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
 * Read through `useSyncExternalStore` rather than an effect, so the very first render already knows
 * the width instead of flashing the mobile sheet on a desktop screen.
 */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeToDesktopQuery, () => window.matchMedia(DESKTOP_QUERY).matches)
}

/** Starts from the device's own setting rather than assuming light, then follows the manual toggle. */
function prefersDark(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
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

  // Off by default. With VITE_USE_DYNAMIC_NETWORK unset this stays "disabled", never touches
  // Supabase, and every line below falls through to the pilot corridor exactly as before.
  const dynamic = useDynamicTransitNetwork()
  const network: TransitNetwork | null = DYNAMIC_NETWORK_ENABLED ? dynamic.network : CAVITE_PILOT_NETWORK

  // What the pickers offer. The full node list would include unnamed OSM nodes and stops no vehicle
  // serves, which are legitimate graph members but not choosable endpoints -- see selectableNodes.
  const placeNodes = useMemo(() => {
    if (!DYNAMIC_NETWORK_ENABLED) return CAVITE_PILOT_NODES
    return network === null ? [] : selectableNodes(network)
  }, [network])

  const nodeNameById = useMemo(
    () => new Map((network?.nodes ?? []).map((node) => [node.id, node.name])),
    [network]
  )

  const [originId, setOriginId] = useState<string | null>(DEFAULT_ORIGIN)
  const [destId, setDestId] = useState<string | null>(DEFAULT_DEST)
  const [priority, setPriority] = useState<RoutePriority>("fastest")
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null)
  const [isDark, setIsDark] = useState(prefersDark)
  const [sheetExpanded, setSheetExpanded] = useState(true)
  const [tripCompleted, setTripCompleted] = useState(false)

  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  // Reports are session-only. There is no backend wired up yet, and the dialog says so.
  const [reportedTrips, setReportedTrips] = useState<Record<string, FeedbackKind>>({})

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark)
  }, [isDark])

  // Once the graph is in memory the engine is synchronous and deterministic, so a search is just a
  // memo -- the only wait in the whole app is the one-off network load, not the solve. Solving all
  // three priorities at once lets each tab preview its own fare and time. A throw here becomes an
  // empty state instead of a crash.
  const solved = useMemo(() => {
    if (network === null || originId === null || destId === null || originId === destId) {
      return { routes: null, failed: false }
    }
    try {
      return {
        routes: {
          cheapest: findRoute(network, originId, destId, "cheapest"),
          fastest: findRoute(network, originId, destId, "fastest"),
          easiest: findRoute(network, originId, destId, "easiest"),
        },
        failed: false,
      }
    } catch (error) {
      console.error("CommuTayo routing failed", error)
      return { routes: null, failed: true }
    }
  }, [network, originId, destId])

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
  // values at once, and on mobile it opens the sheet so the steps are immediately readable.
  const search = useCallback((nextOrigin: string, nextDest: string, nextPriority: RoutePriority) => {
    setOriginId(nextOrigin)
    setDestId(nextDest)
    setPriority(nextPriority)
    setActiveStepIndex(null)
    setSheetExpanded(true)
  }, [])

  // --------------------------------------------------------------- Feedback and toasts

  const toastTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const showToast = useCallback((next: ToastState, durationMs: number) => {
    setToast(next)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), durationMs)
  }, [])

  const submitFeedback = useCallback(
    (option: FeedbackOption) => {
      setReportedTrips((current) => ({ ...current, [tripKey]: option.id }))
      setFeedbackOpen(false)
      showToast({ id: Date.now(), message: option.toast, tone: option.toastTone, Icon: option.Icon, kind: "info" }, 3600)
    },
    [tripKey, showToast]
  )

  // --------------------------------------------------------------- Live trip tracking
  //
  // "Start" turns on the browser's GPS watch. useTripProgress projects each fix onto the active
  // route so the map can redraw the ridden portion as done, and raises the three proximity moments
  // below. The 250 m warning is the one that buzzes the phone: it is the only alert that arrives
  // while there is still time to act on it.

  const geo = useGeolocation()
  const isTracking = geo.status === "requesting" || geo.status === "active"

  const handleProximity = useCallback(
    (event: ProximityEvent) => {
      if (event.kind === "approaching") {
        vibrateArrivalPattern()
        showToast(
          {
            id: Date.now(),
            message: `Your stop is coming up: ${event.placeName}`,
            detail: `About ${event.minutes} min away, ${formatMeters(event.distanceMeters)} to go. Get ready to get off.`,
            tone: "text-amber-300",
            Icon: TriangleAlert,
            kind: "alert",
          },
          6000
        )
        return
      }

      if (event.kind === "arrived") {
        showToast(
          {
            id: Date.now(),
            message: `You are at ${event.placeName}.`,
            tone: "text-sky-700 dark:text-sky-400",
            Icon: MapPin,
            kind: "info",
          },
          3600
        )
        return
      }

      // Reaching the destination ends the ride: stop draining the GPS and flip the card to its
      // summary, which is the only screen that can still be useful at this point.
      vibrateArrivalPattern()
      setTripCompleted(true)
      geo.stop()
      showToast(
        {
          id: Date.now(),
          message: `You have arrived at ${event.placeName}.`,
          detail: "Your trip summary is below.",
          tone: "text-emerald-700 dark:text-emerald-400",
          Icon: Flag,
          kind: "celebration",
        },
        5200
      )
    },
    [geo, showToast]
  )

  const progress = useTripProgress(activeRoute, geo.fix, handleProximity)

  // Changing the trip mid-track is a fresh trip: stop watching and clear the summary rather than
  // silently keep tracking toward a stop the commuter no longer cares about.
  useEffect(() => {
    setTripCompleted(false)
    if (isTracking) geo.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripKey, priority])

  const planNewTrip = useCallback(() => {
    setTripCompleted(false)
    setActiveStepIndex(null)
    setSheetExpanded(true)
  }, [])

  // --------------------------------------------------------------- Shared pieces

  const networkLoading = DYNAMIC_NETWORK_ENABLED && dynamic.status === "loading"
  const networkFailed = DYNAMIC_NETWORK_ENABLED && dynamic.status === "error"

  const header = (
    <AppHeader
      isDark={isDark}
      onToggleDark={() => setIsDark((current) => !current)}
      onReport={() => setFeedbackOpen(true)}
      canReport={activeRoute !== null}
      reported={alreadyReported !== undefined}
      floating={!isDesktop}
      scopeLabel={
        DYNAMIC_NETWORK_ENABLED
          ? networkLoading
            ? "Loading the network"
            : `All of Cavite · ${placeNodes.length} stops`
          : "Aguinaldo Highway spine"
      }
    />
  )

  const planner = networkFailed ? (
    <NetworkStateCard
      title="Could not load the route network"
      body="We could not reach the stop and route database. Check your connection, then try again."
      detail={dynamic.error?.message}
      onRetry={dynamic.reload}
    />
  ) : networkLoading ? (
    <NetworkStateCard
      loading
      title="Getting all of Cavite ready"
      body="Loading stops, routes and roads from the database. This happens once each time you open the app."
    />
  ) : (
    <>
      <RouteSearch
        nodes={placeNodes}
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
            completed={tripCompleted}
            onReportIssue={() => setFeedbackOpen(true)}
            onPlanNewTrip={planNewTrip}
          />
        ) : (
          emptyReason !== null && (
            <RouteEmptyState
              key={emptyReason}
              reason={emptyReason}
              actionLabel={emptyReason === "no-route" ? "Swap the direction" : undefined}
              onAction={emptyReason === "no-route" ? swap : undefined}
            />
          )
        )}
      </AnimatePresence>

      {activeRoute !== null && !tripCompleted && (
        <TripTrackingBar
          route={activeRoute}
          geoStatus={geo.status}
          progress={progress}
          onStart={geo.start}
          onStop={geo.stop}
        />
      )}

      <p className="max-w-md px-2 pb-1 text-center text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        {solved.failed
          ? "Something went wrong while searching. Try another stop, or swap the direction."
          : DYNAMIC_NETWORK_ENABLED
            ? "Routes and stops here come from OpenStreetMap. Fares and times are estimates, and none of it has been surveyed on the road yet."
            : "Fares, times and signboards here are estimated from the corridor spec. None of it has been surveyed on the road yet."}
      </p>
    </>
  )

  const map = (
    <AppErrorBoundary
      fallback={(retry) => (
        <PaneFallback
          title="The map could not load"
          body="Something went wrong with the map. The full ride guide is still here beside it."
          onRetry={retry}
        />
      )}
    >
      <CommuterMap
        originId={originId}
        destId={destId}
        activeRoute={activeRoute}
        activeStepIndex={activeStepIndex}
        isDark={isDark}
        userFix={geo.fix}
        progress={progress}
        tracking={isTracking}
        nodes={network?.nodes ?? []}
      />

      {/* The map is real but empty until the network lands, which without a word on it reads as a
          broken map rather than a loading one. */}
      {networkLoading && (
        <div className={cn("pointer-events-none absolute inset-x-0 top-4 flex justify-center", Z.header)}>
          <span
            className={cn(
              "pointer-events-auto flex items-center gap-2 px-3.5 py-2 text-xs font-semibold",
              RADIUS.pill,
              GLASS_STRONG,
              "text-zinc-700 dark:text-zinc-200"
            )}
          >
            <LoaderCircle className={cn(ICON.xs, "animate-spin motion-reduce:animate-none")} aria-hidden />
            Loading stops
          </span>
        </div>
      )}
    </AppErrorBoundary>
  )

  // --------------------------------------------------------------- Layouts

  return (
    <div className="bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      {isDesktop ? (
        <div className="relative h-screen w-full overflow-hidden">
          <div className="absolute inset-0">{map}</div>

          {/* Floats over the map with a margin on every side, the same glass treatment the mobile
              sheet uses, rather than a rigid sidebar that touches three edges of the screen. */}
          <div className={cn("pointer-events-none absolute inset-y-4 left-4 flex w-full max-w-md flex-col", Z.header)}>
            <div className={cn("pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden", RADIUS.panel, GLASS_STRONG)}>
              {header}
              <div className="min-w-0 flex-1 overflow-y-auto">
                <div className="flex min-w-0 flex-col items-center gap-4 px-4 pb-6">{planner}</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative h-[100dvh] w-full overflow-hidden">
          <div className="absolute inset-0">{map}</div>

          {/* Leaflet's own panes top out around z-index 800, so the chrome sits above 1000. The
              insets keep the bar clear of a notch and of a landscape camera cutout. */}
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0",
              Z.header,
              "px-[max(0.75rem,env(safe-area-inset-left))] pt-[max(0.75rem,env(safe-area-inset-top))]"
            )}
          >
            {header}
          </div>

          <MobileSheet
            expanded={sheetExpanded}
            onExpandedChange={setSheetExpanded}
            reduceMotion={reduceMotion === true}
            peek={
              activeRoute !== null && originId !== null && destId !== null ? (
                <SheetPeekSummary
                  route={activeRoute}
                  originName={nodeNameById.get(originId) ?? originId}
                  destName={nodeNameById.get(destId) ?? destId}
                />
              ) : null
            }
          >
            <div className="flex min-w-0 flex-col items-center gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
              {planner}
            </div>
          </MobileSheet>
        </div>
      )}

      <FeedbackDialog
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        route={activeRoute}
        originName={originId === null ? null : (nodeNameById.get(originId) ?? originId)}
        destName={destId === null ? null : (nodeNameById.get(destId) ?? destId)}
        alreadyReported={alreadyReported}
        onSubmit={submitFeedback}
      />

      <ToastBanner toast={toast} reduceMotion={reduceMotion === true} onDismiss={() => setToast(null)} />
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
  /** What network is loaded, in the badge under the wordmark. */
  scopeLabel: string
}

function AppHeader({ isDark, onToggleDark, onReport, canReport, reported, floating, scopeLabel }: AppHeaderProps) {
  return (
    <header
      className={cn(
        "pointer-events-auto flex w-full items-center gap-2",
        floating ? cn("px-3 py-2.5", RADIUS.panel, GLASS_STRONG) : "px-4 pt-5 pb-3"
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg leading-tight font-bold tracking-tight">
          Commu<span className="text-emerald-700 dark:text-emerald-400">Tayo</span>
        </h1>
        <span
          className={cn(
            "mt-1 inline-flex max-w-full items-center gap-1.5 px-2 py-0.5 text-xs font-medium",
            RADIUS.pill,
            "bg-amber-500/10 text-amber-800 ring-1 ring-amber-600/20 dark:text-amber-300 dark:ring-amber-400/25"
          )}
        >
          <Zap className={cn(ICON.xs, "shrink-0")} aria-hidden />
          <span className="truncate">{scopeLabel}</span>
        </span>
      </div>

      <button
        type="button"
        onClick={onReport}
        disabled={!canReport}
        aria-label={reported ? "Report on this route again" : "Report an update on this route"}
        className={cn(
          // min-w-11 matters below `sm`, where the label hides and the button would otherwise
          // shrink to its icon plus padding, landing at 40px against a 44px minimum.
          "flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 px-3 text-sm font-semibold",
          RADIUS.control,
          PRESS,
          FOCUS,
          "disabled:cursor-not-allowed disabled:opacity-40",
          reported
            ? "bg-emerald-500/12 text-emerald-800 ring-1 ring-emerald-600/25 dark:text-emerald-300 dark:ring-emerald-400/30"
            : "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white"
        )}
      >
        {reported ? <CircleCheck className={ICON.sm} aria-hidden /> : <Megaphone className={ICON.sm} aria-hidden />}
        <span className="hidden sm:inline">{reported ? "Reported" : "Report"}</span>
      </button>

      <button
        type="button"
        onClick={onToggleDark}
        aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        aria-pressed={isDark}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center",
          RADIUS.control,
          "bg-white/70 text-zinc-700 ring-1 ring-zinc-900/[0.07] hover:text-zinc-900",
          "dark:bg-zinc-900/70 dark:text-zinc-200 dark:ring-white/10 dark:hover:text-zinc-50",
          PRESS,
          FOCUS
        )}
      >
        {isDark ? <Sun className={ICON.md} aria-hidden /> : <Moon className={ICON.md} aria-hidden />}
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
  /** Shown instead of `children` while collapsed, if given -- a compact fare/time summary rather
   *  than a cut-off search form. Null falls back to peeking at `children` itself (the empty-trip
   *  state, where there's nothing to summarize yet). */
  peek?: ReactNode
  children: ReactNode
}

/**
 * A two-position sheet: fully open, or peeking with just the search bar showing.
 *
 * Dragging is bound to the grab handle (`dragListener={false}` plus `dragControls`) rather than the
 * whole panel, so scrolling the steps inside, and the route card's own swipe-to-dismiss, never
 * fight the sheet for the same gesture. The handle is also a real button, so the sheet is fully
 * operable without ever performing a drag.
 */
function MobileSheet({ expanded, onExpandedChange, reduceMotion, peek = null, children }: MobileSheetProps) {
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
    // Project where the flick is heading rather than reading the finger's last position, so a fast
    // short swipe still lands where the commuter meant it to.
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
        "absolute inset-x-0 bottom-0 flex h-[86dvh] flex-col overflow-hidden rounded-t-3xl",
        Z.sheet,
        GLASS_STRONG
      )}
    >
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        onPointerDown={(event) => dragControls.start(event)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse the trip planner" : "Open the trip planner"}
        className={cn("flex h-11 w-full shrink-0 touch-none items-center justify-center gap-2 active:cursor-grabbing", FOCUS)}
      >
        <span className="h-1.5 w-10 rounded-full bg-zinc-400/50 dark:bg-zinc-600" aria-hidden />
        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }}
          className="text-zinc-500 dark:text-zinc-400"
          aria-hidden
        >
          <ChevronUp className={ICON.sm} />
        </motion.span>
      </button>

      <div className={cn("relative min-h-0 flex-1 overscroll-contain", expanded ? "overflow-y-auto" : "overflow-hidden")}>
        {/* Collapsed with a route on hand: a tap target showing what the full form is hidden
            behind, instead of whatever happened to land in the form's first 236px. The form
            itself stays mounted (just visually swapped out) so its state survives the toggle. */}
        {!expanded && peek !== null && (
          <button
            type="button"
            onClick={() => onExpandedChange(true)}
            aria-label="Open the trip planner"
            className={cn("absolute inset-x-0 top-0 z-10 text-left", FOCUS)}
          >
            {peek}
          </button>
        )}
        <div className={!expanded && peek !== null ? "invisible" : undefined}>{children}</div>
      </div>
    </motion.div>
  )
}

interface SheetPeekSummaryProps {
  route: RouteResult
  originName: string
  destName: string
}

/** The sheet's collapsed face once a route exists: total fare, total time, transfer count, and a
 *  puck per vehicle mode actually ridden -- everything a glance needs before tapping to expand. */
function SheetPeekSummary({ route, originName, destName }: SheetPeekSummaryProps) {
  const modesRidden = Array.from(new Set(route.steps.map((step) => step.mode)))

  return (
    <div className="flex w-full items-center gap-3 px-4 pb-4">
      <div className="flex -space-x-2">
        {modesRidden.map((mode) => {
          const meta = MODE_META[mode]
          return (
            <span
              key={mode}
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-full ring-2 ring-white dark:ring-zinc-900",
                meta.puck
              )}
            >
              <meta.Icon className={ICON.sm} aria-hidden />
            </span>
          )
        })}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-zinc-900 dark:text-zinc-50">
          {originName} <span className="text-zinc-500 dark:text-zinc-400">&rarr;</span> {destName}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs font-semibold text-zinc-600 dark:text-zinc-300">
          <span className="truncate">
            {formatPeso(route.totalFare)} &middot; {formatDuration(route.totalDurationMin)}
          </span>
          <span
            className={cn(
              "shrink-0 px-1.5 py-0.5 text-[11px] font-semibold ring-1",
              RADIUS.pill,
              "bg-zinc-900/5 text-zinc-600 ring-zinc-900/10 dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10"
            )}
          >
            {route.transferCount === 0 ? "Direct" : `${route.transferCount} transfer${route.transferCount > 1 ? "s" : ""}`}
          </span>
        </p>
      </div>
      <ChevronUp className={cn(ICON.sm, "shrink-0 text-zinc-400 dark:text-zinc-500")} aria-hidden />
    </div>
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
        className={cn("gap-3 bg-zinc-50 p-5 ring-zinc-900/[0.07] sm:max-w-md dark:bg-zinc-900 dark:ring-white/10", RADIUS.panel)}
      >
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-tight">Check this route</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            One tap. Your answer is what keeps the fares honest for the next commuter.
          </DialogDescription>
        </DialogHeader>

        {route !== null && originName !== null && destName !== null && (
          <div className={cn("px-3.5 py-3", RADIUS.control, INSET)}>
            <p className="truncate text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              {originName} <span className="text-zinc-600 dark:text-zinc-300">&rarr;</span> {destName}
            </p>
            <p className="mt-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
              {formatPeso(route.totalFare)} &middot; {formatDuration(route.totalDurationMin)}
            </p>
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{route.confidence}% verified</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {FEEDBACK_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onSubmit(option)}
              className={cn(
                "flex min-h-14 w-full items-center gap-3 px-3.5 py-2.5 text-left ring-1",
                RADIUS.control,
                PRESS,
                FOCUS,
                option.tone,
                alreadyReported === option.id && "ring-2"
              )}
            >
              <option.Icon className={cn(ICON.md, "shrink-0")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{option.label}</span>
                <span className="block truncate text-xs text-zinc-600 dark:text-zinc-300">{option.hint}</span>
              </span>
              {alreadyReported === option.id && <CircleCheck className={cn(ICON.sm, "shrink-0")} aria-hidden />}
            </button>
          ))}
        </div>

        <p className="text-center text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
          Reports are kept only in this session for now. There is no server receiving them yet.
        </p>

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className={cn(
            "h-11 w-full text-sm font-semibold",
            RADIUS.control,
            "bg-zinc-200/70 text-zinc-800 hover:bg-zinc-200",
            "dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700",
            PRESS,
            FOCUS
          )}
        >
          Not now
        </button>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Live trip tracking bar
// ---------------------------------------------------------------------------

const GEO_STATUS_COPY: Partial<Record<GeolocationStatus, string>> = {
  denied: "Location access is blocked. Allow it in your browser settings to use live tracking.",
  unsupported: "This browser does not support live GPS tracking.",
  error: "Something went wrong getting your location. Try again.",
}

interface TripTrackingBarProps {
  route: RouteResult
  geoStatus: GeolocationStatus
  progress: TripProgress | null
  onStart: () => void
  onStop: () => void
}

/**
 * A persistent strip under the ride guide: start and stop live GPS tracking, see how far to the
 * next drop-off, and, the thing a commuter actually scans for on a moving road, which signboard to
 * be watching for right now. Separate from RouteResultCard because tracking is a device concern
 * (permissions, a live watch) that outlives any one step being expanded or collapsed.
 */
function TripTrackingBar({ route, geoStatus, progress, onStart, onStop }: TripTrackingBarProps) {
  const isActive = geoStatus === "requesting" || geoStatus === "active"
  const isWaitingForFix = isActive && progress === null
  const currentStep = progress !== null ? route.steps[progress.stepIndex] : null
  const statusCopy = GEO_STATUS_COPY[geoStatus]

  return (
    <div className={cn("w-full max-w-md p-3.5", RADIUS.panel, GLASS)}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {statusCopy !== undefined && (
            <p className="text-xs leading-relaxed font-medium text-rose-700 dark:text-rose-400">{statusCopy}</p>
          )}

          {statusCopy === undefined && !isActive && (
            <p className="text-xs leading-relaxed font-medium text-zinc-600 dark:text-zinc-300">
              Turn on GPS to see where you are along the route, and to get a warning before your stop.
            </p>
          )}

          {/* A real pending state rather than a dead panel: the first GPS fix can take many
              seconds, and silence during that wait reads as a broken button. */}
          {statusCopy === undefined && isWaitingForFix && (
            <p className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
              <LoaderCircle className={cn(ICON.xs, "animate-spin motion-reduce:animate-none")} aria-hidden />
              Finding your location
            </p>
          )}

          {statusCopy === undefined && isActive && progress !== null && currentStep !== null && (
            <>
              <p className="truncate text-sm font-bold text-zinc-900 dark:text-zinc-50">
                {progress.onRoute ? `Heading to ${currentStep.to}` : "You are off the route"}
              </p>
              <p className="text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                {progress.onRoute
                  ? `${formatMeters(progress.distanceToStepEndMeters)} to your next stop`
                  : "Try to get back onto the route"}
              </p>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={isActive ? onStop : onStart}
          aria-pressed={isActive}
          className={cn(
            "flex min-h-11 shrink-0 items-center gap-1.5 px-3.5 text-sm font-semibold",
            RADIUS.control,
            PRESS,
            FOCUS,
            isActive
              ? "bg-rose-500/12 text-rose-800 ring-1 ring-rose-600/25 hover:bg-rose-500/20 dark:text-rose-300 dark:ring-rose-400/30"
              : "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white"
          )}
        >
          {isActive ? <Square className={ICON.sm} aria-hidden /> : <Navigation className={ICON.sm} aria-hidden />}
          {isActive ? "Stop" : "Start"}
        </button>
      </div>

      {/* The one thing worth scanning a moving road for: what is painted on the vehicle. */}
      {isActive && currentStep !== null && currentStep.mode !== "walk" && (
        <div className={cn("mt-3 flex flex-wrap items-center gap-2 px-3 py-2.5", RADIUS.control, INSET)}>
          {(() => {
            const meta = MODE_META[currentStep.mode]
            return (
              <>
                <meta.Icon className={cn(ICON.sm, "shrink-0")} style={{ color: meta.hex }} aria-hidden />
                <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">Look for:</span>
                <PlacardTag text={currentStep.placardText} size="sm" />
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toast and fallback
// ---------------------------------------------------------------------------

function ToastBanner({
  toast,
  reduceMotion,
  onDismiss,
}: {
  toast: ToastState | null
  reduceMotion: boolean
  onDismiss: () => void
}) {
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30 }
  const exit = reduceMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" as const }
  const isCelebration = toast?.kind === "celebration"
  const isAlert = toast?.kind === "alert"

  return (
    <AnimatePresence>
      {toast !== null && (
        <motion.div
          key={toast.id}
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98, transition: exit }}
          transition={spring}
          className={cn(
            "fixed left-1/2 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2",
            "top-[max(6rem,calc(env(safe-area-inset-top)+5.5rem))] lg:top-6",
            Z.toast,
            RADIUS.control,
            // The 250 m warning gets a near-black card with an amber rule so it reads at a glance
            // in direct sunlight through a jeepney window. Everything else stays a quiet glass pill.
            isAlert
              ? "border-l-4 border-amber-400 bg-zinc-950/95 text-zinc-50 shadow-2xl shadow-black/50 backdrop-blur-xl"
              : cn(GLASS_STRONG, "text-zinc-900 dark:text-zinc-50"),
            isCelebration ? "flex flex-col items-center gap-1.5 px-5 py-5 text-center" : "flex items-start gap-2.5 px-3.5 py-3"
          )}
        >
          <span
            className={cn(
              "flex shrink-0 items-center justify-center",
              isCelebration &&
                "size-11 rounded-full bg-emerald-500/12 ring-1 ring-emerald-600/25 dark:bg-emerald-400/15 dark:ring-emerald-400/30"
            )}
          >
            <toast.Icon className={cn(ICON.md, "shrink-0", toast.tone)} aria-hidden />
          </span>

          <div className={cn("min-w-0", isCelebration ? "" : "flex-1")}>
            <p
              className={cn(
                isCelebration ? "text-base font-bold" : isAlert ? "text-sm leading-snug font-bold" : "text-sm leading-snug font-medium"
              )}
            >
              {toast.message}
            </p>
            {toast.detail !== undefined && (
              <p
                className={cn(
                  "mt-1 text-xs leading-relaxed",
                  isAlert ? "text-zinc-300" : "text-zinc-600 dark:text-zinc-300"
                )}
              >
                {toast.detail}
              </p>
            )}
          </div>

          {/* A toast that buzzes the phone needs a way to be put away on purpose. */}
          {!isCelebration && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss this notice"
              className={cn(
                "-my-1 -mr-1.5 flex size-11 shrink-0 items-center justify-center",
                RADIUS.pill,
                isAlert ? "text-zinc-400 hover:text-zinc-50" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50",
                PRESS,
                FOCUS
              )}
            >
              <CircleX className={ICON.sm} aria-hidden />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * The planner's stand-in while the Cavite-wide network is loading, or after it failed. Occupies the
 * same slot and width as RouteSearch so the column doesn't jump when the real controls arrive.
 */
function NetworkStateCard({
  title,
  body,
  detail,
  loading = false,
  onRetry,
}: {
  title: string
  body: string
  /** The raw failure message, kept small and secondary -- useful in dev, ignorable otherwise. */
  detail?: string
  loading?: boolean
  onRetry?: () => void
}) {
  return (
    <div className={cn("w-full max-w-md p-5", RADIUS.panel, GLASS)} role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        {loading ? (
          <LoaderCircle
            className={cn(ICON.md, "mt-0.5 shrink-0 animate-spin text-emerald-700 motion-reduce:animate-none dark:text-emerald-400")}
            aria-hidden
          />
        ) : (
          <TriangleAlert className={cn(ICON.md, "mt-0.5 shrink-0 text-amber-600 dark:text-amber-400")} aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{body}</p>
          {detail !== undefined && detail.length > 0 && (
            <p className="mt-2 truncate text-xs font-medium text-rose-700 dark:text-rose-400" title={detail}>
              {detail}
            </p>
          )}
        </div>
      </div>

      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "mt-4 flex min-h-11 w-full items-center justify-center gap-1.5 px-4 text-sm font-semibold",
            RADIUS.control,
            "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white",
            PRESS,
            FOCUS
          )}
        >
          <RefreshCw className={ICON.sm} aria-hidden />
          Try again
        </button>
      )}
    </div>
  )
}

function PaneFallback({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className={cn("w-full max-w-sm p-5 text-center", RADIUS.panel, GLASS)}>
        <TriangleAlert className={cn(ICON.md, "mx-auto text-amber-600 dark:text-amber-400")} aria-hidden />
        <h2 className="mt-3 text-sm font-bold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{body}</p>
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "mt-4 inline-flex h-11 items-center gap-1.5 px-4 text-sm font-semibold",
            RADIUS.control,
            "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white",
            PRESS,
            FOCUS
          )}
        >
          <RefreshCw className={ICON.sm} aria-hidden />
          Try again
        </button>
      </div>
    </div>
  )
}

export default App
