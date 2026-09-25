/**
 * @fileoverview Tests for the shared period-literal check both data tools run
 * before any request. The accept and reject sets are the literals probed live
 * against both Eurostat endpoints: every accepted one is read correctly by both,
 * every zero-padded frequency component is rewritten to the form both read, and
 * every rejected one is either refused by an endpoint or silently rolled over to
 * a different period.
 * @module tests/services/eurostat-periods.test
 */

import { describe, expect, it } from 'vitest';
import { normalizePeriod, resolvePeriods } from '@/services/eurostat-periods.js';

describe('normalizePeriod', () => {
  for (const period of [
    '2020',
    '2020-01',
    '2020-12',
    '2020-01-15',
    '2020-01-31',
    '2024-02-29',
    '2000-02-29',
    '2020-Q1',
    '2020-Q4',
    '2020-q1',
    '2020-S1',
    '2020-s2',
    '2020-W1',
    '2020-W01',
    '2020-w01',
    '2020-W53',
    '2015-W53',
    '2026-W53',
    '2021-W52',
    '2020-M01',
    '2020-M1',
    '2020-m12',
    '2020-T1',
    '2020-t3',
    '2026-D001',
    '2026-d365',
    '2024-D366',
    '0000',
  ]) {
    it(`accepts "${period}" and passes it through unchanged`, () => {
      expect(normalizePeriod(period)).toMatchObject({ period });
    });
  }

  for (const [sent, canonical] of [
    ['2020-Q01', '2020-Q1'],
    ['2020-Q0004', '2020-Q4'],
    ['2020-q01', '2020-q1'],
    ['2020-S01', '2020-S1'],
    ['2020-s002', '2020-s2'],
    ['2020-W001', '2020-W01'],
    ['2020-W0010', '2020-W10'],
    ['2020-w0053', '2020-w53'],
    ['2020-M001', '2020-M01'],
    ['2020-M0012', '2020-M12'],
    ['2020-m001', '2020-m01'],
    ['2020-T01', '2020-T1'],
    ['2026-D0001', '2026-D001'],
  ] as const) {
    it(`rewrites the zero-padded "${sent}" to "${canonical}", keeping the letter's case`, () => {
      expect(normalizePeriod(sent)).toMatchObject({ period: canonical });
    });
  }

  /**
   * The Statistics API reads a day of the year only as three digits (`2026-D1` is
   * refused there, read by the bulk endpoint), and the SDMX annual form `YYYY-A1`
   * only on the bulk endpoint — so both are sent in the form both endpoints read.
   */
  for (const [sent, canonical] of [
    ['2026-D1', '2026-D001'],
    ['2026-d01', '2026-d001'],
    ['2020-A1', '2020'],
    ['2020-a01', '2020'],
  ] as const) {
    it(`rewrites "${sent}" to "${canonical}", the form both endpoints read`, () => {
      expect(normalizePeriod(sent)).toMatchObject({ period: canonical });
    });
  }

  for (const [period, why] of [
    ['2020-13', /month 13 .*01–12/],
    ['2020-00', /month 00 .*01–12/],
    ['2020-Q5', /quarter 5 .*1–4/],
    ['2020-Q9', /quarter 9 .*1–4/],
    ['2020-Q0', /quarter 0 .*1–4/],
    ['2020-Q05', /quarter 5 .*1–4/],
    ['2020-Q00', /quarter 0 .*1–4/],
    ['2020-S3', /semester 3 .*1–2/],
    ['2020-S0', /semester 0 .*1–2/],
    ['2020-S03', /semester 3 .*1–2/],
    ['2020-W54', /week 54 .*1–53/],
    ['2020-W0', /week 0 .*1–53/],
    ['2020-W00', /week 0 .*1–53/],
    ['2020-W100', /week 100 .*1–53/],
    ['2021-W53', /2021 has 52 ISO weeks/],
    ['2021-W053', /week 53 .*2021 has 52 ISO weeks/],
    ['2020-M13', /month 13 .*1–12/],
    ['2020-M0', /month 0 .*1–12/],
    ['2020-M013', /month 13 .*1–12/],
    ['2026-02-30', /February 2026 has 28 days/],
    ['2021-02-29', /February 2021 has 28 days/],
    ['1900-02-29', /February 1900 has 28 days/],
    ['2020-04-31', /April 2020 has 30 days/],
    ['2020-01-00', /day 00/],
    ['2020-13-01', /month 13/],
    ['2020-T0', /trimester 0 .*1–3/],
    ['2020-T4', /trimester 4 .*1–3/],
    ['2026-D000', /day 0 .*1–366/],
    ['2021-D366', /day 366 .*2021 has 365 days/],
    ['2024-D367', /day 367 .*1–366/],
  ] as const) {
    it(`rejects "${period}" with the component that is out of range`, () => {
      expect(normalizePeriod(period)).toEqual({ problem: expect.stringMatching(why) });
    });
  }

  for (const period of [
    '2020-1',
    '2020Q1',
    '202001',
    '20200102',
    '2020-1-2',
    '2020-01-1',
    '2020-001',
    '2020-01-001',
    '2020M01',
    '2020W01',
    'banana',
    '20',
    '2020-',
    '2020-Q',
    '2020-X1',
    '2020-A0',
    '2020-A2',
    '2020-H1',
    '2026-09-01T00:00:00',
    ' 2020',
    "'; DROP TABLE; --",
    '../../../etc/passwd',
    '9'.repeat(5_000),
    '２０２０',
  ]) {
    it(`rejects the malformed literal ${JSON.stringify(period).slice(0, 30)}`, () => {
      expect(normalizePeriod(period)).toEqual({
        problem: expect.stringMatching(/not one of the accepted period forms/),
      });
    });
  }
});

describe('resolvePeriods', () => {
  it('passes when neither bound is set', () => {
    expect(resolvePeriods({})).toEqual({ ok: true });
    expect(resolvePeriods({ since_period: undefined, until_period: undefined })).toEqual({
      ok: true,
    });
  });

  it('returns both valid bounds, canonical and otherwise unchanged', () => {
    expect(resolvePeriods({ since_period: '2020-Q01', until_period: '2024' })).toEqual({
      ok: true,
      since_period: '2020-Q1',
      until_period: '2024',
    });
  });

  it('names the parameter, the value as sent, and the problem for a bad since_period', () => {
    expect(resolvePeriods({ since_period: '2020-13', until_period: '2024' })).toEqual({
      ok: false,
      message: 'since_period "2020-13" is not a valid period: month 13 is outside 01–12.',
    });
  });

  it('echoes a zero-padded value as sent when its canonical form is out of range', () => {
    expect(resolvePeriods({ until_period: '2020-Q05' })).toEqual({
      ok: false,
      message: 'until_period "2020-Q05" is not a valid period: quarter 5 is outside 1–4.',
    });
  });

  it('checks until_period too', () => {
    expect(resolvePeriods({ since_period: '2020', until_period: '2020-Q9' })).toEqual({
      ok: false,
      message: 'until_period "2020-Q9" is not a valid period: quarter 9 is outside 1–4.',
    });
  });

  it('reports since_period first when both bounds are bad', () => {
    expect(resolvePeriods({ since_period: 'banana', until_period: '2020-13' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^since_period "banana"/),
    });
  });

  it('bounds a long value in the message rather than echoing all of it', () => {
    const resolved = resolvePeriods({ since_period: '9'.repeat(5_000) });
    if (resolved.ok) throw new Error('expected a rejection');
    expect(resolved.message).toContain(`since_period "${'9'.repeat(40)}…"`);
    expect(resolved.message.length).toBeLessThan(200);
  });
});

/**
 * A range is empty when since_period's period starts after until_period's period
 * ends (#53). Each form covers a span of days, so pairs of different frequencies
 * compare without a per-frequency rule.
 */
describe('resolvePeriods — empty ranges (#53)', () => {
  for (const [since, until] of [
    ['2024-01', '2020-01'],
    ['2020-Q3', '2020-06'],
    ['2021', '2020-12-31'],
    ['2020-S2', '2020-Q2'],
    ['2020-T3', '2020-08'],
    ['2021-W01', '2021-01-03'],
    ['2020-12-31', '2020-D365'],
    ['2020-02', '2020-01-31'],
    ['2021-A1', '2020'],
  ] as const) {
    it(`rejects since_period "${since}" with until_period "${until}", naming both`, () => {
      expect(resolvePeriods({ since_period: since, until_period: until })).toEqual({
        ok: false,
        message: `since_period "${since}" starts after until_period "${until}" ends, so the range holds no period.`,
      });
    });
  }

  for (const [since, until] of [
    ['2020-06', '2020'],
    ['2020', '2020-06'],
    ['2020-Q2', '2020-Q2'],
    ['2020-01', '2020-01'],
    ['2020-W53', '2020-12-31'],
    ['2021-W01', '2021-01-04'],
    ['2020-D366', '2020-12-31'],
    ['2020-T2', '2020-05'],
    ['2020-S2', '2020-Q3'],
    ['2020-12-31', '2020'],
    ['2020-Q01', '2020-M03'],
    ['0000', '0000-12'],
    ['2020-A1', '2020-01-01'],
  ] as const) {
    it(`accepts since_period "${since}" with until_period "${until}"`, () => {
      expect(resolvePeriods({ since_period: since, until_period: until })).toMatchObject({
        ok: true,
      });
    });
  }

  it('checks each literal before the pair, so a bad bound is named for what it is', () => {
    expect(resolvePeriods({ since_period: '2024-13', until_period: '2020' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('month 13'),
    });
  });

  it('names the bounds as sent, trimmed, not their canonical form', () => {
    expect(resolvePeriods({ since_period: '2020-Q03', until_period: '2020-06' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        /^since_period "2020-Q03" starts after until_period "2020-06"/,
      ),
    });
  });
});
