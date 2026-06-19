import { describe, it, expect } from 'vitest';
import { clampToBusinessHours } from '../../src/services/servicetitan/date-window.js';

// All cases use UTC so wall-clock HH:mm maps 1:1 to the ISO times below.
const DATE = '2026-06-18';
const TZ = 'UTC';
const BH = { start: '08:00', end: '17:00' };

describe('clampToBusinessHours', () => {
  it('leaves an appointment fully inside the window unchanged', () => {
    const result = clampToBusinessHours(
      DATE,
      '2026-06-18T09:00:00.000Z',
      '2026-06-18T10:00:00.000Z',
      BH,
      TZ
    );
    expect(result).toEqual({
      startUtc: '2026-06-18T09:00:00.000Z',
      endUtc: '2026-06-18T10:00:00.000Z',
    });
  });

  it('shifts a start-before-open appointment forward, preserving duration', () => {
    const result = clampToBusinessHours(
      DATE,
      '2026-06-18T07:00:00.000Z',
      '2026-06-18T08:00:00.000Z',
      BH,
      TZ
    );
    expect(result).toEqual({
      startUtc: '2026-06-18T08:00:00.000Z',
      endUtc: '2026-06-18T09:00:00.000Z',
    });
  });

  it('pulls an end-after-close appointment back to close, preserving duration', () => {
    const result = clampToBusinessHours(
      DATE,
      '2026-06-18T16:30:00.000Z',
      '2026-06-18T18:00:00.000Z',
      BH,
      TZ
    );
    expect(result).toEqual({
      startUtc: '2026-06-18T15:30:00.000Z',
      endUtc: '2026-06-18T17:00:00.000Z',
    });
  });

  it('errors when the duration exceeds the window', () => {
    const result = clampToBusinessHours(
      DATE,
      '2026-06-18T08:00:00.000Z',
      '2026-06-18T20:00:00.000Z',
      BH,
      TZ
    );
    expect(result).toEqual({ error: 'Appointment duration exceeds business hours window' });
  });

  it('errors when the window is inverted', () => {
    const result = clampToBusinessHours(
      DATE,
      '2026-06-18T09:00:00.000Z',
      '2026-06-18T10:00:00.000Z',
      { start: '17:00', end: '08:00' },
      TZ
    );
    expect(result).toEqual({ error: 'businessHours.end must be after businessHours.start' });
  });

  it('clamps using the tenant timezone wall-clock, not UTC', () => {
    // America/New_York is UTC-4 on this date; 08:00 local = 12:00 UTC.
    const result = clampToBusinessHours(
      DATE,
      '2026-06-18T11:00:00.000Z', // 07:00 local — before open
      '2026-06-18T12:00:00.000Z',
      BH,
      'America/New_York'
    );
    expect(result).toEqual({
      startUtc: '2026-06-18T12:00:00.000Z', // 08:00 local
      endUtc: '2026-06-18T13:00:00.000Z',
    });
  });
});
