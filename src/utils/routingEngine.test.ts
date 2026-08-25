import { describe, expect, it } from "vitest"

import { computeFare } from "@/utils/fares"
import { haversineMeters } from "@/utils/geo"
import CAVITE_PILOT_NETWORK, {
  CAVITE_PILOT_EDGES,
  CAVITE_PILOT_NODES,
  WALKING_TRANSFER_RADIUS_METERS,
  computeConfidence,
  findRoute,
  findRoutes,
  type RouteStep,
  type TransitNetwork,
  type TransitNode,
} from "@/utils/routingEngine"

function step(overrides: Partial<RouteStep> = {}): RouteStep {
  return {
    mode: "jeepney",
    vehicleClass: "jeepney_traditional",
    serviceId: "jeepney:a:b",
    from: "A",
    to: "B",
    viaStops: [],
    placardText: "B / SOMEWHERE",
    alternatePlacards: [],
    boardingSpot: "Sa waiting shed ng A.",
    driverPhrase: "B po",
    landmarkCues: ["B gate"],
    landmark: "B gate",
    fare: 13,
    durationMin: 10,
    distanceMeters: 2500,
    landmarkVerified: true,
    path: [
      [0, 0],
      [1, 1],
    ],
    ...overrides,
  }
}

const ISLAND_NODE: TransitNode = {
  id: "nowhere",
  name: "Nowhere",
  shortName: "Nowhere",
  lat: 0,
  lng: 0,
  city: "Nowhere",
  isTerminal: false,
  aliases: ["nowhere"],
  waitingSpot: "Wala.",
}

describe("findRoute", () => {
  it("returns null when the destination can't be reached", () => {
    const island: TransitNetwork = {
      nodes: [...CAVITE_PILOT_NODES, ISLAND_NODE],
      edges: CAVITE_PILOT_EDGES,
    }
    expect(findRoute(island, "st-dominic", "nowhere", "cheapest")).toBeNull()
  })

  it("is deterministic across runs", () => {
    const first = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "silang-premier", "easiest")
    const second = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "silang-premier", "easiest")
    expect(first).toEqual(second)
  })

  it("charges the cheapest route no more than the fastest one", () => {
    const { cheapest, fastest } = findRoutes("st-dominic", "lpu-gentri")
    expect(cheapest).not.toBeNull()
    expect(fastest).not.toBeNull()
    expect(cheapest!.totalFare).toBeLessThanOrEqual(fastest!.totalFare)
    expect(fastest!.totalDurationMin).toBeLessThanOrEqual(cheapest!.totalDurationMin)
  })

  it("totals match the sum of the steps", () => {
    const route = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "lpu-gentri", "cheapest")!
    const fare = route.steps.reduce((sum, s) => sum + s.fare, 0)
    const duration = route.steps.reduce((sum, s) => sum + s.durationMin, 0)
    expect(route.totalFare).toBeCloseTo(fare)
    expect(route.totalDurationMin).toBeCloseTo(duration)
  })

  it("reaches every stop from every other stop", () => {
    for (const origin of CAVITE_PILOT_NODES) {
      for (const dest of CAVITE_PILOT_NODES) {
        if (origin.id === dest.id) continue
        expect(findRoute(CAVITE_PILOT_NETWORK, origin.id, dest.id, "fastest")).not.toBeNull()
      }
    }
  })
})

describe("walking-first rule", () => {
  const nearPairs = CAVITE_PILOT_NODES.flatMap((a, i) =>
    CAVITE_PILOT_NODES.slice(i + 1)
      .map((b) => ({ a, b, meters: haversineMeters([a.lat, a.lng], [b.lat, b.lng]) }))
      .filter((pair) => pair.meters <= WALKING_TRANSFER_RADIUS_METERS)
  )

  it("finds at least one pair close enough for the rule to bite", () => {
    // Guards the tests below from silently passing on an empty set if coordinates ever move.
    expect(nearPairs.length).toBeGreaterThan(0)
  })

  it("offers no paid vehicle between two stops inside the walking radius", () => {
    for (const { a, b } of nearPairs) {
      const between = CAVITE_PILOT_EDGES.filter(
        (edge) =>
          (edge.fromNodeId === a.id && edge.toNodeId === b.id) || (edge.fromNodeId === b.id && edge.toNodeId === a.id)
      )
      expect(between.length).toBeGreaterThan(0)
      for (const edge of between) {
        expect(edge.mode).toBe("walk")
        expect(edge.fare).toBe(0)
      }
    }
  })

  it("solves a short hop between adjacent terminals as one free walk", () => {
    const route = findRoute(CAVITE_PILOT_NETWORK, "sm-dasma", "pala-pala", "cheapest")!
    expect(route.steps).toHaveLength(1)
    expect(route.steps[0].mode).toBe("walk")
    expect(route.totalFare).toBe(0)
    expect(route.transferCount).toBe(0)
  })
})

describe("fares", () => {
  it("prices every vehicle leg straight off the fare matrix", () => {
    for (const edge of CAVITE_PILOT_EDGES) {
      expect(edge.fare).toBe(computeFare(edge.vehicleClass, edge.distanceMeters / 1000))
    }
  })

  it("never quotes centavos", () => {
    for (const edge of CAVITE_PILOT_EDGES) {
      expect(Number.isInteger(edge.fare)).toBe(true)
    }
  })

  it("charges a modern jeep more than a traditional one over the same distance", () => {
    expect(computeFare("jeepney_modern", 6)).toBeGreaterThan(computeFare("jeepney_traditional", 6))
  })
})

describe("placards", () => {
  it("gives every vehicle segment a signboard to look for", () => {
    for (const edge of CAVITE_PILOT_EDGES) {
      if (edge.mode === "walk") continue
      expect(edge.placardText.trim().length).toBeGreaterThan(0)
    }
  })

  it("tells the commuter where to stand for every segment", () => {
    for (const edge of CAVITE_PILOT_EDGES) {
      expect(edge.boardingSpot.trim().length).toBeGreaterThan(0)
    }
  })

  it("carries the boarding placard of the direction actually travelled", () => {
    const outbound = CAVITE_PILOT_EDGES.find(
      (edge) => edge.fromNodeId === "pala-pala" && edge.toNodeId === "lpu-gentri" && edge.mode === "jeepney"
    )!
    const inbound = CAVITE_PILOT_EDGES.find(
      (edge) => edge.fromNodeId === "lpu-gentri" && edge.toNodeId === "pala-pala" && edge.mode === "jeepney"
    )!
    expect(outbound.placardText).not.toBe(inbound.placardText)
  })
})

describe("leg merging", () => {
  it("never leaves two walking legs back to back", () => {
    for (const origin of CAVITE_PILOT_NODES) {
      for (const dest of CAVITE_PILOT_NODES) {
        if (origin.id === dest.id) continue
        for (const route of Object.values(findRoutes(origin.id, dest.id))) {
          if (route === null) continue
          route.steps.forEach((current, index) => {
            const next = route.steps[index + 1]
            if (next === undefined) return
            expect(current.mode === "walk" && next.mode === "walk").toBe(false)
          })
        }
      }
    }
  })

  it("gives every step a path that starts where the last one ended", () => {
    const route = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "lpu-gentri", "cheapest")!
    route.steps.forEach((current, index) => {
      const next = route.steps[index + 1]
      if (next === undefined) return
      expect(next.path[0]).toEqual(current.path[current.path.length - 1])
    })
    const [lat, lng] = route.steps[0].path[0]
    const [originLat, originLng] = route.polylineCoordinates[0]
    expect(lat).toBeCloseTo(originLat, 3)
    expect(lng).toBeCloseTo(originLng, 3)
  })
})

describe("road geometry", () => {
  it("traces the actual road instead of a straight line between stops", () => {
    // A straight line is exactly two points; every vehicle edge carries real OSRM geometry, so even
    // the shortest ride should have more than its two endpoints. Walking edges are the deliberate
    // exception: inside the walking radius the "road" is a vehicle detour, so they stay straight.
    for (const edge of CAVITE_PILOT_EDGES) {
      if (edge.mode === "walk") continue
      expect(edge.roadPath.length).toBeGreaterThan(2)
    }
  })

  it("starts and ends each road path on the stops it connects", () => {
    for (const edge of CAVITE_PILOT_EDGES) {
      const from = CAVITE_PILOT_NODES.find((node) => node.id === edge.fromNodeId)!
      const to = CAVITE_PILOT_NODES.find((node) => node.id === edge.toNodeId)!
      expect(edge.roadPath[0]).toEqual([from.lat, from.lng])
      expect(edge.roadPath[edge.roadPath.length - 1]).toEqual([to.lat, to.lng])
    }
  })

  it("meters fares on road distance, which is never shorter than the crow flies", () => {
    for (const edge of CAVITE_PILOT_EDGES) {
      const from = CAVITE_PILOT_NODES.find((node) => node.id === edge.fromNodeId)!
      const to = CAVITE_PILOT_NODES.find((node) => node.id === edge.toNodeId)!
      const straight = haversineMeters([from.lat, from.lng], [to.lat, to.lng])
      expect(edge.distanceMeters).toBeGreaterThanOrEqual(Math.round(straight) - 1)
    }
  })
})

describe("transferCount", () => {
  it("counts a jeepney-to-jeepney change as a transfer", () => {
    // Two separate jeepney services end to end: the commuter gets off and boards again.
    const jeepOnly: TransitNetwork = {
      nodes: CAVITE_PILOT_NODES,
      edges: CAVITE_PILOT_EDGES.filter((edge) => edge.mode === "jeepney"),
    }
    const route = findRoute(jeepOnly, "st-dominic", "robinsons-dasma", "cheapest")!
    expect(route.steps).toHaveLength(2)
    expect(route.steps.every((s) => s.mode === "jeepney")).toBe(true)
    expect(route.transferCount).toBe(1)
  })

  it("does not count walking as a boarding", () => {
    const route = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "lpu-gentri", "cheapest")!
    const vehicleLegs = route.steps.filter((s) => s.mode !== "walk").length
    expect(route.transferCount).toBe(vehicleLegs - 1)
    expect(route.walkingMinutes).toBe(
      route.steps.filter((s) => s.mode === "walk").reduce((sum, s) => sum + s.durationMin, 0)
    )
  })

  it("reports a single-vehicle trip as zero transfers", () => {
    const route = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "sm-dasma", "fastest")!
    expect(route.transferCount).toBe(0)
    expect(route.steps).toHaveLength(1)
  })
})

describe("computeConfidence", () => {
  it("scores fully verified, transfer-free routes highest", () => {
    const verified = computeConfidence([step(), step()], 0)
    const inferred = computeConfidence([step({ landmarkVerified: false }), step({ landmarkVerified: false })], 0)
    expect(verified).toBeGreaterThan(inferred)
  })

  it("drops as transfers and walking legs pile up", () => {
    const direct = computeConfidence([step()], 0)
    const messy = computeConfidence([step(), step({ mode: "walk" }), step()], 2)
    expect(messy).toBeLessThan(direct)
  })

  it("stays inside 40-99", () => {
    expect(computeConfidence([], 0)).toBe(0)
    expect(computeConfidence([step()], 0)).toBeLessThanOrEqual(99)
    expect(
      computeConfidence(
        Array.from({ length: 8 }, () => step({ mode: "walk", landmarkVerified: false })),
        7
      )
    ).toBeGreaterThanOrEqual(40)
  })
})
