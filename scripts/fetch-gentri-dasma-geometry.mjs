// One-off: fetches real road geometry for the gentri-dasma-jeepney custom route from the public
// OSRM demo server, per adjacent stop pair, then concatenates. Same source and RDP simplification
// as fetch-roads.mjs (the pilot corridor's own script) -- and per-pair fetching for the same reason
// that script does it that way, not as one multi-waypoint request for the whole route.
//
// That distinction mattered here, concretely: a single 6-point multi-waypoint request forced OSRM
// to solve the *whole* route as one through-trip, and its whole-route optimizer routed Manggahan
// Junction and LPU Cavite via a ~1.2km loop out toward Manggahan Junction and back rather than the
// direct 1.1km local road that actually connects them -- confirmed by fetching that one pair on its
// own, which came back clean and monotonic. The whole-route solve was choosing a *worse* path
// between two of its own waypoints than the direct route between just those two points, almost
// certainly because satisfying "visit every waypoint on one continuous drivable route" pulled in
// one-way or turn-restriction constraints that a shorter, isolated pair query never has to satisfy.
// Per-pair fetching sidesteps that entirely: each hop is its own locally-optimal request.
//
// Run: node scripts/fetch-gentri-dasma-geometry.mjs
// Paste the two printed arrays into data/custom-routes/gentri-dasma-jeepney.json's "waypoints".

const FORWARD_STOPS = [
  ["Bella Vista", 14.33479, 120.909331],
  ["Vista Mall General Trias Transport Terminal", 14.324281, 120.912174],
  ["Manggahan Junction", 14.29216, 120.912151],
  ["LPU Cavite", 14.292273, 120.916183],
  ["Pala-Pala Transport Terminal", 14.301489, 120.95298],
  ["SM City Dasmariñas", 14.300553, 120.956356],
]

const EPSILON_DEG = 0.00012 // ~13 m, same as fetch-roads.mjs

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

async function fetchPair(fromName, fromCoord, toName, toCoord) {
  const [fromLat, fromLng] = fromCoord
  const [toLat, toLng] = toCoord
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`

  const response = await fetch(url)
  if (!response.ok) throw new Error(`${fromName} -> ${toName}: HTTP ${response.status}`)
  const body = await response.json()
  if (body.code !== "Ok" || !body.routes?.length) throw new Error(`${fromName} -> ${toName}: ${body.code}`)

  const route = body.routes[0]
  const raw = route.geometry.coordinates.map(([lng, lat]) => [round6(lat), round6(lng)])
  raw[0] = [fromLat, fromLng]
  raw[raw.length - 1] = [toLat, toLng]

  const path = simplify(raw, EPSILON_DEG).map(([lat, lng]) => [round6(lat), round6(lng)])
  console.error(
    `  ${fromName} -> ${toName}: ${Math.round(route.distance)}m, ${raw.length} -> ${path.length} pts`
  )
  return path
}

async function fetchDirection(stops, label) {
  console.error(`${label}:`)
  let combined = []
  for (let i = 0; i < stops.length - 1; i++) {
    const [fromName, fromLat, fromLng] = stops[i]
    const [toName, toLat, toLng] = stops[i + 1]
    const segment = await fetchPair(fromName, [fromLat, fromLng], toName, [toLat, toLng])
    // Drop the shared boundary point so consecutive segments don't duplicate a vertex.
    combined = combined.length === 0 ? segment : [...combined, ...segment.slice(1)]
    await new Promise((resolve) => setTimeout(resolve, 400)) // be polite to the demo server
  }
  return combined
}

const forward = await fetchDirection(FORWARD_STOPS, "SM DASMARIÑAS")
const reverse = await fetchDirection([...FORWARD_STOPS].reverse(), "GENERAL TRIAS")

const fmt = (path) => path.map(([lat, lng]) => `[${lat}, ${lng}]`).join(", ")
console.log(`\nSM DASMARIÑAS waypoints (${forward.length} pts):\n[${fmt(forward)}]`)
console.log(`\nGENERAL TRIAS waypoints (${reverse.length} pts):\n[${fmt(reverse)}]`)
