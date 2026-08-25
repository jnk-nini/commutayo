# Aguinaldo Highway Corridor Spec (CommuTayo Pilot)

## Core Transit Nodes

Coordinates are the **transit bay or pedestrian entrance a commuter physically stands at**, not the
centroid of the property. A mall centroid drops the pin in the middle of a building; the waiting
shed is what someone walking with a phone actually needs to find. These replace the earlier
approximations, which rendered off-road or across residential blocks.

| # | Stop | Latitude | Longitude | What the pin marks |
|---|------|----------|-----------|--------------------|
| 1 | **St. Dominic (Bacoor Longos)** | 14.4682 | 120.9634 | Waiting shed opposite St. Dominic Savio Parish, southbound side. Major UV and traditional jeepney terminus connecting Metro Manila (PITX) to Cavite. |
| 2 | **Imus Lumina / Robinsons Imus** | 14.4267 | 120.9405 | Under the Lumina overpass, at the Robinsons Imus entrance. Key interchange for mid-Cavite travellers. |
| 3 | **Robinsons Place Dasmariñas** | 14.3312 | 120.9575 | Loading bay on the Aguinaldo Highway frontage. Secondary boarding zone. |
| 4 | **SM City Dasmariñas** | 14.3005 | 120.9576 | Main waiting shed, at the overpass opposite the Hypermarket entrance. |
| 5 | **Pala-Pala Terminal** | 14.2982 | 120.9568 | Inside the terminal, in the General Trias bay. Central transfer point for jeepneys to General Trias and buses to Silang and Tagaytay. |
| 6 | **LPU Cavite (General Trias)** | 14.3168 | 120.9254 | Directly opposite the LPU main gate on Governor's Drive, beside the jeepney stand. Feeder terminus via Manggahan jeepneys and local tricycles. |
| 7 | **Silang Premier** | 14.2341 | 120.9744 | Waiting shed opposite the Silang Premier outlet, southbound side. Southern boundary corridor stop via modern jeeps and buses. |

Nodes 4 and 5 are roughly **270 m apart**, which puts them inside the walking-first radius below.

## Route Geometry

Every stop pair carries real road geometry and road distance fetched from OSRM's public routing API
(driving profile), simplified with Ramer-Douglas-Peucker and baked into `src/utils/routingEngine.ts`
as `ROAD_SEGMENTS`. Lines drawn on the map follow Governor's Drive and Aguinaldo Highway rather than
cutting straight across blocks, and fares are metered on road kilometers rather than crow-flies
distance.

Regenerate with `node scripts/fetch-roads.mjs` after any change to the coordinates above.

**Exception:** stop pairs inside the walking radius keep a straight line. The road route between SM
Dasmariñas and Pala-Pala is a 1.5 km vehicle detour around a divided highway; tracing that as a
270 m walk would be wrong.

## Transit Modes & Fares

Fares are computed in `src/utils/fares.ts` from base fare plus a per-kilometer rate, then rounded to
whole pesos, because no conductor makes change for 25 centavos.

| Vehicle | Base fare | Base distance | Per km after |
|---------|-----------|---------------|--------------|
| Traditional Jeepney | ₱13.00 | first 4 km | ₱1.80 |
| Modern Jeepney | ₱15.00 | first 4 km | ₱1.80 |
| Bus | ₱15.00 | first 5 km | ₱2.20 |
| UV Express | ₱50.00 flat | point to point | n/a |
| Tricycle | ₱35.00 flat | terminal feeder | n/a |

**Discounts:** students, senior citizens and PWDs get 20% off (RA 9994, RA 10754, LTFRB student fare
rules). The discount is taken off the whole-peso matrix fare and rounded again, which is the order it
happens on the road.

**Walking-first rule:** when two stops are within **500 m** of each other, the planner removes every
vehicle edge between them and substitutes a free walking connection. Charging a full base fare for a
two-minute hop between adjacent terminals is the exact trap this closes. In the pilot corridor this
applies to SM Dasmariñas and Pala-Pala.

## Vehicle Signboards ("Anong sasakyan ang sasakyan ko?")

The board painted on the windshield or hung on the acrylic placard, per direction. These follow
corridor convention and are **inferred, not quoted from a survey**, so treat them at the same
confidence grade as the fares.

| Leg | Direction | Placard |
|-----|-----------|---------|
| St. Dominic to Imus Lumina | southbound | `IMUS / TANZANG LUMA` |
| Imus Lumina to St. Dominic | northbound | `ZAPOTE / BACLARAN` |
| Imus Lumina to Robinsons Dasma | southbound | `DASMARIÑAS / SALITRAN` |
| Robinsons Dasma to Imus Lumina | northbound | `IMUS / ZAPOTE` |
| Robinsons Dasma to SM Dasma | southbound | `PALA-PALA / SM DASMA` |
| SM Dasma to Robinsons Dasma | northbound | `SALITRAN / ROBINSONS` |
| Pala-Pala to LPU Cavite | westbound | `MANGGAHAN / GOV. DRIVE`, also `TRECE / INDANG / DBB-C` |
| LPU Cavite to Pala-Pala | eastbound | `PALA-PALA / DASMA BAYAN` |
| Pala-Pala to Silang (modern jeep) | southbound | `SILANG BAYAN` |
| Pala-Pala to Silang (bus) | southbound | `SILANG / TAGAYTAY` |
| Any bus on the highway spine | both | `DASMARIÑAS - BACLARAN` / `BACLARAN - DASMARIÑAS` |
| St. Dominic to SM Dasma (UV) | southbound | `DASMARIÑAS - PITX` |
| Pala-Pala to LPU (tricycle) | both | `TODA: PALA-PALA / LPU GATE` |

## Waiting Spots ("Saan ako tatayo?")

- St. Dominic: sa waiting shed tapat ng St. Dominic Savio Parish, sa southbound na gilid ng Aguinaldo Highway.
- Imus Lumina: sa ilalim ng Lumina overpass, tapat mismo ng entrance ng Robinsons Imus.
- Robinsons Dasma: sa loading bay sa gilid ng Robinsons Place Dasmariñas, harap ng Aguinaldo Highway.
- SM Dasmariñas: sa main waiting shed ng SM City Dasmariñas, sa overpass tapat ng Hypermarket.
- Pala-Pala: sa loob ng Pala-Pala terminal, sa hanay ng mga sasakyang papuntang General Trias.
- LPU Cavite: sa tapat mismo ng LPU main gate sa Governor's Drive, katabi ng jeepney stand.
- Silang Premier: sa waiting shed tapat ng Silang Premier outlet, sa southbound na gilid.

## Landmark & Driver Phrasings ("Sabihin kay Manong")

These are the verified ones. Robinsons Dasma and Silang Premier have no phrase in the source
material; the engine flags both as unverified and the confidence score deducts for them.

- St. Dominic: "St. Dominic babaan po"
- Imus Lumina: "Lumina overpass po"
- SM Dasmariñas: "SM Dasma tapat ng overpass po"
- Pala-Pala: "Pala-Pala terminal po"
- LPU Cavite: "LPU Gate / Bayan po"

## Live Trip Thresholds

| Moment | Distance | What happens |
|--------|----------|--------------|
| Approaching a drop-off | 250 m along the route | Phone vibrates `[250, 150, 250]`, high-contrast banner: "Malapit na ang babaan" |
| Reached a mid-route stop | 60 m along the route | Quiet banner confirming the stop |
| Trip complete | 50 m straight-line from the destination pin | GPS watch stops, card flips to the fare summary |

Measured straight-line at the destination on purpose: the last few meters are usually on foot and
off the drawn route, and a route-projected distance would never quite reach zero.
