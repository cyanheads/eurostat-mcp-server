/**
 * @fileoverview Domain types and the static flag dictionaries for the Eurostat
 * SDMX 2.1 bulk (TSV) service.
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
/** Measure column names — the non-dimension columns of a {@link BulkRow}. */
export const OBS_VALUE_COLUMN = 'obs_value';
export const OBS_FLAG_COLUMN = 'obs_flag';
export const OBS_FLAG_LABEL_COLUMN = 'obs_flag_label';
export const CONF_STATUS_COLUMN = 'conf_status';
export const CONF_STATUS_LABEL_COLUMN = 'conf_status_label';

/**
 * Eurostat's `OBS_FLAG` codelist, verbatim from
 * `sdmx/2.1/codelist/ESTAT/OBS_FLAG` — all 42 codes.
 *
 * Codes are composite: a cell flagged `bdep` is one code meaning "break in time
 * series, definition differs, estimated, provisional", not four codes to be
 * decomposed. Lookups that miss return `undefined` and the row's label column is
 * `null` — Eurostat can ship a code in data that its published codelist omits,
 * and an invented label is worse than an absent one.
 */
export const OBS_FLAG_LABELS: Readonly<Record<string, string>> = {
  b: 'break in time series',
  bd: 'break in time series, definition differs (see metadata)',
  bde: 'break in time series, definition differs (see metadata), estimated',
  bdep: 'break in time series, definition differs (see metadata), estimated, provisional',
  bdf: 'break in time series, definition differs (see metadata), forecast',
  bdi: 'break in time series, definition differs (see metadata), value imputed by Eurostat or other receiving agencies',
  bdip: 'break in time series, definition differs (see metadata), value imputed by Eurostat or other receiving agencies, provisional',
  bdm: 'break in time series, definition differs (see metadata), missing value; data cannot exist',
  bdn: 'break in time series, definition differs (see metadata), not significant',
  bdp: 'break in time series, definition differs (see metadata), provisional',
  bdu: 'break in time series, definition differs (see metadata), low reliability',
  be: 'break in time series, estimated',
  bep: 'break in time series, estimated, provisional',
  bf: 'break in time series, forecast',
  bi: 'break in time series, value imputed by Eurostat or other receiving agencies',
  bip: 'break in time series, value imputed by Eurostat or other receiving agencies, provisional',
  bm: 'break in time series, missing value; data cannot exist',
  bn: 'break in time series, not significant',
  bp: 'break in time series, provisional',
  bpu: 'break in time series, provisional, low reliability',
  bu: 'break in time series, low reliability',
  d: 'definition differs (see metadata)',
  de: 'definition differs (see metadata), estimated',
  dep: 'definition differs (see metadata), estimated, provisional',
  df: 'definition differs (see metadata), forecast',
  di: 'definition differs (see metadata), value imputed by Eurostat or other receiving agencies',
  dip: 'definition differs (see metadata), value imputed by Eurostat or other receiving agencies, provisional',
  dm: 'definition differs (see metadata), missing value; data cannot exist',
  dn: 'definition differs (see metadata), not significant',
  dp: 'definition differs (see metadata), provisional',
  dpu: 'definition differs (see metadata), provisional, low reliability',
  du: 'definition differs (see metadata), low reliability',
  e: 'estimated',
  ep: 'estimated, provisional',
  f: 'forecast',
  i: 'value imputed by Eurostat or other receiving agencies',
  ip: 'value imputed by Eurostat or other receiving agencies, provisional',
  m: 'missing value; data cannot exist',
  n: 'not significant',
  p: 'provisional',
  pu: 'provisional, low reliability',
  u: 'low reliability',
};

/**
 * Eurostat's `CONF_STATUS` codelist, verbatim from
 * `sdmx/2.1/codelist/ESTAT/CONF_STATUS` — all three codes.
 *
 * `C` is what appears in TSV data, behind the `@` of a cell like `: @C`. The
 * same cells surface in JSON-stat folded into the observation status instead,
 * as `|C` labelled `|confidential`, which is why a bulk-staged table and a
 * query-staged one disagree about where a confidentiality marker lives.
 */
export const CONF_STATUS_LABELS: Readonly<Record<string, string>> = {
  C: 'confidential',
  N: 'not for publication',
  P: 'information under non-statistical secrecy arrangements',
};

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
