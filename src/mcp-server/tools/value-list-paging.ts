/**
 * @fileoverview Paging and word filtering for a dimension's code/label list:
 * the byte budget each response surface is held to, the search for the most
 * whole values a page can carry within it, and the case- and accent-blind
 * token match the filter applies.
 * @module mcp-server/tools/value-list-paging
 */

/**
 * UTF-8 bytes each response surface may carry, charged separately to the
 * serialized structuredContent and to the content[] text (every block,
 * enrichment trailer included). A code constant, not an env var, so a page's
 * size cannot drift between deployments. structuredContent is the larger
 * surface on every list measured, so it is the one that ends a page.
 */
export const INLINE_BUDGET_BYTES = 64_000;

/** Byte length of `text` once UTF-8 encoded — what a surface costs on the wire. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Bytes on each response surface. */
export interface SurfaceBytes {
  structured: number;
  text: number;
}

const fits = (size: SurfaceBytes) =>
  size.structured <= INLINE_BUDGET_BYTES && size.text <= INLINE_BUDGET_BYTES;

/**
 * The most values, out of `count`, a page can carry within the budget on both
 * surfaces — never fewer than one, even when that one alone exceeds it. `measure(k)` gives the exact bytes of the
 * response carrying the first `k` values; `costOf(i)` what value `i` adds to
 * each surface. The costs grow an estimate from a one-value response, so only
 * the values that can fit are serialized, and `measure` then settles the exact
 * answer: the response's own fields (the cursor, the notice) differ by a few
 * bytes from one page length to the next.
 */
export function fitPage(
  count: number,
  measure: (k: number) => SurfaceBytes,
  costOf: (index: number) => SurfaceBytes,
): number {
  if (count === 0) return 0;
  let { structured, text } = measure(1);
  let k = 1;
  while (k < count) {
    const next = costOf(k);
    if (
      structured + next.structured > INLINE_BUDGET_BYTES ||
      text + next.text > INLINE_BUDGET_BYTES
    ) {
      break;
    }
    structured += next.structured;
    text += next.text;
    k++;
  }
  while (k > 1 && !fits(measure(k))) k--;
  while (k < count && fits(measure(k + 1))) k++;
  return k;
}

/** Lowercase, compatibility-decompose, and drop combining marks: "Zürich" → "zurich". */
export function foldForMatch(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

/**
 * The distinct folded words of a filter, split on whitespace. Punctuation stays
 * part of a word, so `DE_EDDF` and `frankfurt/main` match literally. Empty when
 * nothing but whitespace or combining marks was given.
 */
export function filterTokens(filter: string): string[] {
  return [...new Set(foldForMatch(filter).split(/\s+/).filter(Boolean))];
}

/**
 * The values whose code and label, joined by a space and folded, contain every
 * token as a substring — in the list's own order, with no ranking.
 */
export function matchValues<T extends { code: string; label: string }>(
  values: readonly T[],
  tokens: readonly string[],
): T[] {
  return values.filter((value) => {
    const haystack = foldForMatch(`${value.code} ${value.label}`);
    return tokens.every((token) => haystack.includes(token));
  });
}
