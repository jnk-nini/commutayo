import { describe, expect, it } from "vitest"

import CAVITE_PILOT_NETWORK, {
  CAVITE_PILOT_EDGES,
  CAVITE_PILOT_NODES,
  computeConfidence,
  findRoute,
  findRoutes,
  type RouteStep,
  type TransitNetwork,
} from "@/utils/routingEngine"

function step(overrides: Partial<RouteStep> = {}): RouteStep {
  return {
    mode: "jeepney",
    serviceId: "jeepney:a:b",
    from: "A",
    to: "B",
    viaStops: [],
    signboard: "B",
    driverPhrase: "B po",
    landmarkCues: ["B gate"],
    landmark: "B gate",
    fare: 13,
    durationMin: 10,
    landmarkVerified: true,
    path: [
      [0, 0],
      [1, 1],
    ],
    ...overrides,
  }
}

describe("findRoute", () => {
  it("returns null when the destination can't be reached", () => {
    const island: TransitNetwork = {
      nodes: [...CAVITE_PILOT_NODES, { id: "nowhere", name: "Nowhere", lat: 0, lng: 0, city: "—", isTerminal: false }],
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

  it("merges a walk-through-an-interchange into one continuous leg", () => {
    // Robinsons Dasma -> SM Dasma -> Pala-Pala are both walkable, so walking the pair is one walk.
    const walkOnly: TransitNetwork = {
      nodes: CAVITE_PILOT_NODES,
      edges: CAVITE_PILOT_EDGES.filter((edge) => edge.mode === "walk"),
    }
    const route = findRoute(walkOnly, "robinsons-dasma", "pala-pala", "fastest")!
    expect(route.steps).toHaveLength(1)
    expect(route.steps[0].from).toBe("Robinsons Place Dasmariñas")
    expect(route.steps[0].to).toBe("Pala-Pala Terminal")
    expect(route.steps[0].viaStops).toEqual(["SM City Dasmariñas"])
    expect(route.steps[0].durationMin).toBe(16 + 8)
    // The merged leg keeps a full path, so the map can still draw every corner of it.
    expect(route.steps[0].path).toHaveLength(3)
  })

  it("gives every step a path that starts where the last one ended", () => {
    const route = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "lpu-gentri", "cheapest")!
    route.steps.forEach((current, index) => {
      const next = route.steps[index + 1]
      if (next === undefined) return
      expect(next.path[0]).toEqual(current.path[current.path.length - 1])
    })
    expect(route.steps[0].path[0]).toEqual(route.polylineCoordinates[0])
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
    expect(computeConfidence(Array.from({ length: 8 }, () => step({ mode: "walk", landmarkVerified: false })), 7)).toBeGreaterThanOrEqual(40)
  })
})
