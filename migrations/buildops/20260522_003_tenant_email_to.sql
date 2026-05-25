-- Add email_to array to buildops_tenants so each tenant can configure
-- the list of recipient addresses for job notification emails.
-- sendJobNotification() reads this field and sends to all addresses in the array.

ALTER TABLE buildops_tenants
  ADD COLUMN IF NOT EXISTS email_to text[] NOT NULL DEFAULT '{}';
