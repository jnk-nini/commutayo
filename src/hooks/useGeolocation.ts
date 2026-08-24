// Thin wrapper around the browser's geolocation watch API. Kept separate from the trip-progress
// math in useTripProgress so the "do we have a GPS fix" concern never tangles with "where on the
// route is that fix" — a phone that denies permission should still show a clear, specific reason.

import { useCallback, useEffect, useRef, useState } from "react"

export type GeolocationStatus = "idle" | "requesting" | "active" | "denied" | "unsupported" | "error"

export interface LiveFix {
  lat: number
  lng: number
  accuracyMeters: number
  headingDeg: number | null
  timestamp: number
}

export interface UseGeolocationResult {
  status: GeolocationStatus
  fix: LiveFix | null
  start: () => void
  stop: () => void
}

export function useGeolocation(): UseGeolocationResult {
  const [status, setStatus] = useState<GeolocationStatus>("idle")
  const [fix, setFix] = useState<LiveFix | null>(null)
  const watchIdRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current)
    }
    watchIdRef.current = null
    setStatus("idle")
    setFix(null)
  }, [])

  const start = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setStatus("unsupported")
      return
    }
    setStatus("requesting")
    const id = navigator.geolocation.watchPosition(
      (position) => {
        setStatus("active")
        setFix({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          headingDeg: position.coords.heading,
          timestamp: position.timestamp,
        })
      },
      (error) => {
        setStatus(error.code === error.PERMISSION_DENIED ? "denied" : "error")
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    )
    watchIdRef.current = id
  }, [])

  // Stop watching if the commuter navigates away mid-trip — a dangling watch would keep draining
  // battery for a screen that's no longer showing any of this.
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(watchIdRef.current)
      }
    }
  }, [])

  return { status, fix, start, stop }
}
