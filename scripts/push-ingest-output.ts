// Reads the already-prepared JSON rows in scripts/.ingest-output/ (written by ingest-osm.ts when no
// service key was available) and writes them directly to Supabase, in FK-dependency order. Does not
// re-run the OSM fetch/dedup/stitch pipeline -- that would mint fresh random UUIDs and break the
// foreign keys already baked into these JSON files (route_stops.route_id/stop_id, etc).
//
// Usage: node scripts/push-ingest-output.ts
// Requires SUPABASE_SERVICE_ROLE_KEY + VITE_SUPABASE_URL in .env.local (RLS blocks the anon key).

import { createClient } from "@supabase/supabase-js"
import { readFileSync, existsSync } from "node:fs"
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const outDir = path.join(__dirname, ".ingest-output")
function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(outDir, name), "utf8"))
}

async function main() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const url = process.env.VITE_SUPABASE_URL
  if (!serviceKey || !url) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_URL in .env.local")
  }
  const supabase = createClient(url, serviceKey)

  const stops = load<any[]>("stops.json")
  const stopOsmSources = load<any[]>("stop_osm_sources.json")
  const routes = load<any[]>("routes.json")
  const routeStops = load<any[]>("route_stops.json")
  const routeGeometry = load<any[]>("route_geometry.json")

  console.log(
    `Loaded: ${stops.length} stops, ${stopOsmSources.length} stop_osm_sources, ${routes.length} routes, ` +
      `${routeStops.length} route_stops, ${routeGeometry.length} route_geometry`,
  )

  console.log("\n1/5 stops...")
  for (const batch of chunk(stops, 500)) {
    const { error } = await supabase.from("stops").insert(batch)
    if (error) throw new Error(`stops insert failed: ${error.message}`)
  }

  console.log("2/5 stop_osm_sources...")
  for (const batch of chunk(stopOsmSources, 500)) {
    const { error } = await supabase.from("stop_osm_sources").insert(batch)
    if (error) throw new Error(`stop_osm_sources insert failed: ${error.message}`)
  }

  // paired_route_id is a self-FK (route -> route); inserting both sides of a pair in one shot risks
  // ordering issues, so insert every route unpaired first, then fill in the pairing in a second pass
  // once every id is guaranteed to already exist.
  console.log("3/5 routes...")
  const routesUnpaired = routes.map((r) => ({ ...r, paired_route_id: null }))
  for (const batch of chunk(routesUnpaired, 500)) {
    const { error } = await supabase.from("routes").insert(batch)
    if (error) throw new Error(`routes insert failed: ${error.message}`)
  }
  const pairedRoutes = routes.filter((r) => r.paired_route_id)
  console.log(`  linking ${pairedRoutes.length} paired routes...`)
  for (const r of pairedRoutes) {
    const { error } = await supabase.from("routes").update({ paired_route_id: r.paired_route_id }).eq("id", r.id)
    if (error) throw new Error(`routes pairing update failed for route ${r.id}: ${error.message}`)
  }

  console.log("4/5 route_stops...")
  for (const batch of chunk(routeStops, 500)) {
    const { error } = await supabase.from("route_stops").insert(batch)
    if (error) throw new Error(`route_stops insert failed: ${error.message}`)
  }

  console.log("5/5 route_geometry...")
  for (const batch of chunk(routeGeometry, 100)) {
    const { error } = await supabase.from("route_geometry").insert(batch)
    if (error) throw new Error(`route_geometry insert failed: ${error.message}`)
  }

  console.log(`\nDone. Wrote ${stops.length} stops and ${routes.length} routes to Supabase.`)
}

main().catch((err) => {
  console.error("Push failed:", err)
  process.exitCode = 1
})
