// Async fetchers for the Cavite-wide transit tables (see supabase/migrations/ and
// src/types/transit.ts). Each one selects only the columns dynamicRoutingEngine.ts needs to build
// a graph -- not `select("*")` -- so a schema addition elsewhere doesn't silently change what the
// routing engine receives.

import { supabase } from "@/lib/supabase"
import type { Route, RouteGeometry, RouteStop, Stop } from "@/types/transit"

const STOP_COLUMNS = "id, name, short_name, lat, lon, city, is_terminal, aliases, waiting_spot, source, confidence_tier"
const ROUTE_COLUMNS =
  "id, name, ref, direction, paired_route_id, vehicle_class, vehicle_class_confidence, flat_fare, geometry_quality, confidence_tier, needs_review, is_active"
const ROUTE_STOP_COLUMNS = "id, route_id, stop_id, sequence, role"
const ROUTE_GEOMETRY_COLUMNS = "route_id, path, point_count, gap_count"

function requireClient() {
  if (supabase === null) {
    throw new Error(
      "Supabase is not configured -- set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local before fetching the dynamic transit network."
    )
  }
  return supabase
}

export async function fetchStops(): Promise<Stop[]> {
  const { data, error } = await requireClient().from("stops").select(STOP_COLUMNS)
  if (error !== null) throw error
  return (data ?? []) as unknown as Stop[]
}

// Only active routes: an inactive route (retired line, superseded mapping) shouldn't offer rides.
export async function fetchRoutes(): Promise<Route[]> {
  const { data, error } = await requireClient().from("routes").select(ROUTE_COLUMNS).eq("is_active", true)
  if (error !== null) throw error
  return (data ?? []) as unknown as Route[]
}

export async function fetchRouteStops(): Promise<RouteStop[]> {
  const { data, error } = await requireClient()
    .from("route_stops")
    .select(ROUTE_STOP_COLUMNS)
    .order("route_id", { ascending: true })
    .order("sequence", { ascending: true })
  if (error !== null) throw error
  return (data ?? []) as unknown as RouteStop[]
}

export async function fetchRouteGeometries(): Promise<RouteGeometry[]> {
  const { data, error } = await requireClient().from("route_geometry").select(ROUTE_GEOMETRY_COLUMNS)
  if (error !== null) throw error
  return (data ?? []) as unknown as RouteGeometry[]
}

export interface TransitNetworkTables {
  stops: Stop[]
  routes: Route[]
  routeStops: RouteStop[]
  routeGeometries: RouteGeometry[]
}

/** Fetches everything dynamicRoutingEngine.ts's graph builder needs, in one round trip each. */
export async function fetchTransitNetworkTables(): Promise<TransitNetworkTables> {
  const [stops, routes, routeStops, routeGeometries] = await Promise.all([
    fetchStops(),
    fetchRoutes(),
    fetchRouteStops(),
    fetchRouteGeometries(),
  ])
  return { stops, routes, routeStops, routeGeometries }
}
