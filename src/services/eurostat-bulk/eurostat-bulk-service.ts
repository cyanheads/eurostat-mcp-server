/**
 * @fileoverview Eurostat Bulk Service — streaming client for the SDMX 2.1 TSV
 * dissemination endpoint. Builds the positional dimension key, sniffs gzip off
 * the stream, enforces a byte budget and the call's time budget mid-transfer, keeping
 * the rows read when either ends it, classifies XML SOAP faults
 * and the asynchronous queue envelope, and expands the wide TSV layout into
 * one row per non-blank cell.
 * @module services/eurostat-bulk/eurostat-bulk-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  defaultIsTransient,
  fetchWithTimeout,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  CONF_STATUS_COLUMN,
  CONF_STATUS_LABEL_COLUMN,
  CONF_STATUS_LABELS,
  decodeTextValue,
  OBS_FLAG_COLUMN,
  OBS_FLAG_LABEL_COLUMN,
  OBS_FLAG_LABELS,
  OBS_VALUE_COLUMN,
  OBS_VALUE_TEXT_COLUMN,
} from '@/services/eurostat-codelists.js';
import { TIME_DIMENSION_KEYS } from '@/services/eurostat-data/eurostat-data-service.js';
import type { OutsideSpan } from '@/services/eurostat-data/types.js';
import { normalizeFilters, unknownDimensionsMessage } from '@/services/eurostat-filters.js';
import { dataHostFor, isComextDataset } from '@/services/eurostat-hosts.js';
import { isUpstreamOutage, upstreamOutage } from '@/services/eurostat-outage.js';
import {
  frequencySpans,
  type ListedPeriod,
  oneDayRange,
  outsideSpanOf,
  periodFrequency,
} from '@/services/eurostat-periods.js';
import { decodeXmlEntities } from '@/services/xml-entities.js';
import {
  type BulkDownload,
  type BulkRow,
  type BulkStats,
  TIME_COLUMN,
  type TsvHeader,
} from './types.js';

/**
 * Decoded characters buffered before an XML body is classified.
 *
 * Both non-data shapes are small — the largest SOAP fault and the largest queue
 * envelope observed are each under 400 bytes — so this only has to hold one of them.
 * It deliberately does **not** bound the search for the TSV header's line break:
 * that line carries one field per period and runs to 166 KB on a daily series.
 */
const XML_PEEK_CHARS = 8_192;

/** Separator between the observation flag and the confidentiality flag inside a TSV cell. */
const CONF_SEPARATOR = '@';

/**
 * Eurostat's marker for a cell with no value: with a flag or status, an observation
 * published without one; with neither, a period the series has no cell in — one it lacks,
 * one no series has an observation in, or one of a frequency it does not carry.
 */
const MISSING_VALUE = ':';

/** The header line's first field ends with this literal before the period columns begin. */
const TIME_HEADER_SUFFIX = '\\TIME_PERIOD';

/**
 * The clause fault 150 closes with when the range selected no period, as opposed to
 * naming a filter value: `TIME_PERIOD: >=2022-06-01 and <=2023-06-30.`, either bound
 * alone included. Anchoring on the end of the sentence before it (`are not allowed:`)
 * keeps a filter value that spells the clause (`GEO=TIME_PERIOD: >=2020`,
 * `GEO=x: TIME_PERIOD: >=2020`) a filter fault. A changed clause falls back to the
 * filter wording.
 */
const PERIOD_FAULT_CLAUSE = /allowed: TIME_PERIOD: [<>]=/;

/**
 * Translate an XML body from the SDMX endpoint into the declared error contract.
 *
 * Two unrelated shapes arrive as XML and neither is data. A `S:Fault` envelope
 * accompanies a 4xx and names the problem in a numeric `faultcode`. The
 * `syncResponse` envelope arrives on **HTTP 200** carrying a queue ticket
 * instead of the dataset — parsed as TSV it yields a header row of XML, so it is
 * detected here rather than downstream.
 *
 * The ticket means Eurostat is preparing the extraction in the background, and it
 * serves the identical download minutes later, so `async_queued` is retryable by the
 * caller, never by {@link EurostatBulkService.startDownload}'s retry loop, which
 * resends only an outage: the repeat is the caller's, minutes later.
 *
 * Always throws.
 */
export function classifyXmlBody(xml: string, datasetCode: string): never {
  if (xml.includes('syncResponse') || xml.includes('<status>SUBMITTED</status>')) {
    throw serviceUnavailable(
      `Eurostat is preparing the extraction of "${datasetCode}" in the background and has not served it yet: the SDMX endpoint answered with a "SUBMITTED" queue ticket instead of data.`,
      { reason: 'async_queued', datasetCode, retryable: true },
    );
  }

  const code = /<faultcode>\s*(\d+)\s*<\/faultcode>/.exec(xml)?.[1];
  const detail = decodeXmlEntities(
    /<faultstring>([\s\S]*?)<\/faultstring>/.exec(xml)?.[1]?.trim() ?? xml.slice(0, 300),
  );

  if (code === '100') {
    throw notFound(
      `Dataset "${datasetCode}" is not available for dissemination. Eurostat fault ${code}: ${detail}`,
      { reason: 'not_found', datasetCode, faultcode: code },
    );
  }
  /**
   * Fault 140 covers two unrelated refusals, told apart only by the fault string:
   * `TIME_PERIOD_FILTER_SPEC_INVALID` for a period literal the endpoint cannot
   * parse, `INVALID_QUERY_NB_FILTERS` for a key with the wrong number of positions.
   */
  if (code === '140' && detail.includes('TIME_PERIOD_FILTER_SPEC_INVALID')) {
    throw validationError(
      `Eurostat rejected the period range for "${datasetCode}". Eurostat fault ${code}: ${detail}`,
      { reason: 'invalid_period', datasetCode, faultcode: code },
    );
  }
  if (code === '140') {
    throw validationError(
      `Eurostat rejected the dimension key: the number of filter positions did not match the dataset's dimensions. Eurostat fault ${code}: ${detail}`,
      { reason: 'filter_arity', datasetCode, faultcode: code },
    );
  }
  if (code === '150') {
    /**
     * The fault's own clause stays out of this message: a one-day download asks for the
     * day and the next, so the clause would show the caller a bound it never sent.
     */
    if (PERIOD_FAULT_CLAUSE.test(detail)) {
      throw validationError(
        `Eurostat rejected the period range for "${datasetCode}": it selects no period of the dataset (fault ${code}).`,
        { reason: 'invalid_dimension', datasetCode, faultcode: code, periodRange: true },
      );
    }
    throw validationError(
      `Eurostat rejected a filter value. This fault also covers a period range outside the dataset's coverage. Eurostat fault ${code}: ${detail}`,
      { reason: 'invalid_dimension', datasetCode, faultcode: code },
    );
  }
  /**
   * Fault 413 is Eurostat refusing the extraction's size, on either host:
   * `EXTRACTION_TOO_BIG` past its 5,000,000-row limit, or `EXTRACTION_TOO_BIG_COMEXT`
   * for an unfiltered download of a large Comext collection (a small one, such as
   * `DS-059368`, is served whole). The same
   * request fails the same way every time, so it is not retryable.
   */
  if (code === '413') {
    throw serviceUnavailable(
      `Eurostat refused the extraction of "${datasetCode}" as too large. Eurostat fault ${code}: ${detail}`,
      { reason: 'extraction_too_big', datasetCode, faultcode: code, retryable: false },
    );
  }
  throw serviceUnavailable(
    `Eurostat SDMX endpoint returned a fault for "${datasetCode}"${code ? ` (faultcode ${code})` : ''}: ${detail}`,
    { reason: 'upstream_fault', datasetCode, ...(code && { faultcode: code }) },
  );
}

/**
 * Classify the XML body a non-2xx answer carried, when it names a failure this server
 * models; otherwise return, leaving the caller to rethrow the HTTP error.
 *
 * `fetchWithTimeout` throws for any non-2xx before the caller sees the body, so a SOAP
 * fault is only reachable through the excerpt captured on `err.data`. Faults run well
 * under the framework's 500-byte cap, so the excerpt carries the whole envelope. On a
 * 5xx, a body naming nothing this server models — an HTML or XML error page — is the
 * outage itself, so the HTTP error is kept to mark it one.
 */
function classifyFaultBody(err: unknown, datasetCode: string): void {
  const body = (err as McpError).data?.body;
  if (typeof body !== 'string' || !body.includes('<')) return;
  try {
    classifyXmlBody(body, datasetCode);
  } catch (fault) {
    const unmodeled = (fault as McpError).data?.reason === 'upstream_fault';
    if (!(unmodeled && isUpstreamOutage(err))) throw fault;
  }
}

/**
 * Split one wide-TSV cell into its value and flags.
 *
 * The grammar, read off live responses, is `<value>` `SPACE` `<flags>`, where
 * flags is `<obs_flag>` optionally followed by `@<conf_status>` and either part
 * may be empty: `429634.3 `, `3853937.0 p`, `: `, `: @C`. A cell that is empty
 * on both sides of the split yields `undefined` — distinct from `: `, an unflagged
 * `:` that comes back with every field null: a period the series has no cell in, where
 * the Statistics API has none either. A flagged `:` (`: u`, `: @C`) is an observation
 * Eurostat publishes without a value.
 *
 * A value that is not a number is read by {@link decodeTextValue}: PRODCOM's flag
 * and unit indicators publish `:C` (confidential, no space before the `C`) and `KG`
 * in the value position. `:C` lands in `conf`, and other text in `text`.
 */
export function parseCell(
  cell: string,
): { conf: string | null; flag: string | null; text?: string; value: number | null } | undefined {
  const sep = cell.indexOf(' ');
  const rawValue = (sep === -1 ? cell : cell.slice(0, sep)).trim();
  const rawFlags = (sep === -1 ? '' : cell.slice(sep + 1)).trim();

  if (rawValue === '' && rawFlags === '') return;

  const atIdx = rawFlags.indexOf(CONF_SEPARATOR);
  const flag = (atIdx === -1 ? rawFlags : rawFlags.slice(0, atIdx)) || null;
  const conf = (atIdx === -1 ? '' : rawFlags.slice(atIdx + 1)) || null;

  if (rawValue === '' || rawValue === MISSING_VALUE) return { conf, flag, value: null };
  const num = Number(rawValue);
  if (Number.isFinite(num)) return { conf, flag, value: num };
  const decoded = decodeTextValue(rawValue);
  return {
    conf: conf ?? decoded.confStatus ?? null,
    flag,
    value: null,
    ...(decoded.text && { text: decoded.text }),
  };
}

/**
 * Parse the header line of a wide TSV body.
 *
 * The first tab-separated field is the comma-joined dimension list with
 * `\TIME_PERIOD` appended to the last name; the remaining fields are the period
 * codes, each padded with a trailing space Eurostat does not strip.
 */
export function parseHeader(line: string): TsvHeader {
  const fields = line.split('\t');
  const keyField = (fields[0] ?? '').trim();
  const dimensionField = keyField.endsWith(TIME_HEADER_SUFFIX)
    ? keyField.slice(0, -TIME_HEADER_SUFFIX.length)
    : keyField;
  const dimensions = dimensionField
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '');
  const periods = fields.slice(1).map((p) => p.trim());
  if (dimensions.length === 0 || periods.length === 0) {
    throw serviceUnavailable(
      `Eurostat returned a TSV body whose header names no ${dimensions.length === 0 ? 'dimensions' : 'periods'}. Header: ${line.slice(0, 200)}`,
      { reason: 'upstream_fault' },
    );
  }
  return { dimensions, periods };
}

/**
 * Build the positional dimension key the SDMX path takes.
 *
 * The key is a dot-separated segment carrying one position per dimension **in
 * dataset order excluding time**; empty means wildcard and `+` means OR. The
 * count must match exactly — a key with one position too few or too many is
 * rejected upstream with faultcode 140 — so positions are emitted for every
 * dimension in `dimensionOrder`, filtered or not, and never only for the
 * dimensions the caller named.
 *
 * A filter key names its dimension in any case (`GEO` places the same as `geo`),
 * as the Statistics API reads it; keys that differ only in case pool their values.
 * A blank value is unset rather than an empty member of the `+` list, and a value
 * holding `+` arrives here already split into its codes. A key naming no dimension
 * fails the build, every such key named at once; the message adds where the period
 * goes only when one of them is a time key, which the order never lists.
 *
 * Returns `undefined` when no filter applies. An all-wildcard key is accepted
 * by Eurostat, but omitting the segment asks the same question without staking
 * the request on this server's copy of the dimension order being current.
 */
export function buildKeyPath(
  dimensionOrder: string[],
  filters: Record<string, string[]>,
): string | undefined {
  const applied = Object.entries(normalizeFilters(filters));
  if (applied.length === 0) return;

  const byDimension = new Map<string, string[]>();
  const unknown: string[] = [];
  for (const [key, values] of applied) {
    const dim = dimensionOrder.find((d) => d.toLowerCase() === key.toLowerCase());
    if (dim === undefined) unknown.push(key);
    else byDimension.set(dim, [...(byDimension.get(dim) ?? []), ...values]);
  }
  if (unknown.length > 0) {
    const timeKey = unknown.some((key) => TIME_DIMENSION_KEYS.has(key.toLowerCase()));
    throw validationError(
      `${unknownDimensionsMessage(unknown, dimensionOrder)}${timeKey ? ' The time dimension is filtered with since_period/until_period instead.' : ''}`,
      { reason: 'invalid_dimension', unknownDimensions: unknown, dimensionOrder },
    );
  }

  return dimensionOrder.map((dim) => (byDimension.get(dim) ?? []).join('+')).join('.');
}

/**
 * Canvas column schema for {@link BulkRow}, declared rather than sniffed.
 *
 * Inference reads only the leading rows, which types an all-integer measure
 * prefix as `BIGINT` — serialized back out as a string — and types an
 * all-missing prefix from nulls alone. Every column is nullable: a measure is
 * routinely unavailable, and flags are the exception rather than the rule.
 *
 * `valueText` declares `obs_value_text` after `obs_value`, for a `DS-*` dataset —
 * the same flag {@link BulkDownload.valueText} reports for the rows.
 */
export function bulkRowSchema(dimensions: string[], valueText = false): ColumnSchema[] {
  return [
    ...dimensions.map((dim): ColumnSchema => ({ name: dim, type: 'VARCHAR', nullable: true })),
    { name: TIME_COLUMN, type: 'VARCHAR', nullable: true },
    { name: OBS_VALUE_COLUMN, type: 'DOUBLE', nullable: true },
    ...(valueText
      ? [{ name: OBS_VALUE_TEXT_COLUMN, type: 'VARCHAR', nullable: true } satisfies ColumnSchema]
      : []),
    { name: OBS_FLAG_COLUMN, type: 'VARCHAR', nullable: true },
    { name: OBS_FLAG_LABEL_COLUMN, type: 'VARCHAR', nullable: true },
    { name: CONF_STATUS_COLUMN, type: 'VARCHAR', nullable: true },
    { name: CONF_STATUS_LABEL_COLUMN, type: 'VARCHAR', nullable: true },
  ];
}

export class EurostatBulkService {
  // config and storage accepted to match the standard service init pattern;
  // this service uses only the Eurostat public API and per-request config.
  // biome-ignore lint/complexity/noUselessConstructor: standard init pattern
  constructor(_config: AppConfig, _storage: StorageService) {}

  private buildUrl(
    datasetCode: string,
    keyPath: string | undefined,
    sinceP: string | undefined,
    untilP: string | undefined,
  ): URL {
    const path = keyPath
      ? `${encodeURIComponent(datasetCode)}/${encodeURIComponent(keyPath)}`
      : encodeURIComponent(datasetCode);
    const url = new URL(`${dataHostFor(datasetCode)}/sdmx/2.1/data/${path}`);
    url.searchParams.set('format', 'TSV');
    if (sinceP) url.searchParams.set('startPeriod', sinceP);
    if (untilP) url.searchParams.set('endPeriod', untilP);
    return url;
  }

  /**
   * Start a bulk download: issue the request, classify the response, parse the
   * header, and hand back a generator over the body.
   *
   * Only the request is retried, and only on an outage: an HTTP 5xx or a host that
   * could not be reached, both of which fail before any of the body is read, so a
   * retry repeats a request rather than a transfer. One that outlasts the retries
   * fails as a retryable `upstream_fault`. A timeout, a fault in the request, and a
   * failure once the body is streaming are surfaced on the first attempt: re-running
   * the request then would cost the caller another full transfer.
   *
   * One time budget, `EUROSTAT_BULK_TIMEOUT_MS` counted from `startedAt` (when the
   * caller's call began), covers every attempt, every backoff, the body and whatever
   * pulls it: the fetch's own timer is armed to the budget's end and stays armed until
   * the body closes. Reached before the first row, the download fails as
   * `retry_deadline_exceeded`; reached once rows have streamed, the row generator ends
   * on them as it does on the byte budget ({@link expandRows}). A budget already spent
   * sends nothing.
   */
  async startDownload(
    datasetCode: string,
    dimensionOrder: string[],
    filters: Record<string, string[]>,
    sinceP: string | undefined,
    untilP: string | undefined,
    ctx: Context,
    startedAt = Date.now(),
  ): Promise<BulkDownload> {
    const { bulkTimeoutMs, bulkMaxBytes } = getServerConfig();
    const keyPath = buildKeyPath(dimensionOrder, filters);
    const deadlineMs = remainingBudgetMs(datasetCode, startedAt);
    /**
     * Eurostat ignores a range of one day and answers with the whole series, and this
     * endpoint ignores `time`. So one day is asked for as that day and the next, and
     * {@link expandRows} drops the next before anything is counted.
     */
    const oneDay = oneDayRange({ since_period: sinceP, until_period: untilP });
    const url = this.buildUrl(datasetCode, keyPath, oneDay?.date ?? sinceP, oneDay?.next ?? untilP);
    const fetchCtx = withExtra(ctx, { endpoint: 'sdmx-data', datasetCode });

    ctx.log.info('Starting SDMX bulk download', {
      datasetCode,
      keyPath,
      sinceP,
      untilP,
      maxBytes: bulkMaxBytes,
      remainingMs: deadlineMs,
    });

    const stats: BulkStats = {
      absentCellCount: 0,
      bytesRead: 0,
      budgetExceeded: false,
      compressed: false,
      rowCount: 0,
      missingCount: 0,
      periodsSeen: [],
    };
    /** The time budget's failure once it has run out, unless the caller cancelled. */
    const budgetOver = (cause?: unknown): McpError | undefined => {
      const elapsedMs = Date.now() - startedAt;
      if (ctx.signal.aborted || elapsedMs < bulkTimeoutMs) return;
      return timeBudgetFailure(datasetCode, bulkTimeoutMs, elapsedMs, cause);
    };
    /**
     * The time budget as the failure it ends in, for a `Timeout` that lands once the budget
     * has run: the fetch's own timer or the retry clock, both armed to the budget's end.
     * `undefined` for any other failure, and for every failure of a call the caller
     * cancelled, which keeps its own outcome whatever the attempt saw.
     */
    const budgetSpent = (error: unknown): McpError | undefined =>
      error instanceof McpError && error.code === JsonRpcErrorCode.Timeout
        ? budgetOver(error)
        : undefined;
    /**
     * A failure once the body is streaming: the time budget's, or a transport failure that
     * broke the body off, which names the dataset and endpoint rather than reaching the
     * caller as a bare network error. The break-off is an outage, so a later call can
     * succeed; `bytesRead` tells it from an endpoint that could not be reached at all.
     */
    const bodyFailure = (error: unknown): unknown => {
      const spent = budgetSpent(error);
      if (spent) return spent;
      if (ctx.signal.aborted || !isUpstreamOutage(error)) return error;
      return serviceUnavailable(
        `Eurostat's SDMX data endpoint broke off the body of "${datasetCode}" after ${stats.bytesRead} decoded bytes, before it ended.`,
        { reason: 'upstream_fault', datasetCode, bytesRead: stats.bytesRead, retryable: true },
        { cause: error },
      );
    };
    const response = await withRetry(
      async ({ signal, remainingMs }) => {
        try {
          return await fetchWithTimeout(
            url.toString(),
            // The retry clock's own remainder: the timer then fires at the budget's end.
            remainingMs,
            fetchCtx,
            {
              signal,
              // 400 (bad filter value or arity), 404 (unknown dataset) and 413 (extraction too
              // large) are modeled outcomes reclassified below into the declared error
              // contract, not service failures.
              expectedStatuses: [400, 404, 413],
            },
          );
        } catch (err) {
          classifyFaultBody(err, datasetCode);
          throw err;
        }
      },
      {
        operation: 'fetchSdmxData',
        context: fetchCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs,
        /**
         * An outage, minus the 501 the fetch layer marks deterministic. A refusal the
         * caller may repeat later — the retryable `async_queued` — is no outage, so the
         * default predicate's reading of its `retryable` never resends it here.
         */
        isTransient: (error) => isUpstreamOutage(error) && defaultIsTransient(error),
      },
    ).catch((error: unknown) => {
      // A download the caller cancelled is the caller's outcome, whatever the last attempt saw.
      if (ctx.signal.aborted) throw error;
      throw (
        budgetSpent(error) ??
        upstreamOutage(
          error,
          "Eurostat's SDMX data endpoint",
          `the bulk download of dataset "${datasetCode}"`,
          { datasetCode },
        ) ??
        error
      );
    });

    if (!response.body) {
      throw serviceUnavailable(
        `Eurostat SDMX endpoint returned an empty body for "${datasetCode}".`,
        { reason: 'upstream_fault', datasetCode },
      );
    }

    let decoded: AsyncGenerator<string> | undefined;
    try {
      decoded = await decodeBody(response.body, stats, bulkMaxBytes);
      const { header, remainder, iterator } = await readHeader(
        decoded,
        datasetCode,
        stats,
        bulkMaxBytes,
      );
      const valueText = isComextDataset(datasetCode);
      return {
        header,
        stats,
        url: url.toString(),
        valueText,
        rows: () =>
          expandRows(
            iterator,
            remainder,
            header,
            stats,
            { filters: normalizeFilters(filters), onlyPeriod: oneDay?.date, valueText },
            { budgetOver, budgetSpent, bodyFailure, datasetCode, maxBytes: bulkMaxBytes },
          ),
      };
    } catch (error) {
      await decoded?.return(undefined);
      throw bodyFailure(error);
    }
  }
}

/**
 * Milliseconds left of a download call's time budget, `EUROSTAT_BULK_TIMEOUT_MS` counted
 * from `startedAt`, when the call began. Throws `retry_deadline_exceeded` when none is left,
 * so a request that would start on the deadline is never sent.
 */
export function remainingBudgetMs(datasetCode: string, startedAt: number): number {
  const { bulkTimeoutMs } = getServerConfig();
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= bulkTimeoutMs) throw timeBudgetFailure(datasetCode, bulkTimeoutMs, elapsedMs);
  return bulkTimeoutMs - elapsedMs;
}

/** The call's time budget ran out before the download yielded a row. */
function timeBudgetFailure(
  datasetCode: string,
  budgetMs: number,
  elapsedMs: number,
  cause?: unknown,
): McpError {
  return timeout(
    `The download of "${datasetCode}" ran out of its ${budgetMs}ms time budget before the first row arrived.`,
    { reason: 'retry_deadline_exceeded', deadlineMs: budgetMs, elapsedMs },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Wrap the response body in a byte-budgeted, gzip-aware text stream.
 *
 * Eurostat compresses large bodies **without** a `Content-Encoding` header — the
 * only header-level tell is a `.tsv.gz` filename on `Content-Disposition`, and
 * that is not what is trusted here. The first two bytes are read off the stream
 * and checked for the gzip magic number, so the decision is made on what
 * actually arrived. The switch is not monotonic in dataset size, so it cannot
 * be predicted from the request either.
 *
 * The budget counts bytes *after* decompression. That is the uniform measure
 * across both encodings, independent of the wire size. Hitting it
 * cancels the underlying reader rather than draining the rest — the body is
 * chunked with no `Content-Length`, so a budget checked after the fact would
 * have already paid for the whole transfer.
 */
async function decodeBody(
  body: ReadableStream<Uint8Array>,
  stats: BulkStats,
  maxBytes: number,
): Promise<AsyncGenerator<string>> {
  const reader = body.getReader();

  // Pull until at least the two magic bytes are in hand; a chunked body can deliver
  // fewer on the first read, and an empty body delivers none.
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  while (prefixBytes < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      prefix.push(value);
      prefixBytes += value.length;
    }
  }
  const head = concatChunks(prefix, prefixBytes);
  stats.compressed = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

  const replayed = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  /**
   * `DecompressionStream`'s writable side is typed `BufferSource`, wider than the
   * `Uint8Array` chunks this pipeline carries, so `pipeThrough` will not accept it
   * directly. The cast narrows the transform to the stream types actually in play
   * rather than widening the pipeline to `BufferSource`.
   */
  const byteStream = stats.compressed
    ? (replayed.pipeThrough(
        new DecompressionStream('gzip') as unknown as {
          readable: ReadableStream<Uint8Array>;
          writable: WritableStream<Uint8Array>;
        },
      ) as ReadableStream<Uint8Array>)
    : replayed;

  return budgetedText(byteStream, stats, maxBytes);
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Decode a byte stream to text, stopping the moment the byte budget is spent.
 *
 * The generator ends cleanly on overspend rather than throwing: the caller has
 * already paid for everything downloaded so far, and discarding it would leave
 * the agent with an error where it could have had a prefix of the dataset plus
 * `budgetExceeded` telling it exactly what happened.
 *
 * Every exit cancels the reader, so nothing further is transferred: overspend,
 * a normal end, and abandonment alike. Abandonment is the case that needs it —
 * a staging failure or an abort part-way through the canvas append runs the
 * `finally`, and releasing the lock alone would leave the response body
 * undrained and its connection held. Cancelling a stream that already ended is
 * a no-op.
 */
async function* budgetedText(
  stream: ReadableStream<Uint8Array>,
  stats: BulkStats,
  maxBytes: number,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const accepted = Math.min(value.length, maxBytes - stats.bytesRead);
      stats.bytesRead += accepted;
      const cut = accepted < value.length;
      if (cut) stats.budgetExceeded = 'bytes';
      const text = decoder.decode(cut ? value.subarray(0, accepted) : value, { stream: true });
      if (text) yield text;
      // A budget-cut UTF-8 sequence is an incomplete suffix, never a replacement character.
      if (cut) return;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Consume enough of the text stream to tell data from XML, then take the header.
 *
 * Both non-data shapes announce themselves in the first character, so
 * classification happens before a single row is parsed — a `syncResponse`
 * envelope arrives on HTTP 200 and would otherwise be read as a TSV header of
 * XML followed by no rows, which looks like a successful empty download.
 *
 * A body identified as XML is then buffered to the peek window before it is
 * classified, rather than to the first line break. The XML declaration ends in a
 * newline, so stopping there would hand the classifier the declaration alone and
 * lose the `syncResponse` and `faultcode` markers that follow it.
 *
 * A TSV header, by contrast, is buffered to its line break with no length bound.
 * Its length is proportional to the dataset's period count — 166 KB and 13,852
 * fields on a daily series — so capping the search would parse a prefix of it as
 * the whole header, silently drop every period column past the cap, and read the
 * header's own tail as a data line. The byte and time budgets are what bound this loop.
 */
async function readHeader(
  chunks: AsyncGenerator<string>,
  datasetCode: string,
  stats: BulkStats,
  maxBytes: number,
): Promise<{ header: TsvHeader; iterator: AsyncGenerator<string>; remainder: string }> {
  let buf = '';
  let exhausted = false;
  const pull = async (): Promise<void> => {
    const next = await chunks.next();
    if (next.done) exhausted = true;
    else buf += next.value;
  };

  while (buf.trim() === '' && !exhausted) await pull();

  if (buf.trimStart().startsWith('<')) {
    while (buf.length < XML_PEEK_CHARS && !exhausted) await pull();
    classifyXmlBody(buf, datasetCode);
  }

  while (!buf.includes('\n') && !exhausted) await pull();

  const newline = buf.indexOf('\n');
  if (newline === -1) {
    if (stats.budgetExceeded === 'bytes') throw byteBudgetFailure(datasetCode, stats, maxBytes);
    if (buf.trim() === '') {
      throw serviceUnavailable(
        `Eurostat SDMX endpoint returned an empty body for "${datasetCode}".`,
        { reason: 'upstream_fault', datasetCode },
      );
    }
    // A body that ended without a line break: one header line and no data rows.
    return { header: parseHeader(stripCr(buf)), iterator: chunks, remainder: '' };
  }

  return {
    header: parseHeader(stripCr(buf.slice(0, newline))),
    iterator: chunks,
    remainder: buf.slice(newline + 1),
  };
}

/**
 * A local transfer limit prevented the download from yielding a usable row. It carries no
 * recovery hint: the download tool's `byte_budget_exceeded` contract entry supplies it.
 */
function byteBudgetFailure(datasetCode: string, stats: BulkStats, maxBytes: number): McpError {
  return validationError(
    `The ${maxBytes}-byte decoded TSV budget was exhausted before a complete row could be read for "${datasetCode}".`,
    {
      reason: 'byte_budget_exceeded',
      datasetCode,
      maxBytes,
      bytesRead: stats.bytesRead,
      rowCount: stats.rowCount,
    },
  );
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Expand the wide TSV body into one row per non-blank cell.
 *
 * Each data line carries a comma-joined dimension key and one cell per period
 * column, so a line becomes as many rows as it has non-blank cells. Cells that
 * are blank on both sides of the value/flag split are skipped. A `:` is kept: a
 * flagged one is an observation Eurostat publishes without a value, and an
 * unflagged one stays a null row too, though it is no observation — a period the
 * series lacks, a period no line has an observation in, or a period of a frequency
 * the series has no observation of. An unflagged `:` adds no period to `periodsSeen`.
 *
 * The same pass settles what the rows cannot show one at a time. Per frequency
 * ({@link periodFrequency}), the span runs from the earliest to the latest column any
 * line has an observation in ({@link frequencySpans}, chronological whatever the column
 * order). An unflagged `:` adds to `absentCellCount` only inside its column's span, and
 * only when its line carries that frequency in another kept cell; the columns outside a
 * span go to `outsideSpans` with their row count. A filter value no line with an
 * observation carries goes to `emptyValues`, unless the budget cut the transfer short.
 *
 * Only complete lines are parsed. When a budget ends the transfer mid-line the trailing
 * fragment is dropped rather than parsed into a row with silently truncated fields, so
 * every count, span included, describes the lines emitted. The byte budget ends the text
 * stream cleanly; the time budget errors the body read, and once a row has been emitted
 * that error ends the rows the same way, with `budgetExceeded` `time`. Before the first
 * row it is the download's failure (`retry_deadline_exceeded`), as is every other failure.
 *
 * `request.filters` holds the filters the key was built from, `request.valueText` adds
 * the `obs_value_text` column holding a cell's text value, and `request.onlyPeriod` keeps
 * one period column and drops every other before it reaches a row or a counter.
 */
async function* expandRows(
  chunks: AsyncGenerator<string>,
  remainder: string,
  header: TsvHeader,
  stats: BulkStats,
  request: {
    filters: Record<string, string[]>;
    onlyPeriod: string | undefined;
    valueText: boolean;
  },
  failure: {
    /** The body failure, classified, as {@link EurostatBulkService.startDownload} reads it. */
    bodyFailure: (error: unknown) => unknown;
    /** The time budget's failure once it has run out, read between chunks. */
    budgetOver: () => McpError | undefined;
    /** The time budget's failure, when `error` is the budget running out. */
    budgetSpent: (error: unknown) => McpError | undefined;
    datasetCode: string;
    maxBytes: number;
  },
): AsyncGenerator<BulkRow> {
  const { filters, onlyPeriod, valueText } = request;
  const columns = header.periods.length;
  let buf = remainder;

  /**
   * Each period column's frequency, as an index into `frequencies` (at most the seven
   * shapes, so one bit each), or -1 for a code {@link periodFrequency} cannot place, which
   * carries no frequency and so is never counted absent.
   */
  const frequencies: string[] = [];
  const columnFrequency = header.periods.map((period) => {
    const frequency = periodFrequency(period);
    if (frequency === undefined) return -1;
    const at = frequencies.indexOf(frequency);
    return at === -1 ? frequencies.push(frequency) - 1 : at;
  });
  /**
   * Per column: whether any line has an observation there, its unflagged `:` rows, and
   * the unflagged `:` rows of lines that carry the column's frequency elsewhere.
   */
  const observed = new Uint8Array(columns);
  const unflaggedRows = new Uint32Array(columns);
  const lackedRows = new Uint32Array(columns);
  /** The current line's unflagged `:` columns of a known frequency; emptied after any line that has one. */
  const unflaggedAt: number[] = [];

  /**
   * Each filter key on the header column it names, with the values sent, lower-cased, that
   * no line with an observation has carried yet. A key the header does not name tracks nothing.
   */
  const unseenValues = Object.entries(filters).flatMap(([key, values]) => {
    const column = header.dimensions.findIndex((dim) => dim.toLowerCase() === key.toLowerCase());
    if (column === -1) return [];
    return [{ column, key, unseen: new Set(values.map((value) => value.toLowerCase())), values }];
  });

  const emit = function* (line: string): Generator<BulkRow> {
    const trimmed = stripCr(line);
    if (trimmed === '') return;
    const fields = trimmed.split('\t');
    const keyParts = (fields[0] ?? '').split(',');
    const cellCount = Math.min(fields.length - 1, columns);
    /** A bit per frequency index this line carries in a kept cell that is not an unflagged `:`. */
    let carried = 0;
    let hasObservation = false;

    for (let i = 0; i < cellCount; i++) {
      const period = header.periods[i] ?? '';
      if (onlyPeriod !== undefined && period !== onlyPeriod) continue;
      const parsed = parseCell(fields[i + 1] ?? '');
      if (!parsed) continue;
      const frequency = columnFrequency[i] ?? -1;
      if (
        parsed.value === null &&
        parsed.flag === null &&
        parsed.conf === null &&
        parsed.text === undefined
      ) {
        unflaggedRows[i] = (unflaggedRows[i] ?? 0) + 1;
        if (frequency !== -1) unflaggedAt.push(i);
      } else {
        if (frequency !== -1) carried |= 1 << frequency;
        observed[i] = 1;
        hasObservation = true;
      }
      const row: BulkRow = {};
      for (let d = 0; d < header.dimensions.length; d++) {
        row[header.dimensions[d] as string] = keyParts[d]?.trim() ?? null;
      }
      row[TIME_COLUMN] = period;
      row[OBS_VALUE_COLUMN] = parsed.value;
      if (valueText) row[OBS_VALUE_TEXT_COLUMN] = parsed.text ?? null;
      row[OBS_FLAG_COLUMN] = parsed.flag;
      row[OBS_FLAG_LABEL_COLUMN] = parsed.flag ? (OBS_FLAG_LABELS[parsed.flag] ?? null) : null;
      row[CONF_STATUS_COLUMN] = parsed.conf;
      row[CONF_STATUS_LABEL_COLUMN] = parsed.conf
        ? (CONF_STATUS_LABELS[parsed.conf] ?? null)
        : null;

      stats.rowCount++;
      if (parsed.value === null) stats.missingCount++;
      yield row;
    }

    // Reached once the consumer has taken the line's last row, before the next line is read.
    if (hasObservation) {
      for (const { column, unseen } of unseenValues) {
        if (unseen.size > 0) unseen.delete(keyParts[column]?.trim().toLowerCase() ?? '');
      }
    }
    // Lines without an unflagged `:` skip the fold: a per-line reset measurably slows narrow
    // bodies, where lines vastly outnumber cells.
    if (unflaggedAt.length === 0) return;
    for (const i of unflaggedAt) {
      if (carried & (1 << (columnFrequency[i] ?? 0))) lackedRows[i] = (lackedRows[i] ?? 0) + 1;
    }
    unflaggedAt.length = 0;
  };

  /** Read the spans off the finished counters, and the filter values no observation carried. */
  const settle = (): void => {
    stats.periodsSeen = [...new Set(header.periods.filter((_, i) => observed[i] === 1))].sort();

    // A dropped one-day column belongs to no frequency, so it lies in no span.
    const kept = header.periods.map((period) =>
      onlyPeriod === undefined || period === onlyPeriod ? period : undefined,
    );
    const rowsAt = (periods: ListedPeriod[]) =>
      periods.reduce((n, { position }) => n + (unflaggedRows[position] ?? 0), 0);
    const spans: OutsideSpan[] = [];
    let outsideRows = 0;
    for (const entry of frequencySpans(kept, (i) => observed[i] === 1).frequencies) {
      const outside = outsideSpanOf(entry);
      if (outside) spans.push(outside);
      if (entry.kind === 'empty') {
        outsideRows += rowsAt(entry.periods);
        continue;
      }
      for (const { position } of entry.inside) stats.absentCellCount += lackedRows[position] ?? 0;
      outsideRows += rowsAt(entry.before) + rowsAt(entry.after);
    }
    if (spans.length > 0) stats.outsideSpans = { rowCount: outsideRows, spans };

    if (stats.budgetExceeded) return;
    const emptyValues: Record<string, string[]> = {};
    for (const { key, unseen, values } of unseenValues) {
      const lacking = [...new Set(values)].filter((value) => unseen.has(value.toLowerCase()));
      if (lacking.length > 0) emptyValues[key] = lacking;
    }
    if (Object.keys(emptyValues).length > 0) stats.emptyValues = emptyValues;
  };

  /**
   * Drain every complete line sitting in the buffer. Called before the read loop
   * as well as inside it: a small body arrives whole while the header is being
   * read, leaving every data line already buffered and no further chunk to
   * trigger a split.
   */
  const flush = function* (): Generator<BulkRow> {
    let newline = buf.indexOf('\n');
    while (newline !== -1) {
      yield* emit(buf.slice(0, newline));
      buf = buf.slice(newline + 1);
      newline = buf.indexOf('\n');
    }
  };

  try {
    let timeUp: McpError | undefined;
    try {
      yield* flush();
      for await (const chunk of chunks) {
        buf += chunk;
        yield* flush();
        /**
         * The fetch's timer cuts a body still arriving. One the runtime already holds whole,
         * a gzip body whose parsing rather than the wire sets the pace, can outlive that
         * timer's abort, so the budget is also read here, between chunks.
         */
        timeUp = failure.budgetOver();
        if (timeUp) break;
      }
      // The final line of a complete body has no trailing newline. A budget-cancelled
      // body's trailing fragment is not a final line — it is a line cut in half.
      if (!stats.budgetExceeded && !timeUp) yield* emit(buf);
    } catch (error) {
      // Only a body read throws here: the rows' consumer stops this generator by return.
      timeUp = failure.budgetSpent(error);
      if (!timeUp) throw failure.bodyFailure(error);
    }
    if (timeUp) {
      if (stats.rowCount === 0) throw timeUp;
      // Rows have streamed, so they stand as the prefix, the cut line in `buf` dropped.
      stats.budgetExceeded = 'time';
    }

    settle();
    if (stats.budgetExceeded === 'bytes' && stats.rowCount === 0)
      throw byteBudgetFailure(failure.datasetCode, stats, failure.maxBytes);
  } finally {
    /**
     * Close the text stream on every exit. A consumer that stops early — a canvas
     * append that throws, an abort — abandons this generator, and a small body
     * whose rows were all buffered while the header was read is abandoned before
     * the `for await` above ever starts it. Neither path would otherwise reach the
     * cancel that frees the response body.
     */
    await chunks.return(undefined);
  }
}

// --- Init/accessor pattern ---

let _service: EurostatBulkService | undefined;

export function initEurostatBulkService(config: AppConfig, storage: StorageService): void {
  _service = new EurostatBulkService(config, storage);
}

export function getEurostatBulkService(): EurostatBulkService {
  if (!_service) {
    throw new Error(
      'EurostatBulkService not initialized — call initEurostatBulkService() in setup()',
    );
  }
  return _service;
}
