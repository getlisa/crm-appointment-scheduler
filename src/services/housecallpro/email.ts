/**
 * Turns a spoken email address into one HCP will accept, or into nothing.
 *
 * A voice agent transcribes what it hears, so an email arrives as
 * "subhamag2003 at g-mail dot com" or "c l a r a at gmail dot com". HCP rejects
 * those with 400 "Email must be a single, valid email address" — and on
 * create_customer that 400 fails the whole customer, which strands the call.
 *
 * So: normalize what can be normalized, and drop what cannot. An email is the
 * least important field on the record; it must never be the reason a caller's
 * request goes unlogged.
 */

/** Deliberately simple: one @, something either side, a dot in the domain. */
const VALID = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * @param raw - whatever the agent captured
 * @returns a valid address, or null when it cannot be salvaged
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const input = raw?.trim();
  if (!input) return null;

  let s = input.toLowerCase();

  // Spoken separators. Bounded so "that" and "dotty" are left alone.
  s = s.replace(/\s*\b(at|at the rate(\s+of)?)\b\s*/g, '@');
  s = s.replace(/\s*\b(dot|period|point)\b\s*/g, '.');
  s = s.replace(/\s*\b(underscore|under score)\b\s*/g, '_');
  s = s.replace(/\s*\b(dash|hyphen|minus)\b\s*/g, '-');
  s = s.replace(/\s*\b(plus)\b\s*/g, '+');

  // Transcribers hyphenate well-known providers: "g-mail", "hot-mail".
  s = s.replace(/\bg\s*-\s*mail\b/g, 'gmail');
  s = s.replace(/\bhot\s*-\s*mail\b/g, 'hotmail');
  s = s.replace(/\by\s*-\s*ahoo\b/g, 'yahoo');

  // "c l a r a" — letters dictated one at a time. Only collapse runs of three
  // or more single characters, so real words separated by spaces are untouched.
  s = s.replace(/(?:(?<=^|[\s@.])[a-z0-9](?=\s|$)\s*){3,}/g, m => m.replace(/\s+/g, ''));

  s = s.replace(/\s+/g, '');

  return VALID.test(s) ? s : null;
}
