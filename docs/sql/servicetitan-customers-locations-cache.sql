-- Cache ServiceTitan customers and locations for fast booking resolution.
-- Run once in Supabase SQL editor (or your migration tool).

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

create index if not exists idx_st_customers_tenant_phone
  on public.servicetitan_customers (tenant_id, normalized_phone);

create index if not exists idx_st_customers_tenant_address
  on public.servicetitan_customers (tenant_id, address_street, address_city, address_state, address_zip, address_country);

create index if not exists idx_st_locations_tenant_customer
  on public.servicetitan_locations (tenant_id, customer_id);

create index if not exists idx_st_locations_tenant_address
  on public.servicetitan_locations (tenant_id, address_street, address_city, address_state, address_zip, address_country);
