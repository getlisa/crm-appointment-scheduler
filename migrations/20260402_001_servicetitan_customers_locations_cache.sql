-- ServiceTitan CRM cache tables for fast customer/location lookup during booking.
-- Safe to run multiple times.

create table if not exists public.servicetitan_customers (
  tenant_id bigint not null,
  customer_id bigint not null,
  name text null,
  phone text null,
  normalized_phone text null,
  address_street text null,
  address_unit text null,
  address_city text null,
  address_state text null,
  address_zip text null,
  address_country text null,
  raw_contacts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, customer_id)
);

alter table public.servicetitan_customers
  add column if not exists normalized_phone text null;

create table if not exists public.servicetitan_locations (
  tenant_id bigint not null,
  location_id bigint not null,
  customer_id bigint null,
  name text null,
  address_street text null,
  address_unit text null,
  address_city text null,
  address_state text null,
  address_zip text null,
  address_country text null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, location_id)
);

-- Ensure existing environments also allow nullable customer_id on locations.
alter table public.servicetitan_locations
  alter column customer_id drop not null;

create index if not exists idx_st_customers_tenant_phone
  on public.servicetitan_customers (tenant_id, normalized_phone);

create index if not exists idx_st_customers_tenant_address
  on public.servicetitan_customers (
    tenant_id,
    address_street,
    address_city,
    address_state,
    address_zip,
    address_country
  );

create index if not exists idx_st_locations_tenant_customer
  on public.servicetitan_locations (tenant_id, customer_id);

create index if not exists idx_st_locations_tenant_address
  on public.servicetitan_locations (
    tenant_id,
    address_street,
    address_city,
    address_state,
    address_zip,
    address_country
  );
