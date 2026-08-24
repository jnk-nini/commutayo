// Interactive Cavite corridor map: renders the pilot node network, highlights the selected
// origin/destination, and draws the active route (colored per transit mode) when one is picked.

import { Fragment, useEffect } from "react"
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from "react-leaflet"
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

import { CAVITE_PILOT_NODES, type RouteResult, type TransitMode } from "@/utils/routingEngine"

interface CommuterMapProps {
  originId: string | null
  destId: string | null
  activeRoute: RouteResult | null
  /** Index of the step the commuter has open in the result card; that leg is drawn highlighted. */
  activeStepIndex?: number | null
}

const CAVITE_CENTER: [number, number] = [14.3218, 120.9634]
const CAVITE_ZOOM = 12

const CARTODB_POSITRON_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
const CARTODB_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

// Transit accent palette, per the uiux-promax skill: Emerald for jeepneys, Amber for bus/UV
// Express, Sky for tricycles. Walking legs aren't a "mode" in that palette, so they get a
// neutral dashed line, the standard map convention for on-foot segments.
const MODE_COLORS: Record<TransitMode, string> = {
  jeepney: "#10b981",
  bus: "#f59e0b",
  uv_express: "#f59e0b",
  tricycle: "#0ea5e9",
  walk: "#71717a",
}

type PinStatus = "origin" | "destination" | "default"

const PIN_FILL: Record<PinStatus, string> = {
  origin: "#10b981",
  destination: "#f59e0b",
  default: "#18181b",
}

const PIN_HALO: Record<PinStatus, string> = {
  origin: "rgba(16, 185, 129, 0.25)",
  destination: "rgba(245, 158, 11, 0.25)",
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

function pinStatusFor(nodeId: string, originId: string | null, destId: string | null): PinStatus {
  if (nodeId === originId) return "origin"
  if (nodeId === destId) return "destination"
  return "default"
}

/**
 * Keeps the picked route in frame: fits the whole trip when it changes, and zooms to the single
 * leg the commuter has open in the result card. Without this the map sits at a fixed corridor
 * center and a short trip is a cluster of pins in one corner.
 */
function FitToRoute({ route, activeStepIndex }: { route: RouteResult | null; activeStepIndex: number | null }) {
  const map = useMap()

  useEffect(() => {
    if (route === null || route.polylineCoordinates.length === 0) return
    const step = activeStepIndex === null ? undefined : route.steps[activeStepIndex]
    const points = step?.path ?? route.polylineCoordinates
    if (points.length === 0) return

    // A tick late on purpose: Leaflet silently drops a fitBounds issued in the same tick the map
    // is set up, and the container may not have its final size until layout settles. A timer, not
    // requestAnimationFrame — rAF is paused in a backgrounded tab, which would leave the map
    // framed on the wrong trip until the commuter switched back to it.
    const timer = setTimeout(() => {
      map.invalidateSize({ animate: false })
      map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 15, animate: false })
    }, 0)
    return () => clearTimeout(timer)
  }, [map, route, activeStepIndex])

  return null
}

export function CommuterMap({ originId, destId, activeRoute, activeStepIndex = null }: CommuterMapProps) {
  // Each step carries its own path, so a step that merges several segments still draws as one
  // continuous line — walking the coordinate array by index would silently mis-align once the
  // engine merges legs.
  const routeSegments = activeRoute?.steps.map((step, index) => ({ step, index, path: step.path }))

  return (
    <>
      <style>{`
        .commutayo-popup .leaflet-popup-content-wrapper {
          background: rgba(24, 24, 27, 0.92);
          color: #fafafa;
          border-radius: 12px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        }
        .commutayo-popup .leaflet-popup-tip {
          background: rgba(24, 24, 27, 0.92);
        }
        .commutayo-popup .leaflet-popup-content {
          margin: 10px 12px;
        }
      `}</style>
      <MapContainer
        center={CAVITE_CENTER}
        zoom={CAVITE_ZOOM}
        style={{ height: "100%", width: "100%" }}
        className="rounded-2xl"
      >
        <TileLayer url={CARTODB_POSITRON_URL} attribution={CARTODB_ATTRIBUTION} />

        <FitToRoute route={activeRoute} activeStepIndex={activeStepIndex} />

        {routeSegments?.map((segment) => {
          // With a step open in the card, that leg stays full-strength and everything else fades
          // back, so the map answers "which part am I reading about?" without a second glance.
          const isDimmed = activeStepIndex !== null && activeStepIndex !== segment.index
          const isFocused = activeStepIndex === segment.index
          return (
            <Fragment key={`${segment.step.serviceId}-${segment.index}`}>
              <Polyline
                positions={segment.path}
                pathOptions={{
                  color: "#18181b",
                  weight: isFocused ? 11 : 7,
                  opacity: isDimmed ? 0.05 : 0.15,
                  lineCap: "round",
                }}
              />
              <Polyline
                positions={segment.path}
                pathOptions={{
                  color: MODE_COLORS[segment.step.mode],
                  weight: isFocused ? 7 : 5,
                  opacity: isDimmed ? 0.3 : 0.95,
                  lineCap: "round",
                  dashArray: segment.step.mode === "walk" ? "2 8" : undefined,
                }}
              />
            </Fragment>
          )
        })}

        {CAVITE_PILOT_NODES.map((node) => {
          const status = pinStatusFor(node.id, originId, destId)
          return (
            <Marker key={node.id} position={[node.lat, node.lng]} icon={createPinIcon(status, node.isTerminal)}>
              <Popup className="commutayo-popup">
                <div className="min-w-[160px]">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{node.city}</p>
                  <p className="text-base font-bold leading-snug">{node.name}</p>
                  {status !== "default" && (
                    <span
                      className="mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ backgroundColor: PIN_FILL[status], color: "#18181b" }}
                    >
                      {status}
                    </span>
                  )}
                </div>
              </Popup>
            </Marker>
          )
        })}
      </MapContainer>
    </>
  )
}

export default CommuterMap
