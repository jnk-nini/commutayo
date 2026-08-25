import { describe, expect, it } from "vitest"

import { buildNetworkFromDatabase } from "@/utils/dynamicRoutingEngine"
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
})
