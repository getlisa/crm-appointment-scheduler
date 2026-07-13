-- Add tenant company address columns to buildops_tenants.
-- These are used as the top-right address block on generated invoice PDFs.
-- Populate via Supabase dashboard or SQL:
--   UPDATE buildops_tenants SET
--     company_name      = 'Crockett Facilities',
--     company_address   = '4438 Lottsford Vista Rd',
--     company_city_state= 'Lanham, MD 20706',
--     company_phone     = '3012622771'
--   WHERE buildops_tenant_id = '<your-tenant-uuid>';

ALTER TABLE buildops_tenants
  ADD COLUMN IF NOT EXISTS company_name       TEXT,
  ADD COLUMN IF NOT EXISTS company_address    TEXT,
  ADD COLUMN IF NOT EXISTS company_city_state TEXT,
  ADD COLUMN IF NOT EXISTS company_phone      TEXT;

COMMENT ON COLUMN buildops_tenants.company_name
  IS 'Tenant company display name shown in invoice PDF header (left side / fallback when no logo)';
COMMENT ON COLUMN buildops_tenants.company_address
  IS 'Street address shown top-right on invoice PDFs (e.g. "4438 Lottsford Vista Rd")';
COMMENT ON COLUMN buildops_tenants.company_city_state
  IS 'City, State ZIP shown top-right on invoice PDFs (e.g. "Lanham, MD 20706")';
COMMENT ON COLUMN buildops_tenants.company_phone
  IS 'Phone number shown top-right on invoice PDFs (digits only, formatted on output)';
