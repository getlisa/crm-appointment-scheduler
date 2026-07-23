-- HouseCall Pro jobs cache + relationship wiring for the HCP integration.
--
-- Source-of-truth tables that already exist in Supabase:
--   housecallpro_tokens        (tenant anchor; unique tenant_id)
--   housecallpro_customers     (unique (tenant_id, housecallpro_customer_id))
--   housecallpro_callsessions  (unique session_id; per-call state)
--
-- This migration:
--   1. Creates housecallpro_jobs, modeled on the HCP "Create a Job" response.
--   2. Wires the four HCP tables together with foreign keys:
--
--        housecallpro_tokens (tenant_id)
--              ^        ^        ^
--              |        |        |
--        customers   sessions   jobs
--              ^        |  ^      | |
--              |        |  |      | |
--              +--customer  +--session +--customer(composite)
--
-- Safe to run multiple times (create ... if not exists + guarded constraint adds).
-- Requires PostgreSQL 15+ for the column-scoped ON DELETE SET NULL on callsessions
-- (Supabase satisfies this).

-- ---------------------------------------------------------------------------
-- 1. housecallpro_jobs
-- ---------------------------------------------------------------------------
create table if not exists public.housecallpro_jobs (
  id uuid not null default gen_random_uuid (),
  tenant_id uuid not null,

  -- HouseCall Pro job id (the created job's id).
  housecallpro_job_id text not null,

  -- Required to create a job. The composite FK below requires the customer to
  -- be upserted into housecallpro_customers BEFORE inserting a job.
  housecallpro_customer_id text not null,
  address_id text not null,

  -- Link back to the call that booked this job (nullable: jobs may be created
  -- outside a call flow, e.g. backfill/sync).
  session_id uuid null,

  -- Scheduling
  scheduled_start timestamp with time zone null,
  scheduled_end timestamp with time zone null,
  arrival_window integer null, -- minutes

  -- Line items sent to HCP. Each item requires a name (unit_price/quantity optional).
  line_items jsonb null,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint housecallpro_jobs_pkey primary key (id),
  constraint housecallpro_jobs_tenant_hcp_job_id_key unique (tenant_id, housecallpro_job_id),

  -- tenant_id -> tokens (matches customers/callsessions convention)
  constraint housecallpro_jobs_tenant_id_fkey foreign key (tenant_id)
    references public.housecallpro_tokens (tenant_id) on delete cascade,

  -- (tenant_id, housecallpro_customer_id) -> customers.
  -- A job mirrors an HCP job; if the customer cache row is removed, drop the job cache row too.
  constraint housecallpro_jobs_customer_fkey foreign key (tenant_id, housecallpro_customer_id)
    references public.housecallpro_customers (tenant_id, housecallpro_customer_id) on delete cascade,

  -- session_id -> callsessions. Keep the job record if the session is purged.
  constraint housecallpro_jobs_session_fkey foreign key (session_id)
    references public.housecallpro_callsessions (session_id) on delete set null
) TABLESPACE pg_default;

create index if not exists idx_housecallpro_jobs_tenant_id
  on public.housecallpro_jobs using btree (tenant_id) TABLESPACE pg_default;

create index if not exists idx_housecallpro_jobs_tenant_customer
  on public.housecallpro_jobs using btree (tenant_id, housecallpro_customer_id) TABLESPACE pg_default;

create index if not exists idx_housecallpro_jobs_session_id
  on public.housecallpro_jobs using btree (session_id) TABLESPACE pg_default;

create index if not exists idx_housecallpro_jobs_scheduled_start
  on public.housecallpro_jobs using btree (tenant_id, scheduled_start) TABLESPACE pg_default;

-- ---------------------------------------------------------------------------
-- 2. Wire the existing callsessions table to customers.
--    tenant_id is NOT NULL on callsessions, so we scope SET NULL to only the
--    customer column (PostgreSQL 15+). When a matched customer is deleted, the
--    session survives with housecallpro_customer_id cleared (audit-friendly).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'housecallpro_callsessions_customer_fkey'
      and conrelid = 'public.housecallpro_callsessions'::regclass
  ) then
    alter table public.housecallpro_callsessions
      add constraint housecallpro_callsessions_customer_fkey
      foreign key (tenant_id, housecallpro_customer_id)
      references public.housecallpro_customers (tenant_id, housecallpro_customer_id)
      on delete set null (housecallpro_customer_id);
  end if;
end
$$;

-- Supports the FK lookup + customer-scoped session queries.
create index if not exists idx_housecallpro_callsessions_tenant_customer
  on public.housecallpro_callsessions using btree (tenant_id, housecallpro_customer_id) TABLESPACE pg_default;
