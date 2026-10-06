/**
 * HouseCall Pro email notifications via SendGrid (raw fetch, no extra dependency).
 * Recipients come from housecallpro_tokens.emailto (to) and ccMail (cc).
 *
 * Silently skips when SENDGRID_API_KEY is missing or there are no recipients.
 * Three kinds:
 *   job_booked   — Office-Hours booked a job (green)
 *   lead_created — Office-Hours logged a lead, nothing scheduled (blue)
 *   escalation   — After-Hours captured a request / handoff (orange)
 */

const SENDGRID_API = 'https://api.sendgrid.com/v3/mail/send';

export type HcpNotificationKind = 'job_booked' | 'lead_created' | 'escalation';

export interface HcpNotificationDetails {
  customerName?: string | null;
  callbackNumber?: string | null;
  address?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  /** The exact job notes sent to HCP (Service / Issue Description / schedule). */
  notes?: string | null;
  jobNumber?: string | null;
  jobId?: string | null;
  /** HCP job type the agent classified on a lead (name, not uuid). */
  jobType?: string | null;
  leadNumber?: number | null;
  leadId?: string | null;
  escalationType?: string | null;
  summary?: string | null;
}

/** Splits a comma/semicolon-separated email string into a clean array. */
function parseEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export async function sendHcpNotification({
  kind,
  emailTo,
  ccMail,
  details,
}: {
  kind: HcpNotificationKind;
  emailTo: string | null;
  ccMail: string | null;
  details: HcpNotificationDetails;
}): Promise<{ sent: boolean; reason?: string; error?: string }> {
  if (!process.env.SENDGRID_API_KEY) return { sent: false, reason: 'sendgrid_not_configured' };

  const to = parseEmails(emailTo);
  const cc = parseEmails(ccMail).filter(e => !to.includes(e));
  if (to.length === 0) return { sent: false, reason: 'no_recipients' };

  const from = { email: process.env.SENDER_MAIL ?? 'noreply@justclara.ai', name: 'Clara AI' };

  // A lead is deliberately NOT a booking — the subject and badge have to say so
  // at a glance, because nothing about it is scheduled.
  const leadNo = details.leadNumber != null ? String(details.leadNumber) : '';
  const subject =
    kind === 'job_booked'
      ? `New Job Booked — ${details.customerName ?? 'Customer'}${details.jobNumber ? ` | #${details.jobNumber}` : ''}`
      : kind === 'lead_created'
        ? `New Lead — ${details.customerName ?? 'Customer'}${leadNo ? ` | #${leadNo}` : ''}`
        : `Service Request — ${details.customerName ?? 'Caller'}${details.escalationType ? ` (${details.escalationType})` : ''}`;

  const rows: [string, string][] =
    kind === 'job_booked'
      ? [
          ['Customer', details.customerName || '—'],
          ['Callback Number', details.callbackNumber || 'Not provided'],
          ['Service Address', details.address || 'Not provided'],
          ['Notes', details.notes || 'None'],
          ['Job Number', details.jobNumber || '—'],
        ]
      : kind === 'lead_created'
        ? [
            ['Customer', details.customerName || '—'],
            ['Callback Number', details.callbackNumber || 'Not provided'],
            ['Service Address', details.address || 'Not provided'],
            ['Job Type', details.jobType || 'Not classified'],
            ['Notes', details.notes || 'None'],
            ['Lead Number', leadNo || '—'],
          ]
        : [
            ['Caller', details.customerName || '—'],
            ['Callback Number', details.callbackNumber || 'Not provided'],
            ...((details.address ? [['Service Address', details.address]] : []) as [string, string][]),
            ['Type', details.escalationType || 'General'],
            ['Notes', details.notes || details.summary || 'Not provided'],
          ];

  const badge =
    kind === 'job_booked' ? 'Job Booked' : kind === 'lead_created' ? 'Lead — Not Scheduled' : 'Service Request';
  const badgeColor = kind === 'job_booked' ? '#2e7d32' : kind === 'lead_created' ? '#1565c0' : '#e65100';

  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const html = composeHtml(badge, badgeColor, rows);

  const body = {
    personalizations: [{ to: to.map(email => ({ email })), ...(cc.length ? { cc: cc.map(email => ({ email })) } : {}) }],
    from,
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
    ],
    custom_args: { kind, customerName: details.customerName ?? '' },
  };

  try {
    const res = await fetch(SENDGRID_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[hcp][email] sendgrid error', res.status, errText);
      return { sent: false, error: `sendgrid ${res.status}` };
    }
    console.log('[hcp][email] notification sent', { kind, to, subject });
    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hcp][email] failed to send', msg);
    return { sent: false, error: msg };
  }
}

/** Escapes HTML so free-text values (e.g. the caller's issue) can't break markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function composeHtml(badge: string, badgeColor: string, rows: [string, string][]): string {
  const rowsHtml = rows
    .map(
      ([label, value]) => `
    <tr>
      <td style="padding:6px 12px;color:#555;font-size:13px;width:160px;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:6px 12px;color:#111;font-size:13px;font-family:monospace;white-space:pre-wrap">${escapeHtml(value ?? '—').replace(/\n/g, '<br>')}</td>
    </tr>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.12)">
  <tr><td style="background:#1a1a2e;padding:20px 24px">
    <span style="color:#fff;font-size:18px;font-weight:bold">Clara AI — HouseCall Pro</span>
    <span style="float:right;background:${badgeColor};color:#fff;font-size:11px;font-weight:bold;padding:4px 10px;border-radius:12px">${badge}</span>
  </td></tr>
  <tr><td><table width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table></td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}
