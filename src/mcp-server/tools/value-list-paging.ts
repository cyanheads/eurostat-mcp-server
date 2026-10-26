/**
 * @fileoverview Case- and accent-blind word filtering for dimension code/label lists.
 * @module mcp-server/tools/value-list-paging
 */

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
