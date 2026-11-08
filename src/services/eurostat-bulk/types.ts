/**
 * @fileoverview Domain types for the Eurostat SDMX 2.1 bulk (TSV) service. The
 * flag dictionaries and measure column names live in `services/eurostat-codelists`,
 * shared with the JSON-stat service.
 * @module services/eurostat-bulk/types
 */

import type { OutsideSpan } from '@/services/eurostat-data/types.js';

/**
 * One non-blank TSV cell flattened from the wide layout into a dataframe row.
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
   * Emitted rows holding an unflagged `:` — no value, flag, status or text — in a period
   * whose frequency (read off the period code's shape) the same line carries in a row
   * that is not one, inside that frequency's span: from its first to its latest period
   * any emitted line has an observation in. These are periods the series lacks, which the
   * Statistics API has no cell for. A period outside the span is in {@link outsideSpans}
   * instead. An unflagged `:` at a period of a frequency the line has no observation of
   * (the padding of a mixed-frequency slice, or a series that is `:` throughout) is left
   * out. Part of {@link rowCount} and {@link missingCount}.
   */
  absentCellCount: number;
  /**
   * True when the byte budget stopped the transfer before the body ended, so
   * the rows are a prefix of the dataset rather than all of it.
   */
  budgetExceeded: boolean;
  /** Decoded TSV bytes accepted for parsing, never more than the configured byte budget. */
  bytesRead: number;
  /** Whether the response body arrived gzip-compressed. */
  compressed: boolean;
  /**
   * Filter values no emitted line carrying an observation holds, keyed by filter key, in the
   * spelling sent and each once (matching ignores case). Eurostat fails a request naming an
   * unknown code, so each is a value the dataset has with no observation in the range.
   * Unset when every value has one, and on a transfer the byte budget cut short, whose
   * unread lines could hold any of them.
   */
  emptyValues?: Record<string, string[]>;
  /**
   * Emitted rows carrying no numeric value: observations published without a number (a
   * flagged `:`, a text value) and the rows of unflagged `:` cells.
   */
  missingCount: number;
  /**
   * Per frequency, finest first, the periods no emitted line has an observation in outside
   * that frequency's span (or every period of a frequency with none), and `rowCount`, the
   * emitted rows at those periods: unflagged `:` cells all, left out of
   * {@link absentCellCount}. Unset when every kept period lies inside its frequency's span.
   */
  outsideSpans?: { rowCount: number; spans: OutsideSpan[] };
  /**
   * Distinct periods of the emitted rows that carry an observation — a value, a flag, a
   * status or a text value — ascending. An unflagged `:` adds none.
   */
  periodsSeen: string[];
  /**
   * Rows emitted, one per non-blank cell: the observations, flagged `:` cells included,
   * and the unflagged `:` cells, which are not observations — {@link absentCellCount}'s,
   * {@link outsideSpans}' and the padding of a frequency a series has no observation of.
   */
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
  /**
   * True when every row carries an `obs_value_text` column — a `DS-*` dataset, whose
   * PRODCOM indicators publish units and flags as text. Pass it to `bulkRowSchema`.
   */
  valueText: boolean;
}
