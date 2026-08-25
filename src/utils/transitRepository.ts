// Async fetchers for the Cavite-wide transit tables (see supabase/migrations/ and
// src/types/transit.ts). Each one selects only the columns dynamicRoutingEngine.ts needs to build
// a graph -- not `select("*")` -- so a schema addition elsewhere doesn't silently change what the
// routing engine receives.
//
// EVERY fetcher here paginates. PostgREST caps a single response at 1000 rows and reports the cap
// only in the Content-Range header, so an un-paginated `select` on a bigger table returns a
// truncated list with no error at all. `route_stops` is already 2994 rows: read in one shot it
// silently hands back a third of the network, which builds a graph that looks fine and quietly
// cannot route. `stops` is at 877 and would cross the same cliff on the next ingestion run, so the
// paging goes on all four rather than just the table that overflows today.

import { supabase } from "@/lib/supabase"
import type { Route, RouteGeometry, RouteStop, Stop } from "@/types/transit"

/** PostgREST's own per-response ceiling. Asking for more in one range just returns this many. */
const PAGE_SIZE = 1000

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

interface PageResponse {
  data: unknown[] | null
  error: { message: string } | null
}

/**
 * Reads a table one PAGE_SIZE window at a time until a short page proves the end was reached.
 * A full-length page means there may be more behind it, so it keeps going -- the row count is
 * never assumed up front, which is what makes this correct as the tables grow.
 */
async function fetchAllPages<T>(page: (from: number, to: number) => PromiseLike<PageResponse>): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error !== null) throw error
    const rows = (data ?? []) as T[]
    all.push(...rows)
    if (rows.length < PAGE_SIZE) return all
  }
}

export async function fetchStops(): Promise<Stop[]> {
  return fetchAllPages<Stop>((from, to) => requireClient().from("stops").select(STOP_COLUMNS).range(from, to))
}

// Only active routes: an inactive route (retired line, superseded mapping) shouldn't offer rides.
export async function fetchRoutes(): Promise<Route[]> {
  return fetchAllPages<Route>((from, to) =>
    requireClient().from("routes").select(ROUTE_COLUMNS).eq("is_active", true).range(from, to)
  )
}

// Ordered by (route_id, sequence) so the pages stitch back together in a stable order. Without an
// explicit order a paged read can repeat or skip rows between windows, because Postgres makes no
// row-order promise across separate queries.
export async function fetchRouteStops(): Promise<RouteStop[]> {
  return fetchAllPages<RouteStop>((from, to) =>
    requireClient()
      .from("route_stops")
      .select(ROUTE_STOP_COLUMNS)
      .order("route_id", { ascending: true })
      .order("sequence", { ascending: true })
      .range(from, to)
  )
}

export async function fetchRouteGeometries(): Promise<RouteGeometry[]> {
  return fetchAllPages<RouteGeometry>((from, to) =>
    requireClient().from("route_geometry").select(ROUTE_GEOMETRY_COLUMNS).order("route_id", { ascending: true }).range(from, to)
  )
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
