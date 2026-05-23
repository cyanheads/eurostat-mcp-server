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

/** Metadata about a dataset extracted from a JSON-stat response. */
export interface DatasetMeta {
  code: string;
  dimensions: DimensionInfo[];
  label: string;
  lastUpdated: string;
  metadataUrl?: string;
  obsCount: number;
  timeRange: { start: string; end: string };
}

export interface DimensionInfo {
  code: string;
  label: string;
  /** First 10 values as orientation. */
  sampleValues: Array<{ code: string; label: string }>;
  /** Total number of distinct values in this slice. */
  valuesCount: number;
}

export interface DimensionValuesResult {
  dimensionCode: string;
  dimensionLabel: string;
  totalCount: number;
  values: Array<{ code: string; label: string }>;
}

export interface QueryResult {
  datasetCode: string;
  datasetLabel: string;
  dimensionsUsed: string[];
  missingObsCount: number;
  obsCount: number;
  observations: Observation[];
  timeRange: { start: string; end: string };
}

export type GeoLevel = 'aggregate' | 'country' | 'nuts1' | 'nuts2' | 'nuts3';
