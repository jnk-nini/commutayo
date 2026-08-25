// One-off post-process: simplifies route_geometry.json's raw stitched paths with the same
// Ramer-Douglas-Peucker epsilon already used for the pilot corridor's road data (scripts/fetch-roads.mjs),
// since full-resolution OSM geometry for 342 routes is far denser than a map actually needs to
// render correctly, and too large to insert/serve efficiently. Overwrites route_geometry.json in place.

import { readFileSync, writeFileSync } from "node:fs"

const EPSILON_DEG = 0.00012 // ~13m -- keeps every real turn, drops GPS-scale wiggle

function perpendicularDistance(point, lineStart, lineEnd) {
  const [x, y] = point
  const [x1, y1] = lineStart
  const [x2, y2] = lineEnd
  const dx = x2 - x1
  const dy = y2 - y1
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1)
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
  const clamped = Math.max(0, Math.min(1, t))
  return Math.hypot(x - (x1 + clamped * dx), y - (y1 + clamped * dy))
}

function simplify(points, epsilon) {
  if (points.length < 3) return points
  let maxDistance = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], points[0], points[points.length - 1])
    if (distance > maxDistance) {
      maxDistance = distance
      index = i
    }
  }
  if (maxDistance <= epsilon) return [points[0], points[points.length - 1]]
  const left = simplify(points.slice(0, index + 1), epsilon)
  const right = simplify(points.slice(index), epsilon)
  return [...left.slice(0, -1), ...right]
}

const rows = JSON.parse(readFileSync("route_geometry.json", "utf8"))
let totalBefore = 0
let totalAfter = 0
for (const row of rows) {
  totalBefore += row.path.length
  row.path = simplify(row.path, EPSILON_DEG)
  row.point_count = row.path.length
  totalAfter += row.path.length
}

writeFileSync("route_geometry.json", JSON.stringify(rows))
console.log(`Simplified ${rows.length} route geometries: ${totalBefore} -> ${totalAfter} points`)
