/**
 * @fileoverview Domain types for the Eurostat Statistics API (JSON-stat 2.0) service.
 * @module services/eurostat-data/types
 */

import type { EmptyRange, PeriodCut } from '@/services/eurostat-periods.js';

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
  /**
   * Flat dict: linear_index → value. Numeric, or null for missing — except on the
   * PRODCOM collections, which publish flag and unit indicators as text (`":C"`, `"KG"`).
   */
  value?: Record<string, number | string | null>;
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
  /** Numeric value; null when missing, withheld, or published as text. */
  value: number | null;
  /**
   * A value Eurostat published as text rather than a number (a PRODCOM unit such as
   * `KG`), verbatim. Absent for numeric and missing values; `:C` decodes to
   * `confStatus` instead.
   */
  valueText?: string;
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
  /**
   * The dimension's whole list, narrowed only by an explicit geo level: for `geo`
   * without one, every level, beside the `country` default `values` holds.
   */
  listedValues: ListedValue[];
  totalCount: number;
  values: Array<{ code: string; label: string }>;
}

/**
 * A dimension value as the dataset lists it; a `geo` value also carries its NUTS
 * level. A type alias, not an interface, so a list of them stages as canvas rows.
 */
export type ListedValue = {
  code: string;
  label: string;
  /**
   * Set on `geo` values only. Null when the code's codelist entry has no LEVEL
   * annotation, or one no {@link GeoLevel} maps (`5` capital regions, `OTH` groupings).
   */
  level?: GeoLevel | null;
};

/**
 * A decoded query result.
 *
 * `observations` is the caller-bounded deterministic prefix; `obsCount`,
 * `missingObsCount`, `absentCellCount` and `timeRange` describe the whole match. They are
 * counted from the response's cell keys rather than from the decoded array, so previewing
 * never changes what they report.
 *
 * `timeRange` bounds are absent when neither the returned observations nor the dataset-wide
 * annotations report them — an unknown bound is not an empty period.
 */
export interface QueryResult {
  /**
   * Periods the matched series lack: for each series (one combination of the non-time
   * dimensions) with at least one cell, the periods of a frequency it carries in which it
   * has neither a value nor a status, counted only from that frequency's first to its
   * latest period with a cell in any series. Not observations, so no count or row
   * includes them.
   */
  absentCellCount: number;
  /** Filters actually sent upstream — the requested filters minus any zero-length arrays. */
  appliedFilters: Record<string, string[]>;
  datasetCode: string;
  datasetLabel: string;
  dimensionsUsed: string[];
  /**
   * Values the query selects that the reply lists but no cell of the match carries, keyed
   * by dimension: filter values under the key and in the spelling sent, each once, and
   * under `geo_level` every `geo` code of the level. Never a value `unmatchedValues` holds,
   * a time value, or a value of a dimension that neither filters nor `geo_level` selects.
   * Absent when every one has a cell.
   */
  emptyValues?: Record<string, string[]>;
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
 * One frequency's periods without a cell in any series that lie outside the span its
 * cells cover, each list chronological. `edges`: some period of the frequency has a
 * cell, and these are the periods before `first` and after `last`. `empty`: no period of
 * the frequency has a cell in the match.
 */
export type OutsideSpan = { frequency: string } & (
  | { after: string[]; before: string[]; first: string; kind: 'edges'; last: string }
  | { kind: 'empty'; periods: string[] }
);

/**
 * What an empty JSON-stat match says about why it is empty, carried on a
 * `no_results` error's data. The members co-occur — an unmatched value can sit
 * beside periods that carry no value — and all are absent when the reply says
 * nothing more than "empty".
 */
export interface NoResultsDiagnosis {
  /** Set when the reply's `time` dimension is empty: why the range selected no period. */
  emptyRange?: EmptyRange;
  /** Periods the reply selected, none carrying a value. Set only when every dimension matched. */
  matchedPeriods?: string[];
  unmatchedValues?: UnmatchedValues;
}

/**
 * The values a `no_results` error lists for each dimension holding an unmatched filter
 * value, keyed by dimension as sent: `totalCount` counts every value the dimension
 * lists (every `geo` level), and `values` holds each code and label when there are at
 * most 25. A dimension whose values could not be read is absent.
 */
export type ValidValues = Record<
  string,
  { totalCount: number; values?: Array<{ code: string; label: string }> }
>;

/**
 * What a Statistics API query that outlasted its deadline carries on its
 * `retry_deadline_exceeded` Timeout, beside the fields `withRetry` sets.
 */
export interface StatisticsDeadlineData {
  datasetCode: string;
  deadlineMs: number;
  elapsedMs: number;
  /**
   * Whether the last request had its response status and headers before it failed. False
   * when the deadline cut Eurostat off while it was still preparing the extraction; true
   * when the answer was arriving, or when it came back as an error and a backoff was cut.
   */
  headersReceived: boolean;
  reason: 'retry_deadline_exceeded';
  retryAttempts: number;
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
   * The series `absentCellCount` falls in, of the series with at least one cell. Set only
   * when `absentCellCount` is above zero.
   */
  absentSeries?: { affected: number; total: number };
  /**
   * The period of a known shape with a cell that ends last, across frequencies. Set
   * alongside `outsideSpans` whenever such a period exists.
   */
  latestWithCell?: string;
  /**
   * Per frequency, finest first, the periods no series has a cell in outside the span from
   * that frequency's first to its latest period with one, which `absentCellCount` leaves
   * out. Set only when some frequency has such a period.
   */
  outsideSpans?: OutsideSpan[];
  /** Periods a bound excludes, read from the reply's own frequencies and coverage. */
  periodCuts?: PeriodCut[];
  /**
   * Fresh generator over every matched cell, in the same order `observations`
   * uses. Nothing is materialized until a consumer pulls, so staging a
   * million-cell match costs one row object at a time rather than an array of
   * them — the allocation `OBS_CAP` exists to avoid.
   */
  rows: () => Generator<ObservationRow>;
  /**
   * Selected last-N time positions without any in-range value/status cell, in index order:
   * those `outsideSpans` lists, and any inside a span or of no known period shape.
   */
  unpopulatedPeriods?: string[];
}

/**
 * Decode safety limit and automatic staging threshold for a full matched result.
 *
 * The public preview limit is lower, but the decoder still enforces this ceiling. Matches
 * above it stage automatically; callers can explicitly stage smaller matches. Totals remain uncapped.
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
