-- Add representative_ids array to buildops_properties so each property tracks
-- which BuildOps rep IDs are associated with it. Used by call_inbound to pre-select
-- a property when the caller is a known rep for that property.

ALTER TABLE buildops_properties
  ADD COLUMN IF NOT EXISTS representative_ids text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_buildops_properties_rep_ids
  ON buildops_properties USING GIN (representative_ids);
