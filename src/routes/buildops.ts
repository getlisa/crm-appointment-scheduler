import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin as supabase } from '../lib/supabase.js';

const router = Router();

// ── Admin: register / update a tenant ────────────────────────────────────────

const TenantUpsertSchema = z.object({
  no: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format, e.g. +15551234567'),
  buildops_tenant_id: z.string().min(1),
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

  const { error } = await supabase
    .from('buildops_tenants')
    .upsert(
      {
        no: d.no,
        buildops_tenant_id: d.buildops_tenant_id,
        client_id: d.client_id,
        client_secret: d.client_secret,
        access_token: d.access_token,
      },
      { onConflict: 'no' },
    );

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ ok: true, no: d.no, buildops_tenant_id: d.buildops_tenant_id });
});

// ── Admin: list tenants (no secrets) ─────────────────────────────────────────

router.get('/admin/tenants', async (_req, res) => {
  const { data, error } = await supabase
    .from('buildops_tenants')
    .select('no, buildops_tenant_id')
    .order('no');

  if (error) {
    console.error('error:', error);
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ tenants: data });
});

export default router;
