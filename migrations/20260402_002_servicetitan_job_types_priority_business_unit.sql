-- Job type fields for resolve-job-type (priority + first business unit id from ServiceTitan API).

alter table public.servicetitan_job_types
  add column if not exists priority text null;

alter table public.servicetitan_job_types
  add column if not exists business_unit_id bigint null;

create index if not exists idx_st_job_types_tenant_business_unit
  on public.servicetitan_job_types (tenant_id, business_unit_id);
