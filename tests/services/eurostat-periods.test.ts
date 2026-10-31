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
import {
  cutNotice,
  diagnoseEmptyRange,
  frequenciesOf,
  normalizePeriod,
  oneDayRange,
  periodCuts,
  resolvePeriods,
} from '@/services/eurostat-periods.js';

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

/**
 * The periods a bound excludes, read off 380 live probes of both endpoints: a period
 * is kept when its first day is on or after `since`'s first day and its last day on or
 * before `until`'s last day, with ISO week spans. The bulk rows of that matrix give
 * each row below; the two endpoints agreed on all of them.
 */
describe('periodCuts: the bound-form by frequency matrix', () => {
  type Row = [bound: string, role: 'since' | 'until', cut: Partial<Record<string, string>>];

  const midYear: Row[] = [
    ['2022', 'since', { W: '2021-W52' }],
    ['2022', 'until', { W: '2022-W52' }],
    ['2022-06', 'since', { A: '2022', S: '2022-S1', Q: '2022-Q2', W: '2022-W22' }],
    ['2022-M06', 'since', { A: '2022', S: '2022-S1', Q: '2022-Q2', W: '2022-W22' }],
    ['2022-06', 'until', { A: '2022', W: '2022-W26' }],
    ['2022-M06', 'until', { A: '2022', W: '2022-W26' }],
    ['2022-Q2', 'since', { A: '2022', S: '2022-S1', W: '2022-W13' }],
    ['2022-Q2', 'until', { A: '2022', W: '2022-W26' }],
    ['2022-S2', 'since', { A: '2022', W: '2022-W26' }],
    ['2022-S2', 'until', { W: '2022-W52' }],
    ['2022-T2', 'since', { A: '2022', S: '2022-S1', Q: '2022-Q2', W: '2022-W17' }],
    ['2022-T2', 'until', { A: '2022', S: '2022-S2', Q: '2022-Q3', W: '2022-W35' }],
  ];
  const eitherRole: Array<[bound: string, cut: Row[2]]> = [
    ['2022-06-15', { A: '2022', S: '2022-S1', Q: '2022-Q2', M: '2022-06', W: '2022-W24' }],
    ['2022-D166', { A: '2022', S: '2022-S1', Q: '2022-Q2', M: '2022-06', W: '2022-W24' }],
    ['2022-W23', { A: '2022', S: '2022-S1', Q: '2022-Q2', M: '2022-06' }],
  ];
  const aligned: Row[] = [
    ['2022-01', 'since', { W: '2021-W52' }],
    ['2022-01-01', 'since', { W: '2021-W52' }],
    ['2022-D001', 'since', { W: '2021-W52' }],
    ['2022-M01', 'since', { W: '2021-W52' }],
    ['2022-Q1', 'since', { W: '2021-W52' }],
    ['2022-S1', 'since', { W: '2021-W52' }],
    ['2022-T1', 'since', { W: '2021-W52' }],
    // ISO 2022-W01 starts on 3 January, so it falls inside everything that starts on the 1st.
    ['2022-W01', 'since', { A: '2022', S: '2022-S1', Q: '2022-Q1', M: '2022-01' }],
    ['2022-12', 'until', { W: '2022-W52' }],
    ['2022-12-31', 'until', { W: '2022-W52' }],
    ['2022-D365', 'until', { W: '2022-W52' }],
    ['2022-M12', 'until', { W: '2022-W52' }],
    ['2022-Q4', 'until', { W: '2022-W52' }],
    ['2022-T3', 'until', { W: '2022-W52' }],
    // ISO 2022-W52 ends on 1 January 2023: annual 2022 is kept and 2023 is the period cut.
    ['2022-W52', 'until', { A: '2023', S: '2023-S1', Q: '2023-Q1', M: '2023-01' }],
  ];

  const rows: Row[] = [
    ...midYear,
    ...eitherRole.flatMap(([bound, cut]): Row[] => [
      [bound, 'since', cut],
      [bound, 'until', cut],
    ]),
    ...aligned,
  ];

  for (const [bound, role, cut] of rows) {
    for (const frequency of ['A', 'S', 'Q', 'M', 'W', 'D']) {
      const expected = cut[frequency];
      it(`${role} ${bound} on ${frequency}: ${expected ?? 'none'}`, () => {
        const cuts = periodCuts(
          role === 'since' ? { since_period: bound } : { until_period: bound },
          [frequency],
        );
        expect(cuts.map((c) => c.period)).toEqual(expected ? [expected] : []);
      });
    }
  }

  it('reads a trimester the way it reads the other month-based frequencies', () => {
    expect(periodCuts({ since_period: '2022-06' }, ['T'])).toEqual([
      { bounds: ['since_period'], frequency: 'trimester', period: '2022-T2' },
    ]);
    expect(periodCuts({ since_period: '2022-05' }, ['T'])).toEqual([]);
    expect(periodCuts({ until_period: '2022-08' }, ['T'])).toEqual([]);
  });

  it('carries the ISO week year across a year boundary in both directions', () => {
    // 2021-01-01 is a Friday in 2020-W53; 2024-12-30 is a Monday in 2025-W01.
    expect(periodCuts({ since_period: '2021' }, ['W'])[0]?.period).toBe('2020-W53');
    expect(periodCuts({ since_period: '2024-12-31' }, ['W'])[0]?.period).toBe('2025-W01');
  });

  it('counts days across a century, before the epoch included', () => {
    expect(periodCuts({ since_period: '1900-03-01' }, ['M', 'A'])).toEqual([
      { bounds: ['since_period'], frequency: 'annual', period: '1900' },
    ]);
    expect(periodCuts({ since_period: '1969-12-31' }, ['W'])[0]?.period).toBe('1970-W01');
  });

  it('names no period for a range with no bound', () => {
    expect(periodCuts({}, ['A', 'M'])).toEqual([]);
  });

  it('lists the frequencies finest first, whatever order the reply gave them in', () => {
    expect(
      periodCuts({ since_period: '2022-06-15' }, ['A', 'M', 'W']).map((c) => c.frequency),
    ).toEqual(['weekly', 'monthly', 'annual']);
  });

  it('marks a period both bounds fall inside as one cut carrying both', () => {
    expect(periodCuts({ since_period: '2022-06', until_period: '2022-08' }, ['A'])).toEqual([
      { bounds: ['since_period', 'until_period'], frequency: 'annual', period: '2022' },
    ]);
  });

  it('keeps two cuts apart when each bound falls inside its own period', () => {
    expect(periodCuts({ since_period: '2022-06', until_period: '2023-06' }, ['A'])).toEqual([
      { bounds: ['since_period'], frequency: 'annual', period: '2022' },
      { bounds: ['until_period'], frequency: 'annual', period: '2023' },
    ]);
  });

  describe('coverage', () => {
    const coverage = { oldest: '1975', latest: '2025' };

    it('does not name a period lying wholly past or before the reported coverage', () => {
      expect(periodCuts({ until_period: '2031-06' }, ['A'], coverage)).toEqual([]);
      expect(periodCuts({ since_period: '1974-06' }, ['A'], coverage)).toEqual([]);
    });

    it('names a period at the edge of coverage', () => {
      expect(periodCuts({ since_period: '2025-06' }, ['A'], coverage)[0]?.period).toBe('2025');
      expect(periodCuts({ until_period: '1975-06' }, ['A'], coverage)[0]?.period).toBe('1975');
    });

    it('decides from the bound test alone when coverage is absent or half-reported', () => {
      expect(periodCuts({ until_period: '2031-06' }, ['A'])[0]?.period).toBe('2031');
      expect(periodCuts({ until_period: '2031-06' }, ['A'], { oldest: '1975' })[0]?.period).toBe(
        '2031',
      );
      expect(periodCuts({ since_period: '1974-06' }, ['A'], { latest: '2025' })[0]?.period).toBe(
        '1974',
      );
    });

    it('compares coverage reported in another frequency by day', () => {
      expect(
        periodCuts({ until_period: '2026-S2' }, ['W'], { oldest: '2000-W01', latest: '2026-W32' }),
      ).toEqual([]);
      expect(
        periodCuts({ since_period: '2026-08' }, ['Q'], { oldest: '1983-01', latest: '2026-08' }),
      ).toEqual([{ bounds: ['since_period'], frequency: 'quarterly', period: '2026-Q3' }]);
    });

    it('treats a coverage value it cannot parse as unreported', () => {
      expect(
        periodCuts({ until_period: '2031-06' }, ['A'], { latest: 'not a period' })[0]?.period,
      ).toBe('2031');
    });
  });

  describe('input it cannot read', () => {
    it('skips a bound it cannot parse', () => {
      expect(periodCuts({ since_period: 'banana' }, ['A'])).toEqual([]);
    });

    it('skips a frequency code with no calendar span', () => {
      expect(
        periodCuts({ since_period: '2022-06' }, ['H', '', '__proto__', 'constructor', 'a']),
      ).toEqual([]);
    });

    it('still reads the bound it can parse beside one it cannot', () => {
      expect(periodCuts({ since_period: 'banana', until_period: '2022-06' }, ['A'])).toEqual([
        { bounds: ['until_period'], frequency: 'annual', period: '2022' },
      ]);
    });
  });
});

describe('oneDayRange', () => {
  for (const [since, until, date, next] of [
    ['2022-06-15', '2022-06-15', '2022-06-15', '2022-06-16'],
    ['2022-D166', '2022-D166', '2022-06-15', '2022-06-16'],
    ['2022-06-15', '2022-D166', '2022-06-15', '2022-06-16'],
    ['2022-D166', '2022-06-15', '2022-06-15', '2022-06-16'],
    ['2022-06-30', '2022-06', '2022-06-30', '2022-07-01'],
    ['2022-06-30', '2022-Q2', '2022-06-30', '2022-07-01'],
    ['2022', '2022-01-01', '2022-01-01', '2022-01-02'],
    ['2022-07', '2022-07-01', '2022-07-01', '2022-07-02'],
    ['2022-12-31', '2022', '2022-12-31', '2023-01-01'],
    ['2024-02-28', '2024-D059', '2024-02-28', '2024-02-29'],
    ['2023-02-28', '2023-D059', '2023-02-28', '2023-03-01'],
    ['2024-D366', '2024-12-31', '2024-12-31', '2025-01-01'],
    ['2022-W23', '2022-06-06', '2022-06-06', '2022-06-07'],
    ['2022-06-12', '2022-W23', '2022-06-12', '2022-06-13'],
    ['1900-03-01', '1900-03', undefined, undefined],
    ['0099-12-31', '0099', '0099-12-31', '0100-01-01'],
  ] as const) {
    it(`${since} to ${until}: ${date ?? 'not one day'}`, () => {
      expect(oneDayRange({ since_period: since, until_period: until })).toEqual(
        date ? { date, next } : undefined,
      );
    });
  }

  for (const [label, range] of [
    ['two consecutive days', { since_period: '2022-06-15', until_period: '2022-06-16' }],
    ['one month', { since_period: '2022-06', until_period: '2022-06' }],
    ['one year', { since_period: '2022', until_period: '2022' }],
    ['one week', { since_period: '2022-W23', until_period: '2022-W23' }],
    ['a since bound alone', { since_period: '2022-06-15' }],
    ['an until bound alone', { until_period: '2022-06-15' }],
    ['no bound', {}],
    ['a bound it cannot parse', { since_period: 'banana', until_period: '2022-06-15' }],
  ] as const) {
    it(`is not one day for ${label}`, () => {
      expect(oneDayRange(range)).toBeUndefined();
    });
  }
});

describe('frequenciesOf', () => {
  it('reads each frequency from the shape of its period codes', () => {
    expect(
      [
        ...frequenciesOf([
          '2022',
          '2022-S1',
          '2022-T2',
          '2022-Q3',
          '2022-06',
          '2022-W23',
          '2022-06-15',
        ]),
      ].sort(),
    ).toEqual(['A', 'D', 'M', 'Q', 'S', 'T', 'W']);
  });

  it('collapses repeats and reads the letter in either case', () => {
    expect([...frequenciesOf(['2022-q1', '2022-Q2', '2022-M01'])].sort()).toEqual(['M', 'Q']);
  });

  it('skips the blank column of a header-only table and any code of no known shape', () => {
    expect([...frequenciesOf(['', 'H1', '2022-H1', '2022-Z9'])]).toEqual([]);
  });
});

/** The rule the tools state: every row below is an acceptance case of the three-way split. */
describe('diagnoseEmptyRange', () => {
  const coverage = { oldest: '1975', latest: '2025' };
  const NONE = {};

  describe('a range that misses the reported coverage', () => {
    for (const [since, until] of [
      ['2030', '2031'],
      ['1960', '1970'],
      ['2030', undefined],
      [undefined, '1960'],
      ['2030-06', '2031-06'],
    ] as const) {
      it(`${since ?? '…'} to ${until ?? '…'}`, () => {
        expect(
          diagnoseEmptyRange({ since_period: since, until_period: until }, ['A'], coverage),
        ).toEqual({ kind: 'outside_coverage', coverage });
      });
    }

    it('misses on the one side coverage reports', () => {
      expect(diagnoseEmptyRange({ since_period: '2030' }, ['A'], { latest: '2025' }).kind).toBe(
        'outside_coverage',
      );
    });

    it('takes a selection made with no bound as outside coverage, as it always was', () => {
      expect(diagnoseEmptyRange({}, ['A'], coverage)).toEqual({
        kind: 'outside_coverage',
        coverage,
      });
    });
  });

  describe('a bound that falls inside a period', () => {
    for (const [label, since, until, frequencies, cover, expected] of [
      [
        'each bound alone selects one',
        '2022-06',
        '2023-06',
        ['A'],
        coverage,
        [
          { bounds: ['since_period'], frequency: 'annual', period: '2022' },
          { bounds: ['until_period'], frequency: 'annual', period: '2023' },
        ],
      ],
      [
        'one bound falls inside',
        '2020-06',
        '2020',
        ['A'],
        coverage,
        [{ bounds: ['since_period'], frequency: 'annual', period: '2020' }],
      ],
      [
        'the last covered period',
        '2025-06',
        '2031',
        ['A'],
        coverage,
        [{ bounds: ['since_period'], frequency: 'annual', period: '2025' }],
      ],
      [
        'the first covered period, the other bound past it',
        '1974-06',
        '1975-06',
        ['A'],
        coverage,
        [{ bounds: ['until_period'], frequency: 'annual', period: '1975' }],
      ],
      [
        'neither bound alone selects one',
        '2022-06',
        '2022-06',
        ['A'],
        coverage,
        [{ bounds: ['since_period', 'until_period'], frequency: 'annual', period: '2022' }],
      ],
      [
        'one day on annual data',
        '2022-06-15',
        '2022-06-15',
        ['A'],
        coverage,
        [{ bounds: ['since_period', 'until_period'], frequency: 'annual', period: '2022' }],
      ],
      [
        'the finest of a mixed frequency, with no coverage',
        '2023-06-10',
        '2023-06-20',
        ['A', 'M'],
        NONE,
        [{ bounds: ['since_period', 'until_period'], frequency: 'monthly', period: '2023-06' }],
      ],
      [
        'the coarser frequency when the finer one holds whole periods',
        '2023-06',
        '2023-12',
        ['A'],
        NONE,
        [{ bounds: ['since_period'], frequency: 'annual', period: '2023' }],
      ],
    ] as const) {
      it(label, () => {
        expect(
          diagnoseEmptyRange({ since_period: since, until_period: until }, [...frequencies], cover),
        ).toEqual({ kind: 'no_whole_period', coverage: cover, cuts: expected });
      });
    }
  });

  describe('a range that overlaps coverage with no bound inside a period', () => {
    for (const [label, since, until, frequencies, cover] of [
      [
        'a weekend',
        '2022-06-18',
        '2022-06-19',
        ['D'],
        { oldest: '1974-07-01', latest: '2026-10-31' },
      ],
      ['a survey gap', '2020', '2020', ['A'], { oldest: '2002', latest: '2022' }],
      ['past a dataset that reports no coverage', '2031', '2032', ['A', 'M'], NONE],
      ['a frequency the reply never lists', '2022-06', '2022-06', [], coverage],
    ] as const) {
      it(label, () => {
        expect(
          diagnoseEmptyRange({ since_period: since, until_period: until }, [...frequencies], cover),
        ).toEqual({ kind: 'no_published_period', coverage: cover });
      });
    }

    it('takes a suppressed cut as no bound inside a period', () => {
      expect(
        diagnoseEmptyRange({ since_period: '1974-06', until_period: '1975' }, ['A'], coverage).kind,
      ).toBe('no_published_period');
    });
  });

  describe('a whole period inside the range is not what emptied it', () => {
    const surveys = { oldest: '2002', latest: '2022' };

    for (const [label, since, until, frequencies, cover] of [
      ['a skipped year between two cut years', '2019-06', '2021-06', ['A'], surveys],
      ['a skipped year after a bound on its edge', '2019', '2021-06', ['A'], surveys],
      ['a skipped year before a bound on its edge', '2019-06', '2021', ['A'], surveys],
      ['a skipped month, with no coverage', '2023-01-15', '2023-03-15', ['M'], NONE],
      ['a skipped week between two cut weeks', '2022-06-15', '2022-06-29', ['W'], NONE],
    ] as const) {
      it(label, () => {
        expect(
          diagnoseEmptyRange({ since_period: since, until_period: until }, [...frequencies], cover),
        ).toEqual({ kind: 'no_published_period', coverage: cover });
      });
    }

    it('falls to the coarser frequency the range holds no whole period of', () => {
      expect(
        diagnoseEmptyRange({ since_period: '2022-06-10', until_period: '2022-08-20' }, ['A', 'M'], {
          oldest: '2000',
          latest: '2025',
        }),
      ).toEqual({
        kind: 'no_whole_period',
        coverage: { oldest: '2000', latest: '2025' },
        cuts: [{ bounds: ['since_period', 'until_period'], frequency: 'annual', period: '2022' }],
      });
    });

    it('counts no whole period that lies before the reported coverage', () => {
      expect(
        diagnoseEmptyRange({ since_period: '1960-06', until_period: '1975-06' }, ['A'], coverage),
      ).toEqual({
        kind: 'no_whole_period',
        coverage,
        cuts: [{ bounds: ['until_period'], frequency: 'annual', period: '1975' }],
      });
    });

    it('keeps the cut when an open side leaves nothing to measure against', () => {
      expect(diagnoseEmptyRange({ until_period: '2023-06' }, ['A'], NONE)).toEqual({
        kind: 'no_whole_period',
        coverage: NONE,
        cuts: [{ bounds: ['until_period'], frequency: 'annual', period: '2023' }],
      });
    });

    it('closes an open side at the reported coverage', () => {
      expect(diagnoseEmptyRange({ since_period: '2025-06' }, ['A'], coverage)).toEqual({
        kind: 'no_whole_period',
        coverage,
        cuts: [{ bounds: ['since_period'], frequency: 'annual', period: '2025' }],
      });
    });
  });
});

describe('cutNotice', () => {
  it('states the pinned sentence, in the literals the caller sent', () => {
    expect(
      cutNotice([{ bounds: ['since_period'], frequency: 'annual', period: '2022' }], {
        since_period: '2022-06',
        until_period: '2024',
      }),
    ).toBe(
      'since_period "2022-06" falls inside annual period 2022, which Eurostat excludes: it keeps only periods wholly inside the range. since_period "2022" includes that period if this slice has it.',
    );
  });

  it('names the bound that fell inside for an until cut', () => {
    expect(
      cutNotice([{ bounds: ['until_period'], frequency: 'semester', period: '2023-S2' }], {
        until_period: '2023-08',
      }),
    ).toBe(
      'until_period "2023-08" falls inside semester period 2023-S2, which Eurostat excludes: it keeps only periods wholly inside the range. until_period "2023-S2" includes that period if this slice has it.',
    );
  });

  it('needs both bounds moved when both fall inside the one period', () => {
    expect(
      cutNotice(
        [{ bounds: ['since_period', 'until_period'], frequency: 'annual', period: '2023' }],
        { since_period: '2023-06', until_period: '2023-08' },
      ),
    ).toBe(
      'since_period "2023-06" and until_period "2023-08" fall inside annual period 2023, which Eurostat excludes: it keeps only periods wholly inside the range. since_period "2023" and until_period "2023" together include that period if this slice has it.',
    );
  });

  it('gives each cut its own sentence', () => {
    const notice = cutNotice(
      [
        { bounds: ['since_period'], frequency: 'monthly', period: '2023-06' },
        { bounds: ['since_period'], frequency: 'annual', period: '2023' },
      ],
      { since_period: '2023-06-15' },
    );
    expect(notice.match(/falls inside/g)).toHaveLength(2);
    expect(notice).toContain('monthly period 2023-06');
    expect(notice).toContain('annual period 2023');
  });
});
