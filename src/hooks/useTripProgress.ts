// Turns a route plus a live GPS fix into "where is the commuter on this trip" — which leg they're
// on, how far to the next drop-off, and whether they've just arrived somewhere. This is the piece
// that lets the map redraw the ridden portion of a leg as done and fire a "you're here" moment.

import { useEffect, useRef, useState } from "react"

import { buildRouteGeometry, haversineMeters, projectOntoRoute, type LatLng, type RouteGeometry } from "@/utils/geo"
import type { RouteResult } from "@/utils/routingEngine"
import type { LiveFix } from "@/hooks/useGeolocation"

/** Within this many meters of a stop's coordinates counts as "arrived" — GPS in traffic is noisy,
 *  and a tighter number would leave a commuter standing at the stop with no confirmation. Tunable. */
const ARRIVAL_THRESHOLD_METERS = 60

/** Beyond this far from the route line, progress stops updating — the fix is probably a bad reading
 *  or the commuter genuinely left the route, and guessing a position past that point would mislead. */
const OFF_ROUTE_THRESHOLD_METERS = 250

export interface TripProgress {
  stepIndex: number
  /** Index into that step's `path` array — the point just before the live fix's projection. */
  pathIndex: number
  /** Point on the route closest to the live fix — what the map draws the "you are here" marker at. */
  point: LatLng
  /** 0 at the trip's start, 1 at the very end. */
  progressFraction: number
  /** Remaining distance to this leg's drop-off, in meters, following the road. */
  distanceToStepEndMeters: number
  /** Remaining distance to the final destination, in meters, following the road. */
  distanceToFinalMeters: number
  /** How far the live fix is from the route itself. High values mean "not this ride, or bad GPS". */
  offRouteMeters: number
  /** False once the fix is too far from the route to trust — the UI should say so, not guess. */
  onRoute: boolean
}

export interface ArrivalEvent {
  stepIndex: number
  isFinal: boolean
  placeName: string
}

function routeKeyOf(route: RouteResult | null): string | null {
  if (route === null) return null
  return route.steps.map((step) => `${step.serviceId}:${step.to}`).join(">")
}

/** Cumulative route distance at the last point of each step, so "distance to step end" can follow
 *  the actual road instead of a straight line that would cut every curve short. */
function stepEndDistances(geometry: RouteGeometry[], stepCount: number): number[] {
  const ends = new Array<number>(stepCount).fill(0)
  for (const point of geometry) {
    ends[point.stepIndex] = point.cumulativeMeters
  }
  return ends
}

export function useTripProgress(
  route: RouteResult | null,
  fix: LiveFix | null,
  onArrival: (event: ArrivalEvent) => void
): TripProgress | null {
  const [progress, setProgress] = useState<TripProgress | null>(null)

  const geometryRef = useRef<RouteGeometry[]>([])
  const stepEndsRef = useRef<number[]>([])
  const reachedRef = useRef<Set<number>>(new Set())
  const routeKeyRef = useRef<string | null>(null)
  const onArrivalRef = useRef(onArrival)
  onArrivalRef.current = onArrival

  const routeKey = routeKeyOf(route)

  // Rebuild the flattened path (and forget which stops were already reached) only when the trip
  // itself changes — not on every GPS tick, which would otherwise re-walk the whole route ~once a
  // second for nothing.
  useEffect(() => {
    routeKeyRef.current = routeKey
    reachedRef.current = new Set()
    geometryRef.current = route === null ? [] : buildRouteGeometry(route.steps)
    stepEndsRef.current = route === null ? [] : stepEndDistances(geometryRef.current, route.steps.length)
    setProgress(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  useEffect(() => {
    if (route === null || fix === null || geometryRef.current.length < 2) {
      setProgress(null)
      return
    }

    const projection = projectOntoRoute(geometryRef.current, [fix.lat, fix.lng])
    if (projection === null) {
      setProgress(null)
      return
    }

    const onRoute = projection.offRouteMeters <= OFF_ROUTE_THRESHOLD_METERS
    const stepEnd = stepEndsRef.current[projection.stepIndex] ?? projection.totalRouteMeters
    const distanceToStepEndMeters = Math.max(0, stepEnd - projection.distanceTraveledMeters)
    const distanceToFinalMeters = Math.max(0, projection.totalRouteMeters - projection.distanceTraveledMeters)

    setProgress({
      stepIndex: projection.stepIndex,
      point: projection.point,
      progressFraction: projection.totalRouteMeters === 0 ? 0 : projection.distanceTraveledMeters / projection.totalRouteMeters,
      distanceToStepEndMeters,
      distanceToFinalMeters,
      offRouteMeters: projection.offRouteMeters,
      onRoute,
    })

    if (onRoute && distanceToStepEndMeters <= ARRIVAL_THRESHOLD_METERS && !reachedRef.current.has(projection.stepIndex)) {
      reachedRef.current.add(projection.stepIndex)
      onArrivalRef.current({
        stepIndex: projection.stepIndex,
        isFinal: projection.stepIndex === route.steps.length - 1,
        placeName: route.steps[projection.stepIndex].to,
      })
    }
  }, [route, fix])

  return progress
}

/** Straight-line distance from a live fix to a node — used only for the "how far to start" read-out
 *  before the commuter has boarded anything and there's no route leg to measure along yet. */
export function distanceToNode(fix: LiveFix, node: LatLng): number {
  return haversineMeters([fix.lat, fix.lng], node)
}
