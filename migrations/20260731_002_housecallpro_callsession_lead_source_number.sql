-- HouseCall Pro call-session lead-source tracking line.
--
-- The real HCP tracking line the customer dialed, parsed from the SIP Diversion
-- header (exposed by Retell as the {{diversion}} dynamic variable). This is
-- DISTINCT from to_number, which is the shared Twilio DID that every tracking
-- line forwards through and therefore cannot distinguish lead sources.
--
-- book_job / create_customer resolve the lead source from this column first
-- (falling back to to_number, then 'Clara') via housecallpro_lead_sources.
--
-- Safe to run multiple times.

alter table public.housecallpro_callsessions
  add column if not exists lead_source_number text;

comment on column public.housecallpro_callsessions.lead_source_number
  is 'Tracking line parsed from the SIP Diversion header ({{diversion}}); used for lead-source attribution instead of to_number (the shared DID).';
