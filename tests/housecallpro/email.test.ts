/**
 * Unit tests for normalizeEmail — a voice agent transcribes what it hears, so an
 * email arrives spoken. HCP rejects a malformed one with 400 "Email must be a
 * single, valid email address", and on create_customer that 400 fails the whole
 * customer. Anything unsalvageable must therefore become null, never a throw.
 */
import { describe, it, expect } from 'vitest';
import { normalizeEmail } from '../../src/services/housecallpro/email.js';

describe('normalizeEmail', () => {
  it('passes a normal address through', () => {
    expect(normalizeEmail('subhamag2003@gmail.com')).toBe('subhamag2003@gmail.com');
    expect(normalizeEmail('  Laura@Pierce-Inc.com ')).toBe('laura@pierce-inc.com');
  });

  it('resolves the spoken form that failed on call_69ba94bf', () => {
    expect(normalizeEmail('subhamag2003 at g-mail dot com')).toBe('subhamag2003@gmail.com');
    expect(normalizeEmail('subhanag2003 at gmail dot com')).toBe('subhanag2003@gmail.com');
  });

  it('joins letters dictated one at a time', () => {
    expect(normalizeEmail('c l a r a at gmail dot com')).toBe('clara@gmail.com');
  });

  it('handles the other spoken separators', () => {
    expect(normalizeEmail('first underscore last at yahoo dot com')).toBe('first_last@yahoo.com');
    expect(normalizeEmail('jo dash ann at hot-mail dot co dot uk')).toBe('jo-ann@hotmail.co.uk');
    expect(normalizeEmail('dana plus work at gmail dot com')).toBe('dana+work@gmail.com');
  });

  it('returns null rather than something invalid', () => {
    expect(normalizeEmail('no idea')).toBeNull();
    expect(normalizeEmail('@gmail.com')).toBeNull();
    expect(normalizeEmail('dana@')).toBeNull();
    expect(normalizeEmail('dana@gmail')).toBeNull();
    expect(normalizeEmail('two@one.com three@two.com')).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it('leaves real words containing the separator names alone', () => {
    expect(normalizeEmail('that.person@gmail.com')).toBe('that.person@gmail.com');
  });
});
