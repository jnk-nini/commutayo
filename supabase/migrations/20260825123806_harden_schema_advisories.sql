-- Addresses two WARN-level advisor findings from the initial schema migration.

-- Move pg_trgm out of public, per Supabase's extension-placement guidance.
create schema if not exists extensions;
alter extension pg_trgm set schema extensions;

-- Pin search_path so the trigger function can't be hijacked by a search_path change.
create or replace function set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
