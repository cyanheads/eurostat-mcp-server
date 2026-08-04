/**
 * @fileoverview Domain types for the Eurostat Statistics API (JSON-stat 2.0) service.
 * @module services/eurostat-data/types
 */

/** Raw JSON-stat 2.0 response from the Statistics API. */
export interface JsonStatResponse {
  dimension?: Record<string, JsonStatDimension>;
  error?: Array<{ status: number; id: number; label: string }>;
  extension?: JsonStatExtension;
  /** Ordered list of dimension names. */
  id?: string[];
  /** Dataset label. */
  label?: string;
  /** Element count per dimension (same order as id). */
  size?: number[];
  /** Status codes for non-normal observations: linear_index (as string) → status code. */
  status?: Record<string, string>;
  /** Flat dict: linear_index → numeric value (or null for missing). */
  value?: Record<string, number | null>;
  /** Async/error response structures. */
  warning?: { status: number; label: string };
}

export interface JsonStatDimension {
  category?: {
    index?: Record<string, number>;
    label?: Record<string, string>;
  };
  label?: string;
}

export interface JsonStatExtension {
  annotation?: Array<{
    type?: string;
    title?: string;
    date?: string;
    href?: string;
  }>;
  status?: {
    label?: Record<string, string>;
  };
}

/** A decoded observation from JSON-stat. */
export interface Observation {
  /** One entry per dimension: code + label. */
  dimensions: Record<string, { code: string; label: string }>;
  status?: { code: string; label: string };
  value: number | null;
}

/**
 * One observation flattened into a dataframe row.
 *
 * A dataframe column holds a scalar, so `Observation`'s nested `{code, label}`
 * pair per dimension is split across two columns — `<dim>` for the code and
 * `<dim>_label` for the label — and the status flag likewise. The measure
 * columns carry the `obs_` prefix Eurostat's own SDMX-CSV output uses, which
 * also keeps them clear of any dimension code.
 */
export type ObservationRow = Record<string, string | number | null>;

/** Measure column names — the non-dimension columns of an {@link ObservationRow}. */
export const OBS_VALUE_COLUMN = 'obs_value';
export const OBS_FLAG_COLUMN = 'obs_flag';
export const OBS_FLAG_LABEL_COLUMN = 'obs_flag_label';

/**
 * Metadata about a dataset extracted from a JSON-stat response.
 *
 * Annotation-derived fields are absent when Eurostat does not report them, rather than
 * defaulted — a missing count is not a zero, and a missing period bound is not an empty string.
 */
export interface DatasetMeta {
  code: string;
  dimensions: DimensionInfo[];
  label: string;
  lastUpdated?: string;
  metadataUrl?: string;
  obsCount?: number;
  timeRange: { start?: string; end?: string };
}

/**
 * One dimension of a dataset.
 *
 * `valuesCount`/`sampleValues` are absent when the dimension's value set could not be
 * measured. That happens for `time`, whose real period range takes a second request the
 * rest of the metadata does not depend on: when that request fails, the fields are omitted
 * rather than filled from the one-period slice, which would report a period count of 1 for
 * every dataset.
 */
export interface DimensionInfo {
  code: string;
  label: string;
  /** First 10 values as orientation. Absent when the value set was not measured. */
  sampleValues?: Array<{ code: string; label: string }>;
  /**
   * Distinct values for this dimension: the dataset's full period set for `time`, the most
   * recent period's codelist otherwise. Absent when the value set was not measured.
   */
  valuesCount?: number;
}

export interface DimensionValuesResult {
  dimensionCode: string;
  dimensionLabel: string;
  totalCount: number;
  values: Array<{ code: string; label: string }>;
}

/**
 * A decoded query result.
 *
 * `observations` is capped at `OBS_CAP`; `obsCount`, `missingObsCount` and `timeRange`
 * describe the whole match, so `obsCount` and `observations.length` diverge whenever the
 * cap bites. They are counted from the response's cell keys rather than from the decoded
 * array, so capping never changes what they report.
 *
 * `timeRange` bounds are absent when neither the returned observations nor the dataset-wide
 * annotations report them — an unknown bound is not an empty period.
 */
export interface QueryResult {
  /** Filters actually sent upstream — the requested filters minus any zero-length arrays. */
  appliedFilters: Record<string, string[]>;
  datasetCode: string;
  datasetLabel: string;
  dimensionsUsed: string[];
  /** Observations with no value across the whole match, not just the decoded page. */
  missingObsCount: number;
  /** Observations matched upstream, before the `OBS_CAP` decode cap. */
  obsCount: number;
  /** Decoded observations, capped at `OBS_CAP` — the first cap rows in linear-index order. */
  observations: Observation[];
  timeRange: { start?: string; end?: string };
}

/**
 * A query result plus a lazy row source over everything it matched.
 *
 * `observations` stops at `OBS_CAP`; `rows()` does not. Both read the same
 * single walk of the response, so the capped list is always a prefix of the row
 * source rather than a separately-derived set that can drift from it.
 */
export interface QueryExecution extends QueryResult {
  /**
   * Fresh generator over every matched cell, in the same order `observations`
   * uses. Nothing is materialized until a consumer pulls, so staging a
   * million-cell match costs one row object at a time rather than an array of
   * them — the allocation `OBS_CAP` exists to avoid.
   */
  rows: () => Generator<ObservationRow>;
}

/**
 * Upper bound on decoded observations returned for one query.
 *
 * Applied inside the decoder, so an oversized match never materializes as observation
 * objects. The totals alongside `observations` stay honest about the full match.
 */
export const OBS_CAP = 5_000;

export type GeoLevel = 'aggregate' | 'country' | 'nuts1' | 'nuts2' | 'nuts3';

/** Tuple of valid GeoLevel values — use with `z.enum(GEO_LEVEL_VALUES)` in tool schemas. */
export const GEO_LEVEL_VALUES = [
  'aggregate',
  'country',
  'nuts1',
  'nuts2',
  'nuts3',
] as const satisfies readonly GeoLevel[];
