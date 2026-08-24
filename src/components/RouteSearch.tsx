// The "where to?" panel: two place pickers with a swap, three priority pills, and a plain-language
// search bar on top. The search bar is the fast path — a commuter types "SM Dasma to LPU cheapest"
// and the pickers fill themselves in. The dropdowns stay as the slow, always-correct fallback.
//
// Place ids come straight from the routing engine, so this list can never drift from the network.

import { useMemo, useState, type FormEvent } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { ArrowRight, ArrowUpDown, Flag, MapPin, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  CAVITE_PILOT_NODES,
  type RoutePriority,
  type RouteResult,
  type TransitNode,
} from "@/utils/routingEngine"

/** Short signboard-style labels for the pickers — the engine's full names are too long on a phone. */
const SHORT_LABEL: Record<string, string> = {
  "st-dominic": "St. Dominic (Bacoor)",
  "imus-lumina": "Imus Lumina",
  "robinsons-dasma": "Robinsons Dasma",
  "sm-dasma": "SM Dasma",
  "pala-pala": "Pala-Pala",
  "lpu-gentri": "LPU Cavite (GenTri)",
  "silang-premier": "Silang Premier",
}

interface PriorityTab {
  id: RoutePriority
  emoji: string
  label: string
  hint: string
  /** Hex, not a class, because the sliding pill cross-fades its colour as it moves. */
  accent: string
}

export const PRIORITY_TABS: PriorityTab[] = [
  { id: "fastest", emoji: "\u{26A1}", label: "Fastest", hint: "Pinakamabilis na biyahe", accent: "#f59e0b" },
  { id: "cheapest", emoji: "\u{1F4B0}", label: "Cheapest", hint: "Pinakamurang pamasahe", accent: "#10b981" },
  { id: "easiest", emoji: "\u{1F9D8}", label: "Easiest", hint: "Pinakakonting lipat", accent: "#0ea5e9" },
]

/** Helper chips under the search bar — each one is a real keyword the parser below understands. */
const KEYWORD_CHIPS: { keyword: string; priority: RoutePriority }[] = [
  { keyword: "Mura lang", priority: "cheapest" },
  { keyword: "Walang lipat", priority: "easiest" },
  { keyword: "Mabilis", priority: "fastest" },
]

export interface RouteSearchProps {
  /** Fired when the commuter commits a trip — via the button, Enter, or a parsed search query. */
  onSearch: (originId: string, destId: string, priority: RoutePriority) => void
  selectedPriority: RoutePriority
  onPriorityChange: (priority: RoutePriority) => void
  /**
   * Origin and destination are owned by the parent, not this component, so the map can follow
   * along the moment a picker changes instead of waiting for the search button.
   */
  originId: string | null
  destId: string | null
  onOriginChange: (nodeId: string) => void
  onDestChange: (nodeId: string) => void
  onSwap: () => void
  /** Solved routes per priority, so each tab can preview its own fare and time. */
  routes: Record<RoutePriority, RouteResult | null> | null
  /** Defaults to the pilot corridor; overridable so this panel isn't welded to one network. */
  nodes?: TransitNode[]
  className?: string
}

export function RouteSearch({
  onSearch,
  selectedPriority,
  onPriorityChange,
  originId,
  destId,
  onOriginChange,
  onDestChange,
  onSwap,
  routes,
  nodes = CAVITE_PILOT_NODES,
  className,
}: RouteSearchProps) {
  const reduceMotion = useReducedMotion()
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 320, damping: 28 }

  const [query, setQuery] = useState("")
  const [hint, setHint] = useState<string | null>(null)
  // Counts swaps rather than toggling, so the arrows keep spinning the same way every press.
  const [swapTurns, setSwapTurns] = useState(0)

  const places = useMemo(
    () => nodes.map((node) => ({ id: node.id, label: SHORT_LABEL[node.id] ?? node.name })),
    [nodes]
  )

  const canSwap = originId !== null || destId !== null
  const canSearch = originId !== null && destId !== null && originId !== destId

  function handleSwap() {
    setSwapTurns((turns) => turns + 1)
    onSwap()
    setHint(null)
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()

    const parsed = parseQuery(query)
    const nextOrigin = parsed.originId ?? originId
    const nextDest = parsed.destId ?? destId
    const nextPriority = parsed.priority ?? selectedPriority

    if (parsed.originId !== null) onOriginChange(parsed.originId)
    if (parsed.destId !== null) onDestChange(parsed.destId)
    if (parsed.priority !== null && parsed.priority !== selectedPriority) onPriorityChange(parsed.priority)

    if (nextOrigin === null || nextDest === null) {
      setHint(
        query.trim().length > 0
          ? "Hindi ko masyadong nakuha — pumili na lang sa dalawang kahon sa ibaba."
          : "Pumili ng simula at destinasyon muna."
      )
      return
    }
    if (nextOrigin === nextDest) {
      setHint("Pareho ang simula at destinasyon.")
      return
    }

    setHint(null)
    onSearch(nextOrigin, nextDest, nextPriority)
  }

  function handleChip(chip: { keyword: string; priority: RoutePriority }) {
    setQuery((current) => {
      const trimmed = current.trim()
      if (trimmed.toLowerCase().includes(chip.keyword.toLowerCase())) return current
      return trimmed.length > 0 ? `${trimmed} ${chip.keyword.toLowerCase()}` : chip.keyword
    })
    onPriorityChange(chip.priority)
    setHint(null)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        "w-full max-w-md rounded-3xl p-4",
        "bg-zinc-50/90 ring-1 ring-black/[0.06] backdrop-blur-md",
        "dark:bg-zinc-900/85 dark:ring-white/10",
        className
      )}
    >
      {/* --------------------------------------------------- Natural language search */}
      <label htmlFor="commutayo-search" className="sr-only">
        Hanapin ang ruta sa sarili mong salita
      </label>
      <div
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-2xl px-3",
          "bg-white ring-1 ring-zinc-200 transition-shadow duration-150",
          "focus-within:ring-2 focus-within:ring-zinc-900/25",
          "dark:bg-white/[0.06] dark:ring-zinc-800 dark:focus-within:ring-white/30"
        )}
      >
        <Search className="size-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
        <input
          id="commutayo-search"
          type="text"
          inputMode="search"
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setHint(null)
          }}
          placeholder="e.g., SM Dasma to LPU cheapest"
          className={cn(
            "min-h-11 w-full min-w-0 bg-transparent text-sm font-medium text-zinc-900 outline-none",
            "placeholder:font-normal placeholder:text-zinc-400",
            "dark:text-zinc-50 dark:placeholder:text-zinc-500"
          )}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {KEYWORD_CHIPS.map((chip) => (
          <button
            key={chip.keyword}
            type="button"
            onClick={() => handleChip(chip)}
            className={cn(
              "min-h-11 rounded-full px-3 text-xs font-semibold transition-colors duration-150",
              "bg-black/[0.04] text-zinc-600 ring-1 ring-black/[0.05] hover:bg-black/[0.07]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20",
              "dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/[0.1]",
              "dark:focus-visible:ring-white/25"
            )}
          >
            {chip.keyword}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------ Origin / dest */}
      <div className="mt-4 flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <PlaceSelect
            id="route-search-origin"
            label="Simula"
            Icon={MapPin}
            value={originId}
            places={places}
            placeholder="Saan ka galing?"
            onChange={(id) => {
              onOriginChange(id)
              setHint(null)
            }}
          />
          <PlaceSelect
            id="route-search-dest"
            label="Destinasyon"
            Icon={Flag}
            value={destId}
            places={places}
            placeholder="Saan ka pupunta?"
            onChange={(id) => {
              onDestChange(id)
              setHint(null)
            }}
          />
        </div>

        <button
          type="button"
          onClick={handleSwap}
          disabled={!canSwap}
          aria-label="Palitan ang simula at destinasyon"
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-2xl",
            "bg-black/[0.04] text-zinc-600 ring-1 ring-black/[0.05] transition-colors duration-150",
            "hover:bg-black/[0.07] disabled:opacity-40 disabled:hover:bg-black/[0.04]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20",
            "dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/[0.1]",
            "dark:focus-visible:ring-white/25"
          )}
        >
          <motion.span animate={{ rotate: swapTurns * 180 }} transition={spring} className="flex">
            <ArrowUpDown className="size-4" aria-hidden />
          </motion.span>
        </button>
      </div>

      {/* ----------------------------------------------------------------- Priority */}
      <div role="tablist" aria-label="Ano ang mas importante sa'yo?" className="mt-3 flex gap-1.5">
        {PRIORITY_TABS.map((tab) => {
          const isActive = tab.id === selectedPriority
          const preview = routes?.[tab.id] ?? null
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              title={tab.hint}
              onClick={() => onPriorityChange(tab.id)}
              className={cn(
                "relative min-h-11 flex-1 rounded-2xl px-2 py-1.5 transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 dark:focus-visible:ring-white/25",
                isActive
                  ? "text-zinc-950"
                  : "text-zinc-600 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="route-search-priority-pill"
                  transition={spring}
                  style={{ backgroundColor: tab.accent }}
                  className="absolute inset-0 -z-10 rounded-2xl"
                />
              )}
              <span className="block text-xs font-semibold">
                <span aria-hidden>{tab.emoji}</span> {tab.label}
              </span>
              {/* Preview what each option actually costs, so you can compare before committing. */}
              <span className={cn("block text-[11px] tabular-nums", isActive ? "opacity-75" : "opacity-60")}>
                {preview === null ? "—" : `₱${preview.totalFare.toFixed(0)} · ${Math.round(preview.totalDurationMin)}m`}
              </span>
            </button>
          )
        })}
      </div>

      {/* ------------------------------------------------------------------- Submit */}
      <button
        type="submit"
        disabled={!canSearch && query.trim().length === 0}
        className={cn(
          "mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl px-4",
          "bg-zinc-900 text-sm font-semibold text-zinc-50 ring-1 ring-black/[0.06] transition-colors duration-150",
          "hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-zinc-900",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/25",
          "dark:bg-zinc-50 dark:text-zinc-900 dark:ring-white/10 dark:hover:bg-white",
          "dark:disabled:hover:bg-zinc-50 dark:focus-visible:ring-white/30"
        )}
      >
        Hanapin ang ruta
        <ArrowRight className="size-4" aria-hidden />
      </button>

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "mt-2 text-center text-[11px] font-medium text-zinc-500 dark:text-zinc-400",
          hint === null && "sr-only"
        )}
      >
        {hint}
      </p>
    </form>
  )
}

interface PlaceSelectProps {
  id: string
  label: string
  Icon: typeof MapPin
  value: string | null
  places: { id: string; label: string }[]
  placeholder: string
  onChange: (placeId: string) => void
}

// Native <select> on purpose — on a phone it opens the OS picker, which is faster and more
// accessible than any custom dropdown, and it works with one thumb while standing in a jeepney.
function PlaceSelect({ id, label, Icon, value, places, placeholder, onChange }: PlaceSelectProps) {
  return (
    <div>
      <label
        htmlFor={id}
        className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400"
      >
        <Icon className="size-3" aria-hidden />
        {label}
      </label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "mt-1 h-11 w-full truncate rounded-2xl px-3 text-sm font-semibold",
          "bg-black/[0.04] text-zinc-900 ring-1 ring-black/[0.05]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/25",
          "dark:bg-white/[0.06] dark:text-zinc-50 dark:ring-white/10 dark:focus-visible:ring-white/30"
        )}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {places.map((place) => (
          <option key={place.id} value={place.id}>
            {place.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/* -------------------------------------------------------------------------------------------- */
/* Plain-language query parsing                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Nicknames a commuter would actually type, per place. Order inside each list doesn't matter —
 * matching always prefers the longest alias at a given position, so "robinsons imus" wins over
 * "imus" and "sm dasma" wins over "sm".
 */
const PLACE_ALIASES: { id: string; aliases: string[] }[] = [
  { id: "st-dominic", aliases: ["st dominic", "st. dominic", "saint dominic", "dominic", "bacoor"] },
  { id: "imus-lumina", aliases: ["imus lumina", "robinsons imus", "lumina", "imus"] },
  { id: "robinsons-dasma", aliases: ["robinsons place dasmarinas", "robinsons dasmarinas", "robinsons dasma", "robinsons"] },
  { id: "sm-dasma", aliases: ["sm city dasmarinas", "sm dasmarinas", "sm dasma", "sm"] },
  { id: "pala-pala", aliases: ["pala-pala", "pala pala", "palapala"] },
  { id: "lpu-gentri", aliases: ["lpu cavite", "lpu gentri", "general trias", "gen trias", "gentri", "lpu"] },
  { id: "silang-premier", aliases: ["silang premier", "silang"] },
]

const PRIORITY_ALIASES: { priority: RoutePriority; aliases: string[] }[] = [
  { priority: "easiest", aliases: ["walang lipat", "wala lipat", "no transfer", "one ride", "direkta", "easiest", "easy", "madali", "dali"] },
  { priority: "cheapest", aliases: ["mura lang", "cheapest", "cheap", "mura", "tipid", "budget", "murang"] },
  { priority: "fastest", aliases: ["mabilis", "fastest", "fast", "bilis", "mabilisan", "rush"] },
]

/** Lowercase, strip accents (Dasmariñas -> dasmarinas), and collapse runs of whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isWordEdge(char: string | undefined): boolean {
  return char === undefined || /[^a-z0-9]/.test(char)
}

/** True when `needle` sits at `index` in `haystack` without being glued to a neighbouring word. */
function matchesAt(haystack: string, needle: string, index: number): boolean {
  if (!haystack.startsWith(needle, index)) return false
  return isWordEdge(haystack[index - 1]) && isWordEdge(haystack[index + needle.length])
}

export interface ParsedQuery {
  originId: string | null
  destId: string | null
  priority: RoutePriority | null
}

/**
 * Reads a free-text query like "SM Dasma to LPU cheapest" into a trip.
 *
 * Deliberately dumb: it walks the string left to right and takes the first two places it meets,
 * so word order alone decides origin and destination — no need for the word "to". Anything it
 * can't read comes back as null and the caller falls back to whatever the pickers already hold.
 */
export function parseQuery(rawQuery: string): ParsedQuery {
  const text = normalize(rawQuery)
  if (text.length === 0) return { originId: null, destId: null, priority: null }

  const found: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    let hit: { id: string; length: number } | null = null

    for (const place of PLACE_ALIASES) {
      for (const alias of place.aliases) {
        if (matchesAt(text, alias, cursor) && (hit === null || alias.length > hit.length)) {
          hit = { id: place.id, length: alias.length }
        }
      }
    }

    if (hit === null) {
      cursor += 1
      continue
    }
    // Repeats ("SM Dasma to SM Dasma") collapse — the same place twice isn't a trip.
    if (found[found.length - 1] !== hit.id) found.push(hit.id)
    cursor += hit.length
  }

  let priority: RoutePriority | null = null
  for (const entry of PRIORITY_ALIASES) {
    if (priority !== null) break
    for (const alias of entry.aliases) {
      for (let i = 0; i < text.length; i += 1) {
        if (matchesAt(text, alias, i)) {
          priority = entry.priority
          break
        }
      }
      if (priority !== null) break
    }
  }

  return {
    originId: found.length >= 2 ? found[0] : null,
    destId: found.length >= 2 ? found[1] : (found[0] ?? null),
    priority,
  }
}

export default RouteSearch
