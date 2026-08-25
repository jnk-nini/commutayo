-- CommuTayo Cavite-wide transit schema.
-- Field choices trace back to the OSM cleanup/dedup/stitch prototype (see project research):
-- confidence/provenance fields exist because the source data is a mix of community-mapped OSM
-- routes and, later, official/surveyed data, never a single trusted feed.

create extension if not exists "pg_trgm";

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- stops
-- ---------------------------------------------------------------------------

create table stops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_name text,
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  city text,
  is_terminal boolean not null default false,
  aliases text[] not null default '{}',
  waiting_spot text,

  -- Provenance. A stop can be the centroid merge of several raw source points (mega-terminals
  -- like PITX collapse many OSM bay nodes into one pin), so the raw id list lives here for
  -- display/debugging; stop_osm_sources below is the indexed table the ingestion script actually
  -- queries to answer "have I already imported this OSM node."
  source text not null default 'osm' check (source in ('osm', 'official_ltfrb', 'commutetour', 'survey', 'crowdsource')),
  source_osm_node_ids bigint[] not null default '{}',
  confidence_tier text not null default 'medium' check (confidence_tier in ('high', 'medium', 'low')),
  merged_from_count int not null default 1 check (merged_from_count >= 1),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_verified_at timestamptz
);

comment on column stops.merged_from_count is
  'How many raw OSM points were centroid-merged into this stop. >1 means a mega-terminal collapse
   (e.g. PITX) or a genuine duplicate-mapping merge, per the dedup prototype.';

create index stops_city_idx on stops (city);
create index stops_aliases_gin_idx on stops using gin (aliases);
create index stops_name_trgm_idx on stops using gin (name gin_trgm_ops);

create trigger stops_set_updated_at
  before update on stops
  for each row execute function set_updated_at();

-- Indexed, 1-to-many join from a raw OSM node id to the canonical stop it was merged into.
-- This is what re-import checks against ("have I seen this OSM node before"), not the
-- source_osm_node_ids array on stops, which exists for display only and isn't efficiently
-- queryable per-id.
create table stop_osm_sources (
  osm_node_id bigint primary key,
  stop_id uuid not null references stops(id) on delete cascade,
  osm_role text,
  created_at timestamptz not null default now()
);

create index stop_osm_sources_stop_id_idx on stop_osm_sources (stop_id);

-- ---------------------------------------------------------------------------
-- routes
-- ---------------------------------------------------------------------------

create table routes (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  raw_name text,
  -- One real-world "line" is two directional relations in OSM (and in reality: a jeepney doesn't
  -- reverse mid-route). paired_route_id links them; null means no opposite-direction match was
  -- found yet, not that the route is one-way.
  direction text check (direction in ('inbound', 'outbound', 'eastbound', 'westbound', 'northbound', 'southbound', 'loop')),
  paired_route_id uuid references routes(id) on delete set null,

  vehicle_class text not null check (
    vehicle_class in ('jeepney_traditional', 'jeepney_modern', 'uv_express', 'bus', 'bus_premium', 'tricycle')
  ),
  -- Half of the OSM sample had no reliable signal for vehicle class beyond a generic "bus" tag.
  -- This stops that guess from being presented with the same confidence as a name-pattern match.
  vehicle_class_confidence text not null default 'default_fallback' check (
    vehicle_class_confidence in ('tag_pattern', 'name_pattern', 'default_fallback', 'survey_confirmed')
  ),

  ref text,
  operators text[] not null default '{}',
  network text,

  -- Set only for routes whose fare doesn't follow the standard LTFRB per-km matrix in fares.ts
  -- (UV Express, tricycle). Null means "compute it from vehicle_class + distance," matching how
  -- the pilot corridor already works.
  flat_fare numeric,

  source text not null default 'osm' check (source in ('osm', 'official_ltfrb', 'commutetour', 'survey', 'crowdsource')),
  source_osm_relation_id bigint unique,
  source_checked_at timestamptz,

  geometry_quality text not null default 'unknown' check (
    geometry_quality in ('complete', 'has_minor_gap', 'has_major_gap', 'unknown')
  ),
  confidence_tier text not null default 'low' check (confidence_tier in ('high', 'medium', 'low')),
  -- True when geometry_quality = 'has_major_gap' or vehicle_class_confidence = 'default_fallback'
  -- at import time. Kept as a real column (not computed on read) so a review queue can be indexed
  -- and so a human clearing a review doesn't need the original inputs recomputed.
  needs_review boolean not null default false,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index routes_needs_review_idx on routes (needs_review) where needs_review;
create index routes_vehicle_class_idx on routes (vehicle_class);
create index routes_paired_route_id_idx on routes (paired_route_id);

create trigger routes_set_updated_at
  before update on routes
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- route_stops
-- ---------------------------------------------------------------------------

-- Ordered stop sequence per route. A route legitimately has zero rows here (the prototype found a
-- real OSM relation with a complete road line but no marked boarding points at all) -- that's a
-- valid, expected state, not an error, so nothing here requires at-least-one-row.
create table route_stops (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  stop_id uuid not null references stops(id) on delete restrict,
  sequence int not null check (sequence >= 0),
  role text,
  source_osm_node_id bigint,

  unique (route_id, sequence)
);

create index route_stops_stop_id_idx on route_stops (stop_id);

-- ---------------------------------------------------------------------------
-- route_geometry
-- ---------------------------------------------------------------------------

-- One row per route (1:1), kept separate from `routes` because the path itself is large and
-- rarely needed alongside route metadata (e.g. a route list view never needs the polyline).
create table route_geometry (
  route_id uuid primary key references routes(id) on delete cascade,

  -- [[lat, lon], ...] matching the shape RouteResult.polylineCoordinates already uses in the app.
  path jsonb not null default '[]',
  point_count int not null default 0,

  gap_count int not null default 0,
  max_gap_meters numeric,
  -- [{ afterWayIndex, gapMeters, action, sourceOsmWayId }, ...]. `action` is one of
  -- auto_connect / fill_via_osrm / flag_manual_review, per the gap-handling thresholds the
  -- prototype derived from the real gap-distance histogram (<=20m / 20-500m / >500m).
  gaps jsonb not null default '[]',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger route_geometry_set_updated_at
  before update on route_geometry
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- route_reports (crowdsourced corrections -- currently collected client-side and discarded;
-- this is the backend for App.tsx's already-built "Report Update" dialog)
-- ---------------------------------------------------------------------------

create table route_reports (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references routes(id) on delete cascade,

  report_type text not null check (report_type in ('fare_confirmed', 'fare_changed', 'route_inactive', 'other')),
  message text,
  reported_fare numeric,

  created_at timestamptz not null default now(),
  resolved boolean not null default false,
  resolved_at timestamptz,
  resolution_note text
);

create index route_reports_route_id_idx on route_reports (route_id);
create index route_reports_unresolved_idx on route_reports (resolved) where not resolved;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- No auth in the app yet. Transit data is meant to be publicly readable (it's the whole point of
-- the app); route_reports accepts anonymous inserts (the crowdsource dialog has no login) but
-- only a service-role connection (ingestion script, future admin tool) can read/resolve them --
-- so there is no public select policy on route_reports.

alter table stops enable row level security;
alter table stop_osm_sources enable row level security;
alter table routes enable row level security;
alter table route_stops enable row level security;
alter table route_geometry enable row level security;
alter table route_reports enable row level security;

create policy "public read" on stops for select using (true);
create policy "public read" on routes for select using (true);
create policy "public read" on route_stops for select using (true);
create policy "public read" on route_geometry for select using (true);

create policy "public insert" on route_reports for insert with check (true);

-- stop_osm_sources has no public policies: it's an internal provenance/dedup index for the
-- ingestion script (service role), not something the client app needs to read.
