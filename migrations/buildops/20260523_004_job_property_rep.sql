-- Track the property representative associated with each job.
-- property_rep_name: full name of the rep (set at job creation if caller is a known property rep,
--                    or after add_representative if the caller opts in during the call).
-- property_rep_id:   Supabase UUID from buildops_representatives (nullable — not set when caller
--                    is unrecognised at creation time and does not opt in).

ALTER TABLE buildops_jobs
  ADD COLUMN IF NOT EXISTS property_rep_name text,
  ADD COLUMN IF NOT EXISTS property_rep_id   text;
