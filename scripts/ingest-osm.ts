// Pulls Cavite's public-transport route relations from OpenStreetMap (via the free Overpass API),
// cleans them using the rules validated in the dedup/stitch research prototype, fills short road
// gaps with OSRM, and writes the result into Supabase's stops/routes/route_stops/route_geometry
// tables. Safe to re-run: routes upsert on their source OSM relation id, and stops are matched
// against previously-imported OSM node ids via stop_osm_sources before creating new ones.
//
// Usage: node scripts/ingest-osm.ts
// Requires SUPABASE_SERVICE_ROLE_KEY (server-side only -- never the anon key, RLS blocks writes
// for it) in .env.local alongside the existing VITE_SUPABASE_URL. Without it, the script still
// does the full fetch/clean/build pass and writes the prepared rows to
// scripts/.ingest-output/*.json instead of touching the database, so it's still useful to run.
//
// Every successful Overpass phase (relation list, relation geometry, stop-node tags) is checkpointed
// to data/raw_overpass_cache.json as soon as it comes back, and reloaded from there on the next run
// instead of re-querying -- Overpass's public servers rate-limit an IP that queries too much in one
// session, hit directly during this project's research phase. Delete that file to force a fresh
// pull once the data is known to be stale. Overpass has no official uptime guarantee, so requests
// also fall over to OVERPASS_MIRRORS if the primary instance is down.

import { createClient } from "@supabase/supabase-js"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadEnvLocal(): void {
  const envPath = path.join(__dirname, "..", ".env.local")
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].trim()
  }
}
loadEnvLocal()

// Tried in order; a mirror is skipped after two failed attempts rather than exhausting retries on
// a single dead instance. All three serve the same OSM planet data via standard Overpass QL.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
]
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving"
const CAVITE_AREA_QUERY = 'area["name"="Cavite"]["admin_level"="6"]["boundary"="administrative"]->.cavite;'
const CACHE_PATH = path.join(__dirname, "..", "data", "raw_overpass_cache.json")

// Evidence-based thresholds from the dedup/stitch prototype (see project research). Not guesses --
// each one traces to a measured distribution in a real ~340-relation sample.
const EXACT_NAME_MERGE_M = 60
const PREFIX_NAME_MERGE_M = 20
const UNNAMED_ATTACH_M = 15
const MAX_NORMAL_CLUSTER_SPREAD_M = 100 // beyond this, treat as a mega-terminal, not a mapping error
const GAP_AUTO_CONNECT_M = 20
const GAP_OSRM_FILL_M = 500

const STOP_ROLES = new Set([
  "stop",
  "platform",
  "stop_entry_only",
  "stop_exit_only",
  "platform_entry_only",
  "platform_exit_only",
])

const RELATION_CHUNK_SIZE = 50
const NODE_CHUNK_SIZE = 400
const OSRM_DELAY_MS = 250

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function normalizeName(raw: string | null | undefined): string {
  if (!raw) return ""
  let s = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  s = s
    .replace(/\bsta\b/g, "santa")
    .replace(/\bsto\b/g, "santo")
    .replace(/\bbrgy\b/g, "barangay")
    .replace(/\bhwy\b/g, "highway")
    .replace(/\bmkt\b/g, "market")
    .replace(/\bter\b/g, "terminal")
  return s
}

// Overpass's Apache front-end returns a bare 406 for Node's default fetch() headers (URLSearchParams
// as body, or an unset Accept/User-Agent) even though the request is otherwise valid -- reproduced
// directly, not assumed. Sending explicit headers and a manually-encoded body avoids it.
async function fetchOverpass(query: string, mirrorIndex = 0, attempt = 1): Promise<any> {
  const maxAttemptsPerMirror = 2
  const url = OVERPASS_MIRRORS[mirrorIndex]
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*",
        "User-Agent": "commutayo-ingest/1.0",
      },
      body: "data=" + encodeURIComponent(query),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    if (attempt < maxAttemptsPerMirror) {
      console.log(`  ${url} failed (attempt ${attempt}/${maxAttemptsPerMirror}): ${err}. Retrying...`)
      await sleep(3000 * attempt)
      return fetchOverpass(query, mirrorIndex, attempt + 1)
    }
    if (mirrorIndex < OVERPASS_MIRRORS.length - 1) {
      console.log(`  ${url} exhausted after ${maxAttemptsPerMirror} attempts, falling back to ${OVERPASS_MIRRORS[mirrorIndex + 1]}...`)
      return fetchOverpass(query, mirrorIndex + 1, 1)
    }
    throw new Error(`All Overpass mirrors failed. Last error: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// Disk cache -- checkpointed after every successful Overpass phase so a rate-limited or crashed
// run never has to re-fetch data it already has.
// ---------------------------------------------------------------------------

interface IngestCache {
  fetchedAt?: string
  relationIds?: number[]
  rawRelations?: RawRelation[]
  nodeTags?: [number, { lat: number; lon: number; tags: Record<string, string> }][]
}

function loadCache(): IngestCache {
  if (!existsSync(CACHE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"))
  } catch {
    console.log(`  ${CACHE_PATH} exists but isn't valid JSON -- ignoring it and fetching fresh.`)
    return {}
  }
}

function saveCache(patch: Partial<IngestCache>): void {
  mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
  const merged = { ...loadCache(), ...patch, fetchedAt: new Date().toISOString() }
  writeFileSync(CACHE_PATH, JSON.stringify(merged))
  console.log(`  checkpointed to ${CACHE_PATH}`)
}

interface OsrmResult {
  distanceMeters: number
  path: [number, number][]
}

async function fetchOsrmRoute(from: { lat: number; lon: number }, to: { lat: number; lon: number }): Promise<OsrmResult | null> {
  const url = `${OSRM_URL}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`
  try {
    const res = await fetch(url, { headers: { "User-Agent": "commutayo-ingest/1.0" } })
    if (!res.ok) return null
    const body = await res.json()
    if (body.code !== "Ok" || !body.routes?.length) return null
    const route = body.routes[0]
    const points: [number, number][] = route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng])
    return { distanceMeters: Math.round(route.distance), path: points }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Step 1-2: fetch relations
// ---------------------------------------------------------------------------

interface RawMember {
  type: "node" | "way"
  ref: number
  role: string
  lat?: number
  lon?: number
  geometry?: { lat: number; lon: number }[]
}

interface RawRelation {
  id: number
  tags: Record<string, string>
  members: RawMember[]
}

async function fetchRelationIds(): Promise<number[]> {
  console.log("Fetching Cavite transit route relation list from Overpass...")
  const query = `[out:json][timeout:90];
${CAVITE_AREA_QUERY}
(
  relation["route"="share_taxi"](area.cavite);
  relation["route"="minibus"](area.cavite);
  relation["route"="bus"](area.cavite);
);
out ids;`
  const data = await fetchOverpass(query)
  const ids = data.elements.map((e: { id: number }) => e.id)
  console.log(`  found ${ids.length} route relations`)
  return ids
}

async function fetchRelationsFull(ids: number[]): Promise<RawRelation[]> {
  const relations: RawRelation[] = []
  const chunks = chunk(ids, RELATION_CHUNK_SIZE)
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Fetching relation geometry: batch ${i + 1}/${chunks.length} (${chunks[i].length} relations)...`)
    const query = `[out:json][timeout:120];
relation(id:${chunks[i].join(",")});
out body geom;`
    const data = await fetchOverpass(query)
    for (const el of data.elements) relations.push(el)
    if (i < chunks.length - 1) await sleep(1000) // be polite to the free public server
  }
  return relations
}

async function fetchStopNodeTags(nodeIds: number[]): Promise<Map<number, { lat: number; lon: number; tags: Record<string, string> }>> {
  const result = new Map<number, { lat: number; lon: number; tags: Record<string, string> }>()
  const chunks = chunk(nodeIds, NODE_CHUNK_SIZE)
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Fetching stop-node tags: batch ${i + 1}/${chunks.length} (${chunks[i].length} nodes)...`)
    const query = `[out:json][timeout:90];
node(id:${chunks[i].join(",")});
out body;`
    const data = await fetchOverpass(query)
    for (const el of data.elements) result.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags || {} })
    if (i < chunks.length - 1) await sleep(500)
  }
  return result
}

// ---------------------------------------------------------------------------
// Step 3: stop deduplication (global, across every fetched relation)
// ---------------------------------------------------------------------------

interface RawStopNode {
  osmId: number
  lat: number
  lon: number
  name: string | null
  role: string
}

interface CanonicalStop {
  id: string
  name: string | null
  shortName: string | null
  lat: number
  lon: number
  city: string | null
  isTerminal: boolean
  sourceOsmNodeIds: number[]
  mergedFromCount: number
  confidenceTier: "high" | "medium" | "low"
  isHubMerge: boolean
}

function dedupeStops(rawNodes: RawStopNode[]): { stops: CanonicalStop[]; rawIdToStopId: Map<number, string> } {
  // One entry per unique OSM node id (a node can appear as a member of several routes).
  const byId = new Map<number, RawStopNode>()
  for (const n of rawNodes) if (!byId.has(n.osmId)) byId.set(n.osmId, n)
  const nodes = [...byId.values()]

  const parent = new Map<number, number>(nodes.map((n) => [n.osmId, n.osmId]))
  function find(x: number): number {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!)
      x = parent.get(x)!
    }
    return x
  }
  function union(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const named = nodes.filter((n) => n.name)
  const unnamed = nodes.filter((n) => !n.name)

  // Rule 1 + 2: exact normalized-name match within 60m, or one name a prefix of the other within 20m.
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const a = named[i]
      const b = named[j]
      const nameA = normalizeName(a.name)
      const nameB = normalizeName(b.name)
      const d = haversineMeters(a, b)
      if (nameA === nameB && d <= EXACT_NAME_MERGE_M) union(a.osmId, b.osmId)
      else if (d <= PREFIX_NAME_MERGE_M && (nameA.startsWith(nameB) || nameB.startsWith(nameA))) union(a.osmId, b.osmId)
    }
  }

  // Rule 3: an unnamed node within 15m of exactly one named node is that node's platform/position pair.
  for (const u of unnamed) {
    const nearby = named.filter((n) => haversineMeters(u, n) <= UNNAMED_ATTACH_M)
    if (nearby.length === 1) union(u.osmId, nearby[0].osmId)
  }

  const groups = new Map<number, RawStopNode[]>()
  for (const n of nodes) {
    const root = find(n.osmId)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(n)
  }

  const stops: CanonicalStop[] = []
  const rawIdToStopId = new Map<number, string>()
  let hubCount = 0

  for (const group of groups.values()) {
    const lat = group.reduce((s, n) => s + n.lat, 0) / group.length
    const lon = group.reduce((s, n) => s + n.lon, 0) / group.length
    const named_ = group.filter((n) => n.name)
    const name = named_.length > 0 ? named_.sort((a, b) => (b.name!.length - a.name!.length))[0].name : null

    let maxSpread = 0
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) maxSpread = Math.max(maxSpread, haversineMeters(group[i], group[j]))
    }
    const isHubMerge = maxSpread > MAX_NORMAL_CLUSTER_SPREAD_M
    if (isHubMerge) hubCount++

    // Confidence: a name-agreeing merge from multiple independent OSM points is *more* trustworthy
    // than a single unconfirmed point, unless it's a hub merge, where centroid precision is a
    // deliberate simplification (approved product call) and should read as lower-confidence.
    const confidenceTier: CanonicalStop["confidenceTier"] = isHubMerge ? "low" : group.length > 1 ? "high" : "medium"

    const id = crypto.randomUUID()
    stops.push({
      id,
      name,
      shortName: null,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      city: null,
      isTerminal: /terminal|station|pitx/i.test(name || ""),
      sourceOsmNodeIds: group.map((n) => n.osmId),
      mergedFromCount: group.length,
      confidenceTier,
      isHubMerge,
    })
    for (const n of group) rawIdToStopId.set(n.osmId, id)
  }

  console.log(`Stop dedup: ${nodes.length} raw nodes -> ${stops.length} canonical stops (${hubCount} mega-terminal merges)`)
  return { stops, rawIdToStopId }
}

// ---------------------------------------------------------------------------
// Step 4: geometry stitching + gap handling
// ---------------------------------------------------------------------------

interface GapRecord {
  afterWayIndex: number
  sourceOsmWayIdBefore: number
  sourceOsmWayIdAfter: number
  gapMeters: number
  action: "auto_connect" | "fill_via_osrm" | "fill_via_osrm_failed" | "flag_manual_review"
}

interface StitchResult {
  path: [number, number][]
  gaps: GapRecord[]
}

async function stitchRoute(ways: RawMember[]): Promise<StitchResult> {
  const usable = ways.filter((w) => w.geometry && w.geometry.length > 0)
  const gaps: GapRecord[] = []
  if (usable.length === 0) return { path: [], gaps }

  let path: [number, number][] = usable[0].geometry!.map((p) => [p.lat, p.lon])

  for (let i = 1; i < usable.length; i++) {
    const tail = { lat: path[path.length - 1][0], lon: path[path.length - 1][1] }
    const g = usable[i].geometry!
    const start = { lat: g[0].lat, lon: g[0].lon }
    const end = { lat: g[g.length - 1].lat, lon: g[g.length - 1].lon }
    const dStart = haversineMeters(tail, start)
    const dEnd = haversineMeters(tail, end)
    const reversed = dEnd < dStart
    const gapMeters = Math.min(dStart, dEnd)
    const seg: [number, number][] = (reversed ? [...g].reverse() : g).map((p) => [p.lat, p.lon])
    const farEnd = { lat: seg[0][0], lon: seg[0][1] }

    if (gapMeters <= 2) {
      path.push(...seg.slice(1))
      continue
    }

    let action: GapRecord["action"]
    if (gapMeters <= GAP_AUTO_CONNECT_M) {
      action = "auto_connect"
      path.push(...seg)
    } else if (gapMeters <= GAP_OSRM_FILL_M) {
      const filled = await fetchOsrmRoute(tail, farEnd)
      await sleep(OSRM_DELAY_MS)
      if (filled) {
        action = "fill_via_osrm"
        path.push(...filled.path.slice(1), ...seg.slice(1))
      } else {
        action = "fill_via_osrm_failed"
        path.push(...seg)
      }
    } else {
      // Do not guess. Leave the raw jump in place (accurate to what's actually known) and let the
      // needs_review flag on the route steer this to a human before it's trusted.
      action = "flag_manual_review"
      path.push(...seg)
    }

    gaps.push({
      afterWayIndex: i - 1,
      sourceOsmWayIdBefore: usable[i - 1].ref,
      sourceOsmWayIdAfter: usable[i].ref,
      gapMeters: Math.round(gapMeters),
      action,
    })
  }

  return { path, gaps }
}

// ---------------------------------------------------------------------------
// Step 5: route normalization
// ---------------------------------------------------------------------------

function inferVehicleClass(tags: Record<string, string>): { vehicleClass: string; confidence: string } {
  const name = (tags.name || "").toLowerCase()
  const network = tags.network || ""
  // All OSM share_taxi routes found in Cavite were UV Express vans, not jeepneys -- verified
  // against the real data during the research phase, not assumed from the tag's usual meaning.
  if (tags.route === "share_taxi") {
    return name.includes("uv") ? { vehicleClass: "uv_express", confidence: "name_pattern" } : { vehicleClass: "uv_express", confidence: "tag_pattern" }
  }
  if (name.includes("jeepney")) {
    return name.includes("modern") ? { vehicleClass: "jeepney_modern", confidence: "name_pattern" } : { vehicleClass: "jeepney_traditional", confidence: "name_pattern" }
  }
  if (network === "P2P" || name.includes("p2p")) return { vehicleClass: "bus_premium", confidence: "tag_pattern" }
  if (name.includes("uv express") || name.includes(" uv ") || name.endsWith(" uv")) return { vehicleClass: "uv_express", confidence: "name_pattern" }
  return { vehicleClass: "bus", confidence: "default_fallback" }
}

function normalizeRouteName(raw: string | undefined): string {
  if (!raw) return "Unnamed route"
  return raw.replace(/\s*\((inbound|outbound|eastbound|westbound|northbound|southbound)\)\s*/i, "").trim()
}

function inferDirection(raw: string | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\((inbound|outbound|eastbound|westbound|northbound|southbound)\)/i)
  return m ? m[1].toLowerCase() : null
}

function splitOperators(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(";").map((s) => s.trim()).filter(Boolean)
}

interface NormalizedRoute {
  id: string
  name: string
  rawName: string | null
  direction: string | null
  vehicleClass: string
  vehicleClassConfidence: string
  ref: string | null
  operators: string[]
  network: string | null
  sourceOsmRelationId: number
  from: string | null
  to: string | null
  pairedRouteId: string | null
}

function pairRoutes(routes: NormalizedRoute[]): void {
  const used = new Set<number>()
  for (let i = 0; i < routes.length; i++) {
    if (used.has(i)) continue
    for (let j = i + 1; j < routes.length; j++) {
      if (used.has(j)) continue
      const a = routes[i]
      const b = routes[j]
      const sameRef = Boolean(a.ref) && a.ref === b.ref
      const sameName = normalizeName(a.name) === normalizeName(b.name)
      const swappedEndpoints = a.from === b.to && a.to === b.from
      if ((sameRef || sameName) && (swappedEndpoints || sameRef)) {
        a.pairedRouteId = b.id
        b.pairedRouteId = a.id
        used.add(i)
        used.add(j)
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cache = loadCache()
  if (cache.fetchedAt) console.log(`Found cache at ${CACHE_PATH} (last updated ${cache.fetchedAt})`)

  let relationIds: number[]
  if (cache.relationIds) {
    console.log(`Using cached relation list: ${cache.relationIds.length} relations`)
    relationIds = cache.relationIds
  } else {
    relationIds = await fetchRelationIds()
    saveCache({ relationIds })
  }

  let rawRelations: RawRelation[]
  if (cache.rawRelations) {
    console.log(`Using cached relation geometry: ${cache.rawRelations.length} relations`)
    rawRelations = cache.rawRelations
  } else {
    rawRelations = await fetchRelationsFull(relationIds)
    saveCache({ rawRelations })
  }

  const stopNodeIds = new Set<number>()
  for (const rel of rawRelations) {
    for (const m of rel.members) if (m.type === "node" && STOP_ROLES.has(m.role)) stopNodeIds.add(m.ref)
  }

  let nodeTags: Map<number, { lat: number; lon: number; tags: Record<string, string> }>
  if (cache.nodeTags) {
    console.log(`Using cached stop-node tags: ${cache.nodeTags.length} nodes`)
    nodeTags = new Map(cache.nodeTags)
  } else {
    nodeTags = await fetchStopNodeTags([...stopNodeIds])
    saveCache({ nodeTags: [...nodeTags.entries()] })
  }

  const rawStopNodes: RawStopNode[] = []
  for (const rel of rawRelations) {
    for (const m of rel.members) {
      if (m.type === "node" && STOP_ROLES.has(m.role)) {
        const info = nodeTags.get(m.ref)
        if (!info) continue
        rawStopNodes.push({ osmId: m.ref, lat: info.lat, lon: info.lon, name: info.tags.name || null, role: m.role })
      }
    }
  }
  const { stops, rawIdToStopId } = dedupeStops(rawStopNodes)

  console.log(`\nStitching geometry and filling gaps for ${rawRelations.length} routes (this calls OSRM per gap 20-500m, so it takes a while)...`)

  const normalizedRoutes: NormalizedRoute[] = []
  const routeStopsRows: { id: string; routeId: string; stopId: string; sequence: number; role: string; sourceOsmNodeId: number }[] = []
  const routeGeometryRows: {
    routeId: string
    path: [number, number][]
    pointCount: number
    gapCount: number
    maxGapMeters: number | null
    gaps: GapRecord[]
    geometryQuality: "complete" | "has_minor_gap" | "has_major_gap"
  }[] = []

  let gapStats = { auto_connect: 0, fill_via_osrm: 0, fill_via_osrm_failed: 0, flag_manual_review: 0 }

  for (let i = 0; i < rawRelations.length; i++) {
    const rel = rawRelations[i]
    if (i % 20 === 0) console.log(`  route ${i + 1}/${rawRelations.length}...`)

    const ways = rel.members.filter((m) => m.type === "way")
    const { path, gaps } = await stitchRoute(ways)
    for (const g of gaps) gapStats[g.action]++

    const hasMajor = gaps.some((g) => g.action === "flag_manual_review")
    const hasMinor = !hasMajor && gaps.length > 0
    const geometryQuality = hasMajor ? "has_major_gap" : hasMinor ? "has_minor_gap" : "complete"

    const vc = inferVehicleClass(rel.tags)
    const routeId = crypto.randomUUID()
    const normalized: NormalizedRoute = {
      id: routeId,
      name: normalizeRouteName(rel.tags.name),
      rawName: rel.tags.name || null,
      direction: inferDirection(rel.tags.name),
      vehicleClass: vc.vehicleClass,
      vehicleClassConfidence: vc.confidence,
      ref: rel.tags.ref || null,
      operators: splitOperators(rel.tags.operator),
      network: rel.tags.network || null,
      sourceOsmRelationId: rel.id,
      from: rel.tags.from || null,
      to: rel.tags.to || null,
      pairedRouteId: null,
    }
    normalizedRoutes.push(normalized)

    const stopMembers = rel.members.filter((m) => m.type === "node" && STOP_ROLES.has(m.role))
    stopMembers.forEach((m, seq) => {
      const stopId = rawIdToStopId.get(m.ref)
      if (!stopId) return
      routeStopsRows.push({ id: crypto.randomUUID(), routeId, stopId, sequence: seq, role: m.role, sourceOsmNodeId: m.ref })
    })

    routeGeometryRows.push({
      routeId,
      path,
      pointCount: path.length,
      gapCount: gaps.length,
      maxGapMeters: gaps.length > 0 ? Math.max(...gaps.map((g) => g.gapMeters)) : null,
      gaps,
      geometryQuality,
    })
    // Stash quality on the normalized route object for the needs_review computation below.
    ;(normalized as any).__geometryQuality = geometryQuality
  }

  pairRoutes(normalizedRoutes)

  const routeRows = normalizedRoutes.map((r) => {
    const geometryQuality = (r as any).__geometryQuality as "complete" | "has_minor_gap" | "has_major_gap"
    const needsReview = geometryQuality === "has_major_gap" || r.vehicleClassConfidence === "default_fallback"
    return {
      id: r.id,
      name: r.name,
      raw_name: r.rawName,
      direction: r.direction,
      paired_route_id: r.pairedRouteId,
      vehicle_class: r.vehicleClass,
      vehicle_class_confidence: r.vehicleClassConfidence,
      ref: r.ref,
      operators: r.operators,
      network: r.network,
      source: "osm",
      source_osm_relation_id: r.sourceOsmRelationId,
      source_checked_at: new Date().toISOString(),
      geometry_quality: geometryQuality,
      confidence_tier: needsReview ? "low" : "medium",
      needs_review: needsReview,
    }
  })

  const stopRows = stops.map((s) => ({
    id: s.id,
    name: s.name ?? "Unnamed stop",
    short_name: s.shortName,
    lat: s.lat,
    lon: s.lon,
    city: s.city,
    is_terminal: s.isTerminal,
    source: "osm",
    source_osm_node_ids: s.sourceOsmNodeIds,
    confidence_tier: s.confidenceTier,
    merged_from_count: s.mergedFromCount,
  }))

  const stopOsmSourceRows = stops.flatMap((s) => s.sourceOsmNodeIds.map((osmId) => ({ osm_node_id: osmId, stop_id: s.id })))

  const routeStopsDbRows = routeStopsRows.map((r) => ({
    id: r.id,
    route_id: r.routeId,
    stop_id: r.stopId,
    sequence: r.sequence,
    role: r.role,
    source_osm_node_id: r.sourceOsmNodeId,
  }))

  const routeGeometryDbRows = routeGeometryRows.map((g) => ({
    route_id: g.routeId,
    path: g.path,
    point_count: g.pointCount,
    gap_count: g.gapCount,
    max_gap_meters: g.maxGapMeters,
    gaps: g.gaps,
  }))

  console.log("\n" + "=".repeat(70))
  console.log("INGESTION SUMMARY")
  console.log("=".repeat(70))
  console.log(`Routes: ${routeRows.length}`)
  console.log(`Stops: ${stopRows.length} (from ${stopOsmSourceRows.length} raw OSM nodes)`)
  console.log(`Route-stop links: ${routeStopsDbRows.length}`)
  console.log(`Routes needing review: ${routeRows.filter((r) => r.needs_review).length}`)
  console.log(`Vehicle class confidence:`, {
    tag_pattern: routeRows.filter((r) => r.vehicle_class_confidence === "tag_pattern").length,
    name_pattern: routeRows.filter((r) => r.vehicle_class_confidence === "name_pattern").length,
    default_fallback: routeRows.filter((r) => r.vehicle_class_confidence === "default_fallback").length,
  })
  console.log(`Gap actions taken:`, gapStats)
  console.log(`Direction pairs found: ${routeRows.filter((r) => r.paired_route_id).length / 2}`)

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const url = process.env.VITE_SUPABASE_URL

  if (serviceKey && url) {
    console.log("\nSUPABASE_SERVICE_ROLE_KEY found -- writing directly to the database...")
    const supabase = createClient(url, serviceKey)

    // Idempotency: skip creating a stop for any raw OSM node id we've already imported, mapping
    // its route_stops rows onto the existing stop instead. Safe on an empty database (nothing
    // matches) and correct on a re-run (nothing gets duplicated).
    const { data: existingSources } = await supabase.from("stop_osm_sources").select("osm_node_id, stop_id")
    const existingMap = new Map<number, string>((existingSources || []).map((r: any) => [r.osm_node_id, r.stop_id]))
    const newStopRows = stopRows.filter((s) => !s.source_osm_node_ids.some((id: number) => existingMap.has(id)))
    const newStopSourceRows = stopOsmSourceRows.filter((r) => !existingMap.has(r.osm_node_id))

    if (newStopRows.length > 0) {
      const { error } = await supabase.from("stops").insert(newStopRows)
      if (error) throw new Error(`stops insert failed: ${error.message}`)
    }
    if (newStopSourceRows.length > 0) {
      const { error } = await supabase.from("stop_osm_sources").insert(newStopSourceRows)
      if (error) throw new Error(`stop_osm_sources insert failed: ${error.message}`)
    }

    // Remap any route_stops that pointed at an already-existing stop.
    const remappedRouteStops = routeStopsDbRows.map((r) => ({ ...r, stop_id: existingMap.get(r.source_osm_node_id) || r.stop_id }))

    const { error: routesError } = await supabase.from("routes").upsert(routeRows, { onConflict: "source_osm_relation_id" })
    if (routesError) throw new Error(`routes upsert failed: ${routesError.message}`)

    for (const batch of chunk(remappedRouteStops, 500)) {
      const { error } = await supabase.from("route_stops").insert(batch)
      if (error) throw new Error(`route_stops insert failed: ${error.message}`)
    }
    for (const batch of chunk(routeGeometryDbRows, 100)) {
      const { error } = await supabase.from("route_geometry").upsert(batch, { onConflict: "route_id" })
      if (error) throw new Error(`route_geometry upsert failed: ${error.message}`)
    }

    console.log(`\nDone. Inserted ${newStopRows.length} new stops, upserted ${routeRows.length} routes.`)
  } else {
    const outDir = path.join(__dirname, ".ingest-output")
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, "stops.json"), JSON.stringify(stopRows, null, 2))
    writeFileSync(path.join(outDir, "stop_osm_sources.json"), JSON.stringify(stopOsmSourceRows, null, 2))
    writeFileSync(path.join(outDir, "routes.json"), JSON.stringify(routeRows, null, 2))
    writeFileSync(path.join(outDir, "route_stops.json"), JSON.stringify(routeStopsDbRows, null, 2))
    writeFileSync(path.join(outDir, "route_geometry.json"), JSON.stringify(routeGeometryDbRows, null, 2))
    console.log(`\nNo SUPABASE_SERVICE_ROLE_KEY in .env.local -- wrote prepared rows to ${outDir} instead of the database.`)
    console.log("Add SUPABASE_SERVICE_ROLE_KEY (Project Settings -> API -> service_role, in the Supabase dashboard) to .env.local and re-run to write directly.")
  }
}

main().catch((err) => {
  console.error("Ingestion failed:", err)
  // Not process.exit(1): forcing immediate termination while undici still has in-flight request
  // handles crashes Node on Windows (reproduced -- "Assertion failed ... UV_HANDLE_CLOSING").
  // Setting exitCode lets pending handles close on their own before the process exits.
  process.exitCode = 1
})
