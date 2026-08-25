import { describe, expect, it } from "vitest"

import { buildNetworkFromDatabase, selectableNodes } from "@/utils/dynamicRoutingEngine"
import { findRoute } from "@/utils/routingEngine"
import type { TransitNetworkTables } from "@/utils/transitRepository"
import type { Route, RouteGeometry, RouteStop, Stop } from "@/types/transit"

function stop(overrides: Partial<Stop> = {}): Stop {
  return {
    id: "stop-a",
    name: "Stop A",
    short_name: null,
    lat: 14.3,
    lon: 120.95,
    city: "Dasmariñas",
    is_terminal: false,
    aliases: [],
    waiting_spot: null,
    source: "osm",
    confidence_tier: "medium",
    ...overrides,
  }
}

function route(overrides: Partial<Route> = {}): Route {
  return {
    id: "route-a",
    name: "Test Route",
    ref: null,
    direction: null,
    paired_route_id: null,
    vehicle_class: "jeepney_traditional",
    vehicle_class_confidence: "default_fallback",
    flat_fare: null,
    geometry_quality: "unknown",
    confidence_tier: "low",
    needs_review: false,
    is_active: true,
    ...overrides,
  }
}

function tables(overrides: Partial<TransitNetworkTables> = {}): TransitNetworkTables {
  return { stops: [], routes: [], routeStops: [], routeGeometries: [], ...overrides }
}

describe("buildNetworkFromDatabase", () => {
  it("builds one directed edge per adjacent stop pair, following route_stops.sequence", () => {
    const stops: Stop[] = [
      stop({ id: "a", name: "A", lat: 14.30, lon: 120.95 }),
      stop({ id: "b", name: "B", lat: 14.31, lon: 120.95 }),
      stop({ id: "c", name: "C", lat: 14.32, lon: 120.95 }),
    ]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
      { id: "rs3", route_id: "route-a", stop_id: "c", sequence: 2, role: null },
    ]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops }))

    expect(network.nodes).toHaveLength(3)
    expect(network.edges).toHaveLength(2)
    expect(network.edges.map((e) => [e.fromNodeId, e.toNodeId])).toEqual([
      ["a", "b"],
      ["b", "c"],
    ])
    // Directed only -- no reverse edge is synthesized.
    expect(network.edges.some((e) => e.fromNodeId === "c" && e.toNodeId === "a")).toBe(false)
  })

  it("gives every edge from the same route the same serviceId, so they merge into one ride", () => {
    const stops: Stop[] = [stop({ id: "a" }), stop({ id: "b" }), stop({ id: "c" })]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
      { id: "rs3", route_id: "route-a", stop_id: "c", sequence: 2, role: null },
    ]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops }))

    expect(new Set(network.edges.map((e) => e.serviceId))).toEqual(new Set(["route-a"]))

    const result = findRoute(network, "a", "c", "fastest")
    expect(result?.steps).toHaveLength(1)
    expect(result?.transferCount).toBe(0)
  })

  // Regression: the base fare is paid once per boarding, not once per stop the vehicle passes.
  // Summing each segment's fare charged a multi-stop ride one base fare per segment -- ~3x on a
  // real PITX-Dasmariñas trip. Only visible once segments share a serviceId, which is exactly what
  // the DB model does and the pilot's per-segment serviceIds never did.
  it("charges one matrix fare for a whole ride, not a base fare per segment", () => {
    const stops: Stop[] = [
      stop({ id: "a", name: "A", lat: 14.30, lon: 120.95 }),
      stop({ id: "b", name: "B", lat: 14.32, lon: 120.95 }),
      stop({ id: "c", name: "C", lat: 14.34, lon: 120.95 }),
      stop({ id: "d", name: "D", lat: 14.36, lon: 120.95 }),
    ]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
      { id: "rs3", route_id: "route-a", stop_id: "c", sequence: 2, role: null },
      { id: "rs4", route_id: "route-a", stop_id: "d", sequence: 3, role: null },
    ]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops }))
    const result = findRoute(network, "a", "d", "cheapest")

    expect(result?.steps).toHaveLength(1)
    const ride = result!.steps[0]
    // Traditional jeepney: ₱13 covers the first 4 km, then ₱1.80/km. Three ~2.2 km hops is ~6.7 km.
    const expected = 13 + Math.max(0, ride.distanceMeters / 1000 - 4) * 1.8
    expect(ride.fare).toBe(Math.round(expected))
    // The bug summed three independent segment fares, each carrying its own ₱13 base.
    expect(ride.fare).toBeLessThan(39)
  })

  // The cheapest tab must never quote more than the other two. It did on live data once merged
  // rides were priced as one fare: the router still scored each segment at a full base fare, so it
  // optimised a cost nobody was charged and picked a route the easiest tab beat on price.
  it("never quotes more on the cheapest priority than on the fastest or easiest", () => {
    // Two ways from a to d: a slow direct one-vehicle ride, and a quick two-vehicle hop.
    const stops: Stop[] = [
      stop({ id: "a", name: "A", lat: 14.30, lon: 120.95 }),
      stop({ id: "b", name: "B", lat: 14.33, lon: 120.95 }),
      stop({ id: "c", name: "C", lat: 14.36, lon: 120.95 }),
      stop({ id: "d", name: "D", lat: 14.39, lon: 120.95 }),
    ]
    const routeStops: RouteStop[] = [
      // route-through: a -> b -> c -> d on one jeepney, so all three segments merge.
      { id: "t1", route_id: "route-through", stop_id: "a", sequence: 0, role: null },
      { id: "t2", route_id: "route-through", stop_id: "b", sequence: 1, role: null },
      { id: "t3", route_id: "route-through", stop_id: "c", sequence: 2, role: null },
      { id: "t4", route_id: "route-through", stop_id: "d", sequence: 3, role: null },
      // route-express: a -> d on a bus, one boarding but a pricier class.
      { id: "e1", route_id: "route-express", stop_id: "a", sequence: 0, role: null },
      { id: "e2", route_id: "route-express", stop_id: "d", sequence: 1, role: null },
    ]

    const network = buildNetworkFromDatabase(
      tables({
        stops,
        routes: [route({ id: "route-through" }), route({ id: "route-express", vehicle_class: "bus" })],
        routeStops,
      })
    )

    const cheapest = findRoute(network, "a", "d", "cheapest")
    const fastest = findRoute(network, "a", "d", "fastest")
    const easiest = findRoute(network, "a", "d", "easiest")

    expect(cheapest).not.toBeNull()
    expect(cheapest!.totalFare).toBeLessThanOrEqual(fastest!.totalFare)
    expect(cheapest!.totalFare).toBeLessThanOrEqual(easiest!.totalFare)
  })

  it("charges a flat-fare service once for a merged ride, not once per segment", () => {
    const stops: Stop[] = [
      stop({ id: "a", name: "A", lat: 14.30, lon: 120.95 }),
      stop({ id: "b", name: "B", lat: 14.32, lon: 120.95 }),
      stop({ id: "c", name: "C", lat: 14.34, lon: 120.95 }),
    ]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
      { id: "rs3", route_id: "route-a", stop_id: "c", sequence: 2, role: null },
    ]

    const network = buildNetworkFromDatabase(
      tables({ stops, routes: [route({ vehicle_class: "uv_express", flat_fare: 50 })], routeStops })
    )
    const result = findRoute(network, "a", "c", "cheapest")

    expect(result?.steps).toHaveLength(1)
    expect(result?.steps[0].fare).toBe(50)
  })

  it("skips a route with fewer than two stops instead of throwing", () => {
    const stops: Stop[] = [stop({ id: "a" })]
    const routeStops: RouteStop[] = [{ id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null }]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops }))

    expect(network.edges).toHaveLength(0)
  })

  it("excludes inactive routes", () => {
    const stops: Stop[] = [stop({ id: "a" }), stop({ id: "b" })]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
    ]

    const network = buildNetworkFromDatabase(
      tables({ stops, routes: [route({ is_active: false })], routeStops })
    )

    expect(network.edges).toHaveLength(0)
  })

  it("uses flat_fare when set, instead of computing from distance", () => {
    const stops: Stop[] = [stop({ id: "a" }), stop({ id: "b" })]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
    ]

    const network = buildNetworkFromDatabase(
      tables({
        stops,
        routes: [route({ vehicle_class: "uv_express", flat_fare: 50 })],
        routeStops,
      })
    )

    expect(network.edges[0].fare).toBe(50)
  })

  it("slices real road geometry between two stops instead of a straight line, when available", () => {
    const stops: Stop[] = [
      stop({ id: "a", lat: 14.30, lon: 120.95 }),
      stop({ id: "b", lat: 14.32, lon: 120.95 }),
    ]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
    ]
    // A wiggly polyline between A and B -- a straight line would be shorter than this path.
    const routeGeometries: RouteGeometry[] = [
      {
        route_id: "route-a",
        path: [
          [14.30, 120.95],
          [14.305, 120.955],
          [14.31, 120.945],
          [14.315, 120.955],
          [14.32, 120.95],
        ],
        point_count: 5,
        gap_count: 0,
      },
    ]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops, routeGeometries }))

    expect(network.edges[0].roadPath.length).toBeGreaterThan(2)
  })

  it("falls back to a straight line when a route has no geometry row yet", () => {
    const stops: Stop[] = [stop({ id: "a", lat: 14.30, lon: 120.95 }), stop({ id: "b", lat: 14.32, lon: 120.95 })]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
    ]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops }))

    expect(network.edges[0].roadPath).toHaveLength(2)
    expect(network.edges[0].distanceMeters).toBeGreaterThan(0)
  })

  // The OSM import carries ~70 long-haul coach routes that merely start at PITX (PITX-Davao,
  // PITX-Tacloban). Their far terminals are real data but not commutable, and left in they blow up
  // the map's initial fit and hand computeFare a 1500 km "segment".
  it("drops stops outside the service area", () => {
    const stops: Stop[] = [
      stop({ id: "pitx", name: "PITX", lat: 14.51, lon: 120.99 }),
      stop({ id: "davao", name: "Davao City Overland Transport Terminal", lat: 7.06, lon: 125.6 }),
    ]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "pitx", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "davao", sequence: 1, role: null },
    ]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops }))

    expect(network.nodes.map((n) => n.id)).toEqual(["pitx"])
    expect(network.edges).toHaveLength(0)
  })

  it("keeps the in-area hops of a route that leaves the service area", () => {
    const stops: Stop[] = [
      stop({ id: "a", name: "A", lat: 14.30, lon: 120.95 }),
      stop({ id: "b", name: "B", lat: 14.35, lon: 120.97 }),
      stop({ id: "far", name: "Far", lat: 13.14, lon: 123.74 }),
    ]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "b", sequence: 1, role: null },
      { id: "rs3", route_id: "route-a", stop_id: "far", sequence: 2, role: null },
    ]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops }))

    // a->b survives; b->far is the leg that leaves the region and is the only one dropped.
    expect(network.edges.map((e) => [e.fromNodeId, e.toNodeId])).toEqual([["a", "b"]])
  })
})

describe("selectableNodes", () => {
  it("offers only named stops that a vehicle actually serves", () => {
    const stops: Stop[] = [
      stop({ id: "a", name: "A" }),
      stop({ id: "b", name: "B" }),
      // Real graph members, but not things a commuter can pick as an endpoint.
      stop({ id: "nameless", name: "Unnamed stop" }),
      stop({ id: "orphan", name: "Served by nothing" }),
    ]
    const routeStops: RouteStop[] = [
      { id: "rs1", route_id: "route-a", stop_id: "a", sequence: 0, role: null },
      { id: "rs2", route_id: "route-a", stop_id: "nameless", sequence: 1, role: null },
      { id: "rs3", route_id: "route-a", stop_id: "b", sequence: 2, role: null },
    ]

    const network = buildNetworkFromDatabase(tables({ stops, routes: [route()], routeStops }))

    expect(network.nodes).toHaveLength(4)
    expect(selectableNodes(network).map((n) => n.id)).toEqual(["a", "b"])
  })
})
