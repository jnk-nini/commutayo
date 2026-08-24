# Graph Report - commutayo  (2026-08-24)

## Corpus Check
- Corpus is ~6,273 words - fits in a single context window. You may not need a graph.

## Summary
- 285 nodes · 357 edges · 21 communities (19 shown, 2 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 13 edges (avg confidence: 0.75)
- Token cost: 305,591 input · 0 output

## Community Hubs (Navigation)
- shadcn UI Components
- Cavite Routing Engine
- Runtime Dependencies
- App TS Config
- Build & Lint Tooling
- shadcn Config & Registries
- Node TS Config
- Lint Rules & App Entry
- CommuTayo Design Skills
- Cavite Transit Network Doc
- Package Manifest & Scripts
- Social Icon Sprite
- Root TS Config
- Project README & Template
- Brand Colors & Favicon
- HTML Entry Point
- React Logo Asset

## God Nodes (most connected - your core abstractions)
1. `cn()` - 32 edges
2. `compilerOptions` - 18 edges
3. `compilerOptions` - 15 edges
4. `Cavite Network Corridor Spec` - 12 edges
5. `MinHeap` - 7 edges
6. `findRoute()` - 7 edges
7. `react` - 6 edges
8. `tailwind` - 6 edges
9. `aliases` - 6 edges
10. `runDijkstra()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `layout/layoutId Landmark Cue Expansion` --semantically_similar_to--> `Vertical Dashed Landmark Timeline`  [INFERRED] [semantically similar]
  .claude/skills/motion-design/SKILL.md → .claude/skills/taste-design/SKILL.md
- `Dark/Light Base & Transit Accent Color Palette` --semantically_similar_to--> `Transit Mode Icon Cues`  [INFERRED] [semantically similar]
  .claude/skills/uiux-promax/SKILL.md → .claude/skills/taste-design/SKILL.md
- `Card()` --calls--> `cn()`  [EXTRACTED]
  src/components/ui/card.tsx → src/lib/utils.ts
- `CardHeader()` --calls--> `cn()`  [EXTRACTED]
  src/components/ui/card.tsx → src/lib/utils.ts
- `CardTitle()` --calls--> `cn()`  [EXTRACTED]
  src/components/ui/card.tsx → src/lib/utils.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **CommuTayo UI Design Skill System** — claude_skills_motion_design_skill, claude_skills_taste_design_skill, claude_skills_uiux_promax_skill [INFERRED 0.85]
- **Aguinaldo Highway Corridor Transit Nodes** — docs_cavite_network_st_dominic, docs_cavite_network_imus_lumina_robinsons_imus, docs_cavite_network_robinsons_place_dasmarinas, docs_cavite_network_sm_city_dasmarinas, docs_cavite_network_pala_pala_terminal, docs_cavite_network_lpu_cavite, docs_cavite_network_silang_premier [EXTRACTED 1.00]
- **Cavite Transit Modes & Fares** — docs_cavite_network_jeepney_fare, docs_cavite_network_bus_fare, docs_cavite_network_uv_express_fare, docs_cavite_network_tricycle_fare [EXTRACTED 1.00]

## Communities (21 total, 2 thin omitted)

### Community 0 - "shadcn UI Components"
Cohesion: 0.09
Nodes (29): Badge(), badgeVariants, Button(), buttonVariants, Card(), CardAction(), CardContent(), CardDescription() (+21 more)

### Community 1 - "Cavite Routing Engine"
Cohesion: 0.08
Nodes (36): buildEdges(), CAVITE_EDGES, CAVITE_NETWORK, CAVITE_NODES, EDGE_SPECS, EdgeSpec, nodesById, buildAdjacency() (+28 more)

### Community 2 - "Runtime Dependencies"
Cohesion: 0.07
Nodes (29): @base-ui/react, class-variance-authority, clsx, @fontsource-variable/geist, framer-motion, leaflet, lucide-react, dependencies (+21 more)

### Community 3 - "App TS Config"
Cohesion: 0.08
Nodes (23): DOM, DOM.Iterable, ES2020, src, compilerOptions, allowImportingTsExtensions, baseUrl, isolatedModules (+15 more)

### Community 4 - "Build & Lint Tooling"
Cohesion: 0.09
Nodes (23): autoprefixer, oxlint, devDependencies, autoprefixer, oxlint, postcss, tailwindcss, @tailwindcss/postcss (+15 more)

### Community 5 - "shadcn Config & Registries"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "Node TS Config"
Cohesion: 0.10
Nodes (19): ES2023, node, vite.config.ts, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module (+11 more)

### Community 7 - "Lint Rules & App Entry"
Cohesion: 0.14
Nodes (13): App Branding / Visual Identity, plugins, rules, react/only-export-components, react/rules-of-hooks, $schema, oxc, react (+5 more)

### Community 8 - "CommuTayo Design Skills"
Cohesion: 0.14
Nodes (14): Motion Design Skill, Framer Motion Spring Physics (stiffness 300, damping 30), layout/layoutId Landmark Cue Expansion, Micro-interaction & Transition Timing Limits, Modal Dismissal Easing (easeOut <=150ms), Taste Design Skill, Fare & Time Confirmation Chips, Transit Mode Icon Cues (+6 more)

### Community 9 - "Cavite Transit Network Doc"
Cohesion: 0.27
Nodes (13): Cavite Network Corridor Spec, Bus Fare Structure, "Sabihin kay Manong" Driver Phrasings, Imus Lumina / Robinsons Imus Interchange, Jeepney Fare Structure, LPU Cavite (General Trias) Feeder Terminus, Pala-Pala Terminal, Robinsons Place Dasmariñas Boarding Zone (+5 more)

### Community 10 - "Package Manifest & Scripts"
Cohesion: 0.20
Nodes (9): name, private, scripts, build, dev, lint, preview, type (+1 more)

### Community 11 - "Social Icon Sprite"
Cohesion: 0.76
Nodes (7): Bluesky Icon, Discord Icon, Documentation Icon, GitHub Icon, Social/People Icon, icons.svg (Icon Sprite Sheet), X (Twitter) Icon

### Community 12 - "Root TS Config"
Cohesion: 0.33
Nodes (5): compilerOptions, baseUrl, paths, files, references

### Community 13 - "Project README & Template"
Cohesion: 0.50
Nodes (4): commutayo README, Oxlint Linting Configuration, React Compiler (disabled), Vite + React + TypeScript Template

### Community 14 - "Brand Colors & Favicon"
Cohesion: 0.67
Nodes (3): Accent Blue Color (#47bfff), Favicon Icon (Commutayo Brand Mark), Brand Purple Color (#863bff / #7e14ff)

## Knowledge Gaps
- **126 isolated node(s):** `$schema`, `typescript`, `oxc`, `react/rules-of-hooks`, `warn` (+121 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `Runtime Dependencies` to `Package Manifest & Scripts`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `Build & Lint Tooling` to `Package Manifest & Scripts`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `$schema`, `typescript`, `oxc` to the rest of the system?**
  _126 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `shadcn UI Components` be split into smaller, more focused modules?**
  _Cohesion score 0.08562367864693446 - nodes in this community are weakly interconnected._
- **Should `Cavite Routing Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._
- **Should `Runtime Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
- **Should `App TS Config` be split into smaller, more focused modules?**
  _Cohesion score 0.08333333333333333 - nodes in this community are weakly interconnected._