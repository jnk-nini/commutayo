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
// - There is still no walking-first rule (contrast routingEngine.ts's `applyWalkingFirstRule`),
//   so a transfer between two nearby but genuinely different stops cannot happen yet. What does
//   exist is `mergeSplitStops`, which folds the two kerbs OSM maps for one place back into a
//   single node. That is a narrower claim than a walking rule and it fixes a real reported trip;
//   see that function.
// - There is no per-edge placard/driver-phrase/landmark data in the schema. The signboard is
//   derived from the route's name plus the direction its `route_stops.sequence` actually runs
//   (see `derivePlacardText`), and `landmarkVerified` is always false, so `computeConfidence`
//   correctly scores every dynamic route as unverified rather than reusing the pilot's
//   doc-sourced grade by accident.

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

// --- Signboard naming --------------------------------------------------------------------------
//
// A commuter scans a moving road for one thing: the town the vehicle is going TO. OSM route names
// carry both endpoints ("Dasmarinas to Alfonso", "SM Molino to WalterMart Trece Martires"), and the
// naive `route.ref ?? route.name` put the whole string on the signboard -- which the placard chip
// then truncated, so the *origin* was all the commuter could read. Reported from a real trip: a
// jeepney bound for Trece Martires was shown as a "Molino" jeep, and Molino is the opposite
// direction. The vehicle was right; the sign on it was backwards.
//
// The DB's `direction` column cannot help: it holds OSM's "inbound"/"outbound"/"eastbound" tags
// (160 of 342 routes, and null on every route in the reported trip), which name a bearing, not a
// destination. So direction is read off the thing that is always true and always present -- the
// order of `route_stops.sequence` for this row.

/**
 * Separators OSM route names put between their two endpoints. Spelled by codepoint rather than
 * pasted in as characters, because this repo's design rules ban en and em dashes in source text
 * and the scan that enforces them cannot tell a punctuation slip from a parser table.
 *
 * An arrow states the direction outright, so the destination is simply whatever follows it. The
 * symmetric ones are shared by both directions of the same line and say nothing on their own,
 * which is what `pickDestinationEndpoint` is for.
 */
const RIGHT_ARROW = String.fromCharCode(0x2192)
const LEFT_RIGHT_ARROW = String.fromCharCode(0x2194)
const EN_DASH = String.fromCharCode(0x2013)
const EM_DASH = String.fromCharCode(0x2014)

const ARROW_SEPARATORS = [RIGHT_ARROW, "->", "=>"]
const SYMMETRIC_SEPARATORS = [LEFT_RIGHT_ARROW, "<->", EN_DASH, EM_DASH, " - "]

/** "Jeepney Route BT:", "Route 31:" -- an operator label, not part of where the vehicle is going. */
const ROUTE_LABEL_PREFIX = /^[^:]{0,40}\broute\b[^:]{0,20}:\s*/i

/** "(via Dasmariñas)", "via Governor's Drive" -- the way there, not the destination. */
const VIA_SUFFIX = /\s*(?:\(\s*via\b[^)]*\)|\bvia\b.*)$/i

/**
 * Words that appear in so many Cavite stop names that matching on them would pair any stop with
 * any endpoint. Dropping them is what keeps "Trece Martires Bus Terminal" from scoring against
 * "Naic Transport Terminal" purely on the word "terminal".
 */
const GENERIC_PLACE_WORDS = new Set([
  "terminal",
  "transport",
  "station",
  "bus",
  "jeepney",
  "proper",
  "city",
  "public",
  "market",
  "mall",
  "place",
  "junction",
  "exchange",
  "bayan",
])

/** Diacritic-insensitive, punctuation-free significant words, for comparing a name to a stop. */
function significantWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(new RegExp("[\u0300-\u036f]", "g"), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 2 && !GENERIC_PLACE_WORDS.has(word))
}

/** How many of `endpoint`'s significant words the stop name also uses. */
function nameOverlap(endpoint: string, stopName: string): number {
  const stopWords = new Set(significantWords(stopName))
  return significantWords(endpoint).filter((word) => stopWords.has(word)).length
}

/**
 * Given a route name's two endpoints and the two ends of this row's actual stop sequence, works
 * out which endpoint the vehicle is heading toward.
 *
 * The last stop usually says it directly (the "Dasmarinas to Alfonso" line ending at "Alfonso
 * Proper"). When it doesn't, the first stop settles it from the other side: Route 58's
 * westbound row ends at "Vista Terminal Exchange", which matches neither "Alabang" nor "Naic",
 * but it *starts* at "Naic Transport Terminal" -- so it is running to Alabang. Returns null when
 * neither end is decisive, rather than guessing a direction onto a signboard.
 */
function pickDestinationEndpoint(
  endpointA: string,
  endpointB: string,
  firstStopName: string,
  lastStopName: string
): string | null {
  const toA = nameOverlap(endpointA, lastStopName)
  const toB = nameOverlap(endpointB, lastStopName)
  if (toA !== toB) return toA > toB ? endpointA : endpointB

  const fromA = nameOverlap(endpointA, firstStopName)
  const fromB = nameOverlap(endpointB, firstStopName)
  if (fromA !== fromB) return fromA > fromB ? endpointB : endpointA

  return null
}

function splitOnFirstSeparator(name: string, separators: string[]): [string, string] | null {
  for (const separator of separators) {
    if (!name.includes(separator)) continue
    const parts = name.split(separator).map((part) => part.trim())
    if (parts.length < 2) continue
    // "A -> B -> C" is still one journey from A to C; take the outer two.
    return [parts[0], parts[parts.length - 1]]
  }
  return null
}

/**
 * The text to paint on this route's signboard, for the direction its sequence actually runs.
 *
 * Falls through in decreasing order of certainty: an arrow in the name, then the two endpoints
 * resolved against the sequence, then the last stop's own name, then the raw name. The route's
 * `ref` is prefixed when it has one, because a numbered PUV route is read as "58 to Naic".
 */
export function derivePlacardText(route: Route, firstStopName: string, lastStopName: string): string {
  const cleaned = stripViaSuffix(stripRouteLabel(route.name))

  const arrowEnds = splitOnFirstSeparator(cleaned, ARROW_SEPARATORS)
  const symmetricEnds = arrowEnds === null ? splitOnFirstSeparator(cleaned, SYMMETRIC_SEPARATORS) : null

  let destination: string | null = null
  if (arrowEnds !== null) destination = arrowEnds[1]
  else if (symmetricEnds !== null)
    destination = pickDestinationEndpoint(symmetricEnds[0], symmetricEnds[1], firstStopName, lastStopName)

  if (destination === null || destination.length === 0) {
    // An unnamed OSM node is a real point on the road but useless on a signboard, so the raw
    // route name is the better answer there even though it names both ends.
    destination = lastStopName === PLACEHOLDER_STOP_NAME ? cleaned : lastStopName
  }
  if (destination.length === 0) destination = route.name

  const ref = route.ref?.trim() ?? ""
  const alreadyNamesRef = ref.length > 0 && significantWords(destination).includes(ref.toLowerCase())
  const text = ref.length === 0 || alreadyNamesRef ? destination : `${ref} · ${destination}`
  return text.toUpperCase()
}

function stripRouteLabel(name: string): string {
  return name.replace(ROUTE_LABEL_PREFIX, "").trim()
}

function stripViaSuffix(name: string): string {
  return name.replace(VIA_SUFFIX, "").trim()
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

function buildEdge(route: Route, from: Stop, to: Stop, road: RoadSlice, placardText: string): RouteSegmentEdge {
  const mode = MODE_BY_VEHICLE_CLASS[route.vehicle_class]
  const vehicleClass = FARE_VEHICLE_CLASS_BY_VEHICLE_CLASS[route.vehicle_class]
  const distanceKm = road.distanceMeters / 1000
  const flatFare = route.flat_fare
  const fare = flatFare ?? computeFare(vehicleClass, distanceKm)
  const durationMin = Math.max(1, Math.round((distanceKm / SPEED_KMH[mode]) * 60))

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
 * How far apart two same-named stops can be and still be one place to a commuter.
 *
 * OSM maps each kerb of a divided highway as its own node, so "LPU Cavite" is two stops 109m
 * apart: the eastbound side and the westbound side. Each side is served only by the routes running
 * that way, so as separate graph nodes they are genuinely hard to travel between -- on the reported
 * Bella Vista trip the planner had to ride *past* LPU to Manggahan Junction and catch a second bus
 * back. Every edge ran forward along its own sequence and the trip still doubled back, because the
 * destination node was on the far kerb.
 *
 * 150m is deliberately tight. It is wide enough for the two kerbs of Governor's Drive and for the
 * two "PITX" nodes 69m apart, and narrow enough that it cannot fuse genuinely different places.
 * The normalized name has to match as well, so this only ever reunites a stop OSM split in two.
 *
 * This is the same call the ingestion already makes at 60m (see scripts/ingest-osm.ts); doing the
 * wider pass here rather than in SQL keeps the database a faithful record of what OSM says and
 * leaves the threshold a one-line change.
 */
export const SPLIT_STOP_MERGE_METERS = 150

/**
 * How far a merged cluster may spread end to end.
 *
 * Kerbs chain: Monterey Junction is three OSM nodes where the outer two are 162m apart but each is
 * within 150m of the middle one, and all three are the same intersection. So a stop joins a
 * cluster when it is close to *any* member, not just the first -- and this cap is what stops that
 * chaining from walking a same-named stop down a whole boulevard. 400m matches the spread the
 * ingestion already accepts for a mega-terminal like PITX (see scripts/ingest-osm.ts).
 */
export const SPLIT_STOP_SPREAD_METERS = 400

function normalizedStopName(name: string): string {
  return name
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** One merged stop standing in for a cluster of kerbs, positioned at their centre. */
function mergeCluster(cluster: Stop[]): Stop {
  if (cluster.length === 1) return cluster[0]

  const representative = cluster[0]
  const aliases = new Set<string>()
  for (const stop of cluster) {
    for (const alias of stop.aliases) aliases.add(alias)
    // Every other name in the cluster is an alias of the survivor, so a search for the wording
    // that lost still finds the place.
    if (stop.name !== representative.name) aliases.add(stop.name)
  }

  return {
    ...representative,
    lat: cluster.reduce((sum, stop) => sum + stop.lat, 0) / cluster.length,
    lon: cluster.reduce((sum, stop) => sum + stop.lon, 0) / cluster.length,
    is_terminal: cluster.some((stop) => stop.is_terminal),
    short_name: cluster.find((stop) => stop.short_name !== null)?.short_name ?? null,
    city: cluster.find((stop) => stop.city !== null)?.city ?? null,
    waiting_spot: cluster.find((stop) => stop.waiting_spot !== null)?.waiting_spot ?? null,
    aliases: [...aliases],
  }
}

/**
 * Groups same-named stops into clusters by chaining: two stops within `SPLIT_STOP_MERGE_METERS`
 * always land together, and so does anything already joined to either of them. Chaining is what
 * makes Monterey Junction one node -- its outer two kerbs are 162m apart, too far to pair
 * directly, but each is inside 150m of the middle one.
 *
 * A cluster that ends up spread wider than `SPLIT_STOP_SPREAD_METERS` is not a place, it is a
 * chain that walked down a road, so it is broken back into individual stops rather than merged
 * into a node that sits nowhere. That guard does not fire on the current Cavite import; it is
 * here so a future one cannot quietly fuse a street's worth of same-named stops.
 */
function clusterByProximity(group: Stop[]): Stop[][] {
  const parent = group.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    for (let walk = index; parent[walk] !== root; ) {
      const next = parent[walk]
      parent[walk] = root
      walk = next
    }
    return root
  }

  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const meters = haversineMeters([group[i].lat, group[i].lon], [group[j].lat, group[j].lon])
      if (meters <= SPLIT_STOP_MERGE_METERS) parent[find(i)] = find(j)
    }
  }

  const byRoot = new Map<number, Stop[]>()
  for (let i = 0; i < group.length; i++) {
    const root = find(i)
    const bucket = byRoot.get(root)
    if (bucket === undefined) byRoot.set(root, [group[i]])
    else bucket.push(group[i])
  }

  const clusters: Stop[][] = []
  for (const cluster of byRoot.values()) {
    if (spreadMeters(cluster) <= SPLIT_STOP_SPREAD_METERS) clusters.push(cluster)
    else for (const stop of cluster) clusters.push([stop])
  }
  return clusters
}

/** Widest distance between any two members of a cluster. */
function spreadMeters(cluster: Stop[]): number {
  let widest = 0
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      widest = Math.max(widest, haversineMeters([cluster[i].lat, cluster[i].lon], [cluster[j].lat, cluster[j].lon]))
    }
  }
  return widest
}

interface MergedStops {
  stops: Stop[]
  /** Every original stop id, including the survivors', mapped to the id that now represents it. */
  canonicalIdOf: Map<string, string>
}

/**
 * Folds stops that OSM split across a road back into one node each.
 *
 * Only stops that already share a normalized name are compared, so this costs a few comparisons
 * per name group rather than the ~300k-pair sweep a blind radius search over 800 stops would run
 * on the main thread during load. `clusterByProximity` decides the grouping; input order only
 * decides which stop of a cluster keeps its id, which is why `fetchStops` reads in a fixed order.
 */
function mergeSplitStops(stops: Stop[]): MergedStops {
  const groups = new Map<string, Stop[]>()
  for (const stop of stops) {
    const key = stop.name === PLACEHOLDER_STOP_NAME ? `id:${stop.id}` : normalizedStopName(stop.name)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [stop])
    else bucket.push(stop)
  }

  const merged: Stop[] = []
  const canonicalIdOf = new Map<string, string>()
  for (const group of groups.values()) {
    for (const cluster of clusterByProximity(group)) {
      const survivor = mergeCluster(cluster)
      merged.push(survivor)
      for (const stop of cluster) canonicalIdOf.set(stop.id, survivor.id)
    }
  }

  return { stops: merged, canonicalIdOf }
}

// --- Stops a route drives past but never lists ------------------------------------------------
//
// OSM route relations record the *way* a vehicle takes far more reliably than the stops along it.
// A relation is complete when the roads are chained end to end; adding every boarding point on
// those roads is separate, optional, and frequently skipped.
//
// That gap is what produced the reported Bella Vista to LPU Cavite trip. The Trece-bound jeepney
// from Bella Vista drives the length of Governor's Drive and passes LPU Cavite's door -- 8.4m from
// the straight line between the two stops the relation *does* list either side of it, Monterey
// Junction and an unnamed node 230m further west. But because LPU is not in that relation's stop
// list, the graph had no edge reaching it on that jeepney, and the only way to arrive was to
// change onto a Route 31 or Route 58 bus at Monterey Junction. The router was not being greedy;
// it was answering the only question the data let it answer. A commuter looking at the same road
// just stays seated.
//
// So a stop that sits inside a narrow corridor around the segment between two consecutive listed
// stops, and between them rather than beyond either end, is treated as served by that route. This
// is an inference, and it is a conservative one:
//   - the corridor is 40m, about one carriageway plus its shoulder, so a stop on a genuinely
//     different road cannot qualify;
//   - only gaps shorter than 2.5km are filled, because the straight line between two stops far
//     apart stops resembling the road that joins them;
//   - a stop the route already lists anywhere is never inserted, so this can only ever add a
//     stop the relation is silent about, and can never reorder one it names.
//
// On the live Cavite import this adds roughly 1,100 route/stop pairs across 118 of the 342 routes,
// which is the scale you would expect if incomplete stop lists were the norm rather than the
// exception. Nothing is written back to the database: this is a routing-time inference, and the
// tables stay a faithful record of what OSM actually says.

/** Half-width of the corridor around a segment. One carriageway plus a shoulder, not a whole road. */
export const PASSED_STOP_CORRIDOR_METERS = 40

/**
 * Longest gap between two listed stops that will be filled in.
 *
 * The test is against a straight line, and a straight line is only a good model of a road over a
 * short run. Past a couple of kilometres it starts cutting corners the vehicle actually drives
 * around, and a stop near the chord may be nowhere near the route.
 */
export const PASSED_STOP_MAX_CHORD_METERS = 2500

/** Keeps a projection clear of the segment's own endpoints, which are already in the sequence. */
const PASSED_STOP_END_MARGIN_METERS = 25

/** Coarse spatial buckets so a chord only tests the stops near it, not all ~800 of them. */
const GRID_CELL_DEGREES = 0.01

type StopGrid = Map<string, Stop[]>

function gridKey(lat: number, lon: number): string {
  return `${Math.floor(lat / GRID_CELL_DEGREES)}:${Math.floor(lon / GRID_CELL_DEGREES)}`
}

function buildStopGrid(stops: Stop[]): StopGrid {
  const grid: StopGrid = new Map()
  for (const stop of stops) {
    const key = gridKey(stop.lat, stop.lon)
    const bucket = grid.get(key)
    if (bucket === undefined) grid.set(key, [stop])
    else bucket.push(stop)
  }
  return grid
}

/** Every stop in the cells covering a bounding box. A superset of what is in the box, by design. */
function stopsInBox(grid: StopGrid, minLat: number, maxLat: number, minLon: number, maxLon: number): Stop[] {
  const found: Stop[] = []
  const latStart = Math.floor(minLat / GRID_CELL_DEGREES)
  const latEnd = Math.floor(maxLat / GRID_CELL_DEGREES)
  const lonStart = Math.floor(minLon / GRID_CELL_DEGREES)
  const lonEnd = Math.floor(maxLon / GRID_CELL_DEGREES)
  for (let latCell = latStart; latCell <= latEnd; latCell++) {
    for (let lonCell = lonStart; lonCell <= lonEnd; lonCell++) {
      const bucket = grid.get(`${latCell}:${lonCell}`)
      if (bucket !== undefined) found.push(...bucket)
    }
  }
  return found
}

/**
 * The stops a vehicle drives past between `from` and `to`, in the order it reaches them.
 *
 * `skip` holds every stop this route already accounts for -- the ones its relation lists, plus any
 * already inserted into an earlier gap. Excluding them is what guarantees this only ever refines a
 * sequence and never introduces a second visit to a stop, which would let an edge run backward.
 */
function stopsPassedBetween(from: Stop, to: Stop, grid: StopGrid, skip: ReadonlySet<string>): Stop[] {
  const chord: LatLng[] = [
    [from.lat, from.lon],
    [to.lat, to.lon],
  ]
  const chordMeters = haversineMeters(chord[0], chord[1])
  if (chordMeters < 1 || chordMeters > PASSED_STOP_MAX_CHORD_METERS) return []

  const index = buildRouteGeometry([{ path: chord }])
  // A degree of latitude is ~111km, so the corridor is a very small padding on the bounding box.
  const pad = PASSED_STOP_CORRIDOR_METERS / 111_000
  const nearby = stopsInBox(
    grid,
    Math.min(from.lat, to.lat) - pad,
    Math.max(from.lat, to.lat) + pad,
    Math.min(from.lon, to.lon) - pad,
    Math.max(from.lon, to.lon) + pad
  )

  const passed: { stop: Stop; alongMeters: number }[] = []
  for (const stop of nearby) {
    if (skip.has(stop.id)) continue
    const projection = projectOntoRoute(index, [stop.lat, stop.lon])
    if (projection === null) continue
    if (projection.offRouteMeters > PASSED_STOP_CORRIDOR_METERS) continue
    // `projectOntoRoute` clamps to the nearest end, so a stop beyond either end of the segment
    // reports a projection sitting exactly on that endpoint. The margin drops those instead of
    // stacking a zero-length hop onto a stop the sequence already has.
    const along = projection.distanceTraveledMeters
    if (along < PASSED_STOP_END_MARGIN_METERS) continue
    if (along > chordMeters - PASSED_STOP_END_MARGIN_METERS) continue
    passed.push({ stop, alongMeters: along })
  }

  return passed
    .sort((a, b) => (a.alongMeters !== b.alongMeters ? a.alongMeters - b.alongMeters : a.stop.id.localeCompare(b.stop.id)))
    .map((entry) => entry.stop)
}

/**
 * Builds the routable graph from the raw DB rows. Directed, one edge per adjacent stop pair per
 * route, following `route_stops.sequence` -- see the file header for why this doesn't also
 * generate a reverse edge the way the pilot network does. Stops outside `SERVICE_AREA` are
 * excluded, and an edge needs both of its stops inside to survive. Nothing here produces an edge
 * that runs against a sequence: the graph is strictly one-way per route row, and the return trip
 * is the paired route's own row.
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
  const { stops: servedStops, canonicalIdOf } = mergeSplitStops(tables.stops.filter(isInServiceArea))
  const nodes = servedStops.map(stopToNode)
  const stopsById = new Map(servedStops.map((stop) => [stop.id, stop]))
  /** Resolves a raw `route_stops.stop_id` to the merged node that now stands for that kerb. */
  const nodeForStopId = (stopId: string): Stop | undefined => stopsById.get(canonicalIdOf.get(stopId) ?? stopId)
  // Every stop, service area or not: the signboard names where the vehicle finishes, which is
  // often outside the planning box even when every hop we keep is inside it.
  const allStopsById = new Map(tables.stops.map((stop) => [stop.id, stop]))
  const geometryByRoute = new Map<string, DbRouteGeometry>(tables.routeGeometries.map((g) => [g.route_id, g]))
  // Built once for the whole network, then reused by every route's gap-filling pass.
  const stopGrid = buildStopGrid(servedStops)

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

    // The signboard is a property of the whole directed run, not of one hop, so it is derived
    // once from the ends of this row's sequence. Stops filtered out by SERVICE_AREA are still the
    // right thing to read here: a bus to Alabang is signed ALABANG whether or not Alabang is
    // inside the planning box.
    const firstName = allStopsById.get(sequence[0].stop_id)?.name ?? ""
    const lastName = allStopsById.get(sequence[sequence.length - 1].stop_id)?.name ?? ""
    const placardText = derivePlacardText(route, firstName, lastName)

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

    // Every node this route already accounts for. Seeded with the whole listed sequence so a
    // stop the relation names later can never be inserted into an earlier gap, and grown as gaps
    // are filled so one stop cannot be inserted into two of them.
    const accountedFor = new Set<string>()
    for (const routeStop of sequence) {
      const node = nodeForStopId(routeStop.stop_id)
      if (node !== undefined) accountedFor.add(node.id)
    }

    for (let i = 0; i < sequence.length - 1; i++) {
      const from = nodeForStopId(sequence[i].stop_id)
      const to = nodeForStopId(sequence[i + 1].stop_id)
      // A missing stop here means it was filtered out as outside the service area, so this leg
      // leaves the region -- skip it and keep the rest of the route's local hops.
      if (from === undefined || to === undefined) continue
      // Not a ride: either the sequence names the same node twice in a row (101 of the imported
      // sequences do, an OSM relation listing a node once per way that touches it), or the two
      // rows are the two kerbs of one stop and `mergeSplitStops` has just united them.
      if (from.id === to.id) continue

      // Stops the vehicle demonstrably drives past on this stretch but the relation never listed.
      const passed = stopsPassedBetween(from, to, stopGrid, accountedFor)
      for (const stop of passed) accountedFor.add(stop.id)

      const hops = [from, ...passed, to]
      for (let hop = 0; hop < hops.length - 1; hop++) {
        const hopFrom = hops[hop]
        const hopTo = hops[hop + 1]
        const road = sliceRoadBetweenStops(hopFrom, hopTo, polyline, projectionFor(hopFrom), projectionFor(hopTo))
        edges.push(buildEdge(route, hopFrom, hopTo, road, placardText))
      }
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
