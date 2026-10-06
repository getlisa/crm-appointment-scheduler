-- Resolve the HCP lead source once per call, at call start.
--
-- `lead_source_number` (the dialed tracking line) is captured at call_started.
-- Turning it into a lead-source NAME was repeated by four handlers, each hitting
-- housecallpro_lead_sources again mid-call. The name is now resolved once when
-- the session is created or its tracking line changes, and stored here.
--
-- Null means the line resolved to nothing. That is what tells customer_lookup to
-- return ask_lead_source: true, so Clara asks the caller instead.
--
-- Safe to run multiple times.

alter table public.housecallpro_callsessions
  add column if not exists lead_source_name text null;

comment on column public.housecallpro_callsessions.lead_source_name
  is 'HCP lead source name resolved from lead_source_number at call start. Null when the dialed line maps to nothing.';
