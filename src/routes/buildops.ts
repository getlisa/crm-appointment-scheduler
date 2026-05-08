import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin as supabase } from '../lib/supabase.js';

const router = Router();

// ── Admin: register / update a tenant ────────────────────────────────────────

const TenantUpsertSchema = z.object({
  buildops_tenant_id: z.string().min(1),
  company_name: z.string().min(1),
  e164_no: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format, e.g. +15551234567'),
  is_active: z.boolean().optional().default(true),
  business_address: z.record(z.unknown()).optional(),
  billing_address: z.record(z.unknown()).optional(),
  // Resolution table fields
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  access_token: z.string().min(1),
});

router.post('/admin/tenant', async (req, res) => {
  const parsed = TenantUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }

  const d = parsed.data;

  // Upsert into tenants table
  const { error: tenantErr } = await supabase.from('tenants').upsert(
    {
      buildops_tenant_id: d.buildops_tenant_id,
      company_name: d.company_name,
      e164_no: d.e164_no,
      is_active: d.is_active,
      business_address: d.business_address ?? null,
      billing_address: d.billing_address ?? null,
    },
    { onConflict: 'buildops_tenant_id' },
  );

  if (tenantErr) {
    res.status(500).json({ error: tenantErr.message });
    return;
  }

  // Upsert into resolution table
  const { error: resErr } = await supabase
    .from('inbound_no_to_tenant_resolution')
    .upsert(
      {
        no: d.e164_no,
        client_id: d.client_id,
        client_secret: d.client_secret,
        access_token: d.access_token,
        buildops_tenant_id: d.buildops_tenant_id,
      },
      { onConflict: 'no' },
    );

  if (resErr) {
    res.status(500).json({ error: resErr.message });
    return;
  }

  res.json({ ok: true, buildops_tenant_id: d.buildops_tenant_id });
});

// ── Admin: list tenants (no secrets) ─────────────────────────────────────────

router.get('/admin/tenants', async (_req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, buildops_tenant_id, company_name, e164_no, is_active, created_at')
    .order('company_name');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ tenants: data });
});

export default router;
