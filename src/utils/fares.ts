// Every peso in the app is computed here. Two jobs:
//
//   1. The LTFRB-style fare matrix: base fare per vehicle type plus a per-kilometer rate after
//      the base distance. The routing engine calls this so no edge in the graph carries a
//      hand-typed fare that can drift from the rules.
//   2. Discounts and cash rounding. Students, senior citizens and PWDs get 20% off (RA 9994,
//      RA 10754, and the LTFRB student fare rules), and every amount is rounded to money a
//      conductor can actually make change for.
//
// Rounding is the reason this file exists at all: a raw formula produces ₱15.25, and nobody has
// ever handed a jeepney driver 25 centavos. Real matrices are printed in whole pesos.

import type { RouteResult, RouteStep } from "@/utils/routingEngine"

// ---------------------------------------------------------------------------
// Cash rounding
// ---------------------------------------------------------------------------

/**
 * The smallest amount a fare is allowed to land on. ₱1 matches how printed LTFRB matrices are
 * published along this corridor; set it to 0.5 if a route's matrix is ever published in
 * half-peso steps and every fare in the app follows.
 */
export const CASH_INCREMENT = 1

/** Commercial rounding to the nearest payable amount. Half rounds up, the way a fare table does. */
export function roundToCash(amount: number): number {
  if (amount <= 0) return 0
  return Math.round(amount / CASH_INCREMENT) * CASH_INCREMENT
}

// ---------------------------------------------------------------------------
// Fare matrix
// ---------------------------------------------------------------------------

/**
 * What the commuter is boarding, for fare purposes. This is finer-grained than `TransitMode`:
 * a traditional jeepney and a modern (e-jeep / PUV-modernization) jeepney look the same on the
 * map and carry the same icon, but their base fares differ by ₱2.
 */
export type VehicleClass = "jeepney_traditional" | "jeepney_modern" | "bus" | "uv_express" | "tricycle" | "walk"

interface FareRule {
  label: string
  /** Pesos charged for any trip up to `baseKm`. */
  baseFare: number
  /** Kilometers covered by `baseFare`. */
  baseKm: number
  /** Pesos per kilometer past `baseKm`. */
  perKm: number
  /** Set for services that charge one price point-to-point and ignore distance entirely. */
  flatFare?: number
}

// Rates per docs/cavite-network.md, which follows the LTFRB fare structure for the corridor.
// UV Express and tricycle are point-to-point services with a fixed price, not metered by distance.
const FARE_RULES: Record<VehicleClass, FareRule> = {
  jeepney_traditional: { label: "Traditional Jeepney", baseFare: 13, baseKm: 4, perKm: 1.8 },
  jeepney_modern: { label: "Modern Jeepney", baseFare: 15, baseKm: 4, perKm: 1.8 },
  bus: { label: "Bus", baseFare: 15, baseKm: 5, perKm: 2.2 },
  uv_express: { label: "UV Express", baseFare: 50, baseKm: Infinity, perKm: 0, flatFare: 50 },
  tricycle: { label: "Tricycle", baseFare: 35, baseKm: Infinity, perKm: 0, flatFare: 35 },
  walk: { label: "Lakad", baseFare: 0, baseKm: Infinity, perKm: 0, flatFare: 0 },
}

export function fareRuleFor(vehicleClass: VehicleClass): FareRule {
  return FARE_RULES[vehicleClass]
}

/**
 * The regular adult fare for one leg, before any discount, rounded to payable cash.
 *
 * `distanceKm` should be road distance, not straight-line. The engine bakes real OSRM road
 * lengths for exactly this reason, since a crow-flies number under-charges every curve.
 */
export function computeFare(vehicleClass: VehicleClass, distanceKm: number): number {
  const rule = FARE_RULES[vehicleClass]
  if (rule.flatFare !== undefined) return rule.flatFare

  const extraKm = Math.max(0, distanceKm - rule.baseKm)
  return roundToCash(rule.baseFare + extraKm * rule.perKm)
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

export type FareClass = "regular" | "student" | "senior_pwd"

export interface FareClassOption {
  id: FareClass
  /** Short label for the toggle chip. */
  label: string
  /** Spoken-Tagalog description, for the fare note under the total. */
  description: string
  /** Fraction taken off the regular fare, 0-1. */
  discount: number
}

export const FARE_CLASSES: FareClassOption[] = [
  { id: "regular", label: "Regular", description: "Regular na pamasahe", discount: 0 },
  { id: "student", label: "Estudyante", description: "20% student discount", discount: 0.2 },
  { id: "senior_pwd", label: "Senior / PWD", description: "20% senior at PWD discount", discount: 0.2 },
]

const FARE_CLASS_BY_ID = new Map(FARE_CLASSES.map((option) => [option.id, option]))

export function fareClassOption(fareClass: FareClass): FareClassOption {
  const option = FARE_CLASS_BY_ID.get(fareClass)
  if (option === undefined) throw new Error(`Unknown fare class: ${fareClass}`)
  return option
}

/**
 * Applies the discount to one leg's regular fare and rounds the result back to payable cash.
 *
 * The discount is taken off the *matrix* fare, not off the raw formula, because that's the order
 * it happens on the road: the conductor reads a whole-peso fare off the printed table, then takes
 * 20% off that. Free legs (walking) stay free.
 */
export function discountedFare(fare: number, fareClass: FareClass): number {
  if (fare <= 0) return 0
  const { discount } = fareClassOption(fareClass)
  if (discount === 0) return roundToCash(fare)
  return roundToCash(fare * (1 - discount))
}

/** Total fare for a whole route under one fare class, discounting each leg the way a conductor would. */
export function discountedTotalFare(route: RouteResult, fareClass: FareClass): number {
  return route.steps.reduce((sum: number, step: RouteStep) => sum + discountedFare(step.fare, fareClass), 0)
}

/** Pesos saved against the regular fare. Zero for the regular class. */
export function fareSavings(route: RouteResult, fareClass: FareClass): number {
  return route.totalFare - discountedTotalFare(route, fareClass)
}

/** `₱18` for whole amounts, `₱18.50` when the increment allows halves. Never a stray `.00`. */
export function formatPeso(amount: number): string {
  return Number.isInteger(amount) ? `₱${amount}` : `₱${amount.toFixed(2)}`
}
