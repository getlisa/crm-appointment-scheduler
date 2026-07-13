#!/usr/bin/env python3
"""
BuildOps Invoice PDF Generator
Replicates the exact layout of Invoice 6715 (Crockett Facilities style).

All placeholder variables at the top — populate them from:
  - GET /v1/invoices/{invoiceId}
  - GET /v1/jobs/{jobId}
  - GET /v1/projects/{projectId}

Install dependencies:
    pip install reportlab pillow requests
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable, Image
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_RIGHT, TA_LEFT, TA_CENTER
from reportlab.platypus.flowables import KeepTogether
import os

# =============================================================================
# ██████╗ ██╗      █████╗  ██████╗███████╗██╗  ██╗ ██████╗ ██╗     ██████╗ ███████╗██████╗ ███████╗
# ██╔══██╗██║     ██╔══██╗██╔════╝██╔════╝██║  ██║██╔═══██╗██║     ██╔══██╗██╔════╝██╔══██╗██╔════╝
# ██████╔╝██║     ███████║██║     █████╗  ███████║██║   ██║██║     ██║  ██║█████╗  ██████╔╝███████╗
# ██╔═══╝ ██║     ██╔══██║██║     ██╔══╝  ██╔══██║██║   ██║██║     ██║  ██║██╔══╝  ██╔══██╗╚════██║
# ██║     ███████╗██║  ██║╚██████╗███████╗██║  ██║╚██████╔╝███████╗██████╔╝███████╗██║  ██║███████║
# =============================================================================
# Populate these from your API calls before generating the PDF.

# --- FROM GET /v1/invoices/{invoiceId} ---
INVOICE_NUMBER          = "{{invoiceNumber}}"              # e.g. "6715"
INVOICE_ISSUED_DATE     = "{{issuedDate}}"                 # e.g. "Jun 1, 2026"
INVOICE_DUE_DATE        = "{{dueDate}}"                    # e.g. "Jul 1, 2026"
INVOICE_STATUS          = "{{status}}"                     # e.g. "posted"
PAYMENT_TERM_NAME       = "{{paymentTermName}}"            # e.g. "Net 30"
SERVICE_AGREEMENT_ID    = "{{serviceAgreementId}}"         # e.g. "2-CIM5001PM-1"
TOTAL_AMOUNT            = "{{totalAmount}}"                # e.g. "$891.67"
SUBTOTAL                = "{{subtotal}}"                   # e.g. "$891.67"
SERVICE_FEES            = "{{serviceFees}}"                # e.g. "$0.00"  (custom field or 0)
DISCOUNT                = "{{discount}}"                   # e.g. "$0.00"
SUBTOTAL_AFTER_DISCOUNT = "{{subtotalAfterDiscount}}"      # e.g. "$891.67"
TAXABLE_SUBTOTAL        = "{{taxableSubtotal}}"            # e.g. "$0.00"
SALES_TAX_RATE          = "{{salesTaxRate}}"               # e.g. "$0.00" (or "9.25%")
TAX_AMOUNT              = "{{taxAmount}}"                  # e.g. "$0.00"
AMOUNT_PAID             = "{{amountPaid}}"                 # computed from payments[].appliedAmount
BALANCE_DUE             = "{{balanceDue}}"                 # e.g. "$891.67"
NOTE                    = "{{note}}"                       # e.g. "" or invoice note
TERMS_OF_SERVICE        = "{{termsOfService}}"             # e.g. "A 3% service charge..."
AUTHORIZED_BY           = "{{authorizedBy}}"               # e.g. ""
CUSTOMER_PROVIDED_PO    = "{{customerProvidedPONumber}}"   # e.g. ""
CUSTOMER_WO_NUMBER      = "{{customerProvidedWONumber}}"   # e.g. ""
NTE_AMOUNT              = "{{amountNotToExceed}}"          # e.g. ""
INVOICE_SUMMARY         = "{{summary}}"                    # e.g. "Service Agreement: 2-CIM5001PM-1 - CIM/Ashlawn - 4921 Seminary Rd"

# Bill-To Address — from invoice.addresses[] where addressType == "billingAddress"
BILL_TO_NAME            = "{{billTo}}"                     # e.g. "CIM/Ashlawn - 4921 Seminary Rd"
BILL_TO_ADDRESS_LINE1   = "{{billToAddressLine1}}"         # e.g. "4921 Seminary Road"
BILL_TO_CITY            = "{{billToCity}}"                 # e.g. "Alexandria"
BILL_TO_STATE           = "{{billToState}}"                # e.g. "VA"
BILL_TO_ZIP             = "{{billToZipcode}}"              # e.g. "22311"

# Tenant (Service Company) — from invoice top-level fields
TENANT_COMPANY_NAME     = "{{tenantCompanyName}}"          # e.g. "Crockett Facilities"
TENANT_COMPANY_ADDRESS  = "{{tenantCompanyAddress}}"       # e.g. "4438 Lottsford Vista Rd"
TENANT_COMPANY_CITY_ST  = "{{tenantCompanyCityState}}"     # e.g. "Lanham, MD 20706"
TENANT_COMPANY_PHONE    = "{{tenantCompanyPhone}}"         # e.g. "3012622771"
TENANT_LOGO_URL         = "{{tenantCompanyLogoUrl}}"       # path or URL to logo image

# Invoice Line Items — from invoice.invoiceItems[]
# Each dict maps to one row in the line items table.
# lineItemType groups them under sections: "Labor", "Parts", etc.
INVOICE_ITEMS = [
    {
        "lineItemType":  "{{lineItemType}}",        # e.g. "Labor"
        "date":          "{{itemDate}}",             # e.g. "" (often blank for PM)
        "name":          "{{itemName}}",             # e.g. "Preventive Maintenance Agreement"
        "description":   "{{itemDescription}}",     # e.g. "Revenue PM Agreement"
        "taxable":       "{{itemTaxable}}",          # e.g. "No"
        "hours":         "{{itemQuantity}}",         # e.g. "1"
        "rate":          "{{itemUnitPrice}}",        # e.g. "$891.67"
        "price_subtotal":"{{itemAmount}}",           # e.g. "$891.67"
    }
    # Add more items as needed — they will be grouped by lineItemType automatically
]

# --- FROM GET /v1/jobs/{jobId} (via invoice.jobId) ---
JOB_CUSTOMER_NAME       = "{{customerName}}"               # e.g. "c/o CIM Management, Inc. Ashlawn"
JOB_CUSTOMER_PROP_NAME  = "{{customerPropertyName}}"       # e.g. "Ashlawn - 4921 Seminary Road"
JOB_STATUS              = "{{jobStatus}}"                  # e.g. "Complete"
JOB_NUMBER              = "{{jobNumber}}"                  # e.g. "SA1001-229"

# --- FROM GET /v1/projects/{projectId} (via invoice.projectId) ---
PROJECT_NAME            = "{{projectName}}"                # e.g. "CIM/Ashlawn - 4921 Seminary Rd"
PROPERTY_ADDRESS_LINE1  = "{{projectAddress1}}"            # e.g. "4921 Seminary Road"
PROPERTY_CITY           = "{{projectAddressCity}}"         # e.g. "Alexandria"
PROPERTY_STATE          = "{{projectAddressState}}"        # e.g. "VA"
PROPERTY_ZIP            = "{{projectAddressPostal}}"       # e.g. "22311"

# Output filename
OUTPUT_FILENAME = f"Invoice{INVOICE_NUMBER}.pdf"

# =============================================================================
# PDF GENERATION — do not modify below unless changing layout
# =============================================================================

PAGE_WIDTH, PAGE_HEIGHT = letter
MARGIN = 0.6 * inch

def fmt_address(line1, city, state, zipcode):
    return f"{line1}\n{city}, {state} {zipcode}"

def load_logo(url_or_path):
    """Returns a ReportLab Image or None if logo not available."""
    try:
        if url_or_path.startswith("http"):
            import requests, io
            resp = requests.get(url_or_path, timeout=5)
            return Image(io.BytesIO(resp.content), width=1.5*inch, height=0.6*inch)
        elif os.path.exists(url_or_path):
            return Image(url_or_path, width=1.5*inch, height=0.6*inch)
    except Exception:
        pass
    return None

def build_pdf():
    doc = SimpleDocTemplate(
        OUTPUT_FILENAME,
        pagesize=letter,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=0.4*inch,
        bottomMargin=0.4*inch,
    )

    styles = getSampleStyleSheet()

    # Custom styles
    style_normal      = ParagraphStyle("Normal",     fontSize=9,  leading=13)
    style_small       = ParagraphStyle("Small",      fontSize=8,  leading=11, textColor=colors.HexColor("#555555"))
    style_small_bold  = ParagraphStyle("SmallBold",  fontSize=8,  leading=11, textColor=colors.HexColor("#888888"), fontName="Helvetica-Bold")
    style_right       = ParagraphStyle("Right",      fontSize=9,  leading=13, alignment=TA_RIGHT)
    style_bold        = ParagraphStyle("Bold",       fontSize=9,  leading=13, fontName="Helvetica-Bold")
    style_bold_right  = ParagraphStyle("BoldRight",  fontSize=9,  leading=13, fontName="Helvetica-Bold", alignment=TA_RIGHT)
    style_header      = ParagraphStyle("Header",     fontSize=14, leading=18, fontName="Helvetica-Bold")
    style_section     = ParagraphStyle("Section",    fontSize=10, leading=14, fontName="Helvetica-Bold")
    style_total_lbl   = ParagraphStyle("TotalLbl",   fontSize=11, leading=15, fontName="Helvetica-Bold")
    style_total_val   = ParagraphStyle("TotalVal",   fontSize=11, leading=15, fontName="Helvetica-Bold", alignment=TA_RIGHT)

    story = []

    # ── HEADER: Logo (left) + Company address (right) ────────────────────────
    logo = load_logo(TENANT_LOGO_URL)
    if logo is None:
        logo = load_logo(os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "crockett_image.png"))
    logo_cell = logo if logo else Paragraph(f"<b>{TENANT_COMPANY_NAME}</b>", style_bold)

    addr_lines = "<br/>".join(filter(None, [
        TENANT_COMPANY_ADDRESS,
        TENANT_COMPANY_CITY_ST,
        TENANT_COMPANY_PHONE,
    ]))
    header_data = [[
        logo_cell,
        Paragraph(
            addr_lines,
            ParagraphStyle("AddrRight", fontSize=8, leading=12, alignment=TA_RIGHT)
        )
    ]]
    header_table = Table(header_data, colWidths=[3.5*inch, 3.8*inch])
    header_table.setStyle(TableStyle([
        ("VALIGN",      (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (-1,-1), 0),
        ("RIGHTPADDING",(0,0), (-1,-1), 0),
    ]))
    story.append(header_table)
    story.append(Spacer(1, 0.45*inch))

    # ── BILL TO + INVOICE BOX (side by side) ─────────────────────────────────
    bill_to_block = Paragraph(
        f"<font size=8 color='#888888'>Bill To</font><br/><br/>"
        f"<b>{BILL_TO_NAME}</b><br/>"
        f"{BILL_TO_ADDRESS_LINE1}<br/>"
        f"{BILL_TO_CITY}, {BILL_TO_STATE} {BILL_TO_ZIP}",
        style_normal
    )

    # Right box: invoice meta — Service Agreement and Payment Terms rows omitted when empty
    invoice_box_data = [
        [Paragraph(f"<b>Invoice {INVOICE_NUMBER}</b>", style_header),
         Paragraph(INVOICE_ISSUED_DATE, style_right)],        # row 0 — always present
    ]
    if SERVICE_AGREEMENT_ID:
        invoice_box_data.append([
            Paragraph("Service Agreement", style_normal),
            Paragraph(SERVICE_AGREEMENT_ID, style_right),
        ])
    if PAYMENT_TERM_NAME:
        invoice_box_data.append([
            Paragraph("Payment Terms", style_normal),
            Paragraph(PAYMENT_TERM_NAME, style_right),
        ])
    # divider row index = whatever comes right before Total Due
    _divider_row = len(invoice_box_data)
    invoice_box_data += [
        [Paragraph("<b>Total Due</b>", style_total_lbl),
         Paragraph(f"<b>{TOTAL_AMOUNT}</b>", style_total_val)],
        [Paragraph("<b>Due Date</b>", style_bold),
         Paragraph(INVOICE_DUE_DATE, style_bold_right)],
    ]
    invoice_box_table = Table(invoice_box_data, colWidths=[2.0*inch, 1.8*inch])
    invoice_box_table.setStyle(TableStyle([
        ("BOX",          (0,0), (-1,-1), 1, colors.black),
        ("LINEABOVE",    (0,_divider_row), (-1,_divider_row), 0.5, colors.HexColor("#aaaaaa")),
        ("TOPPADDING",   (0,0), (-1,-1), 5),
        ("BOTTOMPADDING",(0,0), (-1,-1), 5),
        ("BOTTOMPADDING",(0,_divider_row-1), (-1,_divider_row-1), 12),  # extra space before dividing line
        ("TOPPADDING",   (0,_divider_row), (-1,_divider_row), 8),
        ("LEFTPADDING",  (0,0), (-1,-1), 8),
        ("RIGHTPADDING", (0,0), (-1,-1), 8),
        ("VALIGN",       (0,0), (-1,-1), "MIDDLE"),
    ]))

    billing_invoice_row = Table(
        [[bill_to_block, invoice_box_table]],
        colWidths=[3.5*inch, 3.8*inch]
    )
    billing_invoice_row.setStyle(TableStyle([
        ("VALIGN",      (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (0,-1), 0.15*inch),  # slight indent on Bill To block
        ("LEFTPADDING", (1,0), (1,-1), 0),
        ("RIGHTPADDING",(0,0), (-1,-1), 0),
        ("TOPPADDING",  (0,0), (-1,-1), 0),
        ("BOTTOMPADDING",(0,0),(-1,-1), 0),
    ]))
    story.append(billing_invoice_row)
    story.append(Spacer(1, 0.15*inch))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#cccccc")))
    story.append(Spacer(1, 0.10*inch))

    # ── CUSTOMER / PROPERTY / ADDRESS ROW ────────────────────────────────────
    meta_data = [[
        [Paragraph("CUSTOMER NAME", style_small_bold),
         Paragraph(JOB_CUSTOMER_NAME, style_normal)],
        [Paragraph("PROPERTY NAME", style_small_bold),
         Paragraph(JOB_CUSTOMER_PROP_NAME, style_normal)],
        [Paragraph("PROPERTY ADDRESS", style_small_bold),
         Paragraph(
             f"{PROPERTY_ADDRESS_LINE1}<br/>{PROPERTY_CITY}, {PROPERTY_STATE} {PROPERTY_ZIP}",
             style_normal
         )],
    ]]

    def label_value_cell(label, value):
        return Table(
            [[Paragraph(label, style_small_bold)],
             [Paragraph(value, style_normal)]],
            colWidths=[2.3*inch]
        )

    meta_row = Table([[
        label_value_cell("CUSTOMER NAME",    JOB_CUSTOMER_NAME),
        label_value_cell("PROPERTY NAME",    JOB_CUSTOMER_PROP_NAME),
        label_value_cell("PROPERTY ADDRESS",
            f"{PROPERTY_ADDRESS_LINE1}\n{PROPERTY_CITY}, {PROPERTY_STATE} {PROPERTY_ZIP}"),
    ]], colWidths=[2.4*inch, 2.4*inch, 2.5*inch])
    meta_row.setStyle(TableStyle([
        ("VALIGN",      (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (-1,-1), 0),
        ("RIGHTPADDING",(0,0), (-1,-1), 4),
        ("TOPPADDING",  (0,0), (-1,-1), 0),
    ]))
    story.append(meta_row)
    story.append(Spacer(1, 0.12*inch))

    auth_nte_row = Table([[
        label_value_cell("AUTHORIZED BY",  AUTHORIZED_BY),
        label_value_cell("CUSTOMER WO",    CUSTOMER_WO_NUMBER),
        label_value_cell("NTE",            NTE_AMOUNT),
    ]], colWidths=[2.4*inch, 2.4*inch, 2.5*inch])
    auth_nte_row.setStyle(TableStyle([
        ("VALIGN",      (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (-1,-1), 0),
        ("RIGHTPADDING",(0,0), (-1,-1), 4),
        ("TOPPADDING",  (0,0), (-1,-1), 0),
    ]))
    story.append(auth_nte_row)
    story.append(Spacer(1, 0.12*inch))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#cccccc")))
    story.append(Spacer(1, 0.10*inch))

    # ── INVOICE SUMMARY ───────────────────────────────────────────────────────
    story.append(Paragraph("<b>Invoice Summary</b>", style_section))
    story.append(Paragraph(INVOICE_SUMMARY, style_normal))
    story.append(Spacer(1, 0.12*inch))

    # ── LINE ITEMS (grouped by lineItemType) ──────────────────────────────────
    from itertools import groupby

    def group_items(items):
        groups = {}
        for item in items:
            key = item.get("lineItemType", "Other")
            groups.setdefault(key, []).append(item)
        return groups

    grouped = group_items(INVOICE_ITEMS)

    col_widths = [0.7*inch, 1.5*inch, 2.1*inch, 0.65*inch, 0.55*inch, 0.75*inch, 1.05*inch]
    header_row = [
        Paragraph("Date",            style_small_bold),
        Paragraph("Labor Name",      style_small_bold),
        Paragraph("Description",     style_small_bold),
        Paragraph("Taxable",         style_small_bold),
        Paragraph("Hours",           style_small_bold),
        Paragraph("Rate",            ParagraphStyle("RH", fontSize=8, fontName="Helvetica-Bold", alignment=TA_RIGHT)),
        Paragraph("Price Subtotal",  ParagraphStyle("PSH",fontSize=8, fontName="Helvetica-Bold", alignment=TA_RIGHT)),
    ]

    for section_name, items in grouped.items():
        story.append(Paragraph(f"<b>{section_name}</b>", style_section))
        story.append(Spacer(1, 0.05*inch))

        table_data = [header_row]
        total_hours = 0

        for item in items:
            try:
                total_hours += float(str(item.get("hours","0")).replace("{{","").replace("}}","") or 0)
            except Exception:
                pass

            table_data.append([
                Paragraph(item.get("date", ""),        style_small),
                Paragraph(f"<b>{item.get('name','')}</b>", style_bold),
                Paragraph(item.get("description", ""), style_small),
                Paragraph(item.get("taxable", ""),     style_small),
                Paragraph(item.get("hours", ""),       style_small),
                Paragraph(item.get("rate", ""),        ParagraphStyle("RV", fontSize=9, alignment=TA_RIGHT)),
                Paragraph(item.get("price_subtotal",""), ParagraphStyle("PSV",fontSize=9, alignment=TA_RIGHT)),
            ])

        # Subtotal row for section — display whole hours as int (no trailing .0)
        hours_disp = str(int(total_hours)) if total_hours and total_hours == int(total_hours) else (str(total_hours) if total_hours else "")
        table_data.append([
            "", "", "", "",
            Paragraph(f"<b>{hours_disp}</b>",
                      ParagraphStyle("TH", fontSize=9, fontName="Helvetica-Bold")),
            "",
            Paragraph(f"<b>{items[-1].get('price_subtotal','')}</b>",
                      ParagraphStyle("TS", fontSize=9, fontName="Helvetica-Bold", alignment=TA_RIGHT)),
        ])

        line_table = Table(table_data, colWidths=col_widths, repeatRows=1)
        line_table.setStyle(TableStyle([
            ("FONTNAME",     (0,0), (-1,0),  "Helvetica-Bold"),
            ("FONTSIZE",     (0,0), (-1,-1), 9),
            ("LINEBELOW",    (0,0), (-1,0),  0.5, colors.HexColor("#cccccc")),
            ("LINEBELOW",    (0,-2),(-1,-2), 0.5, colors.HexColor("#cccccc")),
            ("LINEBELOW",    (0,-1),(-1,-1), 0.5, colors.HexColor("#cccccc")),
            ("VALIGN",       (0,0), (-1,-1), "TOP"),
            ("TOPPADDING",   (0,0), (-1,-1), 4),
            ("BOTTOMPADDING",(0,0), (-1,-1), 4),
            ("LEFTPADDING",  (0,0), (-1,-1), 2),
            ("RIGHTPADDING", (0,0), (-1,-1), 2),
            ("ROWBACKGROUNDS",(0,1),(-1,-2), [colors.white, colors.HexColor("#f9f9f9")]),
        ]))
        story.append(line_table)
        story.append(Spacer(1, 0.12*inch))

    # ── TOTALS BLOCK ──────────────────────────────────────────────────────────
    def totals_row(label, value, bold=False):
        lbl_style = ParagraphStyle("TL", fontSize=9, alignment=TA_RIGHT,
                                   fontName="Helvetica-Bold" if bold else "Helvetica")
        val_style = ParagraphStyle("TV", fontSize=9, alignment=TA_RIGHT,
                                   fontName="Helvetica-Bold" if bold else "Helvetica")
        return [Paragraph(label, lbl_style), Paragraph(value, val_style)]

    totals_data = [
        totals_row("Subtotal",                     SUBTOTAL),            # 0
        totals_row("Service Fees",                 SERVICE_FEES),        # 1
        totals_row("Discount",                     DISCOUNT),            # 2
        totals_row("Subtotal After Discount/Fees", SUBTOTAL_AFTER_DISCOUNT),  # 3
        totals_row("Taxable Subtotal",             TAXABLE_SUBTOTAL),    # 4
        totals_row("Sales Tax Rate",               SALES_TAX_RATE),      # 5
        totals_row("Tax Amount",                   TAX_AMOUNT),          # 6
        totals_row("Total",                        TOTAL_AMOUNT, bold=True),   # 7
        totals_row("Amount Paid",                  AMOUNT_PAID),         # 8
        totals_row("Balance",                      BALANCE_DUE, bold=True),    # 9
    ]

    totals_table = Table(totals_data, colWidths=[5.7*inch, 1.6*inch])
    totals_style = [
        ("ALIGN",        (0,0), (-1,-1), "RIGHT"),
        ("TOPPADDING",   (0,0), (-1,-1), 3),
        ("BOTTOMPADDING",(0,0), (-1,-1), 3),
        ("LINEABOVE",    (0,3), (-1,3),  0.5, colors.HexColor("#aaaaaa")),  # above Subtotal After Discount
        ("LINEABOVE",    (0,7), (-1,7),  0.5, colors.HexColor("#aaaaaa")),  # above Total
        ("LINEABOVE",    (0,9), (-1,9),  0.5, colors.HexColor("#aaaaaa")),  # above Balance
        ("FONTNAME",     (0,7), (-1,7),  "Helvetica-Bold"),
        ("FONTNAME",     (0,9), (-1,9),  "Helvetica-Bold"),
    ]
    totals_table.setStyle(TableStyle(totals_style))
    story.append(totals_table)
    story.append(Spacer(1, 0.15*inch))

    # ── FOOTER: Terms of Service / Notes ─────────────────────────────────────
    if TERMS_OF_SERVICE and "{{" not in TERMS_OF_SERVICE:
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#cccccc")))
        story.append(Spacer(1, 0.1*inch))
        story.append(Paragraph(TERMS_OF_SERVICE, style_small))

    if NOTE and "{{" not in NOTE:
        story.append(Spacer(1, 0.1*inch))
        story.append(Paragraph(NOTE, style_small))

    # ── PAGE NUMBER FOOTER ────────────────────────────────────────────────────
    def add_page_number(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#888888"))
        page_num_text = f"Invoice {INVOICE_NUMBER} - Page {doc.page} of 1"
        canvas.drawRightString(PAGE_WIDTH - MARGIN, 0.35*inch, page_num_text)
        canvas.restoreState()

    doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
    print(f"✅ PDF generated: {OUTPUT_FILENAME}")


if __name__ == "__main__":
    build_pdf()