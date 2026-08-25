// One-off: turns the ingest-osm.ts JSON output into batched SQL files (in FK-dependency order),
// using jsonb_to_recordset so each batch is one clean INSERT with the row data embedded as a
// single escaped JSON string, instead of hand-built VALUES lists.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"

function esc(json) {
  return JSON.stringify(json).replace(/'/g, "''")
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

mkdirSync("sql_batches", { recursive: true })
let fileIndex = 0
function write(name, sql) {
  fileIndex++
  const filename = `sql_batches/${String(fileIndex).padStart(3, "0")}_${name}.sql`
  writeFileSync(filename, sql)
  console.log(`wrote ${filename} (${(sql.length / 1024).toFixed(0)} KB)`)
}

const stops = JSON.parse(readFileSync("stops.json", "utf8"))
const stopOsmSources = JSON.parse(readFileSync("stop_osm_sources.json", "utf8"))
const routes = JSON.parse(readFileSync("routes.json", "utf8"))
const routeStops = JSON.parse(readFileSync("route_stops.json", "utf8"))
const routeGeometry = JSON.parse(readFileSync("route_geometry.json", "utf8"))

// stops --------------------------------------------------------------------
for (const batch of chunk(stops, 300)) {
  write(
    "stops",
    `insert into stops (id, name, short_name, lat, lon, city, is_terminal, source, source_osm_node_ids, confidence_tier, merged_from_count)
select
  (t.id)::uuid, t.name, t.short_name, t.lat, t.lon, t.city, t.is_terminal, t.source,
  (select coalesce(array_agg(e::bigint), '{}') from jsonb_array_elements_text(t.source_osm_node_ids) e),
  t.confidence_tier, t.merged_from_count
from jsonb_to_recordset('${esc(batch)}'::jsonb) as t(
  id text, name text, short_name text, lat double precision, lon double precision, city text,
  is_terminal boolean, source text, source_osm_node_ids jsonb, confidence_tier text, merged_from_count int
);`
  )
}

// stop_osm_sources -----------------------------------------------------------
for (const batch of chunk(stopOsmSources, 500)) {
  write(
    "stop_osm_sources",
    `insert into stop_osm_sources (osm_node_id, stop_id)
select (t.osm_node_id)::bigint, (t.stop_id)::uuid
from jsonb_to_recordset('${esc(batch)}'::jsonb) as t(osm_node_id bigint, stop_id text);`
  )
}

// routes (single batch -- self-referential paired_route_id must resolve within one statement) ---
write(
  "routes",
  `insert into routes (
  id, name, raw_name, direction, paired_route_id, vehicle_class, vehicle_class_confidence,
  ref, operators, network, source, source_osm_relation_id, source_checked_at,
  geometry_quality, confidence_tier, needs_review
)
select
  (t.id)::uuid, t.name, t.raw_name, t.direction, (t.paired_route_id)::uuid, t.vehicle_class,
  t.vehicle_class_confidence, t.ref,
  (select coalesce(array_agg(e), '{}') from jsonb_array_elements_text(t.operators) e),
  t.network, t.source, t.source_osm_relation_id, t.source_checked_at::timestamptz,
  t.geometry_quality, t.confidence_tier, t.needs_review
from jsonb_to_recordset('${esc(routes)}'::jsonb) as t(
  id text, name text, raw_name text, direction text, paired_route_id text, vehicle_class text,
  vehicle_class_confidence text, ref text, operators jsonb, network text, source text,
  source_osm_relation_id bigint, source_checked_at text, geometry_quality text,
  confidence_tier text, needs_review boolean
);`
)

// route_stops ----------------------------------------------------------------
for (const batch of chunk(routeStops, 800)) {
  write(
    "route_stops",
    `insert into route_stops (id, route_id, stop_id, sequence, role, source_osm_node_id)
select (t.id)::uuid, (t.route_id)::uuid, (t.stop_id)::uuid, t.sequence, t.role, t.source_osm_node_id
from jsonb_to_recordset('${esc(batch)}'::jsonb) as t(
  id text, route_id text, stop_id text, sequence int, role text, source_osm_node_id bigint
);`
  )
}

// route_geometry ---------------------------------------------------------------
for (const batch of chunk(routeGeometry, 40)) {
  write(
    "route_geometry",
    `insert into route_geometry (route_id, path, point_count, gap_count, max_gap_meters, gaps)
select (t.route_id)::uuid, t.path, t.point_count, t.gap_count, t.max_gap_meters, t.gaps
from jsonb_to_recordset('${esc(batch)}'::jsonb) as t(
  route_id text, path jsonb, point_count int, gap_count int, max_gap_meters numeric, gaps jsonb
);`
  )
}

console.log(`\nGenerated ${fileIndex} SQL batch files in sql_batches/`)
