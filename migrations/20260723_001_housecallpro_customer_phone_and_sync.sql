-- HouseCall Pro call-time + sync support columns.
--
--   1. housecallpro_customers.normalized_mobile — a STORED generated column of the
--      last 10 digits of mobile_number. Powers O(1) caller identification at
--      call_inbound without mutating the source `mobile_number` value.
--   2. Trigram indexes on first_name / last_name for the Scenario-A fuzzy
--      customer lookup (ILIKE '%term%').
--   3. housecallpro_tokens.sync_customer_page — per-tenant cursor for the
--      paginated Supabase Edge Function customer sync (mirrors buildops_tenants.sync_customer_page).
--
-- Safe to run multiple times.

-- ── 1. Normalized mobile for phone identification ────────────────────────────
alter table public.housecallpro_customers
  add column if not exists normalized_mobile text
  generated always as (right(regexp_replace(coalesce(mobile_number, ''), '[^0-9]', '', 'g'), 10)) stored;

create index if not exists idx_housecallpro_customers_tenant_normalized_mobile
  on public.housecallpro_customers using btree (tenant_id, normalized_mobile) TABLESPACE pg_default;

-- ── 2. Trigram indexes for name fuzzy lookup ─────────────────────────────────
create extension if not exists pg_trgm;

create index if not exists idx_housecallpro_customers_first_name_trgm
  on public.housecallpro_customers using gin (first_name gin_trgm_ops) TABLESPACE pg_default;

create index if not exists idx_housecallpro_customers_last_name_trgm
  on public.housecallpro_customers using gin (last_name gin_trgm_ops) TABLESPACE pg_default;

-- ── 3. Sync cursor on the tenant/token table ─────────────────────────────────
alter table public.housecallpro_tokens
  add column if not exists sync_customer_page integer not null default 1;

comment on column public.housecallpro_customers.normalized_mobile
  is 'Last 10 digits of mobile_number (generated). Used for caller identification at call_inbound.';
comment on column public.housecallpro_tokens.sync_customer_page
  is 'Cursor for the paginated HCP customer sync edge function. page>=1 syncs that page; reset to 1 at end of cycle.';
