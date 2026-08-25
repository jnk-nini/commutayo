// Fuzzy matching for stop names, kept out of the combobox component so it can be unit-tested on
// its own and reused by anything else that needs to resolve "Rob Pala-Pala" to a node id.
//
// Matching runs over each stop's own `aliases` list from the routing engine, so the vocabulary
// lives with the network data and cannot drift away from it.

import type { TransitNode } from "@/utils/routingEngine"

/** Lowercase, strip accents (Dasmariñas becomes dasmarinas), drop punctuation, collapse spaces. */
export function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** True when every character of `query` appears in `text` in order. Catches "lpuc" for "lpu cavite". */
export function isSubsequence(query: string, text: string): boolean {
  if (query.length === 0) return true
  let cursor = 0
  for (const char of text) {
    if (char === query[cursor]) cursor += 1
    if (cursor === query.length) return true
  }
  return false
}

export interface PlaceMatch {
  node: TransitNode
  score: number
  /** The alias that matched, when it wasn't the stop's own name. Shown as a "you typed" hint. */
  matchedAlias: string | null
}

interface Candidate {
  text: string
  isName: boolean
  original: string
}

/**
 * Ranks one stop against a query. Higher is better, null means no match at all.
 *
 * The tiers are deliberately coarse and ordered by how confident each kind of match is, so results
 * stay predictable: typing "sm" should always put SM Dasma first, not shuffle around depending on
 * how a scoring formula happened to weigh a subsequence hit somewhere else.
 */
export function scorePlace(rawQuery: string, node: TransitNode): PlaceMatch | null {
  const query = normalizeQuery(rawQuery)
  if (query.length === 0) return { node, score: 0, matchedAlias: null }

  const candidates: Candidate[] = [
    { text: normalizeQuery(node.name), isName: true, original: node.name },
    { text: normalizeQuery(node.shortName), isName: true, original: node.shortName },
    { text: normalizeQuery(node.city), isName: false, original: node.city },
    ...node.aliases.map((alias) => ({ text: normalizeQuery(alias), isName: false, original: alias })),
  ]

  const tokens = query.split(" ").filter((token) => token.length > 0)
  let best: PlaceMatch | null = null

  const consider = (score: number, candidate: Candidate) => {
    if (best !== null && best.score >= score) return
    best = { node, score, matchedAlias: candidate.isName ? null : candidate.original }
  }

  for (const candidate of candidates) {
    const { text } = candidate

    if (text === query) consider(1000, candidate)
    else if (text.startsWith(query)) consider(900, candidate)
    else if (text.split(" ").some((word) => word.startsWith(query))) consider(800, candidate)
    else if (text.includes(query)) consider(700, candidate)
    else if (tokens.length > 1 && tokens.every((token) => text.includes(token))) consider(600, candidate)
    else if (query.length >= 3 && isSubsequence(query, text)) consider(400, candidate)
  }

  return best
}

/** Every stop that matches, best first. An empty query returns all of them in network order. */
export function rankPlaces(query: string, nodes: TransitNode[]): PlaceMatch[] {
  return nodes
    .map((node) => scorePlace(query, node))
    .filter((match): match is PlaceMatch => match !== null)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.node.name.localeCompare(b.node.name)))
}
