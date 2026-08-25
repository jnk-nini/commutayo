// Re-fetches real road geometry + road distance for every stop pair in the CommuTayo pilot graph,
// using the public OSRM demo server, then simplifies each line with Ramer-Douglas-Peucker and
// prints a ready-to-paste ROAD_SEGMENTS literal for src/utils/routingEngine.ts.
//
// Run after any change to the seed node coordinates: node fetch-roads.mjs

const NODES = {
  "st-dominic": [14.4682, 120.9634],
  "imus-lumina": [14.4267, 120.9405],
  "robinsons-dasma": [14.3312, 120.9575],
  "sm-dasma": [14.3005, 120.9576],
  "pala-pala": [14.2982, 120.9568],
  "lpu-gentri": [14.3168, 120.9254],
  "silang-premier": [14.2341, 120.9744],
}

// Every pair the edge list connects, in the direction the seed array declares it.
const PAIRS = [
  ["st-dominic", "imus-lumina"],
  ["imus-lumina", "robinsons-dasma"],
  ["robinsons-dasma", "sm-dasma"],
  ["sm-dasma", "pala-pala"],
  ["pala-pala", "lpu-gentri"],
  ["pala-pala", "silang-premier"],
  ["st-dominic", "sm-dasma"],
]

const EPSILON_DEG = 0.00012 // ~13 m — keeps every real turn, drops GPS-scale wiggle.

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

const round6 = (n) => Number(n.toFixed(6))

async function fetchPair(fromId, toId) {
  const [fromLat, fromLng] = NODES[fromId]
  const [toLat, toLng] = NODES[toId]
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${fromLng},${fromLat};${toLng},${toLat}` +
    `?overview=full&geometries=geojson`

  const response = await fetch(url)
  if (!response.ok) throw new Error(`${fromId}|${toId}: HTTP ${response.status}`)
  const body = await response.json()
  if (body.code !== "Ok" || !body.routes?.length) throw new Error(`${fromId}|${toId}: ${body.code}`)

  const route = body.routes[0]
  // GeoJSON is [lng, lat]; Leaflet wants [lat, lng]. Pin the real endpoints so the drawn line
  // starts and ends exactly on the pin rather than at OSRM's road-snapped point.
  const raw = route.geometry.coordinates.map(([lng, lat]) => [round6(lat), round6(lng)])
  raw[0] = [fromLat, fromLng]
  raw[raw.length - 1] = [toLat, toLng]

  return {
    key: `${fromId}|${toId}`,
    path: simplify(raw, EPSILON_DEG).map(([lat, lng]) => [round6(lat), round6(lng)]),
    rawPoints: raw.length,
    distanceMeters: Math.round(route.distance),
    durationSecondsCar: Math.round(route.duration),
  }
}

const results = []
for (const [fromId, toId] of PAIRS) {
  const result = await fetchPair(fromId, toId)
  results.push(result)
  console.error(
    `${result.key.padEnd(34)} ${String(result.distanceMeters).padStart(6)} m  ` +
      `${String(result.rawPoints).padStart(4)} -> ${String(result.path.length).padStart(3)} pts`
  )
  await new Promise((resolve) => setTimeout(resolve, 400)) // be polite to the demo server
}

const total = results.reduce((sum, r) => sum + r.path.length, 0)
console.error(`\ntotal simplified points: ${total}`)

const body = results
  .map((r) => {
    const path = r.path.map(([lat, lng]) => `[${lat},${lng}]`).join(",")
    return `  "${r.key}": { distanceMeters: ${r.distanceMeters}, path: [${path}] },`
  })
  .join("\n")

console.log(`const ROAD_SEGMENTS: Record<string, RoadSegment> = {\n${body}\n}`)
