/**
 * @fileoverview Local check of the period literals `since_period`/`until_period`
 * carry, run by both data tools before any request reaches Eurostat.
 * @module services/eurostat-periods
 */

/**
 * The accepted forms, as the tools' descriptions and recovery hints state them.
 * `YYYY-A1`, the SDMX annual form, is read as well and sent as `YYYY`.
 */
export const PERIOD_FORMS =
  'YYYY, YYYY-MM, YYYY-MM-DD, YYYY-Qn (1–4), YYYY-Sn (1–2), YYYY-Tn (1–3), YYYY-Mnn (01–12), YYYY-Wnn (a week the year has, up to 53) or YYYY-Dnnn (a day the year has, up to 366)';

/**
 * `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, the annual `YYYY-A1`, or a frequency letter (in
 * either case) followed by its number: `YYYY-Qn`, `YYYY-Sn`, `YYYY-Tn`, `YYYY-Mnn`,
 * `YYYY-Wnn`, `YYYY-Dnnn`.
 *
 * Read off live probes of both endpoints: each shape here is parsed the same way by
 * the Statistics API and the SDMX bulk endpoint once it is in the form {@link
 * normalizePeriod} sends. The number after the letter may carry extra leading zeros
 * (`2020-Q01`, `2020-W001`) — the bulk endpoint reads those, the Statistics API
 * refuses them. Month and day in `YYYY-MM`/`YYYY-MM-DD` stay exactly two digits
 * (both endpoints refuse `2020-1`). Frequency is deliberately not checked — both
 * endpoints map a literal of another frequency (`2020-01` on annual data) onto the
 * dataset's own.
 */
const PERIOD_SHAPE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?|-(A)0{0,3}1|-([QSTMWD])(\d{1,4}))?$/i;

type Frequency = 'Q' | 'S' | 'T' | 'M' | 'W' | 'D';

/**
 * Per frequency letter: the digits its canonical form keeps and the largest number
 * any year has. Weeks and days are further bounded by the year itself.
 */
const COMPONENT: Record<Frequency, { max: number; name: string; width: number }> = {
  Q: { name: 'quarter', max: 4, width: 1 },
  S: { name: 'semester', max: 2, width: 1 },
  T: { name: 'trimester', max: 3, width: 1 },
  M: { name: 'month', max: 12, width: 2 },
  W: { name: 'week', max: 53, width: 2 },
  D: { name: 'day', max: 366, width: 3 },
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Characters of an offending value echoed back before it is cut short. */
const ECHO_LIMIT = 40;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/**
 * ISO 8601 weeks in a year: 53 when the year starts on a Thursday, or on a
 * Wednesday in a leap year, otherwise 52. Asking either endpoint for week 53 of
 * a 52-week year silently returns data from week 1 of the next year.
 */
function isoWeeksInYear(year: number): number {
  const weekday = (y: number) =>
    (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)) % 7;
  return weekday(year) === 4 || weekday(year - 1) === 3 ? 53 : 52;
}

/** Days since 1970-01-01 (UTC). `setUTCFullYear` keeps years 0–99 literal, where `Date.UTC` would add 1900. */
function dayNumber(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime() / 86_400_000;
}

/** First and last day of months `from`–`to` of `year`, as {@link dayNumber}s. */
const monthSpan = (year: number, from: number, to: number): [number, number] => [
  dayNumber(year, from, 1),
  dayNumber(year, to, daysInMonth(year, to)),
];

/** First and last day of ISO week `week`: week 1 is the one holding 4 January. */
function isoWeekSpan(year: number, week: number): [number, number] {
  const jan4 = dayNumber(year, 1, 4);
  const mondayOffset = (((jan4 + 3) % 7) + 7) % 7; // 1970-01-01, day 0, was a Thursday
  const first = jan4 - mondayOffset + 7 * (week - 1);
  return [first, first + 6];
}

/** First and last day each frequency number covers. */
const FREQUENCY_SPAN: Record<Frequency, (year: number, n: number) => [number, number]> = {
  Q: (year, n) => monthSpan(year, 3 * n - 2, 3 * n),
  S: (year, n) => monthSpan(year, 6 * n - 5, 6 * n),
  T: (year, n) => monthSpan(year, 4 * n - 3, 4 * n),
  M: (year, n) => monthSpan(year, n, n),
  W: isoWeekSpan,
  D: (year, n) => {
    const day = dayNumber(year, 1, n);
    return [day, day];
  },
};

/**
 * A checked period: the literal to send, and the first and last day it covers as
 * {@link dayNumber}s. The span is what lets two bounds of different frequencies be
 * compared.
 */
export interface Period {
  firstDay: number;
  lastDay: number;
  period: string;
}

/**
 * The period to send upstream, or why there is none.
 *
 * A literal already in the form both endpoints read comes back unchanged, letter
 * case included. Otherwise it comes back rewritten to that form, the letter's case
 * kept as sent: a frequency number with extra leading zeros is cut to its canonical
 * width (`2020-Q01` → `2020-Q1`, `2020-W001` → `2020-W01`), a day of the year is
 * always sent as three digits (`2026-D1` → `2026-D001`, the only width the
 * Statistics API reads), and `YYYY-A1` is sent as `YYYY`, which the Statistics API
 * reads and `YYYY-A1` it does not.
 *
 * Beyond the shape, every component must exist: month 01–12, quarter 1–4,
 * semester 1–2, trimester 1–3, a week the ISO year has, a day the year has, and a
 * real calendar day. Both endpoints accept some out-of-range components and
 * silently roll them into a neighbouring period (`2020-13` becomes 2021-01 on the
 * bulk endpoint, `2021-W53` becomes 2022-W01 on both), so an unchecked one returns
 * data for a range the caller never asked for.
 */
export function normalizePeriod(period: string): Period | { problem: string } {
  const match = PERIOD_SHAPE.exec(period);
  if (!match) return { problem: 'it is not one of the accepted period forms' };
  const [, yearText = '', monthText, dayText, annual, letter, digits] = match;
  const year = Number(yearText);
  const wholeYear = () => {
    const [firstDay, lastDay] = monthSpan(year, 1, 12);
    return { firstDay, lastDay };
  };

  if (annual !== undefined) return { period: yearText, ...wholeYear() };

  if (monthText !== undefined) {
    const month = Number(monthText);
    if (month < 1 || month > 12) return { problem: `month ${monthText} is outside 01–12` };
    if (dayText === undefined) {
      const [firstDay, lastDay] = monthSpan(year, month, month);
      return { period, firstDay, lastDay };
    }
    const day = Number(dayText);
    const last = daysInMonth(year, month);
    if (day < 1 || day > last) {
      return {
        problem: `day ${dayText} does not exist: ${MONTH_NAMES[month - 1]} ${yearText} has ${last} days`,
      };
    }
    const firstDay = dayNumber(year, month, day);
    return { period, firstDay, lastDay: firstDay };
  }

  if (letter === undefined || digits === undefined) return { period, ...wholeYear() };
  const kind = letter.toUpperCase() as Frequency;
  const n = Number(digits);
  const { name, max, width } = COMPONENT[kind];
  if (n < 1 || n > max) return { problem: `${name} ${n} is outside 1–${max}` };
  if (kind === 'W' && n > isoWeeksInYear(year)) {
    return { problem: `week ${n} does not exist: ${yearText} has 52 ISO weeks` };
  }
  if (kind === 'D' && n === 366 && !isLeapYear(year)) {
    return { problem: `day 366 does not exist: ${yearText} has 365 days` };
  }

  const number = digits.length < width && kind !== 'D' ? digits : String(n).padStart(width, '0');
  const [firstDay, lastDay] = FREQUENCY_SPAN[kind](year, n);
  return { period: `${yearText}-${letter}${number}`, firstDay, lastDay };
}

/**
 * Check both period bounds, `since_period` first, and return them in the form to
 * send upstream (and echo back). Pass the values after trimming — a blank bound is
 * "no bound" and never reaches this check.
 *
 * With both bounds set, the range must hold at least one day: it is empty when
 * `since_period`'s period starts after `until_period`'s ends. Comparing the start of
 * one against the end of the other keeps a cross-frequency pair such as `2020-06`
 * to `2020` valid. Neither endpoint rejects an inverted range — the Statistics API
 * answers with everything outside the gap, the bulk endpoint with the whole series.
 *
 * Returns the first failure's caller-facing message — naming the parameter, the
 * value as sent, and what is wrong with it — rather than throwing, so the calling
 * tool raises it through its own typed error contract.
 */
export function resolvePeriods(bounds: {
  since_period?: string | undefined;
  until_period?: string | undefined;
}): { ok: true; since_period?: string; until_period?: string } | { ok: false; message: string } {
  const checked: Partial<Record<'since_period' | 'until_period', Period>> = {};
  for (const param of ['since_period', 'until_period'] as const) {
    const value = bounds[param];
    if (value === undefined) continue;
    const result = normalizePeriod(value);
    if ('problem' in result) {
      const shown = value.length > ECHO_LIMIT ? `${value.slice(0, ECHO_LIMIT)}…` : value;
      return {
        ok: false,
        message: `${param} "${shown}" is not a valid period: ${result.problem}.`,
      };
    }
    checked[param] = result;
  }

  const { since_period: since, until_period: until } = checked;
  if (since && until && since.firstDay > until.lastDay) {
    return {
      ok: false,
      message: `since_period "${bounds.since_period}" starts after until_period "${bounds.until_period}" ends, so the range holds no period.`,
    };
  }
  return {
    ok: true,
    ...(since && { since_period: since.period }),
    ...(until && { until_period: until.period }),
  };
}
