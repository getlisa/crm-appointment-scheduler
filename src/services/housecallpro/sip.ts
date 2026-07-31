/**
 * SIP header parsing for HouseCall Pro lead-source attribution.
 *
 * When a customer dials an HCP tracking line, HCP forwards the call (SIP
 * `Diversion` header, reason=unconditional) through a shared Twilio DID into
 * Retell. Retell allowlists the `Diversion` header into `custom_sip_headers`
 * and auto-exposes it as the `{{diversion}}` dynamic variable, e.g.:
 *
 *   diversion: <sip:+17473492132@twilio.com>;reason=unconditional
 *
 * The number inside (`+17473492132`) is the real tracking line — the lead
 * source — as opposed to `to_number`, which is the shared DID every line
 * forwards through. These helpers pull that number out.
 */

/**
 * Extracts the dialed tracking number (E.164, e.g. "+17473492132") from a SIP
 * Diversion value, or null. Accepts "<sip:+1...@host>;reason=..." forms and a
 * bare number. When several Diversion values are concatenated (multi-hop
 * forward) the first `sip:` URI is used — the closest hop, which for HCP's
 * single unconditional forward is the tracking line.
 */
export function parseDiversionNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/sip:\s*(\+?\d{7,15})@/i) ?? raw.match(/(\+?\d{7,15})/);
  if (!match) return null;
  const digits = match[1].replace(/[^\d]/g, '');
  return digits.length >= 7 ? `+${digits}` : null;
}

/**
 * Reads a Diversion value out of a `custom_sip_headers` object or a
 * `retell_llm_dynamic_variables` object (Retell emits header keys lowercased,
 * but tolerate either casing) and parses it to an E.164 tracking number.
 */
export function diversionNumberFrom(
  bag: Record<string, unknown> | null | undefined,
): string | null {
  if (!bag) return null;
  const raw = (bag.diversion ?? bag.Diversion) as string | undefined;
  return parseDiversionNumber(raw);
}
