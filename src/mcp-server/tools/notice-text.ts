/**
 * @fileoverview Wording the two data tools' notices share: counts, period spans, and the
 * listing of filter values that matched no data.
 * @module mcp-server/tools/notice-text
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { formatValues } from '@/mcp-server/tools/narrowing-advice.js';

/**
 * Filter values named in a notice; the structured `emptyValues` keeps every one. A
 * `geo_level` query can have hundreds.
 */
const VALUES_LISTED = 24;

/** `1 period`, `3 periods`. */
export const countOf = (n: number, noun: string): string =>
  `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

/** `2026-08`, or `1975 – 1980` for several periods. */
export function spanOf(periods: string[]): string {
  return periods.length === 1 ? (periods[0] ?? '') : `${periods[0]} – ${periods.at(-1)}`;
}

/**
 * The filter values that matched no data: their total, and the first {@link VALUES_LISTED}
 * as `geo=[DE, XX]; age=[ZZZ]` (escaped for Markdown) with a count of those left out.
 */
export function listEmptyValues(values: Record<string, string[]>): { list: string; total: number } {
  const total = Object.values(values).reduce((n, codes) => n + codes.length, 0);
  const listed: Record<string, string[]> = {};
  let room = VALUES_LISTED;
  for (const [key, codes] of Object.entries(values)) {
    if (room === 0) break;
    const shown = codes.slice(0, room);
    listed[key] = shown;
    room -= shown.length;
  }
  const omitted = total - (VALUES_LISTED - room);
  return {
    list: `${formatValues(listed, escapeMarkdownInline)}${omitted ? ` (${omitted.toLocaleString('en-US')} more omitted; emptyValues lists all ${total.toLocaleString('en-US')})` : ''}`,
    total,
  };
}
