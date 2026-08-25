// Deterministic, weighted Dijkstra routing engine for the CommuTayo Cavite pilot corridor.
// Source data: docs/cavite-network.md (Aguinaldo Highway corridor spec).

import { computeFare, marginalFare, type VehicleClass } from "@/utils/fares"
import { haversineMeters } from "@/utils/geo"

export type TransitMode = "jeepney" | "bus" | "uv_express" | "tricycle" | "walk"

export interface TransitNode {
  id: string
  name: string
  /** Short label for pickers and pins, where the full name does not fit on a phone. */
  shortName: string
  lat: number
  lng: number
  city: string
  isTerminal: boolean
  /**
   * Nicknames a commuter would actually type or say. Lives on the node, not in the search
   * component, so the search box and the network can never disagree about what "Rob Pala-Pala"
   * means.
   */
  aliases: string[]
  /** Exactly where to stand while waiting here. Answers "saan ako tatayo?" before any ride starts. */
  waitingSpot: string
}

export interface RouteSegmentEdge {
  fromNodeId: string
  toNodeId: string
  mode: TransitMode
  /** Fare bracket for this vehicle. Finer than `mode`: modern jeeps cost ₱2 more than traditional. */
  vehicleClass: VehicleClass
  /**
   * The physical service (one jeepney/bus route) this segment belongs to. Consecutive segments
   * sharing a serviceId are the same vehicle staying on the road, so they merge into one ride and
   * cost no transfer; a different serviceId means the commuter gets off and boards again.
   *
   * The seed graph gives every segment its own serviceId, because docs/cavite-network.md doesn't
   * record which routes run through. That's the conservative reading: it never promises a
   * through-ride that doesn't exist. Once real route data lands, give the segments of one route a
   * shared serviceId and they merge automatically.
   */
  serviceId: string
  /**
   * What is actually painted on the vehicle's acrylic signboard or windshield, in the direction
   * this segment travels. This is the thing a commuter scans a moving road for, so it is required
   * on every segment.
   */
  placardText: string
  /** Other boards that also serve this leg. Any of them is the right vehicle to flag down. */
  alternatePlacards: string[]
  /** Where to stand while waiting for this vehicle, copied from the boarding node. */
  boardingSpot: string
  fare: number
  /**
   * Set when this service charges one price for the whole ride regardless of distance, so merging
   * consecutive segments of it must not re-price by kilometer. Null means the fare matrix applies.
   *
   * Only meaningful when segments actually merge (see `serviceId`), which is why it carries the
   * *service's* pricing rule rather than this segment's computed `fare`.
   */
  flatFare: number | null
  durationMin: number
  /** Road distance in meters, from OSRM. Drives both the fare and the clock. */
  distanceMeters: number
  landmarkCues: string[]
  driverPhrase: string
  /** True when the phrase and cues come from docs/cavite-network.md; false when inferred. */
  landmarkVerified: boolean
  /** [lat, lng] tracing the real road between fromNode and toNode, endpoints included. */
  roadPath: [number, number][]
}

export interface RouteStep {
  mode: TransitMode
  vehicleClass: VehicleClass
  serviceId: string
  from: string
  to: string
  /** Stops passed through when consecutive segments merged into one ride. Empty for single hops. */
  viaStops: string[]
  /** The vehicle's signboard text for this leg. See `RouteSegmentEdge.placardText`. */
  placardText: string
  alternatePlacards: string[]
  /** Where to stand and wait before boarding this leg. */
  boardingSpot: string
  driverPhrase: string
  /** Landmark cues for the drop-off point. */
  landmarkCues: string[]
  /** `landmarkCues` joined with "; ", kept for plain-text callers. */
  landmark: string
  fare: number
  durationMin: number
  distanceMeters: number
  landmarkVerified: boolean
  /** [lat, lng] points tracing this step alone, boarding point through drop-off. */
  path: [number, number][]
}

export type RoutePriority = "cheapest" | "fastest" | "easiest"

export interface RouteResult {
  priority: RoutePriority
  /** Regular adult fare. Discounted fares are derived in src/utils/fares.ts. */
  totalFare: number
  totalDurationMin: number
  /** Vehicle boardings after the first. Walking legs are not boardings. */
  transferCount: number
  /** Minutes spent on foot across the whole route. */
  walkingMinutes: number
  /** 0-100, from how much of the route's landmark data is verified. See `computeConfidence`. */
  confidence: number
  steps: RouteStep[]
  /** [lat, lng] pairs tracing the route, one per node visited (origin through destination). */
  polylineCoordinates: [number, number][]
}

export interface TransitNetwork {
  nodes: TransitNode[]
  edges: RouteSegmentEdge[]
}

// ---------------------------------------------------------------------------
// Seed graph: Aguinaldo Highway pilot corridor
// ---------------------------------------------------------------------------

// Coordinates are the transit bay or pedestrian entrance a commuter actually stands at, not the
// centroid of the property. A mall centroid puts the pin in the middle of a building; the waiting
// shed is what someone walking with a phone needs to find.
export const CAVITE_PILOT_NODES: TransitNode[] = [
  {
    id: "st-dominic",
    name: "St. Dominic (Bacoor Longos)",
    shortName: "St. Dominic",
    lat: 14.4682,
    lng: 120.9634,
    city: "Bacoor",
    isTerminal: true,
    aliases: ["st dominic", "st. dominic", "saint dominic", "dominic", "bacoor", "longos", "bacoor longos"],
    waitingSpot: "Sa waiting shed tapat ng St. Dominic Savio Parish, sa southbound na gilid ng Aguinaldo Highway.",
  },
  {
    id: "imus-lumina",
    name: "Imus Lumina / Robinsons Imus",
    shortName: "Imus Lumina",
    lat: 14.4267,
    lng: 120.9405,
    city: "Imus",
    isTerminal: false,
    aliases: ["imus lumina", "robinsons imus", "rob imus", "lumina", "imus", "tanzang luma"],
    waitingSpot: "Sa ilalim ng Lumina overpass, tapat mismo ng entrance ng Robinsons Imus.",
  },
  {
    id: "robinsons-dasma",
    name: "Robinsons Place Dasmariñas",
    shortName: "Robinsons Dasma",
    lat: 14.3312,
    lng: 120.9575,
    city: "Dasmariñas",
    isTerminal: false,
    aliases: [
      "robinsons place dasmarinas",
      "robinsons dasmarinas",
      "robinsons dasma",
      "rob dasma",
      "robinsons",
      "salitran",
    ],
    waitingSpot: "Sa loading bay sa gilid ng Robinsons Place Dasmariñas, harap ng Aguinaldo Highway.",
  },
  {
    id: "sm-dasma",
    name: "SM City Dasmariñas",
    shortName: "SM Dasma",
    lat: 14.3005,
    lng: 120.9576,
    city: "Dasmariñas",
    isTerminal: false,
    aliases: ["sm city dasmarinas", "sm dasmarinas", "sm dasma", "sm", "hypermarket"],
    waitingSpot: "Sa main waiting shed ng SM City Dasmariñas, sa overpass tapat ng Hypermarket.",
  },
  {
    id: "pala-pala",
    name: "Pala-Pala Terminal",
    shortName: "Pala-Pala",
    lat: 14.2982,
    lng: 120.9568,
    city: "Dasmariñas",
    isTerminal: true,
    aliases: ["pala-pala", "pala pala", "palapala", "rob pala-pala", "rob pala pala", "dasma bayan"],
    waitingSpot: "Sa loob ng Pala-Pala terminal, sa hanay ng mga sasakyang papuntang General Trias.",
  },
  {
    id: "lpu-gentri",
    name: "LPU Cavite (General Trias)",
    shortName: "LPU Cavite",
    lat: 14.3168,
    lng: 120.9254,
    city: "General Trias",
    isTerminal: true,
    aliases: ["lpu cavite", "lpu gentri", "lpu gate", "general trias", "gen trias", "gentri", "lpu", "manggahan"],
    waitingSpot: "Sa tapat mismo ng LPU main gate sa Governor's Drive, katabi ng jeepney stand.",
  },
  {
    id: "silang-premier",
    name: "Silang Premier",
    shortName: "Silang",
    lat: 14.2341,
    lng: 120.9744,
    city: "Silang",
    isTerminal: true,
    aliases: ["silang premier", "silang", "silang bayan"],
    waitingSpot: "Sa waiting shed tapat ng Silang Premier outlet, sa southbound na gilid.",
  },
]

const NODE_COORDS = new Map<string, [number, number]>(CAVITE_PILOT_NODES.map((n) => [n.id, [n.lat, n.lng]]))

interface RoadSegment {
  /** Road distance in meters, straight from OSRM. */
  distanceMeters: number
  /** [lat, lng] following the actual road, first and last points pinned to the stop coordinates. */
  path: [number, number][]
}

// Real road geometry and road distance for each stop pair, fetched once from OSRM's public routing
// API (driving profile) and simplified with Ramer-Douglas-Peucker, so the map draws roads instead
// of straight lines and fares are metered on road kilometers, with no runtime network dependency.
// Keyed "fromId|toId"; the reverse direction is this path reversed at lookup time.
//
// Regenerate with scripts/fetch-roads.mjs whenever a seed node coordinate changes. These were
// refetched for the corrected transit-bay coordinates above.
const ROAD_SEGMENTS: Record<string, RoadSegment> = {
  "st-dominic|imus-lumina": { distanceMeters: 6755, path: [[14.4682,120.9634],[14.468332,120.963607],[14.467596,120.966743],[14.467116,120.967327],[14.465826,120.967934],[14.464591,120.967072],[14.46047,120.960743],[14.459685,120.959878],[14.458824,120.959308],[14.42292,120.9423],[14.427005,120.94134],[14.4267,120.9405]] },
  "imus-lumina|robinsons-dasma": { distanceMeters: 12293, path: [[14.4267,120.9405],[14.427005,120.94134],[14.42292,120.9423],[14.420855,120.941353],[14.419546,120.941087],[14.350405,120.937656],[14.350675,120.942286],[14.351403,120.943825],[14.351401,120.944181],[14.351018,120.944661],[14.349104,120.944982],[14.340292,120.948611],[14.331079,120.956681],[14.332063,120.957873],[14.331849,120.958049],[14.3312,120.9575]] },
  "robinsons-dasma|sm-dasma": { distanceMeters: 6520, path: [[14.3312,120.9575],[14.331099,120.957231],[14.330468,120.957781],[14.330209,120.95744],[14.329273,120.958265],[14.329078,120.958191],[14.328646,120.957564],[14.32804,120.955497],[14.32692,120.947196],[14.326751,120.940296],[14.3193,120.94243],[14.317735,120.943074],[14.31524,120.945148],[14.307598,120.952314],[14.304133,120.953851],[14.300736,120.95414],[14.298364,120.955267],[14.298907,120.958437],[14.299263,120.958442],[14.29984,120.957407],[14.300342,120.957709],[14.3005,120.9576]] },
  "sm-dasma|pala-pala": { distanceMeters: 1504, path: [[14.3005,120.9576],[14.301313,120.958376],[14.30289,120.956188],[14.302892,120.95596],[14.30221,120.955073],[14.301984,120.955081],[14.30166,120.955447],[14.30149,120.955302],[14.302039,120.954727],[14.302159,120.954008],[14.300649,120.954165],[14.298364,120.955267],[14.298607,120.956493],[14.298102,120.956571],[14.2982,120.9568]] },
  "pala-pala|lpu-gentri": { distanceMeters: 8699, path: [[14.2982,120.9568],[14.298102,120.956571],[14.298633,120.956449],[14.298416,120.955318],[14.300599,120.954299],[14.302166,120.954112],[14.302145,120.953894],[14.301988,120.953534],[14.300968,120.952758],[14.299962,120.951578],[14.294362,120.941301],[14.293582,120.936998],[14.292423,120.933831],[14.291816,120.930986],[14.291369,120.9267],[14.292106,120.923841],[14.295714,120.924594],[14.297444,120.924561],[14.307274,120.921347],[14.3081,120.920668],[14.309683,120.916812],[14.310321,120.916122],[14.311152,120.915833],[14.314756,120.915669],[14.316031,120.915419],[14.317677,120.915585],[14.318015,120.915921],[14.318129,120.916993],[14.318055,120.919859],[14.317549,120.920204],[14.317378,120.920679],[14.317519,120.921043],[14.317921,120.921263],[14.317051,120.924579],[14.316987,120.925588],[14.3168,120.9254]] },
  "pala-pala|silang-premier": { distanceMeters: 8083, path: [[14.2982,120.9568],[14.298102,120.956571],[14.298633,120.956449],[14.298364,120.955267],[14.295162,120.957273],[14.290716,120.958932],[14.284347,120.95976],[14.277298,120.964474],[14.273368,120.965615],[14.26962,120.967419],[14.262747,120.969102],[14.260007,120.970285],[14.259116,120.970836],[14.254926,120.97443],[14.253488,120.975355],[14.245119,120.975693],[14.238412,120.97633],[14.235713,120.976338],[14.235708,120.975791],[14.23422,120.975784],[14.2341,120.9744]] },
  "st-dominic|sm-dasma": { distanceMeters: 21164, path: [[14.4682,120.9634],[14.468332,120.963607],[14.467596,120.966743],[14.467116,120.967327],[14.465826,120.967934],[14.464591,120.967072],[14.46047,120.960743],[14.459685,120.959878],[14.458824,120.959308],[14.422558,120.942111],[14.420273,120.941184],[14.338713,120.937071],[14.33691,120.937383],[14.319387,120.942404],[14.317735,120.943074],[14.31524,120.945148],[14.307598,120.952314],[14.304133,120.953851],[14.300736,120.95414],[14.298364,120.955267],[14.298907,120.958437],[14.299263,120.958442],[14.29984,120.957407],[14.300342,120.957709],[14.3005,120.9576]] },
}

/** Looks up baked road geometry for an edge, direction-aware, with a straight-line fallback so a
 *  future edge that forgets to fetch geometry degrades instead of crashing. */
function roadSegmentFor(fromId: string, toId: string): RoadSegment {
  const forward = ROAD_SEGMENTS[`${fromId}|${toId}`]
  if (forward !== undefined) return forward

  const backward = ROAD_SEGMENTS[`${toId}|${fromId}`]
  if (backward !== undefined) return { distanceMeters: backward.distanceMeters, path: [...backward.path].reverse() }

  const fromCoord = NODE_COORDS.get(fromId)
  const toCoord = NODE_COORDS.get(toId)
  if (fromCoord === undefined || toCoord === undefined) return { distanceMeters: 0, path: [] }
  return { distanceMeters: Math.round(haversineMeters(fromCoord, toCoord)), path: [fromCoord, toCoord] }
}

// Arrival info ("sabihin kay Manong" cues) keyed by destination node, per docs/cavite-network.md.
// robinsons-dasma and silang-premier have no phrase in the source doc, so they are inferred to
// match the doc's naming pattern and flagged here for easy replacement with verified copy later.
const ARRIVAL_INFO: Record<string, { driverPhrase: string; landmarkCues: string[]; verified: boolean }> = {
  "st-dominic": {
    driverPhrase: "St. Dominic babaan po",
    landmarkCues: ["St. Dominic Savio Parish", "PITX-bound waiting shed"],
    verified: true,
  },
  "imus-lumina": {
    driverPhrase: "Lumina overpass po",
    landmarkCues: ["Lumina Mall footbridge", "Robinsons Imus signage"],
    verified: true,
  },
  // inferred, not in source doc
  "robinsons-dasma": {
    driverPhrase: "Robinsons Dasma po",
    landmarkCues: ["Robinsons Place Dasmariñas main entrance"],
    verified: false,
  },
  "sm-dasma": {
    driverPhrase: "SM Dasma tapat ng overpass po",
    landmarkCues: ["SM City Dasmariñas overpass", "Hypermarket entrance"],
    verified: true,
  },
  "pala-pala": {
    driverPhrase: "Pala-Pala terminal po",
    landmarkCues: ["Pala-Pala public market", "Terminal signage arch"],
    verified: true,
  },
  "lpu-gentri": {
    driverPhrase: "LPU Gate / Bayan po",
    landmarkCues: ["LPU Cavite main gate", "Manggahan jeepney stand"],
    verified: true,
  },
  // inferred, not in source doc
  "silang-premier": {
    driverPhrase: "Silang Premier tapat po",
    landmarkCues: ["Silang Premier outlet entrance"],
    verified: false,
  },
}

const WAITING_SPOT = new Map(CAVITE_PILOT_NODES.map((node) => [node.id, node.waitingSpot]))

// Corridor speeds in km/h. Grounded in a Manila transit study, scaled up for this lighter-traffic
// highway. Documented estimates, not measured, and the UI says so.
export const SPEED_KMH: Record<TransitMode, number> = {
  jeepney: 15,
  bus: 18,
  uv_express: 20,
  tricycle: 12,
  walk: 4.5,
}

/**
 * Two stops this close are a walk, never a fare. Boarding a jeepney to cross a terminal forecourt
 * charges a full base fare for two minutes of riding, which is exactly the trap this rule closes:
 * inside the radius the graph offers a free walking connection and no vehicle edge at all.
 */
export const WALKING_TRANSFER_RADIUS_METERS = 500

interface ServiceSpec {
  from: string
  to: string
  mode: TransitMode
  vehicleClass: VehicleClass
  /** Board text as painted for the `from` to `to` direction. */
  forwardPlacard: string
  /** Board text for the return direction. */
  backwardPlacard: string
  /** Other boards serving the same leg, either direction. Any of them is the right vehicle. */
  alternatePlacards?: string[]
  /** Pass a shared id to mark segments that a single vehicle runs through without re-boarding. */
  serviceId?: string
}

// Signboard texts follow the boards actually painted on vehicles along this corridor. They are
// inferred from corridor convention, not quoted from docs/cavite-network.md the way the driver
// phrases are, so treat them as the same grade of estimate as the fares.
const CORRIDOR_SERVICES: ServiceSpec[] = [
  {
    from: "st-dominic",
    to: "imus-lumina",
    mode: "jeepney",
    vehicleClass: "jeepney_traditional",
    forwardPlacard: "IMUS / TANZANG LUMA",
    backwardPlacard: "ZAPOTE / BACLARAN",
  },
  {
    from: "st-dominic",
    to: "imus-lumina",
    mode: "bus",
    vehicleClass: "bus",
    forwardPlacard: "DASMARIÑAS - BACLARAN",
    backwardPlacard: "BACLARAN - DASMARIÑAS",
  },
  {
    from: "imus-lumina",
    to: "robinsons-dasma",
    mode: "jeepney",
    vehicleClass: "jeepney_traditional",
    forwardPlacard: "DASMARIÑAS / SALITRAN",
    backwardPlacard: "IMUS / ZAPOTE",
  },
  {
    from: "imus-lumina",
    to: "robinsons-dasma",
    mode: "bus",
    vehicleClass: "bus",
    forwardPlacard: "DASMARIÑAS - BACLARAN",
    backwardPlacard: "BACLARAN - DASMARIÑAS",
  },
  {
    from: "robinsons-dasma",
    to: "sm-dasma",
    mode: "jeepney",
    vehicleClass: "jeepney_traditional",
    forwardPlacard: "PALA-PALA / SM DASMA",
    backwardPlacard: "SALITRAN / ROBINSONS",
  },
  {
    from: "robinsons-dasma",
    to: "sm-dasma",
    mode: "bus",
    vehicleClass: "bus",
    forwardPlacard: "DASMARIÑAS - BACLARAN",
    backwardPlacard: "BACLARAN - DASMARIÑAS",
  },
  // Inside the walking radius, so the rule below strips these two and leaves the free walk.
  // Declared anyway: they document that vehicles do run this hop, and deleting them by hand would
  // hide the very thing the rule exists to correct.
  {
    from: "sm-dasma",
    to: "pala-pala",
    mode: "jeepney",
    vehicleClass: "jeepney_traditional",
    forwardPlacard: "PALA-PALA / DASMA BAYAN",
    backwardPlacard: "SM DASMA / SALITRAN",
  },
  {
    from: "sm-dasma",
    to: "pala-pala",
    mode: "bus",
    vehicleClass: "bus",
    forwardPlacard: "DASMARIÑAS - BACLARAN",
    backwardPlacard: "BACLARAN - DASMARIÑAS",
  },
  {
    from: "pala-pala",
    to: "lpu-gentri",
    mode: "jeepney",
    vehicleClass: "jeepney_traditional",
    forwardPlacard: "MANGGAHAN / GOV. DRIVE",
    backwardPlacard: "PALA-PALA / DASMA BAYAN",
    alternatePlacards: ["TRECE / INDANG / DBB-C"],
  },
  {
    from: "pala-pala",
    to: "lpu-gentri",
    mode: "tricycle",
    vehicleClass: "tricycle",
    forwardPlacard: "TODA: PALA-PALA / LPU GATE",
    backwardPlacard: "TODA: LPU GATE / PALA-PALA",
  },
  {
    from: "pala-pala",
    to: "silang-premier",
    mode: "bus",
    vehicleClass: "bus",
    forwardPlacard: "SILANG / TAGAYTAY",
    backwardPlacard: "DASMARIÑAS / PALA-PALA",
  },
  // The doc describes Silang Premier as served by modern jeeps, which carry the ₱15 base fare.
  {
    from: "pala-pala",
    to: "silang-premier",
    mode: "jeepney",
    vehicleClass: "jeepney_modern",
    forwardPlacard: "SILANG BAYAN",
    backwardPlacard: "PALA-PALA / DASMA BAYAN",
  },
  {
    from: "st-dominic",
    to: "sm-dasma",
    mode: "uv_express",
    vehicleClass: "uv_express",
    forwardPlacard: "DASMARIÑAS - PITX",
    backwardPlacard: "PITX - DASMARIÑAS",
  },
]

/**
 * Builds the two directed edges for one service. Fare comes from the LTFRB matrix in fares.ts
 * applied to real road kilometers, and duration from the corridor speed table, so no number in
 * the graph is hand-typed and able to drift from the rules that produced it.
 */
function edgePair(spec: ServiceSpec): [RouteSegmentEdge, RouteSegmentEdge] {
  const { from: fromId, to: toId, mode, vehicleClass } = spec
  const serviceId = spec.serviceId ?? `${mode}:${fromId}:${toId}`
  const alternatePlacards = spec.alternatePlacards ?? []

  const road = roadSegmentFor(fromId, toId)
  const distanceKm = road.distanceMeters / 1000
  const fare = computeFare(vehicleClass, distanceKm)
  const durationMin = Math.max(1, Math.round((distanceKm / SPEED_KMH[mode]) * 60))

  const shared = {
    mode,
    vehicleClass,
    serviceId,
    alternatePlacards,
    fare,
    // The matrix in fares.ts already prices uv_express and tricycle as flat by vehicle class, so
    // the pilot has no per-service override to record here.
    flatFare: null,
    durationMin,
    distanceMeters: road.distanceMeters,
  }

  const forwardArrival = ARRIVAL_INFO[toId]
  const backwardArrival = ARRIVAL_INFO[fromId]

  return [
    {
      ...shared,
      fromNodeId: fromId,
      toNodeId: toId,
      placardText: spec.forwardPlacard,
      boardingSpot: WAITING_SPOT.get(fromId) ?? "",
      landmarkCues: forwardArrival.landmarkCues,
      driverPhrase: forwardArrival.driverPhrase,
      landmarkVerified: forwardArrival.verified,
      roadPath: road.path,
    },
    {
      ...shared,
      fromNodeId: toId,
      toNodeId: fromId,
      placardText: spec.backwardPlacard,
      boardingSpot: WAITING_SPOT.get(toId) ?? "",
      landmarkCues: backwardArrival.landmarkCues,
      driverPhrase: backwardArrival.driverPhrase,
      landmarkVerified: backwardArrival.verified,
      roadPath: [...road.path].reverse(),
    },
  ]
}

/** Both directed keys for a node pair, so a lookup does not care which way an edge points. */
function pairKey(a: string, b: string): string {
  return `${a}|${b}`
}

/** Node pairs close enough that walking beats paying. See `WALKING_TRANSFER_RADIUS_METERS`. */
function findWalkablePairs(nodes: TransitNode[]): { fromId: string; toId: string; meters: number }[] {
  const pairs: { fromId: string; toId: string; meters: number }[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const meters = haversineMeters([a.lat, a.lng], [b.lat, b.lng])
      if (meters <= WALKING_TRANSFER_RADIUS_METERS) pairs.push({ fromId: a.id, toId: b.id, meters })
    }
  }
  return pairs
}

/** A free, on-foot connection between two adjacent stops: straight line, no fare, no boarding. */
function walkEdgePair(fromId: string, toId: string, meters: number): [RouteSegmentEdge, RouteSegmentEdge] {
  const fromCoord = NODE_COORDS.get(fromId) ?? [0, 0]
  const toCoord = NODE_COORDS.get(toId) ?? [0, 0]
  const durationMin = Math.max(1, Math.round((meters / 1000 / SPEED_KMH.walk) * 60))

  // Straight line on purpose. The road geometry between two stops this close is a vehicle detour
  // around a divided highway, and tracing a 1.5 km car loop as a 270 m walk would be a lie.
  const shared = {
    mode: "walk" as const,
    vehicleClass: "walk" as const,
    serviceId: `walk:${fromId}:${toId}`,
    placardText: "",
    alternatePlacards: [],
    fare: 0,
    // Walking is free however far it goes, and consecutive walks do merge, so this has to be flat
    // rather than fall through to a per-kilometer recompute.
    flatFare: 0,
    durationMin,
    distanceMeters: Math.round(meters),
  }

  return [
    {
      ...shared,
      fromNodeId: fromId,
      toNodeId: toId,
      boardingSpot: WAITING_SPOT.get(fromId) ?? "",
      landmarkCues: ARRIVAL_INFO[toId].landmarkCues,
      driverPhrase: ARRIVAL_INFO[toId].driverPhrase,
      landmarkVerified: ARRIVAL_INFO[toId].verified,
      roadPath: [fromCoord, toCoord] as [number, number][],
    },
    {
      ...shared,
      fromNodeId: toId,
      toNodeId: fromId,
      boardingSpot: WAITING_SPOT.get(toId) ?? "",
      landmarkCues: ARRIVAL_INFO[fromId].landmarkCues,
      driverPhrase: ARRIVAL_INFO[fromId].driverPhrase,
      landmarkVerified: ARRIVAL_INFO[fromId].verified,
      roadPath: [toCoord, fromCoord] as [number, number][],
    },
  ]
}

/**
 * Walking-first rule. For every pair of stops inside `WALKING_TRANSFER_RADIUS_METERS`, drops every
 * vehicle edge between them and guarantees a free walking edge instead, so the planner can never
 * charge a base fare for a two-minute hop between adjacent terminals.
 */
export function applyWalkingFirstRule(nodes: TransitNode[], edges: RouteSegmentEdge[]): RouteSegmentEdge[] {
  const walkable = findWalkablePairs(nodes)
  if (walkable.length === 0) return edges

  const walkableKeys = new Set<string>()
  for (const pair of walkable) {
    walkableKeys.add(pairKey(pair.fromId, pair.toId))
    walkableKeys.add(pairKey(pair.toId, pair.fromId))
  }

  const kept = edges.filter((edge) => !walkableKeys.has(pairKey(edge.fromNodeId, edge.toNodeId)))
  const walks = walkable.flatMap((pair) => walkEdgePair(pair.fromId, pair.toId, pair.meters))
  return [...kept, ...walks]
}

export const CAVITE_PILOT_EDGES: RouteSegmentEdge[] = applyWalkingFirstRule(
  CAVITE_PILOT_NODES,
  CORRIDOR_SERVICES.flatMap(edgePair)
)

const CAVITE_PILOT_NETWORK: TransitNetwork = {
  nodes: CAVITE_PILOT_NODES,
  edges: CAVITE_PILOT_EDGES,
}

export default CAVITE_PILOT_NETWORK

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

// Artificial cost charged for changing vehicles, on top of whatever the change costs in time or
// money. Every priority pays it, because a transfer is expensive in ways no column in the database
// records: you stand up, you wait for a vehicle that may not come, you flag it down, you pay a
// second base fare, and you carry your bags across a highway to do it.
//
// Without this the router happily sold a second boarding to save ninety seconds. On the reported
// Bella Vista to LPU Cavite trip that is exactly what it did -- it proposed getting off at
// Monterey Junction and catching a second vehicle, which no local commuter would ever do. Fifteen
// minutes is the number a rider behaves as if a transfer costs, not the number a stopwatch reads.
const TRANSFER_PENALTY_MIN = 15

// "Easiest" exists to avoid transfers at any reasonable price, so it has to stay strictly more
// transfer-averse than "fastest" now that "fastest" pays a penalty too. Were both 15, the two tabs
// would optimise the same quantity and collapse into the same answer on almost every trip.
const EASIEST_TRANSFER_PENALTY_MIN = 25

const WALK_PENALTY_MIN = 10

// The same idea in pesos, for "cheapest", whose weight is a bill rather than a clock.
//
// Deliberately smaller than any base fare (the cheapest is the tricycle's). `cheapestWeight`
// already charges a full base fare on every boarding, so cheapest is *already* minimising base
// fares; this is the tiebreaker on top, and keeping it under one base fare is what stops it from
// overriding a genuinely cheaper itinerary and turning this tab into a second copy of "easiest".
const TRANSFER_PENALTY_PESOS = 6

type WeightFn = (edge: RouteSegmentEdge, previousServiceId: string | null) => number

/**
 * Costs a segment at what it actually adds to the bill: the full fare when it means boarding
 * something, and only the per-kilometer increment when the commuter is already on that vehicle.
 *
 * Summing `edge.fare` unconditionally would charge a base fare at every intermediate stop, which
 * made "cheapest" hunt for routes with few *segments* rather than few *boardings* -- on the live
 * OSM network that produced the plainly wrong result of the cheapest tab (₱92) quoting more than
 * the easiest tab (₱80). Mirrors how `buildRouteResult` prices a merged ride, so the number the
 * search optimises and the number the commuter is shown are the same quantity.
 *
 * No effect on the pilot corridor: no two of its vehicle segments share a serviceId, so nothing
 * ever continues a ride there and this always takes the full-fare branch.
 */
function cheapestWeight(edge: RouteSegmentEdge, previousServiceId: string | null): number {
  const continuingRide = previousServiceId !== null && previousServiceId === edge.serviceId
  // Boarding: the full fare, plus the standing penalty for having had to board at all. The very
  // first boarding of a trip is unavoidable, so it is not penalised.
  if (!continuingRide) return edge.fare + (previousServiceId === null ? 0 : TRANSFER_PENALTY_PESOS)
  if (edge.flatFare !== null) return 0
  return marginalFare(edge.vehicleClass, edge.distanceMeters / 1000)
}

function fastestWeight(edge: RouteSegmentEdge, previousServiceId: string | null): number {
  const isTransfer = previousServiceId !== null && previousServiceId !== edge.serviceId
  return edge.durationMin + (isTransfer ? TRANSFER_PENALTY_MIN : 0)
}

// Penalizes a change of *service*, not just a change of mode: hopping from one jeepney to another
// jeepney is a real transfer for the commuter even though the vehicle type never changed.
function easiestWeight(edge: RouteSegmentEdge, previousServiceId: string | null): number {
  const isTransfer = previousServiceId !== null && previousServiceId !== edge.serviceId
  const walkPenalty = edge.mode === "walk" ? WALK_PENALTY_MIN : 0
  return edge.durationMin + (isTransfer ? EASIEST_TRANSFER_PENALTY_MIN : 0) + walkPenalty
}

function weightFnFor(priority: RoutePriority): WeightFn {
  switch (priority) {
    case "cheapest":
      return cheapestWeight
    case "fastest":
      return fastestWeight
    case "easiest":
      return easiestWeight
  }
}

interface HeapEntry {
  key: string
  cost: number
  seq: number
}

// Binary min-heap ordered by (cost, insertion order) so results are deterministic across runs.
class MinHeap {
  private items: HeapEntry[] = []

  get size(): number {
    return this.items.length
  }

  push(entry: HeapEntry): void {
    this.items.push(entry)
    this.bubbleUp(this.items.length - 1)
  }

  pop(): HeapEntry | undefined {
    const top = this.items[0]
    const last = this.items.pop()
    if (top === undefined) return undefined
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last
      this.bubbleDown(0)
    }
    return top
  }

  private compare(a: HeapEntry, b: HeapEntry): number {
    return a.cost !== b.cost ? a.cost - b.cost : a.seq - b.seq
  }

  private bubbleUp(index: number): void {
    let i = index
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.compare(this.items[i], this.items[parent]) >= 0) break
      ;[this.items[i], this.items[parent]] = [this.items[parent], this.items[i]]
      i = parent
    }
  }

  private bubbleDown(index: number): void {
    let i = index
    const n = this.items.length
    while (true) {
      const left = i * 2 + 1
      const right = i * 2 + 2
      let smallest = i
      if (left < n && this.compare(this.items[left], this.items[smallest]) < 0) smallest = left
      if (right < n && this.compare(this.items[right], this.items[smallest]) < 0) smallest = right
      if (smallest === i) break
      ;[this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]]
      i = smallest
    }
  }
}

interface DijkstraState {
  nodeId: string
  lastServiceId: string | null
}

function stateKey(state: DijkstraState): string {
  return `${state.nodeId}::${state.lastServiceId ?? ""}`
}

function buildAdjacency(edges: RouteSegmentEdge[]): Map<string, RouteSegmentEdge[]> {
  const adjacency = new Map<string, RouteSegmentEdge[]>()
  for (const edge of edges) {
    const bucket = adjacency.get(edge.fromNodeId)
    if (bucket === undefined) adjacency.set(edge.fromNodeId, [edge])
    else bucket.push(edge)
  }
  return adjacency
}

// Dijkstra over a state-expanded graph (node + last-used service) so the "easiest" weight function
// can penalize transfers without turning the search into a non-shortest-path problem. Edge
// iteration order follows the seed array (fixed), and heap ties break on insertion order, so
// results are deterministic across runs.
function runDijkstra(
  network: TransitNetwork,
  originId: string,
  destinationId: string,
  weightFn: WeightFn
): RouteSegmentEdge[] | null {
  const adjacency = buildAdjacency(network.edges)
  const dist = new Map<string, number>()
  const prevEdge = new Map<string, RouteSegmentEdge>()
  const prevStateKey = new Map<string, string>()
  const stateOf = new Map<string, DijkstraState>()
  const visited = new Set<string>()
  const heap = new MinHeap()
  let seq = 0

  const startState: DijkstraState = { nodeId: originId, lastServiceId: null }
  const startKey = stateKey(startState)
  dist.set(startKey, 0)
  stateOf.set(startKey, startState)
  heap.push({ key: startKey, cost: 0, seq: seq++ })

  let goalKey: string | null = null

  while (heap.size > 0) {
    const current = heap.pop()
    if (current === undefined || visited.has(current.key)) continue
    visited.add(current.key)

    const state = stateOf.get(current.key)
    if (state === undefined) continue
    if (state.nodeId === destinationId) {
      goalKey = current.key
      break
    }

    const edges = adjacency.get(state.nodeId) ?? []
    for (const edge of edges) {
      const nextState: DijkstraState = { nodeId: edge.toNodeId, lastServiceId: edge.serviceId }
      const nextKey = stateKey(nextState)
      if (visited.has(nextKey)) continue

      const newCost = current.cost + weightFn(edge, state.lastServiceId)
      const known = dist.get(nextKey)
      if (known === undefined || newCost < known) {
        dist.set(nextKey, newCost)
        prevEdge.set(nextKey, edge)
        prevStateKey.set(nextKey, current.key)
        stateOf.set(nextKey, nextState)
        heap.push({ key: nextKey, cost: newCost, seq: seq++ })
      }
    }
  }

  if (goalKey === null) return null

  const path: RouteSegmentEdge[] = []
  let key: string | undefined = goalKey
  while (key !== undefined && prevEdge.has(key)) {
    const edge = prevEdge.get(key)
    if (edge !== undefined) path.unshift(edge)
    key = prevStateKey.get(key)
  }
  return path
}

/**
 * Two consecutive segments are one ride, not two, when the commuter never gets off. That's true
 * when they share a service, and always true for walking (a walk through an interchange is one
 * continuous walk). Anything else means standing up, paying again, and boarding something new.
 */
function isSameRide(previous: RouteSegmentEdge, next: RouteSegmentEdge): boolean {
  if (previous.mode !== next.mode) return false
  return next.mode === "walk" || previous.serviceId === next.serviceId
}

/**
 * Route confidence, 0-100, grounded in the repo's own data provenance: it starts from how many of
 * the route's drop-off cues are quoted from docs/cavite-network.md versus inferred, then deducts
 * for the things that go wrong on the ground. Every transfer is a ride that might not show up, and
 * every walking leg is a stretch with no signboard to follow.
 */
export function computeConfidence(steps: RouteStep[], transferCount: number): number {
  if (steps.length === 0) return 0
  const verifiedShare = steps.filter((step) => step.landmarkVerified).length / steps.length
  const walkLegs = steps.filter((step) => step.mode === "walk").length
  const raw = 60 + 35 * verifiedShare - transferCount * 4 - walkLegs * 3
  return Math.max(40, Math.min(99, Math.round(raw)))
}

function buildRouteResult(
  network: TransitNetwork,
  priority: RoutePriority,
  path: RouteSegmentEdge[],
  originId: string
): RouteResult {
  const nodesById = new Map(network.nodes.map((n) => [n.id, n]))

  const nodeOrThrow = (nodeId: string): TransitNode => {
    const node = nodesById.get(nodeId)
    if (node === undefined) throw new Error(`Edge references an unknown node: ${nodeId}`)
    return node
  }

  const originNode = nodesById.get(originId)
  const polylineCoordinates: [number, number][] = originNode !== undefined ? [[originNode.lat, originNode.lng]] : []

  const steps: RouteStep[] = []
  let previousEdge: RouteSegmentEdge | null = null

  for (const edge of path) {
    const fromNode = nodeOrThrow(edge.fromNodeId)
    const toNode = nodeOrThrow(edge.toNodeId)
    const toCoord: [number, number] = [toNode.lat, toNode.lng]

    // Extend the ride in progress rather than starting a new one: the commuter stays seated, so
    // this is one leg with a longer fare, a longer clock, and a later drop-off.
    if (previousEdge !== null && isSameRide(previousEdge, edge)) {
      const current = steps[steps.length - 1]
      current.viaStops.push(fromNode.name)
      current.to = toNode.name
      current.placardText = edge.placardText
      current.alternatePlacards = edge.alternatePlacards
      current.driverPhrase = edge.driverPhrase
      current.landmarkCues = edge.landmarkCues
      current.landmark = edge.landmarkCues.join("; ")
      current.landmarkVerified = current.landmarkVerified && edge.landmarkVerified
      current.durationMin += edge.durationMin
      current.distanceMeters += edge.distanceMeters
      // Re-price the whole ride off its accumulated distance instead of adding the segments'
      // fares together. Each segment's own fare includes the base fare, and the base fare is paid
      // once per boarding, not once per stop the vehicle passes -- summing them charged a 20-stop
      // bus ride twenty base fares. Invisible on the pilot corridor, where no two segments share a
      // serviceId so nothing merges, and glaring on the OSM network, where a whole route is one
      // service: a PITX-Dasmariñas ride came out at ₱293 against a matrix fare of ₱92.
      current.fare = edge.flatFare ?? computeFare(current.vehicleClass, current.distanceMeters / 1000)
      // Skip the road path's first point: it's the shared node the previous edge's road path
      // already ends on, and repeating it would draw a zero-length kink in the merged line.
      current.path.push(...edge.roadPath.slice(1))
    } else {
      steps.push({
        mode: edge.mode,
        vehicleClass: edge.vehicleClass,
        serviceId: edge.serviceId,
        from: fromNode.name,
        to: toNode.name,
        viaStops: [],
        placardText: edge.placardText,
        alternatePlacards: edge.alternatePlacards,
        boardingSpot: edge.boardingSpot,
        driverPhrase: edge.driverPhrase,
        landmarkCues: edge.landmarkCues,
        landmark: edge.landmarkCues.join("; "),
        fare: edge.fare,
        durationMin: edge.durationMin,
        distanceMeters: edge.distanceMeters,
        landmarkVerified: edge.landmarkVerified,
        path: edge.roadPath.length > 0 ? [...edge.roadPath] : [[fromNode.lat, fromNode.lng], toCoord],
      })
    }

    previousEdge = edge
    polylineCoordinates.push(toCoord)
  }

  const totalFare = steps.reduce((sum, step) => sum + step.fare, 0)
  const totalDurationMin = steps.reduce((sum, step) => sum + step.durationMin, 0)
  const walkingMinutes = steps.filter((s) => s.mode === "walk").reduce((sum, step) => sum + step.durationMin, 0)

  // A transfer is a boarding after the first one. Walking isn't a boarding, so a jeep, walk, jeep
  // route is one transfer (two vehicles), not two.
  const vehicleSteps = steps.filter((step) => step.mode !== "walk").length
  const transferCount = Math.max(0, vehicleSteps - 1)

  return {
    priority,
    totalFare,
    totalDurationMin,
    transferCount,
    walkingMinutes,
    confidence: computeConfidence(steps, transferCount),
    steps,
    polylineCoordinates,
  }
}

export function findRoute(
  network: TransitNetwork,
  originId: string,
  destinationId: string,
  priority: RoutePriority
): RouteResult | null {
  const weightFn = weightFnFor(priority)
  const path = runDijkstra(network, originId, destinationId, weightFn)
  if (path === null) return null
  return buildRouteResult(network, priority, path, originId)
}

// Finds routes for all three priorities over the default Cavite pilot seed graph.
export function findRoutes(originId: string, destId: string): Record<RoutePriority, RouteResult | null> {
  return {
    cheapest: findRoute(CAVITE_PILOT_NETWORK, originId, destId, "cheapest"),
    fastest: findRoute(CAVITE_PILOT_NETWORK, originId, destId, "fastest"),
    easiest: findRoute(CAVITE_PILOT_NETWORK, originId, destId, "easiest"),
  }
}
