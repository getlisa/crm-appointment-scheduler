/**
 * BuildOps email notification service.
 * Sends tier-based job notification emails via SendGrid after prepare_job completes.
 * Uses raw fetch — no additional npm dependency required.
 *
 * Gate checks (both must pass or the email is silently skipped):
 *  1. SENDGRID_API_KEY present in env
 *  2. recipientEmails array is non-empty (sourced from buildops_tenants.email_to)
 *
 * Tiers:
 *  tier1 — job created, no review required     (green)
 *  tier2 — job created, manual review required (orange)
 *  tier3 — job not created (blocked or error)  (red)
 */

const SENDGRID_API    = 'https://api.sendgrid.com/v3/mail/send';
const BUILDOPS_JOB_URL = 'https://live.buildops.com/job/view/';

function isConfigured() {
  return !!process.env.SENDGRID_API_KEY;
}

/**
 * Sends a tier-based job notification email.
 *
 * @param {Object} opts
 * @param {'tier1'|'tier2'|'tier3'} opts.outcome
 * @param {string[]} opts.recipientEmails  - from buildops_tenants.email_to
 * @param {Object}  opts.details
 * @param {string}  opts.details.callerName
 * @param {string}  opts.details.callbackNumber
 * @param {string}  opts.details.customerName
 * @param {{line1?:string,city?:string,state?:string,zip?:string}} opts.details.propertyAddress
 * @param {string}  opts.details.issueDescription
 * @param {string}  [opts.details.jobNumber]       - tier1/tier2 only
 * @param {string}  [opts.details.jobId]           - tier1/tier2 only
 * @param {string}  [opts.details.reasonCode]      - tier2/tier3 only
 * @param {string}  [opts.details.reasonMessage]   - tier2/tier3 only
 */
export async function sendJobNotification({ outcome, recipientEmails, details }) {
  if (!isConfigured()) {
    return { sent: false, reason: 'sendgrid_not_configured' };
  }

  const to = (recipientEmails ?? []).filter(Boolean);
  if (to.length === 0) {
    return { sent: false, reason: 'no_recipients' };
  }

  const from = {
    email: process.env.SENDER_MAIL ?? 'noreply@justclara.ai',
    name: 'Clara AI',
  };

  const isTier1 = outcome === 'tier1';
  const isTier2 = outcome === 'tier2';
  const hasJob  = isTier1 || isTier2;

  const subject = isTier1
    ? `New Service Request — ${details.customerName} | Job #${details.jobNumber}`
    : isTier2
      ? `Service Request Needs Review — ${details.customerName} | Job #${details.jobNumber}`
      : `Service Request Failed — ${details.customerName}`;

  const html = isTier1 ? composeTier1Html(details)
             : isTier2 ? composeTier2Html(details)
             :            composeTier3Html(details);

  const text = isTier1 ? composeTier1Text(details)
             : isTier2 ? composeTier2Text(details)
             :            composeTier3Text(details);

  const body = {
    personalizations: [{ to: to.map(email => ({ email })) }],
    from,
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html',  value: html },
    ],
    custom_args: {
      outcome,
      customerName: details.customerName ?? '',
      jobNumber:    details.jobNumber    ?? '',
    },
  };

  try {
    const res = await fetch(SENDGRID_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[email] sendgrid error', res.status, errText);
      return { sent: false, error: `sendgrid ${res.status}` };
    }

    console.log('[email] notification sent', { outcome, to, subject });
    return { sent: true, to, subject };
  } catch (err) {
    console.error('[email] failed to send notification', err?.message ?? err);
    return { sent: false, error: err?.message ?? 'unknown' };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAddress(addr) {
  if (!addr) return 'Not provided';
  const { line1, city, state, zip } = addr;
  return [line1, city, state, zip].filter(Boolean).join(', ') || 'Not provided';
}

function formatTimestamp() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// ── HTML composers ────────────────────────────────────────────────────────────

function baseHtml(badge, badgeColor, rows, footerNote, ctaUrl) {
  const rowsHtml = rows.map(([label, value]) => `
    <tr>
      <td style="padding:6px 12px;color:#555;font-size:13px;width:160px;vertical-align:top">${label}</td>
      <td style="padding:6px 12px;color:#111;font-size:13px;font-family:monospace">${value ?? '—'}</td>
    </tr>`).join('');

  const ctaHtml = ctaUrl ? `
  <tr><td style="padding:16px 24px;text-align:center">
    <a href="${ctaUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:10px 28px;border-radius:6px;font-size:13px;font-weight:bold;letter-spacing:.3px">View in BuildOps</a>
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.12)">
  <tr><td style="background:#1a1a2e;padding:20px 24px">
    <span style="color:#fff;font-size:18px;font-weight:bold">Crockett Facilities — Clara AI</span>
    <span style="float:right;background:${badgeColor};color:#fff;font-size:11px;font-weight:bold;padding:4px 10px;border-radius:12px">${badge}</span>
  </td></tr>
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
  </td></tr>
  ${ctaHtml}
  <tr><td style="padding:16px 24px;background:#fafafa;border-top:1px solid #eee;color:#888;font-size:12px">${footerNote}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function composeTier1Html(d) {
  const jobUrl = d.jobNumber ? `${BUILDOPS_JOB_URL}${d.jobNumber}` : null;
  return baseHtml(
    'Tier 1 — Service Request Logged', '#2e7d32',
    [
      ['Caller Name',     d.callerName       || 'Unknown'],
      ['Callback Number', d.callbackNumber   || 'Not provided'],
      ['Customer',        d.customerName     || '—'],
      ['Service Address', formatAddress(d.propertyAddress)],
      ['Issue',           d.issueDescription || 'Not provided'],
      ['Job Number',      d.jobNumber        || '—'],
      ['Tier',            'Tier 1 — Service Request Logged'],
      ['Logged At',       formatTimestamp()],
    ],
    'Expected callback: Within office hours',
    jobUrl,
  );
}

function composeTier2Html(d) {
  const jobUrl = d.jobNumber ? `${BUILDOPS_JOB_URL}${d.jobNumber}` : null;
  const reviewReason = d.reasonMessage || 'Manual review required before dispatch';
  return baseHtml(
    'Tier 2 — Review Required', '#e65100',
    [
      ['Caller Name',     d.callerName       || 'Unknown'],
      ['Callback Number', d.callbackNumber   || 'Not provided'],
      ['Customer',        d.customerName     || '—'],
      ['Service Address', formatAddress(d.propertyAddress)],
      ['Issue',           d.issueDescription || 'Not provided'],
      ['Job Number',      d.jobNumber        || '—'],
      ['Tier',            'Tier 2 — Review Required'],
      ['Review Reason',   reviewReason],
      ['Logged At',       formatTimestamp()],
    ],
    'Review required — please action before dispatch.',
    jobUrl,
  );
}

function composeTier3Html(d) {
  const reason = d.reasonMessage || d.reasonCode || 'See internal logs';
  return baseHtml(
    'Tier 3 — Job Not Created', '#c62828',
    [
      ['Caller Name',     d.callerName       || 'Unknown'],
      ['Callback Number', d.callbackNumber   || 'Not provided'],
      ['Customer',        d.customerName     || '—'],
      ['Service Address', formatAddress(d.propertyAddress)],
      ['Issue',           d.issueDescription || 'Not provided'],
      ['Tier',            'Tier 3 — Job Not Created'],
      ['Reason',          reason],
      ['Logged At',       formatTimestamp()],
    ],
    'No job was created. Manual follow-up required.',
    null,
  );
}

// ── Plain-text composers ──────────────────────────────────────────────────────

function composeTier1Text(d) {
  const jobUrl = d.jobNumber ? `${BUILDOPS_JOB_URL}${d.jobNumber}` : null;
  return [
    'Crockett Facilities — Clara AI | TIER 1 — SERVICE REQUEST LOGGED',
    '---',
    `Caller Name     : ${d.callerName       || 'Unknown'}`,
    `Callback Number : ${d.callbackNumber   || 'Not provided'}`,
    `Customer        : ${d.customerName     || '—'}`,
    `Service Address : ${formatAddress(d.propertyAddress)}`,
    `Issue           : ${d.issueDescription || 'Not provided'}`,
    `Job Number      : ${d.jobNumber        || '—'}`,
    `Tier            : Tier 1 — Service Request Logged`,
    `Logged At       : ${formatTimestamp()}`,
    ...(jobUrl ? [`View in BuildOps : ${jobUrl}`] : []),
    '---',
    'Expected callback: Within office hours',
  ].join('\n');
}

function composeTier2Text(d) {
  const jobUrl = d.jobNumber ? `${BUILDOPS_JOB_URL}${d.jobNumber}` : null;
  const reviewReason = d.reasonMessage || 'Manual review required before dispatch';
  return [
    'Crockett Facilities — Clara AI | TIER 2 — REVIEW REQUIRED',
    '---',
    `Caller Name     : ${d.callerName       || 'Unknown'}`,
    `Callback Number : ${d.callbackNumber   || 'Not provided'}`,
    `Customer        : ${d.customerName     || '—'}`,
    `Service Address : ${formatAddress(d.propertyAddress)}`,
    `Issue           : ${d.issueDescription || 'Not provided'}`,
    `Job Number      : ${d.jobNumber        || '—'}`,
    `Tier            : Tier 2 — Review Required`,
    `Review Reason   : ${reviewReason}`,
    `Logged At       : ${formatTimestamp()}`,
    ...(jobUrl ? [`View in BuildOps : ${jobUrl}`] : []),
    '---',
    'Review required — please action before dispatch.',
  ].join('\n');
}

function composeTier3Text(d) {
  const reason = d.reasonMessage || d.reasonCode || 'See internal logs';
  return [
    'Crockett Facilities — Clara AI | TIER 3 — JOB NOT CREATED',
    '---',
    `Caller Name     : ${d.callerName       || 'Unknown'}`,
    `Callback Number : ${d.callbackNumber   || 'Not provided'}`,
    `Customer        : ${d.customerName     || '—'}`,
    `Service Address : ${formatAddress(d.propertyAddress)}`,
    `Issue           : ${d.issueDescription || 'Not provided'}`,
    `Tier            : Tier 3 — Job Not Created`,
    `Reason          : ${reason}`,
    `Logged At       : ${formatTimestamp()}`,
    '---',
    'No job was created. Manual follow-up required.',
  ].join('\n');
}
