/**
 * @fileoverview Domain types for the Eurostat SDMX 2.1 bulk (TSV) service. The
 * flag dictionaries and measure column names live in `services/eurostat-codelists`,
 * shared with the JSON-stat service.
 * @module services/eurostat-bulk/types
 */

/**
 * One observation flattened from the wide TSV layout into a dataframe row.
 *
 * The TSV endpoint carries codes only — no labels — so a row has one column per
 * dimension holding the code, `time` for the period, then the measure columns.
 * There is deliberately no `<dim>_label` companion: staging all-null label
 * columns would claim a lookup the bulk endpoint never performed.
 */
export type BulkRow = Record<string, string | number | null>;

/** Period column name. `time` matches the dimension name JSON-stat uses. */
export const TIME_COLUMN = 'time';

/**
 * The header of a wide TSV body, parsed.
 *
 * Read from the response itself rather than from dataset metadata: the first
 * field of the header line names the dimensions in the order the row keys use
 * (`freq,unit,na_item,geo\TIME_PERIOD`), and the remaining tab-separated fields
 * are the period columns. Both arrive with padding Eurostat does not strip.
 */
export interface TsvHeader {
  /** Dimension codes in row-key order, `time` excluded. */
  dimensions: string[];
  /** Period codes, in column order. */
  periods: string[];
}

/**
 * Counters filled in as {@link BulkDownload.rows} is drained.
 *
 * Nothing here is knowable before the stream is consumed — the body is chunked
 * with no `Content-Length` — so a consumer reads these only after the generator
 * has been exhausted (or has stopped on the byte budget).
 */
export interface BulkStats {
  /**
   * True when the byte budget stopped the transfer before the body ended, so
   * the rows are a prefix of the dataset rather than all of it.
   */
  budgetExceeded: boolean;
  /** Decoded TSV bytes read. The unit the byte budget is enforced in. */
  bytesRead: number;
  /** Whether the response body arrived gzip-compressed. */
  compressed: boolean;
  /** Emitted observations carrying no numeric value. */
  missingCount: number;
  /** Distinct periods actually emitted, ascending. */
  periodsSeen: string[];
  /** Observations emitted — one per populated cell. */
  rowCount: number;
}

/**
 * A started bulk download: the header is parsed, the body is not yet drained.
 *
 * Returning before the body is consumed is what lets the caller declare a canvas
 * column schema from {@link header} and then hand {@link rows} straight to the
 * canvas appender, so a multi-million-row download never materializes as an
 * array. {@link stats} is mutated as the generator runs and is only meaningful
 * once it has finished.
 */
export interface BulkDownload {
  header: TsvHeader;
  rows: () => AsyncGenerator<BulkRow>;
  stats: BulkStats;
  /** The request URL, minus nothing — no credentials are involved. */
  url: string;
}
