-- HouseCall Pro lead-source attribution lookup.
--
-- Maps an HCP tracking / lead-source phone line (the number the customer
-- originally dialed, surfaced to the voice flow as `lead_source_number` =
-- Retell's `to_number`) to the real HCP lead source. book_job / create_customer
-- look up the dialed line here and stamp the resolved lead source onto the
-- created job / customer instead of a hardcoded value.
--
-- Global (not tenant-scoped): keyed only by the tracking-line phone number.
-- Safe to run multiple times.

create table if not exists public.housecallpro_lead_sources (
  lead_phone_no text not null,
  lead_source_id text null,
  lead_name text null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone null default now(),
  constraint housecallpro_lead_sources_pkey primary key (lead_phone_no)
) TABLESPACE pg_default;

comment on table public.housecallpro_lead_sources
  is 'Maps an HCP tracking line (lead_source_number = dialed to_number) to its HCP lead source. Used to attribute jobs/customers created by the voice agent.';
comment on column public.housecallpro_lead_sources.lead_phone_no
  is 'The HCP tracking / lead-source phone line the customer dialed (matches the call session to_number).';
comment on column public.housecallpro_lead_sources.lead_source_id
  is 'HCP lead source id for this line, if known.';
comment on column public.housecallpro_lead_sources.lead_name
  is 'Human-readable HCP lead source name (e.g. "Google LSA", "Yelp"). Stamped onto job/customer lead_source.';
