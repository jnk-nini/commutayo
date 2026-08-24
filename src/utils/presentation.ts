// Shared visual language for transit modes and route priorities — one source of truth so the map,
// the search tabs, and the result card can never drift into three slightly different palettes.
// Icons only, no emoji: lucide-react is already the app's icon language everywhere else, and a
// mixed emoji/icon UI is what reads as slapped-together rather than designed.
//
// Palette per the uiux-promax skill: Emerald = jeepney, Amber = bus/UV Express, Sky = tricycle,
// neutral zinc for on-foot legs. Priorities borrow the same three accents (cheapest/fastest/easiest)
// so a commuter learns the color code once and reuses it everywhere.

import { Bike, Bus, CarFront, Footprints, Route, Truck, Wallet, Zap, type LucideIcon } from "lucide-react"

import type { RoutePriority, TransitMode } from "@/utils/routingEngine"

export interface ModeMeta {
  label: string
  Icon: LucideIcon
  /** Solid accent hex — map polylines, pins, anything drawn on canvas rather than styled with classes. */
  hex: string
  /** Icon puck: tinted fill + sub-pixel ring, per the uiux-promax border rule. */
  puck: string
  /** Signboard badge + fare chip tint. */
  chip: string
  /** Vertical dashed connector rail. */
  rail: string
}

export const MODE_META: Record<TransitMode, ModeMeta> = {
  jeepney: {
    label: "Jeepney",
    Icon: Truck,
    hex: "#10b981",
    puck: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/25",
    chip: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-400/20",
    rail: "border-emerald-500/35 dark:border-emerald-400/30",
  },
  bus: {
    label: "Bus",
    Icon: Bus,
    hex: "#d97706",
    puck: "bg-amber-500/12 text-amber-700 ring-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/25",
    chip: "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300 dark:ring-amber-400/20",
    rail: "border-amber-500/35 dark:border-amber-400/30",
  },
  uv_express: {
    label: "UV Express",
    Icon: CarFront,
    hex: "#d97706",
    puck: "bg-amber-500/12 text-amber-700 ring-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/25",
    chip: "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300 dark:ring-amber-400/20",
    rail: "border-amber-500/35 dark:border-amber-400/30",
  },
  tricycle: {
    label: "Tricycle",
    Icon: Bike,
    hex: "#0284c7",
    puck: "bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/25",
    chip: "bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300 dark:ring-sky-400/20",
    rail: "border-sky-500/35 dark:border-sky-400/30",
  },
  walk: {
    label: "Lakad (Walk)",
    Icon: Footprints,
    hex: "#71717a",
    puck: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-400/10 dark:text-zinc-300 dark:ring-white/10",
    chip: "bg-zinc-500/10 text-zinc-600 ring-zinc-500/15 dark:text-zinc-300 dark:ring-white/10",
    rail: "border-zinc-400/40 dark:border-white/15",
  },
}

export interface PriorityMeta {
  label: string
  hint: string
  Icon: LucideIcon
  /** Solid accent hex — for the sliding tab pill, which cross-fades its color as it moves. */
  hex: string
  /** Header badge: tinted fill + ring. */
  badge: string
  /** Faint accent wash behind the header. */
  wash: string
}

export const PRIORITY_META: Record<RoutePriority, PriorityMeta> = {
  cheapest: {
    label: "Cheapest",
    hint: "Pinakamurang pamasahe",
    Icon: Wallet,
    hex: "#059669",
    badge:
      "bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/25",
    wash: "from-emerald-500/10",
  },
  fastest: {
    label: "Fastest",
    hint: "Pinakamabilis na biyahe",
    Icon: Zap,
    hex: "#d97706",
    badge:
      "bg-amber-500/12 text-amber-700 ring-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/25",
    wash: "from-amber-500/10",
  },
  easiest: {
    label: "Easiest",
    hint: "Pinakakonting lipat",
    Icon: Route,
    hex: "#0284c7",
    badge: "bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/25",
    wash: "from-sky-500/10",
  },
}

/** Small solid dot instead of a traffic-light emoji — same at-a-glance read, no emoji font involved. */
export function confidenceColor(score: number): string {
  if (score >= 90) return "#059669"
  if (score >= 75) return "#d97706"
  return "#ea580c"
}
