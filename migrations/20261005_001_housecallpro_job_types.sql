-- HouseCall Pro job-type name → uuid lookup.
--
-- The Retell agent picks a job type by NAME from a fixed enum on the create_lead
-- tool (it never sees a uuid). The backend resolves the name here and sends the
-- stored `jbt_…` id to HCP verbatim as the top-level `job_type_uuid` on
-- POST /leads.
--
-- Tenant-scoped: each HCP account has its own job-type list with its own ids.
-- Safe to run multiple times.

create table if not exists public.housecallpro_job_types (
  tenant_id uuid not null,
  name text not null,
  housecallpro_job_type_id text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone null default now(),
  constraint housecallpro_job_types_pkey primary key (tenant_id, name)
) TABLESPACE pg_default;

comment on table public.housecallpro_job_types
  is 'Maps an HCP job-type name to its uuid, per tenant. Read by create_lead to set job_type_uuid on POST /leads.';
comment on column public.housecallpro_job_types.name
  is 'Exact HCP job-type name. Must match the create_lead tool enum values the agent sends.';
comment on column public.housecallpro_job_types.housecallpro_job_type_id
  is 'HCP job type id (jbt_...), sent verbatim as the top-level job_type_uuid on POST /leads.';

-- Pierce Electric (tenant d4133982-fd2a-43c5-8982-8b8aa00add66).
-- Read from GET /job_fields/job_types on 2026-09-30.
insert into public.housecallpro_job_types (tenant_id, name, housecallpro_job_type_id) values
  ('d4133982-fd2a-43c5-8982-8b8aa00add66', 'Commercial',  'jbt_2956b129802f42d1a1ec42ae32c3eb57'),
  ('d4133982-fd2a-43c5-8982-8b8aa00add66', 'Estimate',    'jbt_1a7d4561d46a47a8980caa95252b3741'),
  ('d4133982-fd2a-43c5-8982-8b8aa00add66', 'Diagnostic',  'jbt_93d07080cf1e4ba795f3786bb9149a39'),
  ('d4133982-fd2a-43c5-8982-8b8aa00add66', 'Install',     'jbt_e978ccdef6ff457695239a52ad552400'),
  ('d4133982-fd2a-43c5-8982-8b8aa00add66', 'Maintenance', 'jbt_479b587e295c42129995bea0a0bba0f9'),
  ('d4133982-fd2a-43c5-8982-8b8aa00add66', 'Repair',      'jbt_a9d450afb2924b17bde05435c2c824dc')
on conflict (tenant_id, name) do update
  set housecallpro_job_type_id = excluded.housecallpro_job_type_id,
      updated_at = now();
