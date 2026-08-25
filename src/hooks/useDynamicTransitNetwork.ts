// Loads the Cavite-wide network from Supabase, behind the DYNAMIC_NETWORK_ENABLED feature flag.
// When the flag is off, this resolves to "disabled" immediately and never touches Supabase, so the
// pilot corridor keeps working untouched in a dev environment with no .env.local at all.
//
// The network is fetched and built exactly once per mount. Everything downstream -- all three
// priority solves, every re-render of the map -- runs against that one in-memory graph, because
// building it means reading four tables and walking ~127k polyline points, which is not something
// to redo when someone taps a priority tab.

import { useCallback, useEffect, useState } from "react"

import { DYNAMIC_NETWORK_ENABLED, loadDynamicNetwork } from "@/utils/dynamicRoutingEngine"
import type { TransitNetwork } from "@/utils/routingEngine"

export type DynamicNetworkStatus = "disabled" | "loading" | "ready" | "error"

export interface UseDynamicTransitNetworkResult {
  status: DynamicNetworkStatus
  network: TransitNetwork | null
  error: Error | null
  /** Re-runs the fetch. Wired to the retry button on the error card. */
  reload: () => void
}

export function useDynamicTransitNetwork(): UseDynamicTransitNetworkResult {
  const [status, setStatus] = useState<DynamicNetworkStatus>(DYNAMIC_NETWORK_ENABLED ? "loading" : "disabled")
  const [network, setNetwork] = useState<TransitNetwork | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!DYNAMIC_NETWORK_ENABLED) return

    let cancelled = false

    loadDynamicNetwork()
      .then((loaded) => {
        if (cancelled) return
        setNetwork(loaded)
        setError(null)
        setStatus("ready")
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setStatus("error")
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  const reload = useCallback(() => {
    if (!DYNAMIC_NETWORK_ENABLED) return
    setStatus("loading")
    setError(null)
    setAttempt((current) => current + 1)
  }, [])

  return { status, network, error, reload }
}
