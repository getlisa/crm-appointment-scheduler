# Invoice PDF Generation — Changes & Notes

Reference doc for the BuildOps invoice PDF generation work done on the `buildops_integration` branch.

---

## Files Touched

| File | What changed |
|---|---|
| `pdf_creation.py` | Layout fixes: grey lines, dynamic invoice box rows |
| `fetch_and_build.py` | Data resolution fixes: dates, phone, address, conditional fields |
| `migrations/20260602_001_buildops_tenant_company_address.sql` | New migration for tenant address columns |
| `.env.example` | Added PDF-specific env var defaults |

---

## `pdf_creation.py` Changes

### 1. Grey lines (was black)
Three lines that were `colors.black` changed to `colors.HexColor("#aaaaaa")` to match the original invoice design:
- Inner divider inside the invoice box (above "Total Due")
- Line above "Total" in the totals block
- Line above "Balance" in the totals block

The outer BOX border of the invoice info block stays black.

### 2. Dynamic invoice box rows
`Service Agreement` and `Payment Terms` rows are now conditionally rendered — they are omitted entirely when their values are empty/null.

Previously they always rendered (showing blank values). Now:
- If `SERVICE_AGREEMENT_ID` is falsy → row is skipped
- If `PAYMENT_TERM_NAME` is falsy → row is skipped

The `LINEABOVE` divider index is computed dynamically (`_divider_row`) so spacing stays correct regardless of which rows are present.

---

## `fetch_and_build.py` Changes

### 1. Unix timestamp strings in dates
BuildOps API returns `issuedDate` and `dueDate` as **numeric strings** (e.g. `"1780318478"`), not ISO dates or integers. The old `_fmt_date` called `fromisoformat` on these, which failed silently and returned the raw number string.

Fix: after `fromisoformat` raises `ValueError`, try parsing as a float Unix timestamp (seconds if `< 1e11`, milliseconds otherwise).

### 2. Tenant company address from `business_address`
The `tenantCompanyAddress` and `tenantCompanyCityState` fields are not returned by the BuildOps invoice API. The `buildops_tenants` table has a `business_address` column (`"4438 Lottsford Vista Rd, Lanham, MD 20706"`) which is parsed by splitting on the first comma:
- Before comma → street line
- After comma → city/state/zip line

Fallback priority for address:
1. API field (`tenantCompanyAddress`)
2. Explicit Supabase columns (`company_address`, `company_city_state`) added by migration
3. Parsed from `business_address` / `billing_address` in `buildops_tenants`
4. Env vars (`COMPANY_ADDRESS`, `COMPANY_CITY_STATE`)

### 3. Phone number resolution
`tenantCompanyPhone` is null in all tested invoice API responses. A `tenantCompanyPhone` column was added directly to `buildops_tenants` with the correct value (`3012622771`).

Fallback priority for phone:
1. `inv.get("tenantCompanyPhone")` — API invoice field
2. `inv.get("companyPhoneNumber")` — alternate API field name
3. `tenant_row.get("tenantCompanyPhone")` — **Supabase `buildops_tenants` column** ← resolves here
4. `tenant_row.get("company_phone")` — migration column fallback
5. `COMPANY_PHONE` env var

### 4. `paymentTermName` behaviour
The API **does** return `paymentTermName` on live/recent invoices. However for older closed invoices, BuildOps clears this field server-side after close — so the live API returns `null` even though the value existed at creation time (visible in `raw_payload` snapshots in Supabase). The script reads it directly from `inv.get("paymentTermName")`. When null, the row is hidden (see dynamic invoice box above).

> Note: `buildops_invoices` is a separate Supabase project used only for reference/debugging — the script does not read from it.

### 5. Debug print added
A single debug line prints raw API values for key fields on every run:
```
[invoice] paymentTermName=...  issuedDate=...  dueDate=...  tenantCompanyPhone=...  companyPhoneNumber=...
```

---

## Migration: `20260602_001_buildops_tenant_company_address.sql`

Adds four optional columns to `buildops_tenants`:

```sql
company_name       TEXT
company_address    TEXT
company_city_state TEXT
company_phone      TEXT
```

These are the explicit per-column fallbacks in the address/phone resolution chain above. In practice the `business_address` parse and `tenantCompanyPhone` column cover the current tenant without needing these populated.

To populate manually:
```sql
UPDATE buildops_tenants SET
  company_name       = 'Crockett Facilities',
  company_address    = '4438 Lottsford Vista Rd',
  company_city_state = 'Lanham, MD 20706',
  company_phone      = '3012622771'
WHERE buildops_tenant_id = '<tenant-uuid>';
```

---

## `.env.example` Additions

```env
COMPANY_NAME=Crockett Facilities
COMPANY_ADDRESS=4438 Lottsford Vista Rd
COMPANY_CITY_STATE=Lanham, MD 20706
COMPANY_PHONE=3012622771
```

These are last-resort fallbacks only. If `buildops_tenants` has `business_address` and `tenantCompanyPhone` populated, env vars are not needed.

---

## Data Sources Summary

| PDF field | Primary source |
|---|---|
| Invoice number, dates, totals, line items | `GET /v1/invoices/{id}` |
| `paymentTermName` | `GET /v1/invoices/{id}` — null on old closed invoices |
| Service Agreement | `GET /v1/invoices/{id}` → `serviceAgreementNumber` / `serviceAgreementName` / `serviceAgreementId` |
| Bill-To address | `invoice.addresses[]` where `addressType == "billingAddress"` |
| Customer name | `GET /v1/jobs/{jobId}` → `customerName`, fallback to Supabase `buildops_customers` |
| Property name + address | Supabase `buildops_properties` (primary), fallback to `GET /v1/projects/{projectId}` |
| Tenant company address | Supabase `buildops_tenants.business_address` (parsed) |
| Tenant company phone | Supabase `buildops_tenants.tenantCompanyPhone` |
| Tenant logo | `invoice.tenantCompanyLogoUrl`, fallback to `public/crockett_image.png` |
