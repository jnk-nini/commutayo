// Regression tests for a real trip a commuter reported riding: Bella Vista to LPU Cavite, along
// Governor's Drive in Dasmariñas.
//
// What the app used to answer, and why each half of it was wrong:
//
//   1. "Ride the Molino jeep to Monterey Junction." The vehicle was right -- it is the jeepney
//      that runs SM Molino to WalterMart Trece Martires, and it was travelling toward Trece --
//      but `placardText` was the whole route name, the signboard chip truncated it, and Molino
//      was the half the commuter could read. Molino is the opposite direction.
//   2. "Then ride the Dasmariñas jeep to LPU Cavite." Same fault: the vehicle was the Alfonso-
//      bound run of the Dasmariñas/Alfonso line, signed with the end it had already left.
//   3. Underneath that, the trip really did double back. LPU Cavite is two OSM nodes, one per
//      kerb of Governor's Drive, and the picker had offered the westbound kerb -- reachable only
//      by riding *past* LPU to Manggahan Junction and catching a second bus back east.
//
// Every edge in the graph ran forward along its own `route_stops.sequence` the whole time, so the
// backwards feel came from (1) and (2) naming the wrong end and (3) splitting one stop in two.
// These tests pin all three.
//
// The fixture is a cut-down copy of the live rows for this corridor: real stop coordinates, real
// route names, real sequence order. Only intermediate stops are dropped.

import { describe, expect, it } from "vitest"

import { buildNetworkFromDatabase, derivePlacardText, selectableNodes } from "@/utils/dynamicRoutingEngine"
import { buildRouteGeometry, projectOntoRoute, type LatLng } from "@/utils/geo"
import { findRoute } from "@/utils/routingEngine"
import type { TransitNetworkTables } from "@/utils/transitRepository"
import type { Route, RouteStop, Stop } from "@/types/transit"

// Spelled by codepoint so this file stays clean under the repo's en/em dash scan, which cannot
// tell a punctuation slip in prose from an OSM route name quoted verbatim.
const EN_DASH = String.fromCharCode(0x2013)
const ARROW = String.fromCharCode(0x2192)

const MOLINO_TO_TRECE = `Jeepney Route: SM Molino ${ARROW} WalterMart Trece Martires`
const ROUTE_31 = `Route 31: Trece Martires${EN_DASH}PITX (via Dasmariñas)`
const ROUTE_58 = `Route 58: Alabang${EN_DASH}Naic via Governor's Drive`
const DASMA_ALFONSO = `Dasmariñas${EN_DASH}Alfonso`

function stop(id: string, name: string, lat: number, lon: number, isTerminal = false): Stop {
  return {
    id,
    name,
    short_name: null,
    lat,
    lon,
    city: null,
    is_terminal: isTerminal,
    aliases: [],
    waiting_spot: null,
    source: "osm",
    confidence_tier: "medium",
  }
}

function route(id: string, name: string, overrides: Partial<Route> = {}): Route {
  return {
    id,
    name,
    ref: null,
    direction: null,
    paired_route_id: null,
    vehicle_class: "bus",
    vehicle_class_confidence: "default_fallback",
    flat_fare: null,
    geometry_quality: "unknown",
    confidence_tier: "low",
    needs_review: false,
    is_active: true,
    ...overrides,
  }
}

function sequence(routeId: string, stopIds: string[]): RouteStop[] {
  return stopIds.map((stopId, index) => ({
    id: `${routeId}-${index}`,
    route_id: routeId,
    stop_id: stopId,
    sequence: index,
    role: null,
  }))
}

// Governor's Drive runs east to west here: Pala-Pala (120.953) is the far east end, then Monterey
// Junction (120.923), then LPU Cavite (120.916), then Manggahan Junction (120.912) toward Trece
// Martires. Bella Vista (120.909, 14.335) sits north of all of it, in General Trias.
const STOPS: Stop[] = [
  stop("sm-molino", "SM City Molino", 14.383945, 120.978017, true),
  stop("bella-vista", "Bella Vista", 14.33479, 120.909331),
  stop("calax-overpass", "CALAX Arnaldo Highway Overpass", 14.295725, 120.924435),
  stop("pala-pala", "Pala-Pala Transport Terminal", 14.301489, 120.95298, true),
  stop("pitx", "PITX", 14.508403, 120.99, true),
  // One junction, two kerbs, three OSM nodes -- exactly as imported.
  stop("monterey-a", "Monterey Junction", 14.292233, 120.922922),
  stop("monterey-b", "Monterey Junction", 14.291836, 120.924368),
  stop("monterey-c", "Monterey Junction", 14.292947, 120.924008),
  // The two kerbs of LPU Cavite, 109m apart. Each one is served by only one direction of travel.
  stop("lpu-east", "LPU Cavite", 14.292273, 120.916183),
  stop("lpu-west", "LPU Cavite", 14.292075, 120.915193),
  stop("manggahan", "Manggahan Junction", 14.29216, 120.912151),
  stop("trece-terminal", "Trece Martires Bus Terminal", 14.283, 120.865, true),
  stop("osorio", "Osorio", 14.279984, 120.878876),
  stop("alfonso-proper", "Alfonso Proper", 14.138434, 120.855537, true),
  stop("f-tirona", "F. Tirona", 14.326104, 120.938211),
  stop("naic-terminal", "Naic Transport Terminal", 14.3168, 120.7686, true),
  stop("alabang-viaduct", "Alabang Viaduct", 14.4189, 121.0409),
]

const ROUTES: Route[] = [
  route("molino-trece", MOLINO_TO_TRECE, { vehicle_class: "jeepney_traditional" }),
  route("r31-to-trece", ROUTE_31, { ref: "31", paired_route_id: "r31-to-pitx" }),
  route("r31-to-pitx", ROUTE_31, { ref: "31", paired_route_id: "r31-to-trece" }),
  route("r58-to-naic", ROUTE_58, { ref: "58", paired_route_id: "r58-to-alabang" }),
  route("r58-to-alabang", ROUTE_58, { ref: "58", paired_route_id: "r58-to-naic" }),
  route("dasma-alfonso", DASMA_ALFONSO, { paired_route_id: "alfonso-dasma" }),
  route("alfonso-dasma", DASMA_ALFONSO, { paired_route_id: "dasma-alfonso" }),
]

const ROUTE_STOPS: RouteStop[] = [
  sequence("molino-trece", ["sm-molino", "bella-vista", "calax-overpass", "monterey-a", "manggahan", "osorio"]),
  sequence("r31-to-trece", ["pitx", "pala-pala", "monterey-a", "lpu-east", "manggahan", "trece-terminal"]),
  sequence("r31-to-pitx", ["trece-terminal", "manggahan", "lpu-west", "monterey-b", "pala-pala", "pitx"]),
  sequence("r58-to-naic", ["alabang-viaduct", "monterey-a", "lpu-east", "manggahan", "naic-terminal"]),
  sequence("r58-to-alabang", ["naic-terminal", "manggahan", "lpu-west", "monterey-c", "alabang-viaduct"]),
  sequence("dasma-alfonso", ["f-tirona", "pala-pala", "monterey-a", "manggahan", "alfonso-proper"]),
  sequence("alfonso-dasma", ["alfonso-proper", "manggahan", "monterey-a", "pala-pala", "f-tirona"]),
].flat()

const CORRIDOR: TransitNetworkTables = {
  stops: STOPS,
  routes: ROUTES,
  routeStops: ROUTE_STOPS,
  routeGeometries: [],
}

const NETWORK = buildNetworkFromDatabase(CORRIDOR)

/** The merged node that now stands for a place, found the way the picker would find it. */
function nodeIdNamed(name: string): string {
  const matches = selectableNodes(NETWORK).filter((node) => node.name === name)
  expect(matches, `expected exactly one selectable "${name}"`).toHaveLength(1)
  return matches[0].id
}

describe("Bella Vista to LPU Cavite", () => {
  it("offers LPU Cavite as one stop, not one per kerb", () => {
    const lpu = selectableNodes(NETWORK).filter((node) => node.name === "LPU Cavite")
    expect(lpu).toHaveLength(1)
    // Positioned between the two kerbs it replaces.
    expect(lpu[0].lat).toBeCloseTo(14.292174, 5)
    expect(lpu[0].lng).toBeCloseTo(120.915688, 5)

    // Same rule, same reason: three Monterey Junction nodes are one junction.
    expect(selectableNodes(NETWORK).filter((node) => node.name === "Monterey Junction")).toHaveLength(1)
  })

  it.each(["cheapest", "fastest", "easiest"] as const)("never rides past LPU Cavite and back (%s)", (priority) => {
    const result = findRoute(NETWORK, nodeIdNamed("Bella Vista"), nodeIdNamed("LPU Cavite"), priority)
    expect(result).not.toBeNull()

    // Manggahan Junction is 300m west of LPU Cavite. Getting off there means the trip overshot
    // its destination and has to come back east, which is what the commuter reported.
    const visited = result!.steps.flatMap((step) => [step.from, ...step.viaStops, step.to])
    expect(visited).not.toContain("Manggahan Junction")

    expect(result!.steps[result!.steps.length - 1].to).toBe("LPU Cavite")
    expect(result!.steps.filter((step) => step.to === "LPU Cavite")).toHaveLength(1)
  })

  it("names each signboard by where the vehicle is going, not where it came from", () => {
    const result = findRoute(NETWORK, nodeIdNamed("Bella Vista"), nodeIdNamed("LPU Cavite"), "cheapest")
    expect(result).not.toBeNull()

    const placards = result!.steps.filter((step) => step.mode !== "walk").map((step) => step.placardText)
    expect(placards.length).toBeGreaterThan(0)

    // Both legs of this trip run west, toward Trece Martires. A board naming Molino, Dasmariñas
    // or PITX points a commuter at a vehicle going the other way down the same road.
    for (const placard of placards) {
      expect(placard).not.toContain("MOLINO")
      expect(placard).not.toContain("DASMARI")
      expect(placard).not.toContain("PITX")
    }

    expect(result!.steps[0].from).toBe("Bella Vista")
    expect(result!.steps[0].placardText).toContain("TRECE MARTIRES")
  })

  it("rides straight through without changing vehicles", () => {
    // The whole point of the trip. The Trece-bound jeepney from Bella Vista drives past LPU
    // Cavite's door; the commuter stays seated, and so should the plan.
    for (const priority of ["cheapest", "fastest", "easiest"] as const) {
      const result = findRoute(NETWORK, nodeIdNamed("Bella Vista"), nodeIdNamed("LPU Cavite"), priority)
      expect(result, priority).not.toBeNull()
      expect(result!.transferCount, `${priority} should be a single-seat ride`).toBe(0)
      expect(result!.steps.filter((step) => step.mode !== "walk"), priority).toHaveLength(1)
      // Monterey Junction is still on the way -- it is just passed, not alighted at.
      expect(result!.steps[0].viaStops, priority).toContain("Monterey Junction")
    }
  })

  it("serves a stop the route drives past but never lists", () => {
    // LPU Cavite is nowhere in molino-trece's own sequence. It qualifies because it sits 8m from
    // the line between Monterey Junction and Manggahan Junction, which the relation does list.
    const listed = ROUTE_STOPS.filter((routeStop) => routeStop.route_id === "molino-trece").map(
      (routeStop) => routeStop.stop_id
    )
    expect(listed).not.toContain("lpu-east")
    expect(listed).not.toContain("lpu-west")

    const lpuId = nodeIdNamed("LPU Cavite")
    const served = NETWORK.edges.filter((edge) => edge.serviceId === "molino-trece" && edge.toNodeId === lpuId)
    expect(served).toHaveLength(1)
  })

  it("inserts nothing on a stretch too long to model as a straight line", () => {
    // Alfonso Proper is 17km south of Manggahan Junction, so dasma-alfonso's last gap is far past
    // PASSED_STOP_MAX_CHORD_METERS. Whatever happens to lie near that chord stays out.
    const nameById = new Map(NETWORK.nodes.map((node) => [node.id, node.name]))
    const longGapEdges = NETWORK.edges.filter(
      (edge) => edge.serviceId === "dasma-alfonso" && nameById.get(edge.fromNodeId) === "Manggahan Junction"
    )
    expect(longGapEdges).toHaveLength(1)
    expect(nameById.get(longGapEdges[0].toNodeId)).toBe("Alfonso Proper")
  })

  it("builds no edge that runs against the direction its route travels", () => {
    // Checked geometrically rather than against `sequence`, because a route now also serves stops
    // its relation never listed and those have no sequence number to compare. Projecting both ends
    // of every edge onto the line through the route's listed stops is the independent test: an
    // edge that runs backward projects to a smaller distance than it started from, whether or not
    // either of its endpoints was in the original list.
    const stopById = new Map(STOPS.map((stopRow) => [stopRow.id, stopRow]))
    const nameById = new Map(NETWORK.nodes.map((node) => [node.id, node.name]))

    const listedPathOf = (routeId: string): LatLng[] =>
      ROUTE_STOPS.filter((routeStop) => routeStop.route_id === routeId)
        .sort((a, b) => a.sequence - b.sequence)
        .map((routeStop) => stopById.get(routeStop.stop_id)!)
        .map((stopRow) => [stopRow.lat, stopRow.lon] as LatLng)

    const geometryByRoute = new Map(ROUTES.map((r) => [r.id, buildRouteGeometry([{ path: listedPathOf(r.id) }])]))

    for (const edge of NETWORK.edges) {
      const geometry = geometryByRoute.get(edge.serviceId)!
      const nodeById = new Map(NETWORK.nodes.map((node) => [node.id, node]))
      const at = (nodeId: string): number => {
        const node = nodeById.get(nodeId)!
        return projectOntoRoute(geometry, [node.lat, node.lng])!.distanceTraveledMeters
      }
      const label = `${edge.serviceId}: ${nameById.get(edge.fromNodeId)} to ${nameById.get(edge.toNodeId)}`
      expect(at(edge.toNodeId), `${label} runs backward`).toBeGreaterThan(at(edge.fromNodeId))
    }
  })
})

describe("derivePlacardText", () => {
  // Every case below is a real row from the live database, with the last and first stop its own
  // sequence actually ends and starts at.
  it.each([
    // An arrow in the name states the direction outright.
    [MOLINO_TO_TRECE, null, "SM City Molino", "Osorio", "WALTERMART TRECE MARTIRES"],
    [
      `Jeepney Route: WalterMart Trece Martires ${ARROW} SM Molino`,
      null,
      "WalterMart Trece Martires",
      "SM City Molino",
      "SM MOLINO",
    ],
    // Both directions share one name, so the sequence has to settle it. Here the last stop does.
    [ROUTE_31, "31", "PITX", "Trece Martires Bus Terminal", "31 · TRECE MARTIRES"],
    [ROUTE_31, "31", "Trece Martires Bus Terminal", "PITX", "31 · PITX"],
    [DASMA_ALFONSO, null, "F. Tirona", "Alfonso Proper", "ALFONSO"],
    // ...and here it does not: "F. Tirona" names neither end, so the first stop settles it from
    // the other side. Same for Route 58 finishing at "Vista Terminal Exchange", which is in
    // Alabang but does not say so.
    [DASMA_ALFONSO, null, "Alfonso Proper", "F. Tirona", "DASMARIÑAS"],
    [ROUTE_58, "58", "Alabang Viaduct", "Naic Transport Terminal", "58 · NAIC"],
    [ROUTE_58, "58", "Naic Transport Terminal", "Vista Terminal Exchange", "58 · ALABANG"],
  ])("signs %s (ref %s) running %s to %s as %s", (name, ref, firstStop, lastStop, expected) => {
    expect(derivePlacardText(route("r", name, { ref }), firstStop, lastStop)).toBe(expected)
  })

  it("falls back to the last stop when the name carries no endpoints at all", () => {
    expect(derivePlacardText(route("r", "Barangay Loop"), "Palapala", "Salitran")).toBe("SALITRAN")
  })

  it("never puts a placeholder name on a signboard", () => {
    // ~36 imported stops are unnamed OSM nodes. A route ending on one still needs a readable
    // board, so the route's own name is the better answer there.
    expect(derivePlacardText(route("r", "Barangay Loop"), "Palapala", "Unnamed stop")).toBe("BARANGAY LOOP")
  })
})
