// Injects hand-authored jeepney routes into Supabase, for the lines OpenStreetMap does not have.
//
// WHY THIS EXISTS
// OSM maps the roads well and the *services on them* unevenly. Some routes are missing outright:
// as of 2026-08-26 nothing in the database carries a passenger from Bella Vista to SM Dasmarinas
// in one ride, even though that jeepney runs every day. No amount of tuning the router fixes a
// route that is not in the data, so this is the way to put it there.
//
// WHAT IT GUARANTEES
//   - Idempotent. Route and stop ids are derived from the slugs in the JSON, not randomly minted,
//     so running this twice updates the same rows instead of creating a second copy of the line.
//   - Non-destructive to OSM data. It only ever writes rows whose `source` is 'survey', and it
//     reuses an existing stop rather than duplicating it when one is already there.
//   - Dry by default. It prints the plan and changes nothing unless you pass --apply.
//
// USAGE
//   node scripts/push-custom-routes.ts              # show what would happen
//   node scripts/push-custom-routes.ts --apply      # actually write
//   node scripts/push-custom-routes.ts --apply --only gentri-dasma-jeepney
//
// Requires SUPABASE_SERVICE_ROLE_KEY + VITE_SUPABASE_URL in .env.local (RLS blocks the anon key).
// See data/custom-routes/README.md for the file format.

import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROUTES_DIR = path.join(__dirname, "..", "data", "custom-routes")

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function loadEnvLocal(): void {
  const envPath = path.join(__dirname, "..", ".env.local")
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].trim()
  }
}
loadEnvLocal()

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

/** An existing stop, found by name. `near` disambiguates when the name is not unique. */
interface StopRef {
  stop: string
  near?: [number, number]
}

/** A stop that is not in the database yet. `slug` is what makes its id stable across runs. */
interface NewStop {
  slug: string
  name: string
  lat: number
  lon: number
  shortName?: string
  city?: string
  isTerminal?: boolean
  aliases?: string[]
  waitingSpot?: string
}

type StopEntry = StopRef | { new: NewStop }

interface DirectionSpec {
  /** What is painted on the signboard for this direction, e.g. "SM DASMARINAS". */
  headsign: string
  /** In travel order. The first is where the run starts, the last where it ends. */
  stops: StopEntry[]
  /**
   * Optional [[lat, lon], ...] tracing the roads the vehicle actually drives.
   *
   * Worth adding for anything that is not a straight run: the map draws it, and the router measures
   * distance (and therefore fare and time) along it. Without it, the line is drawn straight between
   * consecutive stops, which is a fine approximation on a highway and a poor one around a loop.
   */
  waypoints?: [number, number][]
}

interface CustomRouteFile {
  /** Stable id for this line. Changing it creates a new route rather than updating this one. */
  slug: string
  name: string
  vehicleClass: "jeepney_traditional" | "jeepney_modern" | "uv_express" | "bus" | "bus_premium" | "tricycle"
  ref?: string | null
  /** Set only for a line that charges one price regardless of distance. Null means use the matrix. */
  flatFare?: number | null
  /** Free text for whoever reads this row later: who surveyed it, when, and how. */
  notes?: string
  /** Set while a route is still being written up. Skipped by this script until it is false. */
  draft?: boolean
  /** One entry per direction of travel. Two for a normal line, one for a loop. */
  directions: DirectionSpec[]
}

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

/** Fixed namespace for CommuTayo's hand-authored data. Never change it: every id derives from it. */
const NAMESPACE = "9f2b7c14-5a3e-4d88-9b21-0e6c5a7d4f10"

/**
 * RFC 4122 v5 UUID (SHA-1, name-based). Same input always gives the same id, which is the whole
 * reason this script can be run repeatedly without duplicating anything.
 */
function uuidV5(name: string): string {
  const namespaceBytes = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex")
  const hash = createHash("sha1").update(Buffer.concat([namespaceBytes, Buffer.from(name, "utf8")])).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const routeId = (routeSlug: string, directionIndex: number) => uuidV5(`route:${routeSlug}:${directionIndex}`)
const stopId = (stopSlug: string) => uuidV5(`stop:${stopSlug}`)

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function metersBetween(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const dLat = (b[0] - a[0]) * 111_320
  const dLon = (b[1] - a[1]) * 111_320 * Math.cos(a[0] * toRad)
  return Math.sqrt(dLat * dLat + dLon * dLon)
}

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

// ---------------------------------------------------------------------------
// Loading and validating
// ---------------------------------------------------------------------------

function loadFiles(only: string | null): CustomRouteFile[] {
  if (!existsSync(ROUTES_DIR)) {
    throw new Error(`No custom route directory at ${ROUTES_DIR}. See data/custom-routes/README.md.`)
  }
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".json"))
  const loaded: CustomRouteFile[] = []

  for (const file of files) {
    const raw = JSON.parse(readFileSync(path.join(ROUTES_DIR, file), "utf8")) as CustomRouteFile
    if (typeof raw.slug !== "string" || raw.slug.length === 0) throw new Error(`${file}: missing "slug"`)
    if (typeof raw.name !== "string" || raw.name.length === 0) throw new Error(`${file}: missing "name"`)
    if (!Array.isArray(raw.directions) || raw.directions.length === 0) {
      throw new Error(`${file}: needs at least one entry in "directions"`)
    }
    raw.directions.forEach((direction, index) => {
      if (!Array.isArray(direction.stops) || direction.stops.length < 2) {
        throw new Error(`${file}: direction ${index} needs at least two stops`)
      }
    })
    if (only !== null && raw.slug !== only) continue
    if (raw.draft === true) {
      console.log(`  skipping ${raw.slug} (marked "draft": true)`)
      continue
    }
    loaded.push(raw)
  }
  return loaded
}

// ---------------------------------------------------------------------------
// Resolving stops
// ---------------------------------------------------------------------------

interface ExistingStop {
  id: string
  name: string
  lat: number
  lon: number
}

interface ResolvedStop {
  id: string
  name: string
  lat: number
  lon: number
  /** A row to insert, or null when this stop is already in the database. */
  insert: Record<string, unknown> | null
}

/**
 * Turns one entry from the JSON into a real stop id.
 *
 * A `{ "stop": "..." }` entry must match exactly one existing stop, or the script stops and tells
 * you which ones it found. Silently picking the closest would be how a route quietly attaches
 * itself to the wrong kerb, which is the class of bug this whole feature exists to fix.
 */
function resolveStop(entry: StopEntry, existing: ExistingStop[], routeSlug: string): ResolvedStop {
  if ("new" in entry) {
    const spec = entry.new
    const id = stopId(`${routeSlug}:${spec.slug}`)
    // If a stop of that name already sits within 80m, use it rather than planting a twin.
    const nearby = existing.find(
      (stop) =>
        normalizeName(stop.name) === normalizeName(spec.name) &&
        metersBetween([stop.lat, stop.lon], [spec.lat, spec.lon]) <= 80
    )
    if (nearby !== undefined) {
      return { id: nearby.id, name: nearby.name, lat: nearby.lat, lon: nearby.lon, insert: null }
    }
    return {
      id,
      name: spec.name,
      lat: spec.lat,
      lon: spec.lon,
      insert: {
        id,
        name: spec.name,
        short_name: spec.shortName ?? null,
        lat: spec.lat,
        lon: spec.lon,
        city: spec.city ?? null,
        is_terminal: spec.isTerminal ?? false,
        aliases: spec.aliases ?? [],
        waiting_spot: spec.waitingSpot ?? null,
        source: "survey",
        confidence_tier: "high",
      },
    }
  }

  const wanted = normalizeName(entry.stop)
  let candidates = existing.filter((stop) => normalizeName(stop.name) === wanted)
  if (candidates.length === 0) {
    throw new Error(
      `No stop named "${entry.stop}". Either fix the spelling, or add it with a { "new": { ... } } entry.`
    )
  }
  if (candidates.length > 1 && entry.near !== undefined) {
    const near = entry.near
    candidates = [candidates.reduce((best, stop) =>
      metersBetween([stop.lat, stop.lon], near) < metersBetween([best.lat, best.lon], near) ? stop : best
    )]
  }
  if (candidates.length > 1) {
    const listed = candidates.map((c) => `      ${c.name} (${c.lat}, ${c.lon})`).join("\n")
    throw new Error(
      `"${entry.stop}" matches ${candidates.length} stops. Add "near": [lat, lon] to pick one:\n${listed}`
    )
  }
  const found = candidates[0]
  return { id: found.id, name: found.name, lat: found.lat, lon: found.lon, insert: null }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface Plan {
  newStops: Record<string, unknown>[]
  routes: Record<string, unknown>[]
  routeStops: Record<string, unknown>[]
  geometries: Record<string, unknown>[]
  summary: string[]
}

function buildPlan(files: CustomRouteFile[], existing: ExistingStop[]): Plan {
  const plan: Plan = { newStops: [], routes: [], routeStops: [], geometries: [], summary: [] }
  const seenNewStop = new Set<string>()

  for (const file of files) {
    plan.summary.push(`\n${file.name}  [${file.slug}]`)

    const ids = file.directions.map((_, index) => routeId(file.slug, index))

    file.directions.forEach((direction, index) => {
      const id = ids[index]
      // A two-direction line pairs its two rows; a one-direction loop pairs with nothing.
      const paired = file.directions.length === 2 ? ids[index === 0 ? 1 : 0] : null

      const resolved = direction.stops.map((entry) => resolveStop(entry, existing, file.slug))
      for (const stop of resolved) {
        if (stop.insert !== null && !seenNewStop.has(stop.id)) {
          seenNewStop.add(stop.id)
          plan.newStops.push(stop.insert)
        }
      }

      plan.routes.push({
        id,
        // The headsign leads, because derivePlacardText reads the name to decide what goes on the
        // signboard and an arrow states the direction outright, leaving nothing to infer.
        name: `${file.name} → ${direction.headsign}`,
        raw_name: file.name,
        ref: file.ref ?? null,
        direction: null,
        paired_route_id: paired,
        vehicle_class: file.vehicleClass,
        vehicle_class_confidence: "survey_confirmed",
        flat_fare: file.flatFare ?? null,
        source: "survey",
        geometry_quality: direction.waypoints !== undefined ? "complete" : "unknown",
        confidence_tier: "high",
        needs_review: false,
        is_active: true,
      })

      resolved.forEach((stop, sequence) => {
        plan.routeStops.push({ id: uuidV5(`rs:${id}:${sequence}`), route_id: id, stop_id: stop.id, sequence, role: null })
      })

      const path: [number, number][] =
        direction.waypoints ?? resolved.map((stop) => [stop.lat, stop.lon] as [number, number])
      plan.geometries.push({ route_id: id, path, point_count: path.length, gap_count: 0, gaps: [] })

      const created = resolved.filter((s) => s.insert !== null).length
      plan.summary.push(
        `  ${direction.headsign}: ${resolved.length} stops (${created} new), ` +
          `${path.length} geometry points${direction.waypoints === undefined ? " (straight lines)" : ""}`
      )
      plan.summary.push(`    ${resolved.map((s) => s.name).join(" > ")}`)
    })
  }
  return plan
}

async function apply(supabase: SupabaseClient, plan: Plan): Promise<void> {
  if (plan.newStops.length > 0) {
    console.log(`\nWriting ${plan.newStops.length} new stops...`)
    const { error } = await supabase.from("stops").upsert(plan.newStops, { onConflict: "id" })
    if (error) throw new Error(`stops upsert failed: ${error.message}`)
  }

  // paired_route_id is a self-FK, so write every route unpaired first and link them afterwards,
  // exactly as push-ingest-output.ts does.
  console.log(`Writing ${plan.routes.length} routes...`)
  const unpaired = plan.routes.map((route) => ({ ...route, paired_route_id: null }))
  const { error: routeError } = await supabase.from("routes").upsert(unpaired, { onConflict: "id" })
  if (routeError) throw new Error(`routes upsert failed: ${routeError.message}`)

  for (const route of plan.routes) {
    if (route.paired_route_id === null) continue
    const { error } = await supabase
      .from("routes")
      .update({ paired_route_id: route.paired_route_id })
      .eq("id", route.id as string)
    if (error) throw new Error(`pairing failed: ${error.message}`)
  }

  // Replace rather than merge: the JSON file is the whole truth about this route's stop list, so a
  // stop deleted from the file has to disappear from the database too.
  const ids = plan.routes.map((route) => route.id as string)
  console.log(`Replacing route_stops for ${ids.length} routes...`)
  const { error: clearError } = await supabase.from("route_stops").delete().in("route_id", ids)
  if (clearError) throw new Error(`route_stops clear failed: ${clearError.message}`)
  const { error: stopsError } = await supabase.from("route_stops").insert(plan.routeStops)
  if (stopsError) throw new Error(`route_stops insert failed: ${stopsError.message}`)

  console.log(`Writing ${plan.geometries.length} geometries...`)
  const { error: geomError } = await supabase.from("route_geometry").upsert(plan.geometries, { onConflict: "route_id" })
  if (geomError) throw new Error(`route_geometry upsert failed: ${geomError.message}`)
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const shouldApply = args.includes("--apply")
  const onlyIndex = args.indexOf("--only")
  const only = onlyIndex >= 0 ? (args[onlyIndex + 1] ?? null) : null

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const url = process.env.VITE_SUPABASE_URL
  if (!serviceKey || !url) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_URL in .env.local")
  const supabase = createClient(url, serviceKey)

  console.log("Reading data/custom-routes/ ...")
  const files = loadFiles(only)
  if (files.length === 0) {
    console.log("Nothing to do. Every file is a draft, or --only matched none of them.")
    return
  }

  // Every stop, so a route can reference one by name. Paged for the same reason
  // transitRepository.ts pages: PostgREST silently caps a response at 1000 rows.
  const existing: ExistingStop[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("stops")
      .select("id, name, lat, lon")
      .order("id", { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(`could not read stops: ${error.message}`)
    const rows = (data ?? []) as ExistingStop[]
    existing.push(...rows)
    if (rows.length < 1000) break
  }
  console.log(`${existing.length} stops already in the database.\n`)

  const plan = buildPlan(files, existing)
  console.log(plan.summary.join("\n"))
  console.log(
    `\nPlan: ${plan.newStops.length} new stops, ${plan.routes.length} routes, ` +
      `${plan.routeStops.length} route stops, ${plan.geometries.length} geometries.`
  )

  if (!shouldApply) {
    console.log("\nDry run. Nothing was written. Re-run with --apply to write it.")
    return
  }

  await apply(supabase, plan)
  console.log("\nDone. Reload the app to pick up the new routes.")
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
