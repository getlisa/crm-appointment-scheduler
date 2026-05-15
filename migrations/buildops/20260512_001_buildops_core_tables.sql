-- BuildOps core tables.
-- Idempotent — safe to run multiple times.
-- Source of truth: docs/buildops/database-schema.md
-- Incorporates all v2 schema changes (20260513_002_buildops_schema_v2.sql).

-- ─────────────────────────────────────────────
-- buildops_tenants
-- One row per HVAC company (our customer).
-- Looked up by inbound E.164 number at call start.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_tenants (
  no                  text        primary key,               -- E.164 inbound phone line, e.g. +18041234567
  client_id           text        not null,
  client_secret       text        not null,
  access_token        text        not null,
  buildops_tenant_id  text        not null,
  company_name        text,
  is_active           boolean     not null default true,
  business_address    jsonb,
  billing_address     jsonb
);

alter table public.buildops_tenants
  add column if not exists company_name     text,
  add column if not exists is_active        boolean not null default true,
  add column if not exists business_address jsonb,
  add column if not exists billing_address  jsonb;

-- ─────────────────────────────────────────────
-- buildops_customers
-- Mirror of BuildOps customers.
-- Primary lookup table for inbound calls.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_customers (
  id                       uuid    primary key default gen_random_uuid(),
  tenant_id                text    not null,
  buildops_customer_id     text    not null,
  name                     text    not null,
  phone_primary            text,
  phone_secondary          text,
  is_active                boolean not null default true,
  account_number           text,
  customer_type            text,
  status                   text,
  email                    text,
  customer_number          text,
  price_book_id            text,
  version                  integer,
  buildops_last_updated_at bigint,
  buildops_created_at      bigint,
  all_numbers              text[],
  all_numbers_sources      text[],
  property_ids             text[]  not null default '{}',      -- FK → buildops_properties.id (BuildOps property UUIDs). Stores IDs only; full data lives in buildops_properties.
  representative_ids       uuid[]  not null default '{}',      -- FK → buildops_representatives.id (our UUIDs). Stores IDs only; full data lives in buildops_representatives.
  billing_address          text,                               -- formatted string from addresses[addressType=billingAddress]
  business_address         text,                               -- formatted string from primary service address
  constraint customers_tenant_buildops_id_key unique (tenant_id, buildops_customer_id),
  constraint buildops_customers_buildops_customer_id_key unique (buildops_customer_id)
);

create index if not exists idx_buildops_customers_all_numbers
  on public.buildops_customers using gin (all_numbers);

create index if not exists idx_buildops_customers_tenant_id
  on public.buildops_customers (tenant_id);

create index if not exists idx_buildops_customers_tenant_buildops_id
  on public.buildops_customers (tenant_id, buildops_customer_id);

-- ─────────────────────────────────────────────
-- buildops_properties
-- Mirror of BuildOps service locations.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_properties (
  id             text    primary key,          -- BuildOps property UUID
  name           text,
  phone_primary  text,
  customer_id    text    not null,             -- references buildops_customers.buildops_customer_id
  address        jsonb   not null              -- {line1, line2, city, state, zip}
);

create index if not exists idx_buildops_properties_customer_id
  on public.buildops_properties (customer_id);

create index if not exists idx_buildops_properties_address
  on public.buildops_properties using gin (address);

-- ─────────────────────────────────────────────
-- buildops_representatives
-- Mirror of BuildOps customer representatives.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_representatives (
  id                        uuid        primary key default gen_random_uuid(),
  tenant_id                 text        not null,
  customer_id               text        not null,             -- references buildops_customers.buildops_customer_id
  property_id               text        not null,
  first_name                text        not null,
  last_name                 text        not null,
  cell_phone                text,
  landline_phone            text,
  normalized_cell_phone     text,
  normalized_landline_phone text,
  email                     text,
  is_active                 boolean     default true,
  is_do_not_call            boolean     default false,
  is_email_opt_out          boolean     default false,
  is_sms_opt_out            boolean     default false,
  created_at                timestamptz,
  updated_at                timestamptz,
  version                   integer     default 0
);

create index if not exists idx_buildops_representatives_tenant_customer
  on public.buildops_representatives (tenant_id, customer_id);

create index if not exists idx_buildops_representatives_phones
  on public.buildops_representatives (normalized_cell_phone, normalized_landline_phone);

-- ─────────────────────────────────────────────
-- FK constraints (after both parent + child tables exist)
-- DEFERRABLE so batch upserts can insert child rows before parent rows are committed.
-- ─────────────────────────────────────────────
alter table public.buildops_properties
  drop constraint if exists fk_properties_customer,
  add constraint fk_properties_customer
    foreign key (customer_id)
    references public.buildops_customers(buildops_customer_id)
    on delete cascade
    deferrable initially deferred;

alter table public.buildops_representatives
  drop constraint if exists fk_representatives_customer,
  add constraint fk_representatives_customer
    foreign key (customer_id)
    references public.buildops_customers(buildops_customer_id)
    on delete cascade
    deferrable initially deferred;

-- ─────────────────────────────────────────────
-- buildops_inbound_calls
-- One row per Retell call.
-- Created at call_started, updated throughout lifecycle.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_inbound_calls (
  id                   uuid    primary key default gen_random_uuid(),
  retell_call_id       text    not null unique,
  tenant_id            text    not null,
  caller               text,                                  -- E.164 number of the caller
  matched_customer_id  text,                                  -- our buildops_customers.id (UUID)
  status               text    not null default 'active',     -- active | ended | handed_off
  buildops_job_id      text                                   -- set immediately when prepare_job completes
);

-- ─────────────────────────────────────────────
-- buildops_jobs
-- Mirror of every job created through or synced from BuildOps.
-- Created immediately during the call (not deferred to call end).
-- Incrementally synced every 5 min by the Deno cron edge function.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_jobs (
  id                             uuid      primary key default gen_random_uuid(),
  tenant_id                      text      not null,
  job_id                         text      not null,
  job_number                     text,
  status                         text,                        -- Open | In Progress | On Hold | Canceled | Complete
  customer_property_id           text,
  customer_name                  text,
  customer_id                    text,
  job_type_id                    text,
  job_type_name                  text,
  price_book_id                  text,
  priority                       text,
  version                        integer   default 0,
  billing_status                 text,
  review_status                  text,
  billing_type                   text,
  amount_quoted                  decimal,
  is_use_taxable                 boolean   default false,
  departments                    jsonb     default '[]'::jsonb,
  due_date                       text,
  is_flagged                     boolean   default false,
  audit                          jsonb,                       -- raw BuildOps audit block
  -- incremental sync fields
  created_at                     bigint,                      -- audit.createdDateTime (unix ms)
  last_updated_at                bigint,                      -- audit.lastUpdatedDateTime (unix ms); sync watermark
  issue_description              text,
  customer_provided_job_number   text,
  customer_provided_po_number    text,
  billing_customer_id            text,
  billing_customer_name          text,
  invoice_status                 text,
  service_agreement_id           text,
  completed_date                 bigint,
  is_deleted                     boolean   not null default false,  -- true when audit.deletedDateTime is set
  constraint jobs_tenant_job_id_key unique (tenant_id, job_id)
);

create index if not exists idx_buildops_jobs_tenant_updated
  on public.buildops_jobs (tenant_id, last_updated_at);
