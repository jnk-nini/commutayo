// Loads the Cavite-wide network from Supabase, behind the DYNAMIC_NETWORK_ENABLED feature flag.
// The UI doesn't call this yet -- App.tsx still routes over the hardcoded pilot network -- but
// this is the hook it will switch to once the database is populated and checked. When the flag is
// off, this resolves to "disabled" immediately and never touches Supabase, so it's safe to import
// and leave unused during the transition.

import { useEffect, useState } from "react"

import { DYNAMIC_NETWORK_ENABLED, loadDynamicNetwork } from "@/utils/dynamicRoutingEngine"
import type { TransitNetwork } from "@/utils/routingEngine"

export type DynamicNetworkStatus = "disabled" | "loading" | "ready" | "error"

export interface UseDynamicTransitNetworkResult {
  status: DynamicNetworkStatus
  network: TransitNetwork | null
  error: Error | null
}

export function useDynamicTransitNetwork(): UseDynamicTransitNetworkResult {
  const [status, setStatus] = useState<DynamicNetworkStatus>(DYNAMIC_NETWORK_ENABLED ? "loading" : "disabled")
  const [network, setNetwork] = useState<TransitNetwork | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!DYNAMIC_NETWORK_ENABLED) return

    let cancelled = false

    loadDynamicNetwork()
      .then((loaded) => {
        if (cancelled) return
        setNetwork(loaded)
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
  }, [])

  return { status, network, error }
}
