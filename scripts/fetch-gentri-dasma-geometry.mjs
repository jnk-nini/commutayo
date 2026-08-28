// One-off: fetches real road geometry for the gentri-dasma-jeepney custom route from the public
// OSRM demo server (same source and RDP simplification as fetch-roads.mjs, adapted to a single
// multi-waypoint request per direction instead of per-pair, since push-custom-routes.ts wants one
// combined path per direction rather than a segment table).
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

async function fetchDirection(stops, label) {
  const coords = stops.map(([, lat, lng]) => `${lng},${lat}`).join(";")
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`

  const response = await fetch(url)
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`)
  const body = await response.json()
  if (body.code !== "Ok" || !body.routes?.length) throw new Error(`${label}: ${body.code} ${body.message ?? ""}`)

  const route = body.routes[0]
  const raw = route.geometry.coordinates.map(([lng, lat]) => [round6(lat), round6(lng)])
  // Pin every real stop onto the line at its actual coordinate, same reasoning as fetch-roads.mjs:
  // the drawn line should start/end/pass exactly through the surveyed stop, not OSRM's road snap.
  raw[0] = [stops[0][1], stops[0][2]]
  raw[raw.length - 1] = [stops[stops.length - 1][1], stops[stops.length - 1][2]]

  const path = simplify(raw, EPSILON_DEG).map(([lat, lng]) => [round6(lat), round6(lng)])
  console.error(
    `${label.padEnd(12)} ${String(Math.round(route.distance)).padStart(6)} m  ` +
      `${String(raw.length).padStart(4)} -> ${String(path.length).padStart(3)} pts`
  )
  return path
}

const forward = await fetchDirection(FORWARD_STOPS, "SM DASMARIÑAS")
await new Promise((resolve) => setTimeout(resolve, 400)) // be polite to the demo server
const reverse = await fetchDirection([...FORWARD_STOPS].reverse(), "GENERAL TRIAS")

const fmt = (path) => path.map(([lat, lng]) => `[${lat}, ${lng}]`).join(", ")
console.log(`\nSM DASMARIÑAS waypoints (${forward.length} pts):\n[${fmt(forward)}]`)
console.log(`\nGENERAL TRIAS waypoints (${reverse.length} pts):\n[${fmt(reverse)}]`)
