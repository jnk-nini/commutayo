// Small geometry helpers for turning a live GPS fix into "where on the route is the commuter".
// Distances are planar-projected (equirectangular), not great-circle exact, because every distance
// here is well under a kilometer, so the error against Haversine is centimeters at that scale, and a
// flat projection is what makes "nearest point on a polyline" a cheap loop instead of calculus.

export type LatLng = [number, number]

const EARTH_RADIUS_M = 6371000

/** True great-circle distance in meters. Used for the few checks that span the whole corridor. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const [lat1, lng1] = a
  const [lat2, lng2] = b
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinLng * sinLng
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Meters-per-degree at a given latitude, for the flat local projection below. */
function metersPerDegree(lat: number): { perLat: number; perLng: number } {
  const rad = (lat * Math.PI) / 180
  return {
    perLat: 111320,
    perLng: 111320 * Math.cos(rad),
  }
}

interface Projection {
  /** The closest point on the segment to the query point. */
  point: LatLng
  /** How far off the route the query point is, in meters. */
  offRouteMeters: number
  /** 0 at the segment's start, 1 at its end. Where the projection landed. */
  t: number
  /** Distance from the segment's start to the projected point, in meters. */
  distanceAlongSegmentMeters: number
}

function projectOntoSegment(point: LatLng, segStart: LatLng, segEnd: LatLng): Projection {
  const { perLat, perLng } = metersPerDegree(segStart[0])
  const toXY = ([lat, lng]: LatLng): [number, number] => [(lng - segStart[1]) * perLng, (lat - segStart[0]) * perLat]

  const p = toXY(point)
  const b = toXY(segEnd)
  const lenSq = b[0] * b[0] + b[1] * b[1]

  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (p[0] * b[0] + p[1] * b[1]) / lenSq))
  const projX = b[0] * t
  const projY = b[1] * t

  const offRouteMeters = Math.hypot(p[0] - projX, p[1] - projY)
  const segmentLengthMeters = Math.hypot(b[0], b[1])

  return {
    point: [segStart[0] + (projY / perLat), segStart[1] + (projX / perLng)],
    offRouteMeters,
    t,
    distanceAlongSegmentMeters: segmentLengthMeters * t,
  }
}

export interface RouteProjection {
  /** Index into `route.steps` the commuter's nearest point falls in. */
  stepIndex: number
  /** Index into that step's `path` array, the point just before the projection. */
  pathIndex: number
  /** The point on the route closest to the live fix. */
  point: LatLng
  /** How far the live fix is from the route itself, in meters. High means "probably not on this ride". */
  offRouteMeters: number
  /** Meters travelled from the route's start up to the projected point. */
  distanceTraveledMeters: number
  /** Total route length in meters, for a progress fraction. */
  totalRouteMeters: number
}

/** Steps' paths concatenated with per-point cumulative distance, computed once per route. */
export interface RouteGeometry {
  stepIndex: number
  pathIndex: number
  point: LatLng
  cumulativeMeters: number
}

/** Flattens a route's steps into one indexed list of points with running distance, reused by
 *  every projection call so a route with a live GPS feed isn't re-walking its whole path every fix. */
export function buildRouteGeometry(steps: { path: LatLng[] }[]): RouteGeometry[] {
  const geometry: RouteGeometry[] = []
  let cumulative = 0
  steps.forEach((step, stepIndex) => {
    step.path.forEach((point, pathIndex) => {
      if (geometry.length > 0) {
        cumulative += haversineMeters(geometry[geometry.length - 1].point, point)
      }
      geometry.push({ stepIndex, pathIndex, point, cumulativeMeters: cumulative })
    })
  })
  return geometry
}

/** Finds the closest point on the whole route to a live fix, and how far along the route that is. */
export function projectOntoRoute(geometry: RouteGeometry[], fix: LatLng): RouteProjection | null {
  if (geometry.length < 2) return null

  let best: RouteProjection | null = null

  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i]
    const b = geometry[i + 1]
    const projection = projectOntoSegment(fix, a.point, b.point)
    const distanceTraveledMeters = a.cumulativeMeters + projection.distanceAlongSegmentMeters

    if (best === null || projection.offRouteMeters < best.offRouteMeters) {
      best = {
        stepIndex: a.stepIndex,
        pathIndex: a.pathIndex,
        point: projection.point,
        offRouteMeters: projection.offRouteMeters,
        distanceTraveledMeters,
        totalRouteMeters: geometry[geometry.length - 1].cumulativeMeters,
      }
    }
  }

  return best
}
