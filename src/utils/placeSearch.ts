// Fuzzy matching for stop names, kept out of the combobox component so it can be unit-tested on
// its own and reused by anything else that needs to resolve "Rob Pala-Pala" to a node id.
//
// Matching runs over each stop's own `aliases` list from the routing engine, so the vocabulary
// lives with the network data and cannot drift away from it.
//
// The tiers run from certain to speculative: exact, prefix, word-prefix, substring, all-tokens-at-
// word-boundaries, all-tokens-anywhere, subsequence, and finally typo-tolerant. Nothing here reaches outside our own stops table -- a
// query naming a landmark that is not a stop is `geocoder.ts`'s job, and the picker asks it only
// after these tiers come up short.

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

/**
 * How many single-character edits a word may be off and still count as the word the commuter meant.
 *
 * Scaled to length, because one wrong letter in a three-letter word usually means a different word
 * ("sm" against "st"), while one wrong letter in "dasmarinas" is obviously a typo. Nothing under
 * four characters is fuzzy-matched at all -- short queries are prefixes far more often than they
 * are misspellings, and the prefix tiers above already handle those.
 */
function editBudget(word: string): number {
  if (word.length < 4) return 0
  if (word.length <= 6) return 1
  return 2
}

/**
 * Levenshtein distance, abandoned as soon as it is certain to exceed `budget`.
 *
 * The early exit is what makes this affordable: `rankPlaces` runs over ~670 stops on every
 * keystroke, and most words differ from most other words by far more than two edits, so nearly
 * every comparison stops after a row or two instead of filling a whole matrix.
 */
export function withinEditDistance(a: string, b: string, budget: number): boolean {
  if (budget <= 0) return a === b
  if (Math.abs(a.length - b.length) > budget) return false
  if (a === b) return true

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowBest = i
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution)
      rowBest = Math.min(rowBest, current[j])
    }
    // Every future row can only be larger, so once the whole row is over budget we are done.
    if (rowBest > budget) return false
    previous = current
  }
  return previous[b.length] <= budget
}

/**
 * True when some word of `text` begins with `token`.
 *
 * This is what separates a real match from a coincidence, and it is worth the extra tier. On the
 * live network, "sm dasma" put SM City Dasmarinas at position **16 of 25**: the letters "sm" occur
 * inside "da-sm-arinas", so every Dasmarinas stop in Cavite satisfied a plain `includes` check for
 * both words, and the ties then broke alphabetically -- burying the one stop the commuter meant
 * under Camella Homes, Dasma/Silang Boundary and the rest. Requiring a word boundary drops those
 * to the tier below and puts SM back at the top.
 */
function startsAWord(text: string, token: string): boolean {
  return text.split(" ").some((word) => word.startsWith(token))
}

/** True when every word of the query is some word of `text`, allowing for typos in each. */
function tokensMatchFuzzily(tokens: string[], text: string): boolean {
  const words = text.split(" ").filter((word) => word.length > 0)
  if (words.length === 0) return false
  return tokens.every((token) =>
    words.some((word) => word.startsWith(token) || withinEditDistance(token, word, editBudget(token)))
  )
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
    // Every query word starts a word of the name. Strong: "sm dasma" lands on "SM City Dasmarinas"
    // because "sm" is a whole word there, not because the letters happen to occur somewhere.
    else if (tokens.length > 1 && tokens.every((token) => startsAWord(text, token))) consider(600, candidate)
    // Every query word appears *somewhere*, word boundaries ignored. Kept for recall and ranked
    // below the tier above, because this is the one that fires on coincidences.
    else if (tokens.length > 1 && tokens.every((token) => text.includes(token))) consider(500, candidate)
    else if (query.length >= 3 && isSubsequence(query, text)) consider(400, candidate)
    // Last resort: the commuter typed it wrong. Ranked below every exact tier, so a real match
    // anywhere in the network always outranks a guess at what someone meant.
    else if (tokensMatchFuzzily(tokens, text)) consider(300, candidate)
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
