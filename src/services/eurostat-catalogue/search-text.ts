/**
 * @fileoverview Text as catalogue search reads it — folding and the word-start test, shared
 * by the catalogue's own text and the dimension value labels it falls back to.
 * @module services/eurostat-catalogue/search-text
 */

/**
 * Whitespace beside punctuation other than `_`, removed from search text so `Rev.2` finds
 * `Rev. 2` and `2015=100` finds `2015 = 100`. A run is taken whole after a punctuation mark,
 * or from its first blank when one follows it — never retried from inside a run, so the
 * fold is linear in the text length.
 */
const SPACE_BESIDE_PUNCTUATION = /(?<=[^\p{L}\p{N}_\s])\s+|(?<!\s)\s+(?=[^\p{L}\p{N}_\s])/gu;

/** A character that continues a word: a phrase found right after one starts mid-word. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** `text` as search reads it: lowercased, with whitespace beside punctuation removed. */
export function foldSearchText(text: string): string {
  return text.toLowerCase().replace(SPACE_BESIDE_PUNCTUATION, '');
}

/** Whether `text` has a letter or digit at `at - 1`, so a match at `at` starts mid-word. */
export function continuesWord(text: string, at: number): boolean {
  return at > 0 && LETTER_OR_DIGIT.test(text.charAt(at - 1));
}

/** Whether `needle` occurs in `text` with no letter or digit right before it. */
export function occursAtWordStart(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (!continuesWord(text, at)) return true;
  }
  return false;
}
