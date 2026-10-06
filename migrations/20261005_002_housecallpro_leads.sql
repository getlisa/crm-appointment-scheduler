-- HouseCall Pro leads created by the voice agent (Pierce Electric lead-only intake).
--
-- Pierce Office Hours no longer books a job: create_lead writes an HCP lead
-- against the customer already pinned to the call session, and the office
-- converts it to a job or estimate by hand. This table mirrors
-- housecallpro_jobs so a created lead has the same local audit trail.
--
-- The caller's requested timeframe is OUR record only — a lead has no schedule
-- in HCP, so the preference is also written into the lead's note text.
--
-- Safe to run multiple times (create ... if not exists + guarded column adds).

-- ---------------------------------------------------------------------------
-- 1. housecallpro_leads
-- ---------------------------------------------------------------------------
create table if not exists public.housecallpro_leads (
  id uuid not null default gen_random_uuid (),
  tenant_id uuid not null,

  -- HouseCall Pro lead id (lea_...) and its human-facing number.
  housecallpro_lead_id text not null,
  lead_number integer null,

  -- A lead always belongs to a customer; the composite FK below requires the
  -- customer to be upserted into housecallpro_customers first.
  housecallpro_customer_id text not null,
  address_id text null,

  -- HCP job type stamped on the lead (jbt_...), when the agent classified one.
  job_type_uuid text null,

  -- Link back to the call that logged this lead.
  session_id uuid null,

  -- The caller's requested timeframe. Kept locally; never sent to HCP.
  requested_start timestamp with time zone null,
  requested_end timestamp with time zone null,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint housecallpro_leads_pkey primary key (id),
  constraint housecallpro_leads_tenant_hcp_lead_id_key unique (tenant_id, housecallpro_lead_id),

  constraint housecallpro_leads_tenant_id_fkey foreign key (tenant_id)
    references public.housecallpro_tokens (tenant_id) on delete cascade,

  constraint housecallpro_leads_customer_fkey foreign key (tenant_id, housecallpro_customer_id)
    references public.housecallpro_customers (tenant_id, housecallpro_customer_id) on delete cascade,

  -- Keep the lead record if the session is purged.
  constraint housecallpro_leads_session_fkey foreign key (session_id)
    references public.housecallpro_callsessions (session_id) on delete set null
) TABLESPACE pg_default;

create index if not exists idx_housecallpro_leads_tenant_id
  on public.housecallpro_leads using btree (tenant_id) TABLESPACE pg_default;

create index if not exists idx_housecallpro_leads_tenant_customer
  on public.housecallpro_leads using btree (tenant_id, housecallpro_customer_id) TABLESPACE pg_default;

create index if not exists idx_housecallpro_leads_session_id
  on public.housecallpro_leads using btree (session_id) TABLESPACE pg_default;

-- ---------------------------------------------------------------------------
-- 2. Record the created lead on the call session (mirrors the job columns).
-- ---------------------------------------------------------------------------
alter table public.housecallpro_callsessions
  add column if not exists housecallpro_lead_id text null,
  add column if not exists housecallpro_lead_number integer null,
  add column if not exists job_type_uuid text null;

comment on column public.housecallpro_callsessions.housecallpro_lead_id
  is 'HCP lead (lea_...) created by create_lead on this call.';
comment on column public.housecallpro_callsessions.job_type_uuid
  is 'HCP job type (jbt_...) the agent classified, resolved from housecallpro_job_types.';
