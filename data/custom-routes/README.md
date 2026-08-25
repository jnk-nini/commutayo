# Custom routes: adding a jeepney OpenStreetMap does not have

OpenStreetMap maps the **roads** around Cavite very well and the **services running on them**
unevenly. Some real jeepney lines are simply not in it. When that happens, no amount of tuning the
router will help, because the router can only answer with routes that exist in the data. This
folder is where you add the missing ones by hand.

Each `.json` file here describes **one jeepney line**, both directions. A script reads them and
writes them into Supabase alongside the imported OSM data.

## How to add a route

**1. Copy the template.** Start from `gentri-dasma-jeepney.json` and give your file a new name.

**2. Fill in the line's details.**

| Field | What it means |
| --- | --- |
| `slug` | A short permanent nickname, lowercase with dashes. **Never change it later.** It is how the script recognises this route on a second run instead of creating a duplicate. |
| `name` | The line as a person would describe it, e.g. `Jeepney: General Trias to SM Dasmarinas via Pala-Pala`. |
| `vehicleClass` | One of `jeepney_traditional`, `jeepney_modern`, `uv_express`, `bus`, `bus_premium`, `tricycle`. |
| `ref` | The route code painted on the side, if it has one. Otherwise `null`. |
| `flatFare` | Only if the line charges one price no matter how far you go. Otherwise `null`, and the fare is worked out from distance. |
| `notes` | Who surveyed it and when. Worth writing, because the next person will want to know. |
| `draft` | `true` while you are still working on it. The script skips drafts. Set it to `false` when the stop list is real. |

**3. List the stops, in the order the vehicle reaches them,** once per direction.

Two kinds of entry are allowed:

```jsonc
{ "stop": "Bella Vista" }                          // a stop already in the database
{ "stop": "Robinsons Place Dasmariñas",            // ...and when the name is not unique,
  "near": [14.300918, 120.954297] }                //    say which one you mean

{ "new": {                                          // a stop that does not exist yet
    "slug": "arnaldo-crossing",                     //   unique within this file
    "name": "Arnaldo Crossing",
    "lat": 14.3102, "lon": 120.9331,
    "isTerminal": false
} }
```

If you name a stop that does not exist, the script stops and tells you. If you name one that
matches several stops, it stops and lists them so you can add `near`. It will never guess, because
guessing is exactly how a route ends up attached to the wrong side of a highway.

**4. Optionally trace the road.** `waypoints` is a list of `[latitude, longitude]` points following
the roads the vehicle actually drives. Leave it out and the map draws straight lines between stops,
which looks fine on a highway and wrong around a loop. It also affects the fare, because distance
is measured along this line.

The easy way to get them: open [geojson.io](https://geojson.io), draw a line along the route, and
copy the coordinates, **but swap each pair**, since GeoJSON writes `[longitude, latitude]` and this
file wants `[latitude, longitude]`.

**5. Push it.**

```bash
node scripts/push-custom-routes.ts
```

That is a dry run: it prints exactly what it would create and changes nothing. Read the plan, check
the stop order is right, then:

```bash
node scripts/push-custom-routes.ts --apply
```

Reload the app and the route is there.

## Things worth knowing

- **Running it twice is safe.** Ids are derived from your slugs, so a second run updates the same
  rows. It does not create a second copy of the line.
- **The file is the whole truth about its route.** Delete a stop from the list and it disappears
  from the database on the next `--apply`. That is deliberate: it means fixing a mistake is just
  editing the file.
- **It never touches OSM data.** Everything it writes is marked `source: "survey"`. Re-running the
  OSM import does not overwrite your routes, and this does not overwrite OSM's.
- **Existing stops get reused.** A `{ "new": ... }` stop within 80 m of a stop that already has the
  same name resolves to the existing one instead of planting a duplicate next to it.
- **One direction is a loop.** Give `directions` a single entry and the route is treated as a
  one-way loop, with no return pairing.

## Why the signboard reads the way it does

The app puts the **destination** on the signboard, because that is the one thing a commuter reads
off a moving vehicle. The script builds each route's name as `<name> → <headsign>`, so whatever you
put in `headsign` is what appears on the plate. Write it the way it is actually painted:
`SM DASMARIÑAS`, not `Dasmarinas bound`.
