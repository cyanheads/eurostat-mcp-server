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

export interface DimensionInfo {
  code: string;
  label: string;
  /** First 10 values as orientation. */
  sampleValues: Array<{ code: string; label: string }>;
  /** Distinct values for this dimension: the dataset's full period set for `time`, the most recent period's codelist otherwise. */
  valuesCount: number;
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
 * `timeRange` bounds are absent when neither the returned observations nor the dataset-wide
 * annotations report them — an unknown bound is not an empty period.
 */
export interface QueryResult {
  /** Filters actually sent upstream — the requested filters minus any zero-length arrays. */
  appliedFilters: Record<string, string[]>;
  datasetCode: string;
  datasetLabel: string;
  dimensionsUsed: string[];
  missingObsCount: number;
  obsCount: number;
  observations: Observation[];
  timeRange: { start?: string; end?: string };
}

export type GeoLevel = 'aggregate' | 'country' | 'nuts1' | 'nuts2' | 'nuts3';

/** Tuple of valid GeoLevel values — use with `z.enum(GEO_LEVEL_VALUES)` in tool schemas. */
export const GEO_LEVEL_VALUES = [
  'aggregate',
  'country',
  'nuts1',
  'nuts2',
  'nuts3',
] as const satisfies readonly GeoLevel[];
