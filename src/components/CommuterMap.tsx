// Interactive Cavite map: renders the transit network's stops, highlights the selected
// origin/destination, draws the active route as real road geometry (colored per transit mode), and
// while a live trip is being tracked, redraws the ridden portion as done and follows the
// commuter's GPS fix with a pulsing "you are here" marker.
//
// The stop layer has two modes, picked from the size of the network it is handed. The 7-stop pilot
// corridor draws every stop as a full teardrop pin, exactly as before. The Cavite-wide network is
// ~800 stops, where that would mean ~800 DOM nodes each holding an inline SVG, so those draw as
// canvas circles gated by zoom and viewport instead. See StopLayer.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, CircleMarker, useMap, useMapEvents } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

// Leaflet's default marker icon points at asset paths that don't resolve under a bundler, which
// silently breaks any Marker rendered without an explicit `icon` prop. Re-point it at the
// bundled PNGs so a stray default marker never shows a broken image instead of a pin.
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png"
import markerIconUrl from "leaflet/dist/images/marker-icon.png"
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png"

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2xUrl,
  iconUrl: markerIconUrl,
  shadowUrl: markerShadowUrl,
})

import type { LiveFix } from "@/hooks/useGeolocation"
import type { TripProgress } from "@/hooks/useTripProgress"
import { MODE_META } from "@/utils/presentation"
import { CAVITE_PILOT_NODES, type RouteResult, type TransitMode, type TransitNode } from "@/utils/routingEngine"

interface CommuterMapProps {
  originId: string | null
  destId: string | null
  activeRoute: RouteResult | null
  /** Index of the step the commuter has open in the result card; that leg is drawn highlighted. */
  activeStepIndex?: number | null
  isDark?: boolean
  /** Live GPS fix, when a trip is being tracked. */
  userFix?: LiveFix | null
  /** Where that fix lands on the route. Drives the traveled and remaining split. */
  progress?: TripProgress | null
  /** True while actively tracking: the map follows the live fix instead of fitting the whole route. */
  tracking?: boolean
  /** Stops to draw. Defaults to the pilot corridor so this component isn't welded to one network. */
  nodes?: TransitNode[]
}

// Midpoint of the corrected corridor, which now runs from Bacoor Longos down to Silang.
const CAVITE_CENTER: [number, number] = [14.3512, 120.9449]
const CAVITE_ZOOM = 11

// Above this many stops, drawing every one as a teardrop DivIcon stops being viable and the layer
// switches to canvas circles. The pilot corridor's 7 stay pins; the ~800-stop Cavite network does not.
const PIN_MODE_MAX_STOPS = 40
// Below this zoom only terminals draw, so a whole-province view is landmarks rather than a smear of
// hundreds of dots that carries no information at that scale.
const ALL_STOPS_ZOOM = 13
// Hard ceiling per frame, after viewport culling. Reached only when zoomed out over a dense area.
const MAX_RENDERED_STOPS = 300

const CARTODB_LIGHT_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
const CARTODB_DARK_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
const CARTODB_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

// The portion of a leg already ridden fades to this neutral so the eye reads it as "done" rather
// than as another mode color competing with what's still ahead.
const TRAVELED_COLOR = "#94a3b8"

/**
 * Line style carries the same meaning here as it does in the sakay guide's timeline: a ride is a
 * solid stroke in its mode colour, an on-foot leg is a dashed slate stroke. That pairing is the
 * whole reason a commuter can glance between the card and the map without re-reading a legend.
 */
const WALK_DASH = "2 9"
/** Already-ridden road gets a finer dash so "behind me" and "on foot" never look alike. */
const TRAVELED_DASH = "1 7"

type PinStatus = "origin" | "destination" | "default"

const PIN_FILL: Record<PinStatus, string> = {
  origin: MODE_META.jeepney.hex,
  destination: "#b45309",
  default: "#18181b",
}

const PIN_HALO: Record<PinStatus, string> = {
  origin: "rgba(5, 150, 105, 0.25)",
  destination: "rgba(180, 83, 9, 0.25)",
  default: "rgba(24, 24, 27, 0.12)",
}

// Custom teardrop pin rendered as a DivIcon (not Leaflet's default marker) so origin/destination
// nodes can be color-coded against the corridor's transit accent palette, with a filled core dot
// on terminal stops to distinguish them from ordinary interchange nodes at a glance.
function createPinIcon(status: PinStatus, isTerminal: boolean): L.DivIcon {
  const size = status === "default" ? 30 : 38
  const fill = PIN_FILL[status]
  const halo = PIN_HALO[status]
  const html = `
    <div style="position:relative;width:${size}px;height:${size}px;">
      <div style="position:absolute;inset:-5px;border-radius:9999px;background:${halo};"></div>
      <svg width="${size}" height="${size}" viewBox="0 0 24 24" style="position:relative;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.35));">
        <path d="M12 0C6.48 0 2 4.48 2 10c0 7 10 14 10 14s10-7 10-14c0-5.52-4.48-10-10-10z" fill="${fill}" stroke="#ffffff" stroke-width="1.5"/>
        <circle cx="12" cy="10" r="${isTerminal ? 3.5 : 2.5}" fill="#ffffff" fill-opacity="${isTerminal ? 1 : 0.9}"/>
      </svg>
    </div>
  `
  return L.divIcon({
    html,
    className: "commutayo-pin",
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size + 4],
  })
}

// A pulsing blue dot, the conventional "you are here" GPS marker on every map app, so it reads
// instantly instead of needing to be learned like a custom pin would.
function createLiveMarkerIcon(): L.DivIcon {
  const html = `
    <div class="commutayo-live-marker" style="position:relative;width:22px;height:22px;">
      <span class="pulse" style="position:absolute;inset:0;border-radius:9999px;background:rgba(37,99,235,0.45);"></span>
      <span style="position:absolute;inset:5px;border-radius:9999px;background:#2563eb;border:2px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></span>
    </div>
  `
  return L.divIcon({ html, className: "", iconSize: [22, 22], iconAnchor: [11, 11] })
}

/**
 * Keeps the picked route in frame: fits the whole trip when it changes, and zooms to the single
 * leg the commuter has open in the result card. Without this the map sits at a fixed corridor
 * center and a short trip is a cluster of pins in one corner. Disabled while a live trip is being
 * followed. See FollowLiveLocation, which takes over the camera at that point.
 */
function FitToRoute({
  route,
  activeStepIndex,
  disabled,
}: {
  route: RouteResult | null
  activeStepIndex: number | null
  disabled: boolean
}) {
  const map = useMap()

  useEffect(() => {
    if (disabled || route === null || route.polylineCoordinates.length === 0) return
    const step = activeStepIndex === null ? undefined : route.steps[activeStepIndex]
    const points = step?.path ?? route.polylineCoordinates
    if (points.length === 0) return

    // A tick late on purpose: Leaflet silently drops a fitBounds issued in the same tick the map
    // is set up, and the container may not have its final size until layout settles. A timer, not
    // requestAnimationFrame, because rAF is paused in a backgrounded tab, which would leave the map
    // framed on the wrong trip until the commuter switched back to it.
    const timer = setTimeout(() => {
      map.invalidateSize({ animate: false })
      map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 15, animate: false })
    }, 0)
    return () => clearTimeout(timer)
  }, [map, route, activeStepIndex, disabled])

  return null
}

/** While tracking, recenters on the live fix as it moves. animate:false for the same reason
 *  FitToRoute avoids requestAnimationFrame: a backgrounded tab would otherwise strand the pan
 *  mid-flight instead of just landing on the right spot. */
function FollowLiveLocation({ point, active }: { point: [number, number] | null; active: boolean }) {
  const map = useMap()

  useEffect(() => {
    if (!active || point === null) return
    map.panTo(point, { animate: false })
  }, [map, point, active])

  return null
}

/**
 * Frames the whole network once, so opening the app shows the real coverage area instead of a
 * hardcoded corridor centre that a Cavite-wide dataset has outgrown. Runs only while no route is
 * picked, which is exactly when FitToRoute is inert, so the two can never fight over the camera.
 */
function FitToNetwork({ nodes, enabled }: { nodes: TransitNode[]; enabled: boolean }) {
  const map = useMap()
  const fittedTo = useRef<TransitNode[] | null>(null)

  useEffect(() => {
    if (!enabled || nodes.length === 0 || fittedTo.current === nodes) return
    fittedTo.current = nodes

    // Same one-tick delay and rationale as FitToRoute: a fitBounds issued in the map's setup tick
    // is silently dropped, and the container may not have its final size until layout settles.
    const timer = setTimeout(() => {
      map.invalidateSize({ animate: false })
      map.fitBounds(L.latLngBounds(nodes.map((node) => [node.lat, node.lng])), {
        padding: [28, 28],
        animate: false,
      })
    }, 0)
    return () => clearTimeout(timer)
  }, [map, nodes, enabled])

  return null
}

/**
 * Draws the stops, choosing per network size between full teardrop pins and canvas circles.
 *
 * For a big network the cost that matters is how many stops exist *in view*, not how many exist at
 * all, so this tracks the viewport and renders only what is inside it. Origin and destination are
 * always drawn as pins by the caller regardless of zoom, because losing sight of the two stops the
 * trip is actually about would be the one genuinely disorienting thing this optimisation could do.
 */
function StopLayer({
  nodes,
  originId,
  destId,
  usePins,
}: {
  nodes: TransitNode[]
  originId: string | null
  destId: string | null
  usePins: boolean
}) {
  const map = useMap()
  const read = useCallback(() => ({ zoom: map.getZoom(), bounds: map.getBounds() }), [map])
  const [view, setView] = useState(read)

  useMapEvents({
    moveend: () => setView(read()),
    zoomend: () => setView(read()),
  })

  const visible = useMemo(() => {
    // Endpoints are drawn separately and always; skip them here so they can't render twice.
    const rest = nodes.filter((node) => node.id !== originId && node.id !== destId)
    if (usePins) return rest

    const terminalsOnly = view.zoom < ALL_STOPS_ZOOM
    const inView = rest.filter(
      (node) => (!terminalsOnly || node.isTerminal) && view.bounds.contains([node.lat, node.lng])
    )
    return inView.length > MAX_RENDERED_STOPS ? inView.slice(0, MAX_RENDERED_STOPS) : inView
  }, [nodes, originId, destId, usePins, view])

  if (usePins) {
    return (
      <>
        {visible.map((node) => (
          <Marker key={node.id} position={[node.lat, node.lng]} icon={createPinIcon("default", node.isTerminal)}>
            <StopPopup node={node} status="default" />
          </Marker>
        ))}
      </>
    )
  }

  return (
    <>
      {visible.map((node) => (
        <CircleMarker
          key={node.id}
          center={[node.lat, node.lng]}
          radius={node.isTerminal ? 6 : 4}
          pathOptions={{
            color: "#ffffff",
            weight: node.isTerminal ? 2 : 1.5,
            opacity: 0.9,
            fillColor: node.isTerminal ? "#b45309" : "#18181b",
            fillOpacity: node.isTerminal ? 0.95 : 0.7,
          }}
        >
          <StopPopup node={node} status="default" />
        </CircleMarker>
      ))}
    </>
  )
}

/** Popup body shared by both stop representations, so a pin and a circle say the same things. */
function StopPopup({ node, status }: { node: TransitNode; status: PinStatus }) {
  return (
    <Popup className="commutayo-popup">
      <div className="min-w-[180px] max-w-[240px]">
        {/* OSM-imported stops carry no city, so this line is skipped rather than left blank. */}
        {node.city.length > 0 && <p className="text-xs font-medium text-zinc-400">{node.city}</p>}
        <p className="text-base font-bold leading-snug">{node.name}</p>
        {node.isTerminal && node.city.length === 0 && (
          <p className="text-xs font-medium text-zinc-400">Terminal</p>
        )}
        {status !== "default" && (
          <span
            className="mt-1.5 inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{ backgroundColor: PIN_FILL[status], color: "#fafafa" }}
          >
            {status === "origin" ? "Simula" : "Destinasyon"}
          </span>
        )}
        {/* The pin marks a transit bay, not a building, so say what is actually there -- when the
            data knows. The OSM import has no surveyed waiting spot, so it stays quiet instead of
            printing an empty line where the pilot corridor had real instructions. */}
        {node.waitingSpot.length > 0 && (
          <p className="mt-2 text-xs leading-relaxed text-zinc-300">{node.waitingSpot}</p>
        )}
      </div>
    </Popup>
  )
}

interface SegmentPiece {
  key: string
  path: [number, number][]
  mode: TransitMode
  isDimmed: boolean
  isFocused: boolean
  status: "traveled" | "current" | "upcoming"
}

export function CommuterMap({
  originId,
  destId,
  activeRoute,
  activeStepIndex = null,
  isDark = false,
  userFix = null,
  progress = null,
  tracking = false,
  nodes = CAVITE_PILOT_NODES,
}: CommuterMapProps) {
  const isTrackingLive = tracking && progress !== null && progress.onRoute
  const usePins = nodes.length <= PIN_MODE_MAX_STOPS

  // The two stops the trip is about, pulled out so they can be drawn as full pins unconditionally.
  const endpoints = useMemo(
    () =>
      [
        { node: nodes.find((n) => n.id === originId) ?? null, status: "origin" as const },
        { node: nodes.find((n) => n.id === destId) ?? null, status: "destination" as const },
      ].filter((entry): entry is { node: TransitNode; status: "origin" | "destination" } => entry.node !== null),
    [nodes, originId, destId]
  )

  // Each step carries its own real-road path, so a step that merges several segments still draws
  // as one continuous line. While a trip is tracked, the step under the live fix is split at the
  // fix's projected point into a "done" piece and a "still ahead" piece.
  const pieces = useMemo<SegmentPiece[]>(() => {
    if (activeRoute === null) return []

    return activeRoute.steps.flatMap((step, index): SegmentPiece[] => {
      const isDimmed = activeStepIndex !== null && activeStepIndex !== index
      const isFocused = activeStepIndex === index
      const base = { mode: step.mode, isDimmed, isFocused }

      if (!isTrackingLive || progress === null) {
        return [{ ...base, key: `${step.serviceId}-${index}`, path: step.path, status: "upcoming" }]
      }

      if (index < progress.stepIndex) {
        return [{ ...base, key: `${step.serviceId}-${index}`, path: step.path, status: "traveled" }]
      }
      if (index > progress.stepIndex) {
        return [{ ...base, key: `${step.serviceId}-${index}`, path: step.path, status: "upcoming" }]
      }

      // The step the commuter is on right now: split at the live fix's projected point.
      const cutIndex = Math.min(Math.max(progress.pathIndex, 0), step.path.length - 1)
      const traveledPath: [number, number][] = [...step.path.slice(0, cutIndex + 1), progress.point]
      const remainingPath: [number, number][] = [progress.point, ...step.path.slice(cutIndex + 1)]
      return [
        { ...base, key: `${step.serviceId}-${index}-done`, path: traveledPath, status: "traveled" },
        { ...base, key: `${step.serviceId}-${index}-ahead`, path: remainingPath, status: "current" },
      ]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoute, activeStepIndex, isTrackingLive, progress])

  const livePoint: [number, number] | null =
    userFix === null ? null : progress !== null && progress.onRoute ? progress.point : [userFix.lat, userFix.lng]

  return (
    <>
      <style>{`
        .commutayo-popup .leaflet-popup-content-wrapper {
          background: ${isDark ? "rgba(39, 39, 42, 0.95)" : "rgba(24, 24, 27, 0.92)"};
          color: #fafafa;
          border-radius: 12px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        }
        .commutayo-popup .leaflet-popup-tip {
          background: ${isDark ? "rgba(39, 39, 42, 0.95)" : "rgba(24, 24, 27, 0.92)"};
        }
        .commutayo-popup .leaflet-popup-content {
          margin: 10px 12px;
        }
        ${
          isDark
            ? ""
            : `.leaflet-tile-pane { filter: saturate(0.7) brightness(0.97) contrast(0.96); }`
        }
        @keyframes commutayo-pulse {
          0% { transform: scale(0.6); opacity: 0.55; }
          70%, 100% { transform: scale(2.4); opacity: 0; }
        }
        .commutayo-live-marker .pulse { animation: commutayo-pulse 2.2s cubic-bezier(0.16, 1, 0.3, 1) infinite; }
        @media (prefers-reduced-motion: reduce) {
          .commutayo-live-marker .pulse { animation: none; opacity: 0.35; }
        }
      `}</style>
      <MapContainer
        center={CAVITE_CENTER}
        zoom={CAVITE_ZOOM}
        style={{ height: "100%", width: "100%" }}
        className="rounded-2xl"
        // Routes the circle-marker stop layer and the route polylines through one canvas instead of
        // an SVG element per shape. Pins stay DOM either way -- a DivIcon is HTML by definition.
        preferCanvas
      >
        <TileLayer url={isDark ? CARTODB_DARK_URL : CARTODB_LIGHT_URL} attribution={CARTODB_ATTRIBUTION} />

        <FitToRoute route={activeRoute} activeStepIndex={activeStepIndex} disabled={isTrackingLive} />
        <FitToNetwork nodes={nodes} enabled={activeRoute === null && !isTrackingLive} />
        <FollowLiveLocation point={livePoint} active={isTrackingLive} />

        {pieces.map((piece) => {
          const modeMeta = MODE_META[piece.mode]
          const isTraveled = piece.status === "traveled"
          const isWalk = piece.mode === "walk"
          const color = isTraveled ? TRAVELED_COLOR : modeMeta.hex
          const dimMultiplier = piece.isDimmed ? 0.3 : 1
          const baseOpacity = isTraveled ? 0.4 : piece.status === "current" ? 0.95 : 0.85

          // Rides are solid, walks are dashed. A ride already behind the commuter keeps the solid
          // vs dashed distinction and loses its colour instead, so mode stays readable end to end.
          const dashArray = isWalk ? WALK_DASH : isTraveled ? TRAVELED_DASH : undefined

          return (
            <Fragment key={piece.key}>
              {/* A dark casing under every line, so an emerald route stays visible against a green
                  park polygon and a slate walk stays visible against grey road fill. */}
              <Polyline
                positions={piece.path}
                pathOptions={{
                  color: "#18181b",
                  weight: piece.isFocused ? 11 : 7,
                  opacity: piece.isDimmed ? 0.05 : 0.15,
                  lineCap: "round",
                }}
              />
              <Polyline
                positions={piece.path}
                pathOptions={{
                  color,
                  weight: piece.isFocused ? 7 : 5,
                  opacity: baseOpacity * dimMultiplier,
                  lineCap: "round",
                  dashArray,
                }}
              />
            </Fragment>
          )
        })}

        <StopLayer nodes={nodes} originId={originId} destId={destId} usePins={usePins} />

        {endpoints.map(({ node, status }) => (
          <Marker
            key={node.id}
            position={[node.lat, node.lng]}
            icon={createPinIcon(status, node.isTerminal)}
            zIndexOffset={500}
          >
            <StopPopup node={node} status={status} />
          </Marker>
        ))}

        {userFix !== null && (
          <>
            <Circle
              center={[userFix.lat, userFix.lng]}
              radius={userFix.accuracyMeters}
              pathOptions={{ color: "#2563eb", weight: 1, opacity: 0.25, fillColor: "#2563eb", fillOpacity: 0.08 }}
            />
            <Marker position={[userFix.lat, userFix.lng]} icon={createLiveMarkerIcon()} zIndexOffset={1000} />
          </>
        )}
      </MapContainer>
    </>
  )
}

export default CommuterMap
