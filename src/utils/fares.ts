// Discounted fares. Philippine law (RA 9994 for seniors, RA 10754 for PWDs, and the LTFRB student
// fare rules) gives students, senior citizens, and PWDs 20% off the regular public-transport fare.
//
// The routing engine only ever computes the regular adult fare — discounts are a display concern,
// applied here so one rule change updates every screen.

import type { RouteResult, RouteStep } from "@/utils/routingEngine"

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
 * Applies the discount to a single leg's fare, rounded to the nearest 25 centavos — the smallest
 * coin conductors actually carry. Free legs (walking) stay free.
 *
 * Note: printed LTFRB fare matrices round their own way per route, so a real matrix should win
 * over this helper once one is wired in.
 */
export function discountedFare(fare: number, fareClass: FareClass): number {
  if (fare <= 0) return 0
  const { discount } = fareClassOption(fareClass)
  if (discount === 0) return fare
  return Math.round(fare * (1 - discount) * 4) / 4
}

/** Total fare for a whole route under one fare class, discounting each leg the way a conductor would. */
export function discountedTotalFare(route: RouteResult, fareClass: FareClass): number {
  return route.steps.reduce((sum: number, step: RouteStep) => sum + discountedFare(step.fare, fareClass), 0)
}

/** Pesos saved against the regular fare. Zero for the regular class. */
export function fareSavings(route: RouteResult, fareClass: FareClass): number {
  return route.totalFare - discountedTotalFare(route, fareClass)
}
