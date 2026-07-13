-- Add created_at to servicetitan_customers and servicetitan_locations.
-- Existing rows get backdated to updated_at as a best-effort value.
-- Safe to run multiple times.

alter table public.servicetitan_customers
  add column if not exists created_at timestamptz not null default now();

update public.servicetitan_customers
  set created_at = updated_at
  where created_at = now();

alter table public.servicetitan_locations
  add column if not exists created_at timestamptz not null default now();

update public.servicetitan_locations
  set created_at = updated_at
  where created_at = now();
