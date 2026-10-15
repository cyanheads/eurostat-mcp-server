/**
 * @fileoverview Dimension-filter normalization shared by the Statistics API query and the
 * SDMX bulk download, so both tools agree on which filters restrict a request.
 * @module services/eurostat-filters
 */

/**
 * The filters that restrict anything. A blank or whitespace-only value is unset, as an
 * empty array is: it is removed from its array, and a dimension left with no value is
 * dropped. Everything downstream — conflict checks, the request, the applied-filters
 * echo, the too-large hint — reads this one set. Non-blank values are kept as given.
 */
export function dropUnsetFilters(filters: Record<string, string[]>): Record<string, string[]> {
  const applied: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(filters)) {
    const set = values.filter((value) => value.trim() !== '');
    if (set.length > 0) applied[key] = set;
  }
  return applied;
}
