// Deterministic, weighted Dijkstra routing engine for the CommuTayo Cavite pilot corridor.
// Source data: docs/cavite-network.md (Aguinaldo Highway corridor spec).

export type TransitMode = "jeepney" | "bus" | "uv_express" | "tricycle" | "walk"

export interface TransitNode {
  id: string
  name: string
  lat: number
  lng: number
  city: string
  isTerminal: boolean
}

export interface RouteSegmentEdge {
  fromNodeId: string
  toNodeId: string
  mode: TransitMode
  /**
   * The physical service (one jeepney/bus route) this segment belongs to. Consecutive segments
   * sharing a serviceId are the same vehicle staying on the road, so they merge into one ride and
   * cost no transfer; a different serviceId means the commuter gets off and boards again.
   *
   * The seed graph gives every segment its own serviceId, because docs/cavite-network.md doesn't
   * record which routes run through. That's the conservative reading — it never promises a
   * through-ride that doesn't exist. Once real route data lands, give the segments of one route a
   * shared serviceId and they merge automatically.
   */
  serviceId: string
  signboard: string
  fare: number
  durationMin: number
  landmarkCues: string[]
  driverPhrase: string
  /** True when the phrase and cues come from docs/cavite-network.md; false when inferred. */
  landmarkVerified: boolean
  /** [lat, lng] tracing the real road between fromNode and toNode, endpoints included. */
  roadPath: [number, number][]
}

export interface RouteStep {
  mode: TransitMode
  serviceId: string
  from: string
  to: string
  /** Stops passed through when consecutive segments merged into one ride. Empty for single hops. */
  viaStops: string[]
  signboard: string
  driverPhrase: string
  /** Landmark cues for the drop-off point. */
  landmarkCues: string[]
  /** `landmarkCues` joined with "; ", kept for plain-text callers. */
  landmark: string
  fare: number
  durationMin: number
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

export const CAVITE_PILOT_NODES: TransitNode[] = [
  { id: "st-dominic", name: "St. Dominic (Bacoor)", lat: 14.4503, lng: 120.9492, city: "Bacoor", isTerminal: true },
  { id: "imus-lumina", name: "Imus Lumina / Robinsons Imus", lat: 14.4267, lng: 120.9388, city: "Imus", isTerminal: false },
  { id: "robinsons-dasma", name: "Robinsons Place Dasmariñas", lat: 14.3312, lng: 120.9575, city: "Dasmariñas", isTerminal: false },
  { id: "sm-dasma", name: "SM City Dasmariñas", lat: 14.3218, lng: 120.9634, city: "Dasmariñas", isTerminal: false },
  { id: "pala-pala", name: "Pala-Pala Terminal", lat: 14.3167, lng: 120.965, city: "Dasmariñas", isTerminal: true },
  { id: "lpu-gentri", name: "LPU Cavite (General Trias)", lat: 14.3056, lng: 120.8992, city: "General Trias", isTerminal: true },
  { id: "silang-premier", name: "Silang Premier", lat: 14.2341, lng: 120.9744, city: "Silang", isTerminal: true },
]

const NODE_COORDS = new Map<string, [number, number]>(CAVITE_PILOT_NODES.map((n) => [n.id, [n.lat, n.lng]]))

// Real road geometry for each stop pair, fetched once from OSRM's public routing API (driving
// profile, simplified with Ramer-Douglas-Peucker) and baked in here so the map draws roads instead
// of straight lines, with no runtime network dependency. Keyed by "fromId|toId"; the reverse
// direction is this array reversed at lookup time. Re-fetch and re-paste if the seed node
// coordinates ever change.
const ROAD_PATHS: Record<string, [number, number][]> = {
  "st-dominic|imus-lumina": [[14.450302,120.949189],[14.449971,120.949146],[14.449724,120.949422],[14.449687,120.949631],[14.449522,120.949648],[14.4485,120.949522],[14.446908,120.948966],[14.446202,120.948921],[14.445307,120.952837],[14.444071,120.952319],[14.422649,120.94216],[14.426463,120.938417],[14.426522,120.938478]],
  "imus-lumina|robinsons-dasma": [[14.426522,120.938478],[14.426463,120.938417],[14.422595,120.942131],[14.420855,120.941353],[14.419546,120.941087],[14.350405,120.937656],[14.350675,120.942286],[14.351403,120.943825],[14.351401,120.944181],[14.351018,120.944661],[14.350676,120.944831],[14.349982,120.944744],[14.349104,120.944982],[14.340292,120.948611],[14.331079,120.956681],[14.332063,120.957873],[14.331849,120.958049],[14.3313,120.957409]],
  "robinsons-dasma|sm-dasma": [[14.3313,120.957409],[14.331099,120.957231],[14.330468,120.957781],[14.330209,120.95744],[14.323423,120.963397],[14.320445,120.96378],[14.320432,120.963626],[14.321357,120.963521],[14.321341,120.963357],[14.321623,120.963415],[14.321951,120.963298],[14.321786,120.963243]],
  "sm-dasma|pala-pala": [[14.321786,120.963243],[14.322517,120.96325],[14.322538,120.963553],[14.318585,120.964003],[14.316433,120.964908],[14.316498,120.965085],[14.316701,120.965002]],
  "pala-pala|lpu-gentri": [[14.316701,120.965002],[14.317343,120.96481],[14.317626,120.965541],[14.317777,120.965473],[14.318142,120.966417],[14.318296,120.966369],[14.318214,120.966388],[14.317522,120.964662],[14.317636,120.964483],[14.318587,120.964085],[14.323401,120.963487],[14.32921,120.958436],[14.3286,120.957423],[14.32804,120.955497],[14.327816,120.954081],[14.32692,120.947196],[14.326801,120.940354],[14.3193,120.94243],[14.317735,120.943074],[14.31524,120.945148],[14.307598,120.952314],[14.304133,120.953851],[14.30264,120.953983],[14.301167,120.952945],[14.300026,120.951681],[14.294493,120.941653],[14.293838,120.938763],[14.293582,120.936998],[14.292557,120.934273],[14.291875,120.931405],[14.291619,120.928188],[14.291367,120.926773],[14.292173,120.923303],[14.29223,120.915879],[14.292135,120.911132],[14.29322,120.910566],[14.295504,120.908769],[14.298649,120.906707],[14.3045,120.90319],[14.306404,120.901007],[14.305774,120.900488],[14.305904,120.900214],[14.305869,120.899688],[14.305696,120.89971],[14.30573,120.899401],[14.305587,120.899415],[14.305615,120.899216]],
  "pala-pala|silang-premier": [[14.316701,120.965002],[14.317343,120.96481],[14.317626,120.965541],[14.317777,120.965473],[14.318262,120.966736],[14.318314,120.967408],[14.317836,120.967421],[14.315366,120.967988],[14.314481,120.965707],[14.310962,120.96722],[14.30662,120.970589],[14.304056,120.9764],[14.303271,120.977065],[14.301574,120.977865],[14.301276,120.978136],[14.299513,120.981214],[14.299321,120.981344],[14.298416,120.98119],[14.296729,120.979933],[14.295862,120.979452],[14.295488,120.979548],[14.294655,120.980814],[14.294361,120.980897],[14.293427,120.980833],[14.292665,120.980481],[14.292242,120.980506],[14.291744,120.980197],[14.29114,120.980504],[14.290555,120.980403],[14.29063,120.975641],[14.290772,120.974615],[14.291485,120.973309],[14.293358,120.971992],[14.293506,120.971635],[14.293444,120.97051],[14.292862,120.970468],[14.292496,120.970307],[14.290182,120.967785],[14.289619,120.965714],[14.288253,120.963582],[14.287901,120.961671],[14.287265,120.960288],[14.287082,120.959332],[14.284766,120.959622],[14.284269,120.959799],[14.277298,120.964474],[14.273368,120.965615],[14.269472,120.967467],[14.262747,120.969102],[14.261443,120.969574],[14.259218,120.970756],[14.254926,120.97443],[14.254003,120.97513],[14.253488,120.975355],[14.251918,120.975524],[14.245119,120.975693],[14.24174,120.975933],[14.238412,120.97633],[14.235713,120.976338],[14.235708,120.975791],[14.23422,120.975784],[14.234118,120.974399]],
  "st-dominic|sm-dasma": [[14.450302,120.949189],[14.449971,120.949146],[14.449724,120.949422],[14.449687,120.949631],[14.449522,120.949648],[14.4485,120.949522],[14.446908,120.948966],[14.446202,120.948921],[14.445307,120.952837],[14.421428,120.941584],[14.419873,120.941118],[14.350405,120.937656],[14.350675,120.942286],[14.351403,120.943825],[14.351401,120.944181],[14.351018,120.944661],[14.350676,120.944831],[14.349982,120.944744],[14.349104,120.944982],[14.340292,120.948611],[14.323493,120.963347],[14.32314,120.963493],[14.320445,120.96378],[14.320432,120.963626],[14.321357,120.963521],[14.321341,120.963357],[14.321623,120.963415],[14.321951,120.963298],[14.321786,120.963243]],
}

/** Looks up the baked road geometry for an edge, direction-aware, with a straight-line fallback so
 *  a future edge that forgets to fetch geometry degrades instead of crashing. */
function roadPathFor(fromId: string, toId: string): [number, number][] {
  const forward = ROAD_PATHS[`${fromId}|${toId}`]
  if (forward !== undefined) return forward
  const backward = ROAD_PATHS[`${toId}|${fromId}`]
  if (backward !== undefined) return [...backward].reverse()
  const fromCoord = NODE_COORDS.get(fromId)
  const toCoord = NODE_COORDS.get(toId)
  return fromCoord !== undefined && toCoord !== undefined ? [fromCoord, toCoord] : []
}

// Arrival info ("sabihin kay Manong" cues) keyed by destination node, per docs/cavite-network.md.
// robinsons-dasma and silang-premier have no phrase in the source doc — inferred to match the
// doc's naming pattern and flagged here so they're easy to replace with verified copy later.
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
  // inferred — not in source doc
  "robinsons-dasma": {
    driverPhrase: "Robinsons Dasma po",
    landmarkCues: ["Robinsons Place Dasmariñas main entrance"],
    verified: false,
  },
  "sm-dasma": {
    driverPhrase: "SM Dasma tapat ng overpass po",
    landmarkCues: ["SM City Dasmariñas overpass", "Governor's Drive junction"],
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
  // inferred — not in source doc
  "silang-premier": {
    driverPhrase: "Silang Premier tapat po",
    landmarkCues: ["Silang Premier outlet entrance"],
    verified: false,
  },
}

// Short destination-board text, as painted on jeepney/bus signboards along the corridor.
const BOARD_NAME: Record<string, string> = {
  "st-dominic": "ST. DOMINIC",
  "imus-lumina": "IMUS / LUMINA",
  "robinsons-dasma": "ROBINSONS DASMA",
  "sm-dasma": "SM DASMA",
  "pala-pala": "PALA-PALA",
  "lpu-gentri": "LPU / GEN. TRIAS",
  "silang-premier": "SILANG",
}

// Fare/duration values below are derived from docs/cavite-network.md's fare formulas
// (jeepney: ₱13 base/4km + ₱1.80/km; bus: ₱15 base/5km + ₱2.20/km) applied to the Haversine
// distance between each pair's seed coordinates, at estimated corridor speeds (jeepney 15,
// bus 18, UV Express 20 — grounded in a Manila transit study scaled up for this lighter-traffic
// highway, tricycle 12, walk 4.5 km/h). UV Express and tricycle fares use the doc's flat rates.
// These are documented estimates, not measured values — safe to replace with real numbers later.
function edgePair(
  fromId: string,
  toId: string,
  mode: TransitMode,
  fare: number,
  durationMin: number,
  /** Pass a shared id to mark segments that a single vehicle runs through without re-boarding. */
  serviceId: string = `${mode}:${fromId}:${toId}`
): [RouteSegmentEdge, RouteSegmentEdge] {
  const forwardArrival = ARRIVAL_INFO[toId]
  const backwardArrival = ARRIVAL_INFO[fromId]
  const forwardRoad = roadPathFor(fromId, toId)
  const backwardRoad = [...forwardRoad].reverse()
  return [
    {
      fromNodeId: fromId,
      toNodeId: toId,
      mode,
      serviceId,
      signboard: BOARD_NAME[toId],
      fare,
      durationMin,
      landmarkCues: forwardArrival.landmarkCues,
      driverPhrase: forwardArrival.driverPhrase,
      landmarkVerified: forwardArrival.verified,
      roadPath: forwardRoad,
    },
    {
      fromNodeId: toId,
      toNodeId: fromId,
      mode,
      serviceId,
      signboard: BOARD_NAME[fromId],
      fare,
      durationMin,
      landmarkCues: backwardArrival.landmarkCues,
      driverPhrase: backwardArrival.driverPhrase,
      landmarkVerified: backwardArrival.verified,
      roadPath: backwardRoad,
    },
  ]
}

export const CAVITE_PILOT_EDGES: RouteSegmentEdge[] = [
  ...edgePair("st-dominic", "imus-lumina", "jeepney", 13, 11),
  ...edgePair("st-dominic", "imus-lumina", "bus", 15, 10),
  ...edgePair("imus-lumina", "robinsons-dasma", "jeepney", 25, 43),
  ...edgePair("imus-lumina", "robinsons-dasma", "bus", 28, 36),
  ...edgePair("robinsons-dasma", "sm-dasma", "jeepney", 13, 5),
  ...edgePair("robinsons-dasma", "sm-dasma", "bus", 15, 4),
  ...edgePair("robinsons-dasma", "sm-dasma", "walk", 0, 16),
  ...edgePair("sm-dasma", "pala-pala", "jeepney", 13, 2),
  ...edgePair("sm-dasma", "pala-pala", "bus", 15, 2),
  ...edgePair("sm-dasma", "pala-pala", "walk", 0, 8),
  ...edgePair("pala-pala", "lpu-gentri", "jeepney", 19, 29),
  ...edgePair("pala-pala", "lpu-gentri", "tricycle", 35, 36),
  ...edgePair("pala-pala", "silang-premier", "bus", 24, 31),
  ...edgePair("pala-pala", "silang-premier", "jeepney", 22, 37),
  ...edgePair("st-dominic", "sm-dasma", "uv_express", 50, 43),
]

const CAVITE_PILOT_NETWORK: TransitNetwork = {
  nodes: CAVITE_PILOT_NODES,
  edges: CAVITE_PILOT_EDGES,
}

export default CAVITE_PILOT_NETWORK

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

// Minutes added to the "easiest" score per mode change / per walking segment, so that priority
// heavily favors staying on one vehicle over minimizing raw time. Documented estimates (see
// docs/cavite-network.md), tunable here.
const TRANSFER_PENALTY_MIN = 15
const WALK_PENALTY_MIN = 10

type WeightFn = (edge: RouteSegmentEdge, previousServiceId: string | null) => number

function cheapestWeight(edge: RouteSegmentEdge): number {
  return edge.fare
}

function fastestWeight(edge: RouteSegmentEdge): number {
  return edge.durationMin
}

// Penalizes a change of *service*, not just a change of mode: hopping from one jeepney to another
// jeepney is a real transfer for the commuter even though the vehicle type never changed.
function easiestWeight(edge: RouteSegmentEdge, previousServiceId: string | null): number {
  const isTransfer = previousServiceId !== null && previousServiceId !== edge.serviceId
  const walkPenalty = edge.mode === "walk" ? WALK_PENALTY_MIN : 0
  return edge.durationMin + (isTransfer ? TRANSFER_PENALTY_MIN : 0) + walkPenalty
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

// Dijkstra over a state-expanded graph (node + last-used mode) so the "easiest" weight function
// can penalize mode changes without turning the search into a non-shortest-path problem. Edge
// iteration order follows the seed array (fixed), and heap ties break on insertion order, so
// results are deterministic across runs.
function runDijkstra(network: TransitNetwork, originId: string, destinationId: string, weightFn: WeightFn): RouteSegmentEdge[] | null {
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
 * Two consecutive segments are one ride — not two — when the commuter never gets off. That's true
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
 * for the things that go wrong on the ground — every transfer is a ride that might not show up,
 * every walking leg is a stretch with no signboard to follow.
 */
export function computeConfidence(steps: RouteStep[], transferCount: number): number {
  if (steps.length === 0) return 0
  const verifiedShare = steps.filter((step) => step.landmarkVerified).length / steps.length
  const walkLegs = steps.filter((step) => step.mode === "walk").length
  const raw = 60 + 35 * verifiedShare - transferCount * 4 - walkLegs * 3
  return Math.max(40, Math.min(99, Math.round(raw)))
}

function buildRouteResult(network: TransitNetwork, priority: RoutePriority, path: RouteSegmentEdge[], originId: string): RouteResult {
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

    // Extend the ride in progress rather than starting a new one — the commuter stays seated, so
    // this is one leg with a longer fare, a longer clock, and a later drop-off.
    if (previousEdge !== null && isSameRide(previousEdge, edge)) {
      const current = steps[steps.length - 1]
      current.viaStops.push(fromNode.name)
      current.to = toNode.name
      current.signboard = edge.signboard
      current.driverPhrase = edge.driverPhrase
      current.landmarkCues = edge.landmarkCues
      current.landmark = edge.landmarkCues.join("; ")
      current.landmarkVerified = current.landmarkVerified && edge.landmarkVerified
      current.fare += edge.fare
      current.durationMin += edge.durationMin
      // Skip the road path's first point: it's the shared node the previous edge's road path
      // already ends on, and repeating it would draw a zero-length kink in the merged line.
      current.path.push(...edge.roadPath.slice(1))
    } else {
      steps.push({
        mode: edge.mode,
        serviceId: edge.serviceId,
        from: fromNode.name,
        to: toNode.name,
        viaStops: [],
        signboard: edge.signboard,
        driverPhrase: edge.driverPhrase,
        landmarkCues: edge.landmarkCues,
        landmark: edge.landmarkCues.join("; "),
        fare: edge.fare,
        durationMin: edge.durationMin,
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

  // A transfer is a boarding after the first one. Walking isn't a boarding, so a jeep -> walk ->
  // jeep route is one transfer (two vehicles), not two.
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

export function findRoute(network: TransitNetwork, originId: string, destinationId: string, priority: RoutePriority): RouteResult | null {
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
