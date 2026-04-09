-- Add tenant-scoped campaign ID and fallback technician ID
-- (previously global env vars: SERVICETITAN_CAMPAIGN_ID, SERVICETITAN_FALLBACK_TECHNICIAN_ID)

ALTER TABLE servicetitan_tenants
  ADD COLUMN IF NOT EXISTS campaign_id TEXT,
  ADD COLUMN IF NOT EXISTS fallback_technician_id BIGINT;

COMMENT ON COLUMN servicetitan_tenants.campaign_id
  IS 'ServiceTitan campaign ID used when booking jobs for this tenant';
COMMENT ON COLUMN servicetitan_tenants.fallback_technician_id
  IS 'Last-resort technician ID used when skill matching finds no candidates for this tenant';
