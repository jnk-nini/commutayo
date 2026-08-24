import { describe, expect, it } from "vitest"

import { discountedFare, discountedTotalFare, fareSavings, FARE_CLASSES } from "@/utils/fares"
import { findRoute, type RouteResult } from "@/utils/routingEngine"
import CAVITE_PILOT_NETWORK from "@/utils/routingEngine"

const route: RouteResult = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "lpu-gentri", "cheapest")!

describe("discountedFare", () => {
  it("leaves the regular fare alone", () => {
    expect(discountedFare(13, "regular")).toBe(13)
  })

  it("takes 20% off for students, seniors, and PWDs", () => {
    expect(discountedFare(25, "student")).toBe(20)
    expect(discountedFare(25, "senior_pwd")).toBe(20)
  })

  it("rounds to the nearest 25 centavos", () => {
    expect(discountedFare(13, "student")).toBe(10.5)
    expect(discountedFare(19, "student")).toBe(15.25)
  })

  it("keeps free legs free", () => {
    for (const option of FARE_CLASSES) {
      expect(discountedFare(0, option.id)).toBe(0)
    }
  })
})

describe("discountedTotalFare", () => {
  it("matches the route total at the regular rate", () => {
    expect(discountedTotalFare(route, "regular")).toBeCloseTo(route.totalFare)
    expect(fareSavings(route, "regular")).toBe(0)
  })

  it("saves money for a discounted rider without going negative", () => {
    const discounted = discountedTotalFare(route, "senior_pwd")
    expect(discounted).toBeLessThan(route.totalFare)
    expect(discounted).toBeGreaterThan(0)
    expect(fareSavings(route, "senior_pwd")).toBeCloseTo(route.totalFare - discounted)
  })

  it("discounts each leg the way a conductor would, not the grand total", () => {
    const perLeg = route.steps.reduce((sum, step) => sum + discountedFare(step.fare, "student"), 0)
    expect(discountedTotalFare(route, "student")).toBeCloseTo(perLeg)
  })
})
