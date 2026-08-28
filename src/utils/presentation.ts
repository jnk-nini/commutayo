// The app's visual language in one file, so the map, the search panel and the sakay guide can
// never drift into three slightly different palettes.
//
// Locked decisions (changing one of these means changing it here, not in a component):
//
//   SHAPE      Four radius tiers and nothing else. Panels rounded-3xl, controls and tiles
//              rounded-2xl, pills and chips rounded-full, placards rounded-md. The placard is the
//              deliberate odd one out: a real jeepney signboard is a flat acrylic plate, and
//              rounding it into a soft chip is what made it read as decoration instead of a sign.
//
//   COLOR      Every hue in the app is *data*, not decoration: amber marks a jeepney, sky a bus,
//              emerald a UV Express, violet a tricycle, slate an on-foot leg. A commuter learns the
//              code once and reuses it on the map, in the timeline and in every fare pill. No accent
//              is ever picked to make a surface look nicer. (Emerald is separately the app's own
//              chrome accent -- focus rings, the wordmark, the "cheapest" tab -- which is a different
//              system from the per-mode palette above and only shares emerald with UV Express by
//              coincidence of the palette, not because the two mean the same thing.)
//
//   TYPE       Uppercase wide-tracked type means exactly one thing in this app: "this is painted on
//              the vehicle". It is reserved for placards. Everything else, including form labels
//              and stat labels, is sentence case at 12px or larger, because a screen where every
//              label shouts has no hierarchy left to spend.
//
//   GLASS      One recipe, two densities. Panels float over a live map, so they are translucent and
//              blurred rather than opaque, and every one of them carries a hairline border so the
//              edge survives against both a bright road and a dark basemap.
//
//   ICONS      lucide-react only, three sizes, one stroke width (set globally in index.css).

import { Bike, Bus, CarFront, Footprints, Route, Truck, Wallet, Zap, type LucideIcon } from "lucide-react"

import type { VehicleClass } from "@/utils/fares"
import type { RoutePriority, TransitMode } from "@/utils/routingEngine"

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

// Both densities name their shadow colour in *both* themes on purpose. Tailwind v4 registers
// `--tw-shadow-color` through `@property` with an initial value of `transparent`, so the moment any
// variant sets a shadow colour the `var(..., fallback)` inside `shadow-xl` stops falling back. A
// lone `dark:shadow-black/40` therefore leaves the light theme with a completely invisible shadow.
// The light value is zinc-tinted rather than pure black, so the shadow sits in the same hue family
// as the surface it falls on instead of reading as grey dirt.

/** Floating glass panel: the search card, the sakay guide, the tracking bar, the driver drawer. */
export const GLASS =
  "bg-white/80 backdrop-blur-xl border border-white/40 shadow-xl shadow-zinc-900/10 " +
  "dark:bg-zinc-900/75 dark:border-white/10 dark:shadow-black/40"

/** Heavier glass for surfaces that must stay readable over a busy basemap (headers, sheets). */
export const GLASS_STRONG =
  "bg-white/90 backdrop-blur-xl border border-white/50 shadow-xl shadow-zinc-900/15 " +
  "dark:bg-zinc-900/85 dark:border-white/10 dark:shadow-black/50"

/** A quiet inset block *inside* a glass panel. Never blurred: nesting blurs muddies both. */
export const INSET =
  "bg-zinc-900/[0.035] border border-zinc-900/[0.06] dark:bg-white/[0.04] dark:border-white/10"

/** Radius tiers. See the SHAPE note above before adding a fifth. */
export const RADIUS = {
  panel: "rounded-3xl",
  control: "rounded-2xl",
  pill: "rounded-full",
  placard: "rounded-md",
} as const

/** Icon sizes. Three tokens, no arbitrary in-between values. */
export const ICON = {
  xs: "size-3.5",
  sm: "size-4",
  md: "size-5",
} as const

/**
 * Layer order, documented in one place instead of scattered magic numbers. Leaflet's own panes top
 * out around 800, which is the only reason the app chrome starts as high as it does.
 */
export const Z = {
  mapChrome: "z-[900]",
  header: "z-[1000]",
  sheet: "z-[1100]",
  drawer: "z-[1150]",
  toast: "z-[1200]",
  /** A modal dialog outranks everything, including the toast: it demands an answer before
   *  anything else on screen matters. The generic shadcn Dialog primitive ships with a bare
   *  `z-50`, which is below even Leaflet's own panes (~800) -- that's what made the report dialog
   *  open but render invisibly behind the map and header. See src/components/ui/dialog.tsx. */
  modal: "z-[1300]",
} as const

/** Focus ring shared by every interactive element, so focus looks identical app-wide. */
export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 " +
  "dark:focus-visible:ring-emerald-400/50"

/** Press feedback that does not move neighbouring layout. */
export const PRESS = "transition-[transform,background-color,color] duration-150 active:scale-[0.98]"

// ---------------------------------------------------------------------------
// Transit modes
// ---------------------------------------------------------------------------

export interface ModeMeta {
  label: string
  Icon: LucideIcon
  /** Solid accent hex for map polylines and pins, anything drawn rather than styled with classes. */
  hex: string
  /** Icon puck: tinted fill plus a hairline ring. */
  puck: string
  /** Fare chip and accent tint. */
  chip: string
  /** Vertical timeline rail, drawn solid for a ride. */
  rail: string
  /** Same rail as a dashed border, which is how on-foot legs are drawn here and on the map. */
  railBorder: string
}

export const MODE_META: Record<TransitMode, ModeMeta> = {
  jeepney: {
    label: "Jeepney",
    Icon: Truck,
    hex: "#F59E0B",
    puck: "bg-amber-500/12 text-amber-800 ring-amber-600/25 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30",
    chip: "bg-amber-500/10 text-amber-800 ring-amber-600/20 dark:text-amber-300 dark:ring-amber-400/25",
    rail: "bg-amber-600/30 dark:bg-amber-400/30",
    railBorder: "border-amber-600/40 dark:border-amber-400/35",
  },
  bus: {
    label: "Bus",
    Icon: Bus,
    hex: "#0EA5E9",
    puck: "bg-sky-500/12 text-sky-700 ring-sky-600/25 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/30",
    chip: "bg-sky-500/10 text-sky-700 ring-sky-600/20 dark:text-sky-300 dark:ring-sky-400/25",
    rail: "bg-sky-600/30 dark:bg-sky-400/30",
    railBorder: "border-sky-600/40 dark:border-sky-400/35",
  },
  uv_express: {
    label: "UV Express",
    Icon: CarFront,
    hex: "#10B981",
    puck: "bg-emerald-500/12 text-emerald-700 ring-emerald-600/25 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30",
    chip: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/20 dark:text-emerald-300 dark:ring-emerald-400/25",
    rail: "bg-emerald-600/30 dark:bg-emerald-400/30",
    railBorder: "border-emerald-600/40 dark:border-emerald-400/35",
  },
  tricycle: {
    label: "Tricycle",
    Icon: Bike,
    hex: "#7C3AED",
    puck: "bg-violet-500/12 text-violet-800 ring-violet-600/25 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-400/30",
    chip: "bg-violet-500/10 text-violet-800 ring-violet-600/20 dark:text-violet-300 dark:ring-violet-400/25",
    rail: "bg-violet-600/30 dark:bg-violet-400/30",
    railBorder: "border-violet-600/40 dark:border-violet-400/35",
  },
  walk: {
    label: "Lakad",
    Icon: Footprints,
    hex: "#64748b",
    puck: "bg-slate-500/10 text-slate-700 ring-slate-500/25 dark:bg-slate-400/10 dark:text-slate-300 dark:ring-white/15",
    chip: "bg-slate-500/10 text-slate-700 ring-slate-500/20 dark:text-slate-300 dark:ring-white/15",
    rail: "bg-slate-400/40 dark:bg-slate-400/25",
    railBorder: "border-slate-400/60 dark:border-slate-400/35",
  },
}

/** Spelled-out vehicle type, for the one place a commuter benefits from knowing the fare bracket. */
export const VEHICLE_CLASS_LABEL: Record<VehicleClass, string> = {
  jeepney_traditional: "Traditional jeepney",
  jeepney_modern: "Modern jeepney",
  bus: "Bus",
  uv_express: "UV Express",
  tricycle: "Tricycle",
  walk: "Lakad",
}

// ---------------------------------------------------------------------------
// Route priorities
// ---------------------------------------------------------------------------

export interface PriorityMeta {
  label: string
  hint: string
  Icon: LucideIcon
  /** Solid accent hex for the sliding tab pill, which cross-fades its color as it moves. */
  hex: string
  /** Header badge: tinted fill plus a ring. */
  badge: string
  /** Faint accent wash behind the header. */
  wash: string
}

export const PRIORITY_META: Record<RoutePriority, PriorityMeta> = {
  cheapest: {
    label: "Cheapest",
    hint: "Lowest total fare",
    Icon: Wallet,
    hex: "#059669",
    badge:
      "bg-emerald-500/12 text-emerald-700 ring-emerald-600/25 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30",
    wash: "from-emerald-500/10",
  },
  fastest: {
    label: "Fastest",
    hint: "Shortest travel time",
    Icon: Zap,
    hex: "#b45309",
    badge:
      "bg-amber-500/12 text-amber-800 ring-amber-600/25 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30",
    wash: "from-amber-500/10",
  },
  easiest: {
    label: "Easiest",
    hint: "Fewest transfers",
    Icon: Route,
    hex: "#0369a1",
    badge: "bg-sky-500/12 text-sky-800 ring-sky-600/25 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/30",
    wash: "from-sky-500/10",
  },
}

/**
 * The one place a colored dot is allowed in this app. It carries real state (how much of a route's
 * landmark data is verified) rather than decorating a list, and it never appears more than once
 * per card.
 */
export function confidenceColor(score: number): string {
  if (score >= 90) return "#059669"
  if (score >= 75) return "#b45309"
  return "#c2410c"
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

export function formatDuration(minutes: number): string {
  const whole = Math.round(minutes)
  if (whole < 60) return `${whole} min`
  const hours = Math.floor(whole / 60)
  const rest = whole % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/** Rounds to something a person would say out loud, not a GPS reading. */
export function formatMeters(meters: number): string {
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`
  return `${(meters / 1000).toFixed(1)} km`
}
