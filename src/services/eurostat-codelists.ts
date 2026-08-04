/**
 * @fileoverview Eurostat's published `OBS_FLAG` and `CONF_STATUS` codelists, plus
 * the measure column names both dataframe stagers write. Shared by the JSON-stat
 * and SDMX TSV services so a given observation stages identically whichever
 * endpoint it came from.
 * @module services/eurostat-codelists
 */

/**
 * Measure column names — the non-dimension columns both stagers write.
 *
 * The `obs_` prefix is Eurostat's own SDMX-CSV vocabulary, which also keeps the
 * measure columns clear of any dimension code. Both services declare their canvas
 * schema from these constants, so a table staged from JSON-stat and one staged
 * from the SDMX TSV endpoint carry the same four flag columns under the same
 * names, and a join across them compares like with like.
 */
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
 * decomposed. No code contains a `|` or an `@`, which is what lets both wire
 * formats use those characters to separate an observation flag from a
 * confidentiality status. Lookups that miss return `undefined`, and the caller
 * reports the code unlabelled rather than inventing a label — Eurostat can ship a
 * code in data that its published codelist omits.
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
 * `C` is the code that appears in data, behind the `@` of a TSV cell like `: @C`
 * and behind the `|` of a JSON-stat status like `|C`. Both wire formats are split
 * on that separator before staging, so the code lands in `conf_status` on either
 * path and never inside `obs_flag`.
 */
export const CONF_STATUS_LABELS: Readonly<Record<string, string>> = {
  C: 'confidential',
  N: 'not for publication',
  P: 'information under non-statistical secrecy arrangements',
};
