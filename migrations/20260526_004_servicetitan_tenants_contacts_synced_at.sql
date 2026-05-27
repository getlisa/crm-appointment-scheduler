-- Separate watermark for contacts sync so it doesn't share last_sync_at.
-- Safe to run multiple times.

alter table public.servicetitan_tenants
  add column if not exists contacts_synced_at timestamptz null;
