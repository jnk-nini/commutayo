// TEMPORARY: end-to-end check against the live Supabase network. Deleted after the run.
import { writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { buildNetworkFromDatabase, selectableNodes } from "@/utils/dynamicRoutingEngine"
import { fetchTransitNetworkTables } from "@/utils/transitRepository"
import { findRoute, type RoutePriority } from "@/utils/routingEngine"

const lines: string[] = []
const log = (line: string) => lines.push(line)

describe("live network", () => {
  it("Bella Vista to LPU Cavite", async () => {
    const started = Date.now()
    const tables = await fetchTransitNetworkTables()
    const network = buildNetworkFromDatabase(tables)
    const nodes = selectableNodes(network)
    log(`built in ${Date.now() - started}ms`)
    log(`nodes=${network.nodes.length} selectable=${nodes.length} edges=${network.edges.length}`)

    const find = (name: string) => {
      const hits = nodes.filter((n) => n.name === name)
      log(`"${name}" -> ${hits.length} selectable node(s)`)
      return hits[0]
    }
    const origin = find("Bella Vista")
    const dest = find("LPU Cavite")
    expect(origin).toBeDefined()
    expect(dest).toBeDefined()

    for (const priority of ["fastest", "cheapest", "easiest"] as RoutePriority[]) {
      const r = findRoute(network, origin.id, dest.id, priority)
      if (r === null) {
        log("")
        log(`[${priority}] NO ROUTE`)
        continue
      }
      log("")
      log(`[${priority}] P${r.totalFare} | ${Math.round(r.totalDurationMin)} min | transfers=${r.transferCount} | confidence=${r.confidence}`)
      r.steps.forEach((s, i) => {
        log(`  ${i + 1}. ${s.mode}/${s.vehicleClass} sign="${s.placardText}"`)
        log(`     board ${s.from} -> alight ${s.to}  (P${s.fare}, ${Math.round(s.durationMin)}min, passes ${s.viaStops.length} stops)`)
      })
    }

    writeFileSync("live-check.out.txt", lines.join("\n"), "utf8")
  }, 180000)
})
