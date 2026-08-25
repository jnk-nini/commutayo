import { describe, expect, it } from "vitest"

import {
  CASH_INCREMENT,
  FARE_CLASSES,
  computeFare,
  discountedFare,
  discountedTotalFare,
  fareSavings,
  formatPeso,
  roundToCash,
} from "@/utils/fares"
import CAVITE_PILOT_NETWORK, { findRoute, type RouteResult } from "@/utils/routingEngine"

const route: RouteResult = findRoute(CAVITE_PILOT_NETWORK, "st-dominic", "lpu-gentri", "cheapest")!

describe("computeFare", () => {
  it("charges only the base fare inside the base distance", () => {
    expect(computeFare("jeepney_traditional", 1)).toBe(13)
    expect(computeFare("jeepney_traditional", 4)).toBe(13)
    expect(computeFare("jeepney_modern", 4)).toBe(15)
    expect(computeFare("bus", 5)).toBe(15)
  })

  it("adds the per-kilometer rate past the base distance", () => {
    // 13 + (8 - 4) * 1.80 = 20.20, which is 20 pesos in cash.
    expect(computeFare("jeepney_traditional", 8)).toBe(20)
    // 15 + (10 - 5) * 2.20 = 26.00
    expect(computeFare("bus", 10)).toBe(26)
  })

  it("ignores distance for point-to-point services", () => {
    expect(computeFare("uv_express", 3)).toBe(50)
    expect(computeFare("uv_express", 30)).toBe(50)
    expect(computeFare("tricycle", 9)).toBe(35)
  })

  it("keeps walking free", () => {
    expect(computeFare("walk", 0.3)).toBe(0)
  })

  it("never returns centavos", () => {
    for (let km = 0.5; km <= 30; km += 0.5) {
      expect(roundToCash(computeFare("jeepney_traditional", km))).toBe(computeFare("jeepney_traditional", km))
      expect(computeFare("bus", km) % CASH_INCREMENT).toBe(0)
    }
  })
})

describe("discountedFare", () => {
  it("leaves the regular fare alone", () => {
    expect(discountedFare(13, "regular")).toBe(13)
  })

  it("takes 20% off for students, seniors, and PWDs", () => {
    expect(discountedFare(25, "student")).toBe(20)
    expect(discountedFare(25, "senior_pwd")).toBe(20)
  })

  it("rounds the discount to cash a conductor can hand back", () => {
    // 13 * 0.8 = 10.40 -> 10, and 19 * 0.8 = 15.20 -> 15. Neither leaves loose centavos.
    expect(discountedFare(13, "student")).toBe(10)
    expect(discountedFare(19, "student")).toBe(15)
    expect(discountedFare(18, "student")).toBe(14)
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

describe("formatPeso", () => {
  it("drops the decimals on whole amounts", () => {
    expect(formatPeso(18)).toBe("₱18")
    expect(formatPeso(0)).toBe("₱0")
  })

  it("keeps them when an amount really has them", () => {
    expect(formatPeso(18.5)).toBe("₱18.50")
  })
})
