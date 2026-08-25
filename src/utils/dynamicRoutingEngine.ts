// Builds a TransitNetwork (the same shape routingEngine.ts's Dijkstra already consumes) from the
// live Supabase tables, so the search UI can eventually route over the real Cavite-wide network
// instead of the 7-stop pilot corridor. This file only builds the graph and finds routes over it;
// the existing `findRoute` from routingEngine.ts does the actual pathfinding unchanged.
//
// SAFE TRANSITION: gated behind `DYNAMIC_NETWORK_ENABLED` (VITE_USE_DYNAMIC_NETWORK). The pilot
// engine stays the default export the UI calls until the database is populated and this has been
// checked against it. Nothing here runs unless a caller explicitly opts in via
// `loadDynamicNetwork` / `findRoutesDynamic` / `useDynamicTransitNetwork`.
//
// WHAT'S DIFFERENT FROM THE PILOT MODEL, on purpose:
// - `serviceId` is just `route.id`. Each DB route row is already one physical, one-direction
//   service (see supabase/migrations -- `paired_route_id` links to the *separate* opposite-
//   direction row), so segments from the same route merge into one ride automatically, with no
//   per-segment id assignment needed the way the hand-authored pilot data required.
// - Edges are directed, forward along `route_stops.sequence` only. A jeepney doesn't reverse
//   mid-route; the return trip is `paired_route_id`'s row, if that pairing has been made yet.
// - There is no walking-first rule yet (contrast routingEngine.ts's `applyWalkingFirstRule`).
//   Cavite-wide stop density is unknown until real data lands, and 500m was tuned against 7
//   hand-picked stops -- reapplying it blindly here could strip legitimate short vehicle hops
//   between unrelated stops that happen to be close. Left for a follow-up once real coordinates
//   are in.
// - There is no per-edge placard/driver-phrase/landmark data in the schema. Those fields are
//   filled with the best available proxy (route ref/name, a generic arrival phrase) and
//   `landmarkVerified` is always false, so `computeConfidence` correctly scores every dynamic
//   route as unverified rather than reusing the pilot's doc-sourced grade by accident.

import { computeFare, type VehicleClass } from "@/utils/fares"
import { buildRouteGeometry, haversineMeters, projectOntoRoute, type LatLng } from "@/utils/geo"
import {
  findRoute,
  SPEED_KMH,
  type RouteResult,
  type RoutePriority,
  type RouteSegmentEdge,
  type TransitMode,
  type TransitNetwork,
  type TransitNode,
} from "@/utils/routingEngine"
import { fetchTransitNetworkTables, type TransitNetworkTables } from "@/utils/transitRepository"
import type { DbVehicleClass, Route, RouteGeometry as DbRouteGeometry, Stop } from "@/types/transit"

export const DYNAMIC_NETWORK_ENABLED = import.meta.env.VITE_USE_DYNAMIC_NETWORK === "true"

// Maps the DB's vehicle_class to the app's coarser TransitMode (what icon/speed applies) and to
// fares.ts's VehicleClass (what fare bracket applies). `bus_premium` has no fare bracket of its
// own in fares.ts yet, so it's charged at the standard bus rate until one is added.
const MODE_BY_VEHICLE_CLASS: Record<DbVehicleClass, TransitMode> = {
  jeepney_traditional: "jeepney",
  jeepney_modern: "jeepney",
  bus: "bus",
  bus_premium: "bus",
  uv_express: "uv_express",
  tricycle: "tricycle",
}

const FARE_VEHICLE_CLASS_BY_VEHICLE_CLASS: Record<DbVehicleClass, VehicleClass> = {
  jeepney_traditional: "jeepney_traditional",
  jeepney_modern: "jeepney_modern",
  bus: "bus",
  bus_premium: "bus",
  uv_express: "uv_express",
  tricycle: "tricycle",
}

function stopToNode(stop: Stop): TransitNode {
  return {
    id: stop.id,
    name: stop.name,
    shortName: stop.short_name ?? stop.name,
    lat: stop.lat,
    lng: stop.lon,
    city: stop.city ?? "",
    isTerminal: stop.is_terminal,
    aliases: stop.aliases,
    waitingSpot: stop.waiting_spot ?? "",
  }
}

interface RoadSlice {
  distanceMeters: number
  path: LatLng[]
}

/**
 * Cuts the stretch of a route's stored polyline between two of its stops, by projecting each
 * stop onto the polyline (reusing the same nearest-point projection the live-tracking hook uses)
 * and slicing the vertices between the two projected positions. Falls back to a straight line
 * when there's no geometry yet, or the projections come out of order (bad/partial data) --
 * matching routingEngine.ts's `roadSegmentFor` fallback, so a gap in the data degrades instead of
 * throwing.
 */
function sliceRoadBetweenStops(from: Stop, to: Stop, polyline: LatLng[]): RoadSlice {
  const fromCoord: LatLng = [from.lat, from.lon]
  const toCoord: LatLng = [to.lat, to.lon]
  const straightLine = (): RoadSlice => ({
    distanceMeters: Math.round(haversineMeters(fromCoord, toCoord)),
    path: [fromCoord, toCoord],
  })

  if (polyline.length < 2) return straightLine()

  const geometry = buildRouteGeometry([{ path: polyline }])
  const fromProjection = projectOntoRoute(geometry, fromCoord)
  const toProjection = projectOntoRoute(geometry, toCoord)
  if (fromProjection === null || toProjection === null) return straightLine()
  if (toProjection.distanceTraveledMeters <= fromProjection.distanceTraveledMeters) return straightLine()

  const startIndex = fromProjection.pathIndex + 1
  const endIndex = toProjection.pathIndex
  const between = polyline.slice(startIndex, endIndex + 1)

  return {
    distanceMeters: Math.round(toProjection.distanceTraveledMeters - fromProjection.distanceTraveledMeters),
    path: [fromProjection.point, ...between, toProjection.point],
  }
}

function buildEdge(route: Route, from: Stop, to: Stop, polyline: LatLng[]): RouteSegmentEdge {
  const mode = MODE_BY_VEHICLE_CLASS[route.vehicle_class]
  const vehicleClass = FARE_VEHICLE_CLASS_BY_VEHICLE_CLASS[route.vehicle_class]
  const road = sliceRoadBetweenStops(from, to, polyline)
  const distanceKm = road.distanceMeters / 1000
  const fare = route.flat_fare ?? computeFare(vehicleClass, distanceKm)
  const durationMin = Math.max(1, Math.round((distanceKm / SPEED_KMH[mode]) * 60))
  const placardText = route.ref ?? route.name

  return {
    fromNodeId: from.id,
    toNodeId: to.id,
    mode,
    vehicleClass,
    serviceId: route.id,
    placardText,
    alternatePlacards: [],
    boardingSpot: from.waiting_spot ?? "",
    fare,
    durationMin,
    distanceMeters: road.distanceMeters,
    landmarkCues: [],
    // Nothing in the DB schema records a surveyed drop-off phrase yet -- this is a placeholder,
    // not a claim of accuracy, and `landmarkVerified: false` below keeps computeConfidence honest.
    driverPhrase: `${to.short_name ?? to.name} po`,
    landmarkVerified: false,
    roadPath: road.path,
  }
}

/**
 * Builds the routable graph from the raw DB rows. Directed, one edge per adjacent stop pair per
 * route, following `route_stops.sequence` -- see the file header for why this doesn't also
 * generate a reverse edge or a walking-first pass the way the pilot network does.
 */
export function buildNetworkFromDatabase(tables: TransitNetworkTables): TransitNetwork {
  const nodes = tables.stops.map(stopToNode)
  const stopsById = new Map(tables.stops.map((stop) => [stop.id, stop]))
  const geometryByRoute = new Map<string, DbRouteGeometry>(tables.routeGeometries.map((g) => [g.route_id, g]))

  const stopSequenceByRoute = new Map<string, typeof tables.routeStops>()
  for (const routeStop of tables.routeStops) {
    const bucket = stopSequenceByRoute.get(routeStop.route_id)
    if (bucket === undefined) stopSequenceByRoute.set(routeStop.route_id, [routeStop])
    else bucket.push(routeStop)
  }

  const edges: RouteSegmentEdge[] = []
  for (const route of tables.routes) {
    if (!route.is_active) continue

    // A route legitimately has zero or one stop rows (a mapped road with no marked boarding
    // points) -- that needs at least two stops to contribute an edge, not an error.
    const sequence = (stopSequenceByRoute.get(route.id) ?? []).slice().sort((a, b) => a.sequence - b.sequence)
    if (sequence.length < 2) continue

    const polyline = geometryByRoute.get(route.id)?.path ?? []
    for (let i = 0; i < sequence.length - 1; i++) {
      const from = stopsById.get(sequence[i].stop_id)
      const to = stopsById.get(sequence[i + 1].stop_id)
      if (from === undefined || to === undefined) continue
      edges.push(buildEdge(route, from, to, polyline))
    }
  }

  return { nodes, edges }
}

/** Fetches the live tables and builds the graph. Throws if Supabase isn't configured. */
export async function loadDynamicNetwork(): Promise<TransitNetwork> {
  const tables = await fetchTransitNetworkTables()
  return buildNetworkFromDatabase(tables)
}

/** Same shape as routingEngine.ts's `findRoutes`, but async and over the live database network. */
export async function findRoutesDynamic(
  originId: string,
  destId: string
): Promise<Record<RoutePriority, RouteResult | null>> {
  const network = await loadDynamicNetwork()
  return {
    cheapest: findRoute(network, originId, destId, "cheapest"),
    fastest: findRoute(network, originId, destId, "fastest"),
    easiest: findRoute(network, originId, destId, "easiest"),
  }
}
