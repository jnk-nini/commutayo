import { describe, expect, it } from "vitest"

import { isSubsequence, normalizeQuery, rankPlaces, scorePlace } from "@/utils/placeSearch"
import { CAVITE_PILOT_NODES } from "@/utils/routingEngine"

const nodeById = (id: string) => CAVITE_PILOT_NODES.find((node) => node.id === id)!

/** The id the picker would land on for a given typed string. */
function topMatch(query: string): string | undefined {
  return rankPlaces(query, CAVITE_PILOT_NODES)[0]?.node.id
}

describe("normalizeQuery", () => {
  it("folds the tilde so nobody has to type it", () => {
    expect(normalizeQuery("Dasmariñas")).toBe("dasmarinas")
  })

  it("strips punctuation and collapses spacing", () => {
    expect(normalizeQuery("  Pala-Pala   Terminal! ")).toBe("pala pala terminal")
  })
})

describe("isSubsequence", () => {
  it("matches letters in order with gaps between them", () => {
    expect(isSubsequence("lpuc", "lpu cavite")).toBe(true)
    expect(isSubsequence("smd", "sm dasma")).toBe(true)
  })

  it("rejects letters in the wrong order", () => {
    expect(isSubsequence("cupl", "lpu cavite")).toBe(false)
  })
})

describe("nicknames commuters actually type", () => {
  it.each([
    ["Rob Pala-Pala", "pala-pala"],
    ["pala pala", "pala-pala"],
    ["LPU", "lpu-gentri"],
    ["lpu gate", "lpu-gentri"],
    ["gentri", "lpu-gentri"],
    ["manggahan", "lpu-gentri"],
    ["Lumina", "imus-lumina"],
    ["rob imus", "imus-lumina"],
    ["sm", "sm-dasma"],
    ["hypermarket", "sm-dasma"],
    ["rob dasma", "robinsons-dasma"],
    ["salitran", "robinsons-dasma"],
    ["bacoor", "st-dominic"],
    ["longos", "st-dominic"],
    ["silang", "silang-premier"],
  ])("resolves %s to %s", (typed, expectedId) => {
    expect(topMatch(typed)).toBe(expectedId)
  })

  it("still finds the stop when the tilde is dropped", () => {
    expect(topMatch("dasmarinas")).toBeDefined()
    expect(topMatch("Dasmariñas")).toBe(topMatch("dasmarinas"))
  })
})

describe("ranking", () => {
  it("prefers an exact name over a mere substring hit", () => {
    const exact = scorePlace("pala-pala terminal", nodeById("pala-pala"))!
    const partial = scorePlace("pala", nodeById("pala-pala"))!
    expect(exact.score).toBeGreaterThan(partial.score)
  })

  it("says which nickname matched, so the list can explain itself", () => {
    // "rob imus" is itself a registered alias, so that is the one reported back.
    expect(scorePlace("rob imus", nodeById("imus-lumina"))!.matchedAlias).toBe("rob imus")
    expect(scorePlace("robinsons", nodeById("imus-lumina"))!.matchedAlias).toBe("robinsons imus")
    // A match on the stop's real name reports no alias, so the list shows only the city.
    expect(scorePlace("Imus Lumina / Robinsons Imus", nodeById("imus-lumina"))!.matchedAlias).toBeNull()
  })

  it("returns every stop for an empty query, so the list opens full", () => {
    expect(rankPlaces("", CAVITE_PILOT_NODES)).toHaveLength(CAVITE_PILOT_NODES.length)
  })

  it("returns nothing for a query that matches no stop", () => {
    expect(rankPlaces("qqzzxx", CAVITE_PILOT_NODES)).toHaveLength(0)
  })
})
