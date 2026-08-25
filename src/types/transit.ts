// Row shapes for the Cavite-wide transit tables in Supabase (see supabase/migrations/). These
// mirror the DB schema exactly (snake_case, nullable where the column allows null) so a fetcher
// can hand back a raw row with no silent field-dropping, and the graph builder in
// dynamicRoutingEngine.ts owns all the translation into the app's own TransitNode/RouteSegmentEdge
// shapes. Only the columns the graph builder actually needs are declared.

export type Provenance = "osm" | "official_ltfrb" | "commutetour" | "survey" | "crowdsource"
export type ConfidenceTier = "high" | "medium" | "low"

export interface Stop {
  id: string
  name: string
  short_name: string | null
  lat: number
  lon: number
  city: string | null
  is_terminal: boolean
  aliases: string[]
  waiting_spot: string | null
  source: Provenance
  confidence_tier: ConfidenceTier
}

// Distinct from routes.ts's DbVehicleClass in name only where needed -- kept as the literal union
// the `vehicle_class` check constraint enforces, not the app's fares.ts `VehicleClass`, because
// `bus_premium` has no fare bracket of its own yet (see dynamicRoutingEngine.ts's mapping table).
export type DbVehicleClass = "jeepney_traditional" | "jeepney_modern" | "uv_express" | "bus" | "bus_premium" | "tricycle"
export type VehicleClassConfidence = "tag_pattern" | "name_pattern" | "default_fallback" | "survey_confirmed"
export type RouteDirection =
  | "inbound"
  | "outbound"
  | "eastbound"
  | "westbound"
  | "northbound"
  | "southbound"
  | "loop"
export type GeometryQuality = "complete" | "has_minor_gap" | "has_major_gap" | "unknown"

export interface Route {
  id: string
  name: string
  ref: string | null
  direction: RouteDirection | null
  paired_route_id: string | null
  vehicle_class: DbVehicleClass
  vehicle_class_confidence: VehicleClassConfidence
  /** Null means "compute from vehicle_class + distance via fares.ts", matching the pilot engine. */
  flat_fare: number | null
  geometry_quality: GeometryQuality
  confidence_tier: ConfidenceTier
  needs_review: boolean
  is_active: boolean
}

// Deliberately no not-null/at-least-one constraint in the DB: a route can have a complete road
// line and zero marked stops, which is a real, expected state, not missing data.
export interface RouteStop {
  id: string
  route_id: string
  stop_id: string
  sequence: number
  role: string | null
}

// Named to match the DB table. Shadows geo.ts's unrelated `RouteGeometry` (a live-tracking
// helper type) -- callers that need both should import this one under an alias.
export interface RouteGeometry {
  route_id: string
  /** [[lat, lon], ...], same shape RouteResult.polylineCoordinates already uses. */
  path: [number, number][]
  point_count: number
  gap_count: number
}
