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
import {
  buildRouteGeometry,
  haversineMeters,
  projectOntoRoute,
  type LatLng,
  type RouteGeometry as ProjectionIndex,
  type RouteProjection,
} from "@/utils/geo"
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

/**
 * The box this app will actually plan trips inside: Cavite plus Metro Manila, with a margin.
 *
 * The OSM ingestion pulled every route relation touching the Cavite area, and a lot of them are
 * long-haul provincial coaches that merely *start* at PITX -- PITX to Davao, to Tacloban, to
 * Legazpi, and around 70 more. That data is real and correctly imported, but a 30-hour bus to
 * Mindanao is not a commute, and leaving those stops in does three concrete kinds of damage: the
 * map's initial fit zooms out to the whole country (the raw stop list spans 7.05N to 14.65N), the
 * place pickers fill with terminals in Bicol and Samar, and `computeFare` gets handed a 1500 km
 * "segment" whose distance-banded fare is meaningless.
 *
 * So the filter is a display and planning boundary, not a data cleanup: nothing is deleted, and
 * widening the box is a one-line change here. An edge survives only if BOTH its stops are inside,
 * which keeps every local hop of a long route (the PITX to Lucena runs contribute their Cavite and
 * Manila legs normally) and drops only the legs that leave the region.
 */
export const SERVICE_AREA = {
  minLat: 14.0,
  maxLat: 14.85,
  minLon: 120.55,
  maxLon: 121.25,
} as const

/** Ingestion's placeholder for an OSM stop node carrying no name tag. Real in the graph, unpickable. */
const PLACEHOLDER_STOP_NAME = "Unnamed stop"

function isInServiceArea(stop: Stop): boolean {
  return (
    stop.lat >= SERVICE_AREA.minLat &&
    stop.lat <= SERVICE_AREA.maxLat &&
    stop.lon >= SERVICE_AREA.minLon &&
    stop.lon <= SERVICE_AREA.maxLon
  )
}

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
 * Cuts the stretch of a route's stored polyline between two of its stops, given each stop's
 * already-computed projection onto that polyline. Falls back to a straight line when there's no
 * geometry yet, or the projections come out of order (bad/partial data) -- matching
 * routingEngine.ts's `roadSegmentFor` fallback, so a gap in the data degrades instead of throwing.
 *
 * The projections are passed in rather than computed here because both of them are shared with the
 * neighbouring segments: a stop is the drop-off of one edge and the boarding point of the next, so
 * projecting per edge would do every interior stop twice. See `buildNetworkFromDatabase`.
 */
function sliceRoadBetweenStops(
  from: Stop,
  to: Stop,
  polyline: LatLng[],
  fromProjection: RouteProjection | null,
  toProjection: RouteProjection | null
): RoadSlice {
  const fromCoord: LatLng = [from.lat, from.lon]
  const toCoord: LatLng = [to.lat, to.lon]
  const straightLine = (): RoadSlice => ({
    distanceMeters: Math.round(haversineMeters(fromCoord, toCoord)),
    path: [fromCoord, toCoord],
  })

  if (polyline.length < 2) return straightLine()
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

function buildEdge(route: Route, from: Stop, to: Stop, road: RoadSlice): RouteSegmentEdge {
  const mode = MODE_BY_VEHICLE_CLASS[route.vehicle_class]
  const vehicleClass = FARE_VEHICLE_CLASS_BY_VEHICLE_CLASS[route.vehicle_class]
  const distanceKm = road.distanceMeters / 1000
  const flatFare = route.flat_fare
  const fare = flatFare ?? computeFare(vehicleClass, distanceKm)
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
    // Every segment of one DB route is one service (serviceId is route.id), so consecutive
    // segments merge into a single ride -- and a route with `flat_fare` set must then charge that
    // once for the whole ride, not per segment. See buildRouteResult's merge branch.
    flatFare,
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
 * generate a reverse edge or a walking-first pass the way the pilot network does. Stops outside
 * `SERVICE_AREA` are excluded, and an edge needs both of its stops inside to survive.
 *
 * Two things are computed once per route rather than once per edge, which is what keeps this off
 * the main thread long enough to matter. On the live Cavite data (342 routes, ~127k polyline
 * points, ~2.4k edges) the naive per-edge version walked about 1.4 million polyline points; this
 * shape walks roughly 580 thousand:
 *   - the cumulative-distance index (`buildRouteGeometry`) is built once for the route's polyline,
 *     not rebuilt for each of its segments;
 *   - each stop is projected onto that polyline once, not once as a drop-off and again as the next
 *     segment's boarding point.
 */
export function buildNetworkFromDatabase(tables: TransitNetworkTables): TransitNetwork {
  const servedStops = tables.stops.filter(isInServiceArea)
  const nodes = servedStops.map(stopToNode)
  const stopsById = new Map(servedStops.map((stop) => [stop.id, stop]))
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
    const index: ProjectionIndex[] | null = polyline.length >= 2 ? buildRouteGeometry([{ path: polyline }]) : null

    // One projection per distinct stop on this route, reused by both segments that touch it.
    const projectionByStop = new Map<string, RouteProjection | null>()
    const projectionFor = (stop: Stop): RouteProjection | null => {
      if (index === null) return null
      const cached = projectionByStop.get(stop.id)
      if (cached !== undefined) return cached
      const projection = projectOntoRoute(index, [stop.lat, stop.lon])
      projectionByStop.set(stop.id, projection)
      return projection
    }

    for (let i = 0; i < sequence.length - 1; i++) {
      const from = stopsById.get(sequence[i].stop_id)
      const to = stopsById.get(sequence[i + 1].stop_id)
      // A missing stop here means it was filtered out as outside the service area, so this leg
      // leaves the region -- skip it and keep the rest of the route's local hops.
      if (from === undefined || to === undefined) continue
      const road = sliceRoadBetweenStops(from, to, polyline, projectionFor(from), projectionFor(to))
      edges.push(buildEdge(route, from, to, road))
    }
  }

  return { nodes, edges }
}

/**
 * The stops worth offering in a place picker: ones a vehicle actually serves, and that have a real
 * name to pick. Around 36 of the imported stops are unnamed OSM nodes and a handful more sit on no
 * routable edge at all -- both are legitimate graph members (an unnamed node is still a point the
 * road passes through) but neither is something a commuter can meaningfully choose as an endpoint.
 */
export function selectableNodes(network: TransitNetwork): TransitNode[] {
  const served = new Set<string>()
  for (const edge of network.edges) {
    served.add(edge.fromNodeId)
    served.add(edge.toNodeId)
  }
  return network.nodes.filter((node) => served.has(node.id) && node.name !== PLACEHOLDER_STOP_NAME)
}

/** Fetches the live tables and builds the graph. Throws if Supabase isn't configured. */
export async function loadDynamicNetwork(): Promise<TransitNetwork> {
  const tables = await fetchTransitNetworkTables()
  return buildNetworkFromDatabase(tables)
}

/**
 * Same shape as routingEngine.ts's `findRoutes`, but async and over the live database network.
 *
 * Convenience for scripts and one-off checks only -- it re-reads and re-builds the entire network
 * on every call. The UI must not use this: it loads the network once through
 * `useDynamicTransitNetwork` and then calls the synchronous `findRoute(network, ...)` per priority,
 * so switching a priority tab is instant instead of a fresh round trip to Supabase.
 */
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
