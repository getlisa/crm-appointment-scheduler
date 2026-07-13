-- Add email column to servicetitan_customers.
-- Safe to run multiple times.

alter table public.servicetitan_customers
  add column if not exists email text null;
