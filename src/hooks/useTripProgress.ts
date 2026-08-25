// Turns a route plus a live GPS fix into "where is the commuter on this trip": which leg they're
// on, how far to the next drop-off, and the three moments worth interrupting them for.
//
// The moments, in the order a rider meets them:
//
//   approaching  250 m from this leg's drop-off. The one that matters. On a moving jeepney a
//                commuter needs warning *before* the stop, not confirmation after it, so this is
//                the event that buzzes the phone and raises a banner.
//   arrived       60 m from a non-final drop-off. Confirmation that this is the place to get off.
//   completed     50 m from the destination itself, measured straight-line so it still fires when
//                 the last few meters are on foot and off the drawn route.

import { useEffect, useRef, useState } from "react"

import { buildRouteGeometry, haversineMeters, projectOntoRoute, type LatLng, type RouteGeometry } from "@/utils/geo"
import type { RouteResult } from "@/utils/routingEngine"
import type { LiveFix } from "@/hooks/useGeolocation"

/** Warn this far before the drop-off. Far enough to stand up and say "para po", close enough to be
 *  about this stop and not the previous one. */
export const APPROACH_ALERT_METERS = 250

/** Close enough to a mid-route drop-off to confirm it. GPS in traffic is noisy, and a tighter
 *  number leaves a commuter standing at the stop with no confirmation. */
export const ARRIVAL_METERS = 60

/** Close enough to the destination to call the trip done and switch the card to its summary. */
export const TRIP_COMPLETE_METERS = 50

/** Beyond this far from the route line, progress stops updating: the fix is probably a bad reading
 *  or the commuter genuinely left the route, and guessing a position past that would mislead. */
const OFF_ROUTE_THRESHOLD_METERS = 250

export interface TripProgress {
  stepIndex: number
  /** Index into that step's `path` array, the point just before the live fix's projection. */
  pathIndex: number
  /** Point on the route closest to the live fix, where the map draws the "you are here" marker. */
  point: LatLng
  /** 0 at the trip's start, 1 at the very end. */
  progressFraction: number
  /** Remaining distance to this leg's drop-off, in meters, following the road. */
  distanceToStepEndMeters: number
  /** Estimated minutes to this leg's drop-off, from the leg's own average speed. */
  minutesToStepEnd: number
  /** Remaining distance to the final destination, in meters, following the road. */
  distanceToFinalMeters: number
  /** Straight-line meters from the live fix to the destination pin, regardless of the route. */
  metersFromDestination: number
  /** How far the live fix is from the route itself. High values mean bad GPS, or not this ride. */
  offRouteMeters: number
  /** False once the fix is too far from the route to trust. The UI should say so, not guess. */
  onRoute: boolean
  /** True once the commuter is within `TRIP_COMPLETE_METERS` of the destination. */
  isComplete: boolean
}

export type ProximityKind = "approaching" | "arrived" | "completed"

export interface ProximityEvent {
  kind: ProximityKind
  stepIndex: number
  /** The stop this event is about. */
  placeName: string
  distanceMeters: number
  /** Rounded minutes left to that stop, for copy like "(mga 2 min)". */
  minutes: number
}

/**
 * The arrival buzz. Three pulses rather than one, because a single vibration is indistinguishable
 * from any other notification a phone makes while it's in a pocket on a moving vehicle.
 *
 * Silently does nothing where the API is missing (every desktop browser, iOS Safari) or where the
 * page has no user-activation yet, which is exactly the right failure: the banner still shows.
 */
export function vibrateArrivalPattern(): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return
  try {
    navigator.vibrate([250, 150, 250])
  } catch {
    // Some browsers throw instead of returning false when vibration is blocked by policy.
  }
}

function routeKeyOf(route: RouteResult | null): string | null {
  if (route === null) return null
  return route.steps.map((step) => `${step.serviceId}:${step.to}`).join(">")
}

/** Cumulative route distance at the last point of each step, so "distance to step end" follows the
 *  actual road instead of a straight line that would cut every curve short. */
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
  onProximity: (event: ProximityEvent) => void
): TripProgress | null {
  const [progress, setProgress] = useState<TripProgress | null>(null)

  const geometryRef = useRef<RouteGeometry[]>([])
  const stepEndsRef = useRef<number[]>([])
  // One entry per event already fired, keyed "kind:stepIndex", so a commuter idling 200 m from a
  // stop in traffic gets buzzed once rather than once per GPS tick.
  const firedRef = useRef<Set<string>>(new Set())
  const onProximityRef = useRef(onProximity)
  onProximityRef.current = onProximity

  const routeKey = routeKeyOf(route)

  // Rebuild the flattened path (and forget which alerts already fired) only when the trip itself
  // changes, not on every GPS tick, which would otherwise re-walk the whole route once a second.
  useEffect(() => {
    firedRef.current = new Set()
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

    const step = route.steps[projection.stepIndex]
    const onRoute = projection.offRouteMeters <= OFF_ROUTE_THRESHOLD_METERS
    const stepEnd = stepEndsRef.current[projection.stepIndex] ?? projection.totalRouteMeters
    const distanceToStepEndMeters = Math.max(0, stepEnd - projection.distanceTraveledMeters)
    const distanceToFinalMeters = Math.max(0, projection.totalRouteMeters - projection.distanceTraveledMeters)

    // This leg's own average speed, not a global assumption: a tricycle leg and a bus leg with the
    // same 400 m left are genuinely different waits.
    const metersPerMinute = step.durationMin > 0 ? step.distanceMeters / step.durationMin : 0
    const minutesToStepEnd = metersPerMinute > 0 ? distanceToStepEndMeters / metersPerMinute : 0

    const destination = route.polylineCoordinates[route.polylineCoordinates.length - 1]
    const metersFromDestination =
      destination === undefined ? distanceToFinalMeters : haversineMeters([fix.lat, fix.lng], destination)
    const isComplete = metersFromDestination <= TRIP_COMPLETE_METERS

    setProgress({
      stepIndex: projection.stepIndex,
      pathIndex: projection.pathIndex,
      point: projection.point,
      progressFraction:
        projection.totalRouteMeters === 0 ? 0 : projection.distanceTraveledMeters / projection.totalRouteMeters,
      distanceToStepEndMeters,
      minutesToStepEnd,
      distanceToFinalMeters,
      metersFromDestination,
      offRouteMeters: projection.offRouteMeters,
      onRoute,
      isComplete,
    })

    const fireOnce = (event: ProximityEvent) => {
      const key = `${event.kind}:${event.stepIndex}`
      if (firedRef.current.has(key)) return
      firedRef.current.add(key)
      onProximityRef.current(event)
    }

    const isFinalStep = projection.stepIndex === route.steps.length - 1

    // Trip complete wins outright: once the destination is underfoot, a "malapit na" banner about
    // the same stop is noise.
    if (isComplete) {
      fireOnce({
        kind: "completed",
        stepIndex: route.steps.length - 1,
        placeName: route.steps[route.steps.length - 1]?.to ?? "",
        distanceMeters: metersFromDestination,
        minutes: 0,
      })
      return
    }

    if (!onRoute) return

    if (distanceToStepEndMeters <= APPROACH_ALERT_METERS) {
      fireOnce({
        kind: "approaching",
        stepIndex: projection.stepIndex,
        placeName: step.to,
        distanceMeters: distanceToStepEndMeters,
        minutes: Math.max(1, Math.round(minutesToStepEnd)),
      })
    }

    if (!isFinalStep && distanceToStepEndMeters <= ARRIVAL_METERS) {
      fireOnce({
        kind: "arrived",
        stepIndex: projection.stepIndex,
        placeName: step.to,
        distanceMeters: distanceToStepEndMeters,
        minutes: 0,
      })
    }
  }, [route, fix])

  return progress
}

/** Straight-line distance from a live fix to a node, for the "how far to the start" read-out before
 *  the commuter has boarded anything and there is no route leg to measure along yet. */
export function distanceToNode(fix: LiveFix, node: LatLng): number {
  return haversineMeters([fix.lat, fix.lng], node)
}
