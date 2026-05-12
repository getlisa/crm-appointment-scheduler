-- BuildOps core tables.
-- Idempotent — safe to run multiple times.
-- Source of truth: docs/buildops/database-schema.md

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
  buildops_tenant_id  text        not null
);

-- ─────────────────────────────────────────────
-- customers
-- Mirror of BuildOps customers.
-- Primary lookup table for inbound calls.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_customers (
  id                          uuid          primary key default gen_random_uuid(),
  tenant_id                   text          not null references public.buildops_tenants(no),
  buildops_customer_id        text          not null,
  name                        text          not null,
  phone_primary               text,
  phone_secondary             text,
  is_active                   boolean       not null default true,
  addresses                   jsonb,
  normalized_phone_primary    text,
  normalized_phone_secondary  text,
  price_book_id               text,
  all_numbers                 text[],
  all_numbers_sources         text[],
  account_number              text,
  customer_type               text,
  status                      text,
  email                       text,
  customer_number             text,
  credit_limit                decimal,
  is_taxable                  boolean,
  tax_rate_value              decimal,
  receive_sms                 boolean,
  invoice_delivery_pref       text,
  payment_term_id             text,
  invoice_preset_id           text,
  logo_url                    text,
  website_url                 text,
  version                     integer,
  amount_not_to_exceed        decimal,
  buildops_last_updated_at    bigint,
  buildops_created_at         bigint,
  representatives             jsonb,
  properties                  jsonb,
  constraint customers_tenant_buildops_id_key unique (tenant_id, buildops_customer_id)
);

create index if not exists idx_buildops_customers_all_numbers
  on public.buildops_customers using gin (all_numbers);

create index if not exists idx_buildops_customers_tenant_id
  on public.buildops_customers (tenant_id);

create index if not exists idx_buildops_customers_tenant_buildops_id
  on public.buildops_customers (tenant_id, buildops_customer_id);

create index if not exists idx_buildops_customers_addresses
  on public.buildops_customers using gin (addresses);

-- ─────────────────────────────────────────────
-- property
-- Mirror of BuildOps service locations.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_properties (
  id             text    primary key,          -- BuildOps property UUID
  name           text,
  phone_primary  text,
  customer_id    text    not null,             -- references buildops_customers.id
  address        jsonb   not null              -- {line1, line2, city, state, zip}
);

create index if not exists idx_buildops_properties_customer_id
  on public.buildops_properties (customer_id);

create index if not exists idx_buildops_properties_address
  on public.buildops_properties using gin (address);

-- ─────────────────────────────────────────────
-- representatives
-- Mirror of BuildOps customer representatives.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_representatives (
  id                        uuid        primary key default gen_random_uuid(),
  tenant_id                 text        not null,
  customer_id               text        not null,
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
-- inbound_calls
-- One row per Retell call.
-- Created at call_started, updated throughout lifecycle.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_inbound_calls (
  id                   uuid    primary key default gen_random_uuid(),
  retell_call_id       text    not null unique,
  tenant_id            text    not null,
  caller               text,
  receiver             text    not null,
  matched_customer_id  text,
  status               text    not null default 'active',
  buildops_job_id      text,
  pending_jobs         jsonb   not null default '[]'::jsonb
);

-- ─────────────────────────────────────────────
-- jobs
-- Mirror of every job created through the integration.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_jobs (
  id                    uuid      primary key default gen_random_uuid(),
  job_id                text      not null,
  job_number            text,
  status                text,
  customer_property_id  text,
  customer_name         text,
  customer_id           text,
  job_type_id           text,
  job_type_name         text,
  price_book_id         text,
  priority              text,
  version               integer   default 0,
  billing_status        text,
  review_status         text,
  billing_type          text,
  amount_quoted         decimal,
  is_use_taxable        boolean   default false,
  departments           jsonb     default '[]'::jsonb,
  due_date              text,
  is_flagged            boolean   default false,
  tenant_id             text      not null,
  audit                 jsonb,
  constraint jobs_tenant_job_id_key unique (tenant_id, job_id)
);

-- ─────────────────────────────────────────────
-- departments
-- Local copy of BuildOps departments.
-- Not queried during live calls — hardcoded DEFAULT_DEPARTMENT_ID used instead.
-- ─────────────────────────────────────────────
create table if not exists public.buildops_departments (
  id             text     primary key,    -- BuildOps department UUID
  tag_name       text     not null,
  tenant_id      text     not null,
  phone_primary  text,
  email          text,
  is_active      boolean  default true
);
