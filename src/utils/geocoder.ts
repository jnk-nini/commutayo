// Landmark search, for when a commuter knows where they want to go but not what the stop is called.
//
// The place pickers only ever knew the ~670 names in our own stops table. That is fine if you are
// looking for "Monterey Junction" and hopeless if you are looking for "Robinsons Place Dasmarinas",
// a barangay hall, or your own subdivision -- none of which are stops, all of which are how people
// actually describe where they are going.
//
// So a query that our own table cannot answer is passed to Nominatim, OpenStreetMap's public
// geocoder, and whatever it finds is snapped to the nearest stop we can actually route from. The
// commuter picks a landmark; the router still gets a node id.
//
// Using the public endpoint puts three obligations on this file, per OSM's usage policy:
//   - at most one request per second, which `SEARCH_DEBOUNCE_MS` plus in-flight cancellation
//     enforces (a request is only ever sent after typing has paused);
//   - results are cached so retyping the same query does not re-ask;
//   - the search is bounded to the region we serve, so we are not using a shared service to trawl
//     the planet.
// A production deployment should move to a self-hosted or paid geocoder; this is the honest
// prototype version of that, not a permanent arrangement.

import { SERVICE_AREA } from "@/utils/dynamicRoutingEngine"
import { haversineMeters } from "@/utils/geo"
import type { TransitNode } from "@/utils/routingEngine"

const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search"

/** Typing pause before a request goes out. Also what keeps us inside the one-per-second policy. */
export const SEARCH_DEBOUNCE_MS = 550

/** Nominatim ranks by importance, and past the first few the results stop being local landmarks. */
const RESULT_LIMIT = 6

/**
 * How far a landmark may be from the nearest stop and still be offered.
 *
 * Beyond this the honest answer is "we cannot get you there" rather than a stop that happens to be
 * closest. 2km is roughly the point where a Cavite commuter would take a tricycle for the last leg
 * instead of walking, and the option is labelled with the real distance either way.
 */
export const MAX_SNAP_METERS = 2000

export interface GeocodedPlace {
  /** Nominatim's own name for the place, trimmed to something readable in a dropdown. */
  label: string
  /** The rest of the address, for telling two places with the same name apart. */
  context: string
  lat: number
  lon: number
}

interface NominatimRow {
  name?: string
  display_name?: string
  lat?: string
  lon?: string
}

/** Splits "Robinsons, Aguinaldo Highway, Dasmarinas, Cavite" into a headline and its context. */
function toPlace(row: NominatimRow): GeocodedPlace | null {
  const lat = Number(row.lat)
  const lon = Number(row.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const display = row.display_name ?? ""
  const parts = display.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
  const label = row.name !== undefined && row.name.length > 0 ? row.name : (parts[0] ?? display)
  // Drop the country and postcode tail: it is the same for every result and only costs width.
  const context = parts.filter((part) => part !== label).slice(0, 2).join(", ")

  if (label.length === 0) return null
  return { label, context, lat, lon }
}

const cache = new Map<string, GeocodedPlace[]>()

/**
 * Asks Nominatim for places matching `query` inside the service area.
 *
 * Returns an empty list rather than throwing when the network is down or the response is unusable:
 * this is an enhancement to a picker that already works on its own, so a geocoder outage should
 * quietly cost the commuter the landmark results, not break the field they were typing into.
 */
export async function geocodePlaces(query: string, signal?: AbortSignal): Promise<GeocodedPlace[]> {
  const trimmed = query.trim()
  if (trimmed.length < 3) return []

  const key = trimmed.toLowerCase()
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  // `bounded=1` makes the viewbox a filter rather than a preference, so a query that also matches
  // somewhere in Luzon or abroad cannot outrank the Cavite result on Nominatim's importance score.
  const url = new URL(NOMINATIM_ENDPOINT)
  url.searchParams.set("format", "jsonv2")
  url.searchParams.set("q", trimmed)
  url.searchParams.set("limit", String(RESULT_LIMIT))
  url.searchParams.set("bounded", "1")
  url.searchParams.set(
    "viewbox",
    `${SERVICE_AREA.minLon},${SERVICE_AREA.maxLat},${SERVICE_AREA.maxLon},${SERVICE_AREA.minLat}`
  )
  url.searchParams.set("countrycodes", "ph")

  try {
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } })
    if (!response.ok) return []
    const rows: unknown = await response.json()
    if (!Array.isArray(rows)) return []

    const places = rows
      .map((row) => toPlace(row as NominatimRow))
      .filter((place): place is GeocodedPlace => place !== null)
    cache.set(key, places)
    return places
  } catch {
    // Includes the AbortError raised when the commuter keeps typing, which is the normal path.
    return []
  }
}

export interface SnappedPlace {
  place: GeocodedPlace
  node: TransitNode
  meters: number
}

/** The closest routable stop to a landmark, or null when nothing is within walking-plus reach. */
export function snapToNearestNode(place: GeocodedPlace, nodes: TransitNode[]): SnappedPlace | null {
  let best: SnappedPlace | null = null
  for (const node of nodes) {
    const meters = haversineMeters([place.lat, place.lon], [node.lat, node.lng])
    if (best === null || meters < best.meters) best = { place, node, meters }
  }
  if (best === null || best.meters > MAX_SNAP_METERS) return null
  return best
}

/**
 * Geocodes, then snaps, dropping landmarks that resolve onto a stop the picker is already showing.
 * Offering "Robinsons Pala-Pala -> Pala-Pala Transport Terminal" underneath the Pala-Pala entry the
 * commuter can already see is just the same choice twice.
 */
export async function findLandmarks(
  query: string,
  nodes: TransitNode[],
  alreadyListed: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<SnappedPlace[]> {
  const places = await geocodePlaces(query, signal)
  const snapped: SnappedPlace[] = []
  const seenNodes = new Set<string>()

  for (const place of places) {
    const hit = snapToNearestNode(place, nodes)
    if (hit === null) continue
    if (alreadyListed.has(hit.node.id)) continue
    if (seenNodes.has(hit.node.id)) continue
    seenNodes.add(hit.node.id)
    snapped.push(hit)
  }
  return snapped
}
