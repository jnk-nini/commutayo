// A typeahead place picker that understands what commuters actually call these stops.
//
// This replaces a native <select>. The select was faster to build and worse to use: it could only
// be scrolled, not typed into, its popup covered the card it sat in, and it had no idea that
// "Rob Pala-Pala", "LPU" and "Lumina" are things people say. Matching runs over each stop's own
// `aliases` list from the routing engine, so the vocabulary lives with the network data and cannot
// drift away from it.
//
// The list has two sections, and the second one only appears when the first cannot answer:
//   - STOPS are the names in our own table, ranked by `placeSearch.ts` (exact, then prefix, then
//     substring, then typo-tolerant).
//   - LANDMARKS come from the OpenStreetMap geocoder, and each one is snapped to the nearest stop
//     we can actually route from. This is the answer to "the search bar is useless if I don't know
//     the exact stop name": nobody calls it "Monterey Junction", they call it "the mall", and a
//     picker that only knows stop names cannot help with that.
// Landmarks are asked for only after the local tiers come up short and typing has paused, both to
// keep the fast path instant and to stay inside Nominatim's usage policy. See geocoder.ts.
//
// Accessibility follows the ARIA combobox pattern: the input owns the expanded state and points at
// the active option through aria-activedescendant, the list is a real listbox, and every option is
// a 44px target. The visible label sits above the field. Nothing here uses a placeholder as a label.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Check, ChevronsUpDown, LoaderCircle, MapPinned, X, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { SEARCH_DEBOUNCE_MS, findLandmarks, type SnappedPlace } from "@/utils/geocoder"
import { rankPlaces } from "@/utils/placeSearch"
import { FOCUS, ICON, RADIUS, formatMeters } from "@/utils/presentation"
import type { TransitNode } from "@/utils/routingEngine"

/**
 * How many options the list will actually render. `rankPlaces` scores and returns every stop it
 * matches, which on the Cavite-wide network is ~670 of them for an empty query -- building that
 * many option buttons every time the field is focused is a visible stall on a phone, and nobody
 * scrolls past the first screenful anyway. Ranking is untouched: this caps the DOM, not the search,
 * so the best matches are still the ones that survive the cut.
 */
const MAX_VISIBLE_OPTIONS = 50

/**
 * Local matches below which the geocoder is worth asking.
 *
 * Not zero: a query that matches one stop weakly is exactly the case where the commuter meant a
 * landmark near it rather than the stop itself, and a query that already returns a screenful of
 * stops does not need help.
 */
const LOCAL_MATCHES_BEFORE_GEOCODING = 4

/** Shortest query worth sending. Below this every result would be noise. */
const MIN_GEOCODE_QUERY = 3

/** One row of the dropdown. Both kinds resolve to a routable node id when chosen. */
type Option =
  | { kind: "stop"; node: TransitNode; matchedAlias: string | null }
  | { kind: "landmark"; node: TransitNode; label: string; context: string; meters: number }

export interface PlaceComboboxProps {
  id: string
  label: string
  Icon: LucideIcon
  placeholder: string
  nodes: TransitNode[]
  value: string | null
  onChange: (nodeId: string) => void
  /** Excluded from results, so the origin can't also be offered as the destination. */
  excludeId?: string | null
  className?: string
}

export function PlaceCombobox({
  id,
  label,
  Icon,
  placeholder,
  nodes,
  value,
  onChange,
  excludeId = null,
  className,
}: PlaceComboboxProps) {
  const listId = `${id}-listbox`
  const hintId = useId()
  const reduceMotion = useReducedMotion()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const [landmarks, setLandmarks] = useState<SnappedPlace[]>([])
  const [searchingLandmarks, setSearchingLandmarks] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(() => nodes.find((node) => node.id === value) ?? null, [nodes, value])

  const pool = useMemo(
    () => (excludeId === null ? nodes : nodes.filter((node) => node.id !== excludeId)),
    [nodes, excludeId]
  )
  const ranked = useMemo(() => rankPlaces(query, pool), [pool, query])

  // Everything below navigates and announces the *rendered* list, so keyboard arrows, Enter and
  // aria-activedescendant can never point at an option that isn't on screen.
  const stopMatches = useMemo(() => ranked.slice(0, MAX_VISIBLE_OPTIONS), [ranked])
  const hiddenCount = ranked.length - stopMatches.length

  const trimmedQuery = query.trim()
  const wantsLandmarks =
    open && trimmedQuery.length >= MIN_GEOCODE_QUERY && ranked.length < LOCAL_MATCHES_BEFORE_GEOCODING

  // Ask the geocoder only once typing has paused, and abandon the previous ask when it resumes.
  // The abort is what keeps this to one request per pause rather than one per keystroke.
  useEffect(() => {
    if (!wantsLandmarks) {
      setLandmarks([])
      setSearchingLandmarks(false)
      return
    }

    const controller = new AbortController()
    let cancelled = false
    setSearchingLandmarks(true)

    const timer = window.setTimeout(() => {
      const listed = new Set(pool.map((node) => node.id))
      void findLandmarks(trimmedQuery, pool, listed, controller.signal).then((found) => {
        if (cancelled) return
        setLandmarks(found)
        setSearchingLandmarks(false)
      })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [wantsLandmarks, trimmedQuery, pool])

  const options = useMemo<Option[]>(() => {
    const stops: Option[] = stopMatches.map((match) => ({
      kind: "stop",
      node: match.node,
      matchedAlias: match.matchedAlias,
    }))
    const found: Option[] = landmarks.map((hit) => ({
      kind: "landmark",
      node: hit.node,
      label: hit.place.label,
      context: hit.place.context,
      meters: hit.meters,
    }))
    return [...stops, ...found]
  }, [stopMatches, landmarks])

  // The index the landmark section starts at, so its heading renders in the right place.
  const firstLandmarkIndex = stopMatches.length

  // While closed the field shows the chosen stop; while open it shows what is being typed. Without
  // this the input would either wipe the selection on focus or trap the old name in the box.
  const displayValue = open ? query : (selected?.shortName ?? "")

  const commit = useCallback(
    (nodeId: string) => {
      onChange(nodeId)
      setOpen(false)
      setQuery("")
      inputRef.current?.blur()
    },
    [onChange]
  )

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const delta = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((current) => {
        if (options.length === 0) return 0
        return (current + delta + options.length) % options.length
      })
      return
    }

    if (event.key === "Enter") {
      if (!open) return
      event.preventDefault()
      const option = options[activeIndex]
      if (option !== undefined) commit(option.node.id)
      return
    }

    if (event.key === "Escape") {
      if (!open) return
      event.preventDefault()
      setOpen(false)
      setQuery("")
      return
    }

    if (event.key === "Tab" && open) setOpen(false)
  }

  // Close when focus leaves the whole widget, not just the input, or clicking an option would
  // unmount the list before the click ever lands.
  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (rootRef.current?.contains(event.relatedTarget as Node | null) === true) return
    setOpen(false)
    setQuery("")
  }

  const spring = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.6 }
  const exit = reduceMotion ? { duration: 0 } : { duration: 0.12, ease: "easeOut" as const }

  return (
    <div ref={rootRef} onBlur={handleBlur} className={cn("relative", className)}>
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
        <Icon className={cn(ICON.xs, "text-zinc-400 dark:text-zinc-500")} aria-hidden />
        {label}
      </label>

      <div
        className={cn(
          "mt-1.5 flex h-11 items-center gap-2 px-3",
          RADIUS.control,
          "border border-zinc-900/10 bg-white/70 transition-colors duration-150",
          "focus-within:border-emerald-600/40 focus-within:bg-white",
          "dark:border-white/10 dark:bg-white/[0.06] dark:focus-within:border-emerald-400/40 dark:focus-within:bg-white/[0.09]"
        )}
      >
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={hintId}
          aria-activedescendant={
            open && options[activeIndex] !== undefined ? `${id}-opt-${activeIndex}` : undefined
          }
          autoComplete="off"
          value={displayValue}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className={cn(
            "h-11 w-full min-w-0 bg-transparent text-sm font-semibold text-zinc-900 outline-none",
            "placeholder:font-normal placeholder:text-zinc-500",
            "dark:text-zinc-50 dark:placeholder:text-zinc-400"
          )}
        />

        {searchingLandmarks && (
          <LoaderCircle
            className={cn(ICON.sm, "shrink-0 animate-spin text-zinc-400 motion-reduce:animate-none")}
            aria-hidden
          />
        )}

        {selected !== null && !open ? (
          <button
            type="button"
            onClick={() => {
              setQuery("")
              setOpen(true)
              inputRef.current?.focus()
            }}
            aria-label={`Change ${label.toLowerCase()}, currently ${selected.shortName}`}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center text-zinc-400",
              "transition-colors duration-150 hover:text-zinc-700 dark:hover:text-zinc-200",
              RADIUS.control,
              FOCUS
            )}
          >
            <X className={ICON.sm} aria-hidden />
          </button>
        ) : (
          !searchingLandmarks && (
            <ChevronsUpDown className={cn(ICON.sm, "shrink-0 text-zinc-400 dark:text-zinc-500")} aria-hidden />
          )
        )}
      </div>

      <p id={hintId} className="sr-only">
        Type a stop name, a nickname, or a nearby landmark, then choose with the arrow keys and Enter.
      </p>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.99, transition: exit }}
            transition={spring}
            // Above the sheet's own content but below the app's toasts. Anchored to this field so
            // it can never cover the field that opened it.
            className={cn(
              "absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden",
              RADIUS.control,
              "border border-zinc-900/10 bg-white/95 shadow-xl backdrop-blur-xl",
              "dark:border-white/10 dark:bg-zinc-900/95 dark:shadow-black/50"
            )}
          >
            <ul id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto overscroll-contain py-1">
              {options.length === 0 && (
                <li className="px-3 py-3 text-sm text-zinc-600 dark:text-zinc-300">
                  {searchingLandmarks
                    ? "Looking for nearby places..."
                    : "No match. Try another spelling, or the name of a landmark nearby."}
                </li>
              )}

              {options.map((option, index) => {
                const isActive = index === activeIndex
                const isSelected = option.node.id === value
                // OSM-imported stops carry no city, so the subtitle is assembled from whatever is
                // actually known instead of rendering an empty line under every name.
                const subtitle =
                  option.kind === "stop"
                    ? [option.node.city, option.matchedAlias === null ? "" : `(${option.matchedAlias})`]
                        .filter((part) => part.length > 0)
                        .join(" ")
                    : [option.context, `nearest stop ${option.node.shortName}, ${formatMeters(option.meters)} away`]
                        .filter((part) => part.length > 0)
                        .join(" · ")

                return (
                  <li key={`${option.kind}-${option.node.id}-${index}`}>
                    {/* The heading sits inside the first landmark's row rather than in its own
                        <li>, so the listbox contains only options and the index the keyboard is
                        tracking still matches what is on screen. */}
                    {option.kind === "landmark" && index === firstLandmarkIndex && (
                      <p className="px-3 pt-2 pb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400" aria-hidden>
                        Nearby places
                      </p>
                    )}
                    <button
                      id={`${id}-opt-${index}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => commit(option.node.id)}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left",
                        "transition-colors duration-150",
                        isActive ? "bg-emerald-500/10 dark:bg-emerald-400/10" : "bg-transparent"
                      )}
                    >
                      {option.kind === "landmark" && (
                        <MapPinned
                          className={cn(ICON.sm, "shrink-0 text-zinc-400 dark:text-zinc-500")}
                          aria-hidden
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                          {option.kind === "stop" ? option.node.shortName : option.label}
                        </span>
                        {subtitle.length > 0 && (
                          <span className="block truncate text-xs text-zinc-600 dark:text-zinc-300">{subtitle}</span>
                        )}
                      </span>
                      {isSelected && (
                        <Check className={cn(ICON.sm, "shrink-0 text-emerald-600 dark:text-emerald-400")} aria-hidden />
                      )}
                    </button>
                  </li>
                )
              })}

              {/* Says the list was cut rather than letting it look like the whole network. */}
              {hiddenCount > 0 && (
                <li aria-hidden className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                  +{hiddenCount} more stops. Keep typing to narrow the list.
                </li>
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default PlaceCombobox
