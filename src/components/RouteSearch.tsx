// The "where are you going?" panel: a plain-language search bar, two typeahead place pickers
// with a swap, and three priority tabs that each preview what they would cost.
//
// The search bar is the fast path. A commuter types "SM Dasma to LPU cheapest" and all three controls
// below fill themselves in. The pickers are the always-correct fallback, and since they are now
// comboboxes rather than native selects they accept the same nicknames the search bar does.
//
// Place vocabulary comes from the routing engine's own node data, so this panel can never drift
// from the network it is searching.

import { useState, type FormEvent } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { ArrowRight, ArrowUpDown, Flag, MapPin, Search } from "lucide-react"

import PlaceCombobox from "@/components/PlaceCombobox"
import { cn } from "@/lib/utils"
import { FOCUS, GLASS, ICON, PRESS, PRIORITY_META, RADIUS } from "@/utils/presentation"
import { CAVITE_PILOT_NODES, type RoutePriority, type RouteResult, type TransitNode } from "@/utils/routingEngine"

/** Render order for the priority tabs. Fastest first, since it's the default the app opens on. */
const PRIORITY_ORDER: RoutePriority[] = ["fastest", "cheapest", "easiest"]

/** Helper chips under the search bar. Each one is a real keyword the parser below understands. */
const KEYWORD_CHIPS: { keyword: string; priority: RoutePriority }[] = [
  { keyword: "Cheapest", priority: "cheapest" },
  { keyword: "No transfers", priority: "easiest" },
  { keyword: "Fastest", priority: "fastest" },
]

export interface RouteSearchProps {
  /** Fired when the commuter commits a trip, via the button, Enter, or a parsed search query. */
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
  /** Defaults to the pilot corridor, overridable so this panel isn't welded to one network. */
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

  const canSwap = originId !== null || destId !== null
  const canSearch = originId !== null && destId !== null && originId !== destId

  function handleSwap() {
    setSwapTurns((turns) => turns + 1)
    onSwap()
    setHint(null)
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()

    const parsed = parseQuery(query, nodes)
    const nextOrigin = parsed.originId ?? originId
    const nextDest = parsed.destId ?? destId
    const nextPriority = parsed.priority ?? selectedPriority

    if (parsed.originId !== null) onOriginChange(parsed.originId)
    if (parsed.destId !== null) onDestChange(parsed.destId)
    if (parsed.priority !== null && parsed.priority !== selectedPriority) onPriorityChange(parsed.priority)

    if (nextOrigin === null || nextDest === null) {
      setHint(
        query.trim().length > 0
          ? "I could not read that. Pick from the two boxes below instead."
          : "Pick a starting point and a destination first."
      )
      return
    }
    if (nextOrigin === nextDest) {
      setHint("The start and the destination are the same.")
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
    <form onSubmit={handleSubmit} className={cn("w-full max-w-md p-4", RADIUS.panel, GLASS, className)}>
      {/* --------------------------------------------------- Natural language search */}
      <label htmlFor="commutayo-search" className="sr-only">
        Search for a route in your own words
      </label>
      <div
        className={cn(
          "flex min-h-11 items-center gap-2 px-3",
          RADIUS.control,
          "border border-zinc-900/10 bg-white/70 transition-colors duration-150",
          "focus-within:border-emerald-600/40 focus-within:bg-white",
          "dark:border-white/10 dark:bg-white/[0.06] dark:focus-within:border-emerald-400/40"
        )}
      >
        <Search className={cn(ICON.sm, "shrink-0 text-zinc-400 dark:text-zinc-500")} aria-hidden />
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
          placeholder="e.g. SM Dasma to LPU cheapest"
          className={cn(
            "min-h-11 w-full min-w-0 bg-transparent text-sm font-medium text-zinc-900 outline-none",
            "placeholder:font-normal placeholder:text-zinc-500",
            "dark:text-zinc-50 dark:placeholder:text-zinc-400"
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
              "min-h-11 px-3 text-xs font-semibold",
              RADIUS.pill,
              "bg-zinc-900/5 text-zinc-700 ring-1 ring-zinc-900/[0.07] hover:bg-zinc-900/10",
              "dark:bg-white/[0.06] dark:text-zinc-200 dark:ring-white/10 dark:hover:bg-white/[0.1]",
              PRESS,
              FOCUS
            )}
          >
            {chip.keyword}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------ Origin / dest */}
      <div className="mt-4 flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <PlaceCombobox
            id="route-search-origin"
            label="Starting point"
            Icon={MapPin}
            tone="origin"
            nodes={nodes}
            value={originId}
            excludeId={destId}
            placeholder="Where are you coming from?"
            onChange={(id) => {
              onOriginChange(id)
              setHint(null)
            }}
          />
          <PlaceCombobox
            id="route-search-dest"
            label="Destination"
            Icon={Flag}
            tone="destination"
            nodes={nodes}
            value={destId}
            excludeId={originId}
            placeholder="Where are you going?"
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
          aria-label="Swap start and destination"
          className={cn(
            "flex size-11 shrink-0 items-center justify-center",
            RADIUS.control,
            "bg-zinc-900/5 text-zinc-700 ring-1 ring-zinc-900/[0.07] hover:bg-zinc-900/10",
            "disabled:opacity-40 disabled:hover:bg-zinc-900/5",
            "dark:bg-white/[0.06] dark:text-zinc-200 dark:ring-white/10 dark:hover:bg-white/[0.1]",
            PRESS,
            FOCUS
          )}
        >
          <motion.span animate={{ rotate: swapTurns * 180 }} transition={spring} className="flex">
            <ArrowUpDown className={ICON.sm} aria-hidden />
          </motion.span>
        </button>
      </div>

      {/* ----------------------------------------------------------------- Priority */}
      <div role="tablist" aria-label="What matters most to you?" className="mt-3 flex gap-1.5">
        {PRIORITY_ORDER.map((id) => {
          const meta = PRIORITY_META[id]
          const isActive = id === selectedPriority
          const preview = routes?.[id] ?? null
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              title={meta.hint}
              onClick={() => onPriorityChange(id)}
              className={cn(
                "relative min-h-11 flex-1 px-2 py-1.5",
                RADIUS.control,
                PRESS,
                FOCUS,
                isActive
                  ? "text-white"
                  : "text-zinc-700 hover:bg-zinc-900/5 dark:text-zinc-200 dark:hover:bg-white/[0.06]"
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="route-search-priority-pill"
                  transition={spring}
                  style={{ backgroundColor: meta.hex }}
                  className={cn("absolute inset-0 -z-10", RADIUS.control)}
                />
              )}
              <span className="flex items-center justify-center gap-1.5 text-xs font-semibold">
                <meta.Icon className={ICON.xs} aria-hidden />
                {meta.label}
              </span>
              {/* Preview what each option actually costs, so you can compare before committing. */}
              <span className={cn("block text-xs tabular-nums", isActive ? "opacity-85" : "opacity-70")}>
                {preview === null ? "no route" : `₱${preview.totalFare} / ${Math.round(preview.totalDurationMin)}m`}
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
          "mt-3 flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-semibold",
          RADIUS.control,
          "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-zinc-900",
          "dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white dark:disabled:hover:bg-zinc-50",
          PRESS,
          FOCUS
        )}
      >
        Find the route
        <ArrowRight className={ICON.sm} aria-hidden />
      </button>

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "mt-2 text-center text-xs font-medium text-zinc-600 dark:text-zinc-300",
          hint === null && "sr-only"
        )}
      >
        {hint}
      </p>
    </form>
  )
}

/* -------------------------------------------------------------------------------------------- */
/* Plain-language query parsing                                                                   */
/* -------------------------------------------------------------------------------------------- */

// The interface is English now; what people type into a search box is not. These keep both, and
// cost nothing to carry -- a commuter who types "mura" or "walang lipat" still gets what they
// asked for, which is the entire point of a plain-language search bar.
const PRIORITY_ALIASES: { priority: RoutePriority; aliases: string[] }[] = [
  {
    priority: "easiest",
    aliases: ["walang lipat", "wala lipat", "no transfers", "no transfer", "one ride", "direct", "direkta", "easiest", "easy", "madali", "dali"],
  },
  { priority: "cheapest", aliases: ["mura lang", "cheapest", "cheap", "mura", "tipid", "budget", "murang"] },
  { priority: "fastest", aliases: ["mabilis", "fastest", "fast", "bilis", "mabilisan", "rush"] },
]

/** Lowercase, strip accents (Dasmariñas becomes dasmarinas), and collapse runs of whitespace. */
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
 * Deliberately dumb: it walks the string left to right and takes the first two places it meets, so
 * word order alone decides origin and destination and the word "to" is optional. Anything it can't
 * read comes back as null and the caller falls back to whatever the pickers already hold.
 */
export function parseQuery(rawQuery: string, nodes: TransitNode[] = CAVITE_PILOT_NODES): ParsedQuery {
  const text = normalize(rawQuery)
  if (text.length === 0) return { originId: null, destId: null, priority: null }

  // Every name and nickname the network knows, longest first, so "robinsons imus" beats "imus".
  const lexicon = nodes
    .flatMap((node) => [node.name, node.shortName, ...node.aliases].map((alias) => ({ id: node.id, alias: normalize(alias) })))
    .filter((entry) => entry.alias.length > 0)
    .sort((a, b) => b.alias.length - a.alias.length)

  const found: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    const hit = lexicon.find((entry) => matchesAt(text, entry.alias, cursor))

    if (hit === undefined) {
      cursor += 1
      continue
    }
    // Repeats ("SM Dasma to SM Dasma") collapse. The same place twice isn't a trip.
    if (found[found.length - 1] !== hit.id) found.push(hit.id)
    cursor += hit.alias.length
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
