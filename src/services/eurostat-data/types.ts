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

/**
 * A decoded observation from JSON-stat.
 *
 * `status` and `confStatus` come from two different Eurostat codelists and are
 * carried apart because JSON-stat does not: it folds a `CONF_STATUS` code into
 * the observation status behind a `|`, which the decoder splits back out.
 */
export interface Observation {
  /** `CONF_STATUS` code + label. Absent unless Eurostat restricts this cell. */
  confStatus?: { code: string; label: string };
  /** One entry per dimension: code + label. */
  dimensions: Record<string, { code: string; label: string }>;
  /** `OBS_FLAG` code + label. Absent for an unflagged observation. */
  status?: { code: string; label: string };
  value: number | null;
}

/**
 * One observation flattened into a dataframe row.
 *
 * A dataframe column holds a scalar, so `Observation`'s nested `{code, label}`
 * pair per dimension is split across two columns — `<dim>` for the code and
 * `<dim>_label` for the label — and each of the two flags likewise. The measure
 * columns are the shared set both stagers write, so a table from this service and
 * one from the bulk service carry the same flag columns under the same names.
 */
export type ObservationRow = Record<string, string | number | null>;

/**
 * Metadata about a dataset extracted from its dataset-scoped SDMX structures.
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
 * `valuesCount`/`sampleValues` describe the values the dataset-scoped SDMX content
 * constraint permits. They are absent when that constraint does not enumerate the
 * dimension, rather than inferred from an observation slice that may cover only part of
 * the dataset.
 */
export interface DimensionInfo {
  code: string;
  label: string;
  /** First 10 values as orientation. Absent when the value set was not measured. */
  sampleValues?: Array<{ code: string; label: string }>;
  /**
   * Distinct values permitted by the dataset-scoped content constraint, falling back to the
   * referenced codelist when the constraint omits the dimension. Absent when neither source
   * supplies a measurable value set.
   */
  valuesCount?: number;
}

export interface DimensionValuesResult {
  dimensionCode: string;
  dimensionLabel: string;
  /** Effective hierarchy level for `geo`, including the omitted-input default. */
  geoLevel?: GeoLevel;
  totalCount: number;
  values: Array<{ code: string; label: string }>;
}

/**
 * A decoded query result.
 *
 * `observations` is the caller-bounded deterministic prefix; `obsCount`,
 * `missingObsCount` and `timeRange` describe the whole match. They are counted from the
 * response's cell keys rather than from the decoded array, so previewing never changes
 * what they report.
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
  /** Observations matched upstream, before the inline preview bound. */
  obsCount: number;
  /** Decoded observations — the requested prefix in linear-index order. */
  observations: Observation[];
  timeRange: { start?: string; end?: string };
  /**
   * Filter values the reply matched to nothing, keyed by dimension, spelled as sent.
   * Absent when every value matched.
   */
  unmatchedValues?: UnmatchedValues;
}

/** Filter values that matched nothing, keyed by dimension code, spelled as sent. */
export type UnmatchedValues = Record<string, string[]>;

/**
 * What an empty JSON-stat match says about why it is empty, carried on a
 * `no_results` error's data. The members co-occur — an unmatched value can sit
 * beside periods that carry no value — and all are absent when the reply says
 * nothing more than "empty".
 */
export interface NoResultsDiagnosis {
  /** Periods the reply selected, none carrying a value. Set only when every dimension matched. */
  matchedPeriods?: string[];
  /**
   * Set when the requested range selected no period at all: the dataset's overall
   * coverage from its annotations, each bound absent when Eurostat does not report it.
   */
  outsideCoverage?: { oldest?: string; latest?: string };
  unmatchedValues?: UnmatchedValues;
}

/**
 * A query result plus a lazy row source over everything it matched.
 *
 * `observations` stops at the requested preview bound; `rows()` does not. Both
 * read the same response, so the preview is always a prefix of the row
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
 * Decode safety limit and threshold for staging a full matched result.
 *
 * The public preview limit is lower, but the decoder still enforces this ceiling. Matches
 * above it are the only ones eligible for Canvas staging; totals remain uncapped.
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
