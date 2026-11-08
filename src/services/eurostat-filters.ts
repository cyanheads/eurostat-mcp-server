/**
 * @fileoverview Dimension-filter normalization shared by the Statistics API query and the
 * SDMX bulk download, so both tools agree on which filters restrict a request, and the
 * check that names the filter keys a dataset has no dimension for.
 * @module services/eurostat-filters
 */

/**
 * The filters that restrict anything, one code per value. A value holding "+" is split
 * into its pieces: no Eurostat code contains "+", the bulk key reads it as OR, and the
 * Statistics API would match the whole string against no code, so OR is its one reading.
 * A blank or whitespace-only value or piece is unset, as an empty array is: it is removed
 * from its array, and a dimension left with no value is dropped. Everything downstream —
 * conflict checks, the request, the applied-filters echo, the too-large hint — reads this
 * one set. Non-blank pieces are kept as given.
 */
export function normalizeFilters(filters: Record<string, string[]>): Record<string, string[]> {
  const applied: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(filters)) {
    const set = values.flatMap((value) => value.split('+')).filter((piece) => piece.trim() !== '');
    if (set.length > 0) applied[key] = set;
  }
  return applied;
}

/**
 * The filter keys that name no dimension in `dimensionOrder`, compared in any case, in
 * the order given. The caller leaves out keys it accepts outside the dimension key (the
 * query's `time` filter).
 */
export function unknownFilterKeys(dimensionOrder: string[], keys: string[]): string[] {
  const known = new Set(dimensionOrder.map((dim) => dim.toLowerCase()));
  return keys.filter((key) => !known.has(key.toLowerCase()));
}

/** The error sentence naming every unknown filter key and the dataset's dimensions in key order. */
export function unknownDimensionsMessage(unknown: string[], dimensionOrder: string[]): string {
  return `Filter names ${unknown.map((key) => `"${key}"`).join(', ')}, which ${unknown.length === 1 ? 'is not a dimension' : 'are not dimensions'} of this dataset. Filterable dimensions, in key order: ${dimensionOrder.join(', ')}.`;
}
