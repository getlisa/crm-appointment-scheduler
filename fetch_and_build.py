#!/usr/bin/env python3
"""
Fetch BuildOps invoice + job + project, resolve customer/property from Supabase,
then generate an invoice PDF.

Usage:
    python fetch_and_build.py <invoiceId>

Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env in the project root.
Fetches access_token + buildops_tenant_id + company details from buildops_tenants.
Customer name from buildops_customers, property from buildops_properties.

If there are multiple tenant rows, set BUILDOPS_TENANT_ID env var to filter.
"""

import sys
import os
import requests
from datetime import datetime, timezone
from pathlib import Path

BUILDOPS_API = "https://public-api.live.buildops.com/v1"


# ── .env loader ───────────────────────────────────────────────────────────────

def load_dotenv(path):
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key not in os.environ:
            os.environ[key] = val


# ── Supabase helpers ──────────────────────────────────────────────────────────

def _sb_get(supabase_url, service_role_key, table, params):
    resp = requests.get(
        f"{supabase_url}/rest/v1/{table}",
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Accept": "application/json",
        },
        params=params,
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_tenant_creds(supabase_url, key, tenant_id_filter=None):
    params = {"select": "*"}
    if tenant_id_filter:
        params["buildops_tenant_id"] = f"eq.{tenant_id_filter}"
    rows = _sb_get(supabase_url, key, "buildops_tenants", params)
    if not rows:
        raise RuntimeError("No rows in buildops_tenants")
    if len(rows) > 1:
        ids = [r["buildops_tenant_id"] for r in rows]
        raise RuntimeError(f"Multiple tenants: {ids}\nSet BUILDOPS_TENANT_ID to pick one.")
    return rows[0]


def fetch_customer_name(supabase_url, key, buildops_customer_id, tenant_id):
    if not buildops_customer_id:
        print("  [customer] no buildops_customer_id — skipping lookup")
        return ""
    print(f"  [customer] querying buildops_customers for buildops_customer_id={buildops_customer_id!r}")
    # Try with tenant filter first
    rows = _sb_get(supabase_url, key, "buildops_customers", {
        "select": "name",
        "buildops_customer_id": f"eq.{buildops_customer_id}",
        "tenant_id": f"eq.{tenant_id}",
        "limit": "1",
    })
    if not rows:
        print(f"  [customer] not found with tenant_id filter — retrying without")
        rows = _sb_get(supabase_url, key, "buildops_customers", {
            "select": "name",
            "buildops_customer_id": f"eq.{buildops_customer_id}",
            "limit": "1",
        })
    name = rows[0]["name"] if rows else ""
    print(f"  [customer] result: {name!r}")
    return name


def fetch_property(supabase_url, key, property_id):
    if not property_id:
        print("  [property] no property_id — skipping lookup")
        return {}
    print(f"  [property] querying buildops_properties for id={property_id!r}")
    rows = _sb_get(supabase_url, key, "buildops_properties", {
        "select": "name,address,customer_id",
        "id": f"eq.{property_id}",
        "limit": "1",
    })
    result = rows[0] if rows else {}
    print(f"  [property] result: name={result.get('name')!r} customer_id={result.get('customer_id')!r}")
    return result


# ── BuildOps API ──────────────────────────────────────────────────────────────

def buildops_get(path, access_token, tenant_id):
    url = f"{BUILDOPS_API}{path}"
    print(f"  GET {url}")
    resp = requests.get(url, headers={
        "Authorization": f"Bearer {access_token}",
        "tenantId": tenant_id,
        "Accept": "application/json",
    }, timeout=10)
    resp.raise_for_status()
    return resp.json()


# ── Formatters ────────────────────────────────────────────────────────────────

def _fmt_date(val):
    if not val and val != 0:
        return ""
    try:
        if isinstance(val, (int, float)):
            # Unix timestamp — seconds if < 1e11, else milliseconds
            ts = val / 1000 if val > 1e11 else val
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        else:
            s = str(val).strip()
            try:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            except ValueError:
                # BuildOps returns Unix timestamps as numeric strings (e.g. "1780318478")
                numeric = float(s)
                ts = numeric / 1000 if numeric > 1e11 else numeric
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        return f"{dt.strftime('%b')} {dt.day}, {dt.year}"
    except Exception:
        return str(val)


def _fmt_money(val):
    if val is None:
        return "$0.00"
    try:
        return f"${float(val):,.2f}"
    except Exception:
        return str(val)


# Maps BuildOps API lineItemType values → display section names
_ITEM_TYPE_LABELS = {
    "LaborLineItem":     "Labor",
    "PartsLineItem":     "Parts",
    "MaterialLineItem":  "Materials",
    "EquipmentLineItem": "Equipment",
    "MiscLineItem":      "Miscellaneous",
    "OtherLineItem":     "Other",
}

def _clean_item_type(raw):
    if not raw:
        return "Other"
    return _ITEM_TYPE_LABELS.get(raw, raw.replace("LineItem", "").strip() or "Other")


def _fmt_phone(raw):
    if not raw:
        return ""
    digits = "".join(c for c in str(raw) if c.isdigit())
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    if len(digits) == 11 and digits[0] == "1":
        return f"({digits[1:4]}) {digits[4:7]}-{digits[7:]}"
    return str(raw)


# ── Fetch + parse ─────────────────────────────────────────────────────────────

def fetch_and_parse(invoice_id, access_token, tenant_id, supabase_url, sb_key, tenant_row):
    inv = buildops_get(f"/invoices/{invoice_id}", access_token, tenant_id)

    job = {}
    if inv.get("jobId"):
        job = buildops_get(f"/jobs/{inv['jobId']}", access_token, tenant_id)

    proj = {}
    if inv.get("projectId"):
        proj = buildops_get(f"/projects/{inv['projectId']}", access_token, tenant_id)

    # ── Supabase lookups ──────────────────────────────────────────────────────
    print(f"  [ids] inv.customerPropertyId={inv.get('customerPropertyId')!r}  job.customerPropertyId={job.get('customerPropertyId')!r}")
    print(f"  [ids] job.customerName={job.get('customerName')!r}")

    # Fetch property first — its customer_id is the reliable FK to buildops_customers
    property_id = inv.get("customerPropertyId") or job.get("customerPropertyId") or ""
    sb_prop = fetch_property(supabase_url, sb_key, property_id)
    sb_prop_addr = sb_prop.get("address") or {}

    # Resolve customer name: API → property's customer_id → invoice/job customerId
    buildops_customer_id = (
        sb_prop.get("customer_id")
        or inv.get("customerId")
        or job.get("customerId")
        or ""
    )
    customer_name = (
        job.get("customerName")
        or fetch_customer_name(supabase_url, sb_key, buildops_customer_id, tenant_id)
    )

    prop_name = (
        job.get("customerPropertyName")
        or sb_prop.get("name")
        or proj.get("name")
        or inv.get("projectName")
        or ""
    )

    # ── Billing address (from invoice.addresses[]) ────────────────────────────
    billing = next(
        (a for a in (inv.get("addresses") or []) if a.get("addressType") == "billingAddress"),
        {}
    )

    # ── Tenant company details ────────────────────────────────────────────────
    # Debug: show what company/tenant fields the BuildOps invoice API returned
    api_company = {k: v for k, v in inv.items() if v and ("company" in k.lower() or "tenant" in k.lower())}
    print(f"  [company] BuildOps invoice fields: {api_company}")
    print(f"  [company] Supabase tenant_row keys: company_name={tenant_row.get('company_name')!r}  company_address={tenant_row.get('company_address')!r}")
    print(f"  [invoice] paymentTermName={inv.get('paymentTermName')!r}  issuedDate={inv.get('issuedDate')!r}  dueDate={inv.get('dueDate')!r}  tenantCompanyPhone={inv.get('tenantCompanyPhone')!r}  companyPhoneNumber={inv.get('companyPhoneNumber')!r}")

    # Parse business_address ("STREET, CITY, ST ZIP") as fallback when explicit columns are null
    _biz_addr = tenant_row.get("business_address") or tenant_row.get("billing_address") or ""
    _biz_street, _biz_city_st = "", ""
    if _biz_addr and "," in _biz_addr:
        _split = _biz_addr.split(",", 1)
        _biz_street  = _split[0].strip()
        _biz_city_st = _split[1].strip()

    # Priority: invoice API → explicit buildops_tenants columns → parsed business_address → env vars
    company_name    = (
        inv.get("tenantCompanyName")
        or tenant_row.get("company_name", "")
        or os.getenv("COMPANY_NAME", "")
        or ""
    )
    company_addr    = (
        inv.get("tenantCompanyAddress")
        or tenant_row.get("company_address") or ""
        or _biz_street
        or os.getenv("COMPANY_ADDRESS", "")
        or ""
    )
    company_city_st = (
        inv.get("tenantCompanyCityState")
        or tenant_row.get("company_city_state") or ""
        or _biz_city_st
        or os.getenv("COMPANY_CITY_STATE", "")
        or ""
    )
    raw_phone = (
        inv.get("tenantCompanyPhone")
        or inv.get("companyPhoneNumber")
        or tenant_row.get("tenantCompanyPhone")
        or tenant_row.get("company_phone")
        or os.getenv("COMPANY_PHONE", "")
    )
    company_phone = _fmt_phone(raw_phone) or ""

    if not company_addr:
        print("  [company] WARNING: company address is empty. "
              "Set COMPANY_ADDRESS / COMPANY_CITY_STATE / COMPANY_PHONE in .env "
              "or populate the company_* columns in buildops_tenants (run migrations/20260602_001_buildops_tenant_company_address.sql).")

    # ── Financials ────────────────────────────────────────────────────────────
    subtotal    = float(inv.get("subtotal")    or 0)
    discount    = float(inv.get("discount")    or 0)
    total       = float(inv.get("totalAmount") or 0)
    amount_paid = sum(float(p.get("appliedAmount") or 0) for p in (inv.get("payments") or []))
    balance     = total - amount_paid

    # ── Line items ────────────────────────────────────────────────────────────
    items = []
    for li in (inv.get("invoiceItems") or []):
        items.append({
            "lineItemType":   _clean_item_type(li.get("lineItemType")),
            "date":           _fmt_date(li.get("date")),
            "name":           li.get("name") or "",
            "description":    li.get("description") or "",
            "taxable":        "Yes" if li.get("taxable") else "No",
            "hours":          str(li.get("quantity") or ""),
            "rate":           _fmt_money(li.get("unitPrice")),
            "price_subtotal": _fmt_money(li.get("amount")),
        })

    return {
        "OUTPUT_FILENAME":         f"Invoice{inv.get('invoiceNumber', '')}.pdf",
        "INVOICE_NUMBER":          str(inv.get("invoiceNumber") or ""),
        "INVOICE_ISSUED_DATE":     _fmt_date(inv.get("issuedDate")),
        "INVOICE_DUE_DATE":        _fmt_date(inv.get("dueDate")),
        "INVOICE_STATUS":          inv.get("status") or "",
        "PAYMENT_TERM_NAME":       inv.get("paymentTermName") or "",
        "SERVICE_AGREEMENT_ID":    (
            inv.get("serviceAgreementNumber")
            or inv.get("serviceAgreementName")
            or inv.get("serviceAgreementId")
            or ""
        ),
        "TOTAL_AMOUNT":            _fmt_money(total),
        "SUBTOTAL":                _fmt_money(subtotal),
        "SERVICE_FEES":            "$0.00",
        "DISCOUNT":                _fmt_money(discount),
        "SUBTOTAL_AFTER_DISCOUNT": _fmt_money(subtotal - discount),
        "TAXABLE_SUBTOTAL":        _fmt_money(inv.get("taxableSubtotal")),
        "SALES_TAX_RATE":          f"{float(inv.get('salesTaxRate') or 0):.2f}%",
        "TAX_AMOUNT":              _fmt_money(inv.get("taxAmount")),
        "AMOUNT_PAID":             _fmt_money(amount_paid),
        "BALANCE_DUE":             _fmt_money(balance),
        "NOTE":                    inv.get("note") or "",
        "TERMS_OF_SERVICE":        inv.get("termsOfService") or "",
        "AUTHORIZED_BY":           inv.get("authorizedBy") or "",
        "CUSTOMER_PROVIDED_PO":    inv.get("customerProvidedPONumber") or "",
        "CUSTOMER_WO_NUMBER":      inv.get("customerProvidedWONumber") or "",
        "NTE_AMOUNT":              _fmt_money(inv.get("amountNotToExceed")) if inv.get("amountNotToExceed") else "",
        "INVOICE_SUMMARY":         inv.get("summary") or "",
        # billing address
        "BILL_TO_NAME":            billing.get("billTo") or "",
        "BILL_TO_ADDRESS_LINE1":   billing.get("addressLine1") or "",
        "BILL_TO_CITY":            billing.get("city") or "",
        "BILL_TO_STATE":           billing.get("state") or "",
        "BILL_TO_ZIP":             billing.get("zipcode") or "",
        # tenant company
        "TENANT_COMPANY_NAME":     company_name,
        "TENANT_COMPANY_ADDRESS":  company_addr,
        "TENANT_COMPANY_CITY_ST":  company_city_st,
        "TENANT_COMPANY_PHONE":    company_phone,
        "TENANT_LOGO_URL":         inv.get("tenantCompanyLogoUrl") or "",
        # job — resolved from Supabase if API returns empty
        "JOB_CUSTOMER_NAME":       customer_name,
        "JOB_CUSTOMER_PROP_NAME":  prop_name,
        "JOB_STATUS":              job.get("status") or "",
        "JOB_NUMBER":              job.get("jobNumber") or inv.get("jobNumber") or "",
        # property address — prefer Supabase (address JSONB) over project fields
        "PROJECT_NAME":            prop_name,
        "PROPERTY_ADDRESS_LINE1":  sb_prop_addr.get("line1") or proj.get("address1") or "",
        "PROPERTY_CITY":           sb_prop_addr.get("city")  or proj.get("addressCity") or "",
        "PROPERTY_STATE":          sb_prop_addr.get("state") or proj.get("addressState") or "",
        "PROPERTY_ZIP":            sb_prop_addr.get("zip")   or proj.get("addressPostal") or "",
        # line items
        "INVOICE_ITEMS":           items,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    load_dotenv(Path(__file__).parent / ".env")

    supabase_url     = os.getenv("SUPABASE_URL", "")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    tenant_filter    = os.getenv("BUILDOPS_TENANT_ID", "")

    if not supabase_url:
        print("Error: SUPABASE_URL not set"); sys.exit(1)
    if not service_role_key:
        print("Error: SUPABASE_SERVICE_ROLE_KEY not set"); sys.exit(1)
    if len(sys.argv) < 2:
        print("Usage: python fetch_and_build.py <invoiceId>"); sys.exit(1)

    invoice_id = sys.argv[1]

    print("Fetching credentials from buildops_tenants...")
    tenant_row = fetch_tenant_creds(supabase_url, service_role_key, tenant_filter or None)
    access_token     = tenant_row["access_token"]
    buildops_tenant_id = tenant_row["buildops_tenant_id"]
    print(f"  tenant: {buildops_tenant_id}")

    print(f"Fetching invoice {invoice_id}...")
    data = fetch_and_parse(
        invoice_id, access_token, buildops_tenant_id,
        supabase_url, service_role_key, tenant_row
    )

    import pdf_creation as pc
    for key, val in data.items():
        setattr(pc, key, val)

    pc.build_pdf()


if __name__ == "__main__":
    main()
