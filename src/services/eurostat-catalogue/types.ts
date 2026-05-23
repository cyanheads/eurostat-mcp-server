/**
 * @fileoverview Domain types for the Eurostat Catalogue (TOC) service.
 * @module services/eurostat-catalogue/types
 */

/** A single entry from the parsed Eurostat TOC TXT file. */
export interface TocEntry {
  /** Dataset or folder code (e.g., "nama_10_gdp", "econ"). */
  code: string;
  /** End of data coverage (e.g., "2025"). */
  dataEnd?: string;
  /** Start of data coverage (e.g., "1975"). */
  dataStart?: string;
  /** Depth level in the hierarchy (0-based). */
  depth: number;
  /** Human-readable label (with leading spaces stripped). */
  label: string;
  /** Date of last data update (e.g., "22.05.2026"). */
  lastUpdated?: string;
  /** Number of observations (datasets/tables only). */
  obsCount?: number;
  /** Index of parent entry in the flat entries array, or -1 for root. */
  parentIndex: number;
  /** Entry type from the raw TOC. */
  type: 'dataset' | 'table' | 'folder';
}

/** A dataset result from search or browse. */
export interface DatasetResult {
  code: string;
  dataEnd?: string;
  dataStart?: string;
  label: string;
  lastUpdated?: string;
  obsCount?: number;
  /** Breadcrumb path from root to this entry's parent folder. */
  themePath: string[];
  type: 'dataset' | 'table';
}

/** A theme or dataset item returned from browse. */
export interface BrowseItem {
  code: string;
  dataEnd?: string;
  dataStart?: string;
  hasChildren: boolean;
  label: string;
  obsCount?: number;
  type: 'folder' | 'dataset' | 'table';
}
