/**
 * @fileoverview Eurostat Bulk Service — streaming client for the SDMX 2.1 TSV
 * dissemination endpoint. Builds the positional dimension key, sniffs gzip off
 * the stream, enforces a byte budget mid-transfer, classifies XML SOAP faults
 * and the asynchronous queue envelope, and expands the wide TSV layout into
 * one row per observation.
 * @module services/eurostat-bulk/eurostat-bulk-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  type McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  CONF_STATUS_COLUMN,
  CONF_STATUS_LABEL_COLUMN,
  CONF_STATUS_LABELS,
  OBS_FLAG_COLUMN,
  OBS_FLAG_LABEL_COLUMN,
  OBS_FLAG_LABELS,
  OBS_VALUE_COLUMN,
} from '@/services/eurostat-codelists.js';
import {
  type BulkDownload,
  type BulkRow,
  type BulkStats,
  TIME_COLUMN,
  type TsvHeader,
} from './types.js';

// Context satisfies the runtime contract of RequestContext but lacks the index signature
// required by fetchWithTimeout.
const asReqCtx = (ctx: Context) => ctx as unknown as Record<string, unknown> & typeof ctx;

/**
 * Decoded characters buffered before an XML body is classified.
 *
 * Both non-data shapes are small — the largest SOAP fault observed is under 400
 * bytes and the queue envelope under 350 — so this only has to hold one of them.
 * It deliberately does **not** bound the search for the TSV header's line break:
 * that line carries one field per period and runs to 166 KB on a daily series.
 */
const XML_PEEK_CHARS = 8_192;

/** Separator between the observation flag and the confidentiality flag inside a TSV cell. */
const CONF_SEPARATOR = '@';

/** Eurostat's marker for an observation whose value is not available. */
const MISSING_VALUE = ':';

/** The header line's first field ends with this literal before the period columns begin. */
const TIME_HEADER_SUFFIX = '\\TIME_PERIOD';

/** Minimal XML entity decoding — the five predefined entities SOAP fault strings use. */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Translate an XML body from the SDMX endpoint into the declared error contract.
 *
 * Two unrelated shapes arrive as XML and neither is data. A `S:Fault` envelope
 * accompanies a 4xx and names the problem in a numeric `faultcode`. The
 * `syncResponse` envelope arrives on **HTTP 200** carrying a queue ticket
 * instead of the dataset — parsed as TSV it yields a header row of XML, so it is
 * detected here rather than downstream.
 *
 * Always throws.
 */
export function classifyXmlBody(xml: string, datasetCode: string): never {
  if (xml.includes('syncResponse') || xml.includes('<status>SUBMITTED</status>')) {
    throw serviceUnavailable(
      `Eurostat queued this extraction instead of returning data: the SDMX endpoint answered with an asynchronous "SUBMITTED" ticket for "${datasetCode}". The queued result is not retrievable through this server. Narrow the request with dimension filters or a period range so Eurostat serves it synchronously.`,
      { reason: 'async_queued', datasetCode, retryable: false },
    );
  }

  const code = /<faultcode>\s*(\d+)\s*<\/faultcode>/.exec(xml)?.[1];
  const detail = decodeEntities(
    /<faultstring>([\s\S]*?)<\/faultstring>/.exec(xml)?.[1]?.trim() ?? xml.slice(0, 300),
  );

  if (code === '100') {
    throw notFound(
      `Dataset "${datasetCode}" is not available for dissemination. Eurostat fault ${code}: ${detail}`,
      { reason: 'not_found', datasetCode, faultcode: code },
    );
  }
  if (code === '140') {
    throw validationError(
      `Eurostat rejected the dimension key: the number of filter positions did not match the dataset's dimensions. Eurostat fault ${code}: ${detail}`,
      { reason: 'filter_arity', datasetCode, faultcode: code },
    );
  }
  if (code === '150') {
    throw validationError(
      `Eurostat rejected a filter value. This fault also covers a period range outside the dataset's coverage. Eurostat fault ${code}: ${detail}`,
      { reason: 'invalid_dimension', datasetCode, faultcode: code },
    );
  }
  throw serviceUnavailable(
    `Eurostat SDMX endpoint returned a fault for "${datasetCode}"${code ? ` (faultcode ${code})` : ''}: ${detail}`,
    { reason: 'upstream_fault', datasetCode, ...(code && { faultcode: code }) },
  );
}

/**
 * Split one wide-TSV cell into its value and flags.
 *
 * The grammar, read off live responses, is `<value>` `SPACE` `<flags>`, where
 * flags is `<obs_flag>` optionally followed by `@<conf_status>` and either part
 * may be empty: `429634.3 `, `3853937.0 p`, `: `, `: @C`. A cell that is empty
 * on both sides of the split is not an observation at all and yields
 * `undefined` — distinct from `: `, which is an observation Eurostat reports as
 * unavailable.
 */
export function parseCell(
  cell: string,
): { conf: string | null; flag: string | null; value: number | null } | undefined {
  const sep = cell.indexOf(' ');
  const rawValue = (sep === -1 ? cell : cell.slice(0, sep)).trim();
  const rawFlags = (sep === -1 ? '' : cell.slice(sep + 1)).trim();

  if (rawValue === '' && rawFlags === '') return;

  const atIdx = rawFlags.indexOf(CONF_SEPARATOR);
  const flag = (atIdx === -1 ? rawFlags : rawFlags.slice(0, atIdx)) || null;
  const conf = (atIdx === -1 ? '' : rawFlags.slice(atIdx + 1)) || null;

  if (rawValue === '' || rawValue === MISSING_VALUE) return { conf, flag, value: null };
  const num = Number(rawValue);
  return { conf, flag, value: Number.isFinite(num) ? num : null };
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
 * Returns `undefined` when no filter applies. An all-wildcard key is accepted
 * by Eurostat, but omitting the segment asks the same question without staking
 * the request on this server's copy of the dimension order being current.
 */
export function buildKeyPath(
  dimensionOrder: string[],
  filters: Record<string, string[]>,
): string | undefined {
  const applied = Object.entries(filters).filter(([, values]) => values.length > 0);
  if (applied.length === 0) return;

  const unknown = applied.map(([dim]) => dim).filter((dim) => !dimensionOrder.includes(dim));
  if (unknown.length > 0) {
    throw validationError(
      `Filter names ${unknown.map((d) => `"${d}"`).join(', ')}, which ${unknown.length === 1 ? 'is not a dimension' : 'are not dimensions'} of this dataset. Filterable dimensions, in key order: ${dimensionOrder.join(', ')}. The time dimension is filtered with since_period/until_period instead.`,
      { reason: 'invalid_dimension', unknownDimensions: unknown, dimensionOrder },
    );
  }

  return dimensionOrder.map((dim) => (filters[dim] ?? []).join('+')).join('.');
}

/**
 * Canvas column schema for {@link BulkRow}, declared rather than sniffed.
 *
 * Inference reads only the leading rows, which types an all-integer measure
 * prefix as `BIGINT` — serialized back out as a string — and types an
 * all-missing prefix from nulls alone. Every column is nullable: a measure is
 * routinely unavailable, and flags are the exception rather than the rule.
 */
export function bulkRowSchema(dimensions: string[]): ColumnSchema[] {
  return [
    ...dimensions.map((dim): ColumnSchema => ({ name: dim, type: 'VARCHAR', nullable: true })),
    { name: TIME_COLUMN, type: 'VARCHAR', nullable: true },
    { name: OBS_VALUE_COLUMN, type: 'DOUBLE', nullable: true },
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
    const { baseUrl } = getServerConfig();
    const path = keyPath
      ? `${encodeURIComponent(datasetCode)}/${encodeURIComponent(keyPath)}`
      : encodeURIComponent(datasetCode);
    const url = new URL(`${baseUrl}/sdmx/2.1/data/${path}`);
    url.searchParams.set('format', 'TSV');
    if (sinceP) url.searchParams.set('startPeriod', sinceP);
    if (untilP) url.searchParams.set('endPeriod', untilP);
    return url;
  }

  /**
   * Start a bulk download: issue the request, classify the response, parse the
   * header, and hand back a generator over the body.
   *
   * The request is made once with no retry. A bulk body streams for up to
   * `EUROSTAT_BULK_TIMEOUT_MS`, so re-running it on a transient failure costs
   * the caller another full transfer for a request that is already the most
   * expensive one this server makes; the failure is surfaced instead.
   */
  async startDownload(
    datasetCode: string,
    dimensionOrder: string[],
    filters: Record<string, string[]>,
    sinceP: string | undefined,
    untilP: string | undefined,
    ctx: Context,
  ): Promise<BulkDownload> {
    const { bulkTimeoutMs, bulkMaxBytes } = getServerConfig();
    const keyPath = buildKeyPath(dimensionOrder, filters);
    const url = this.buildUrl(datasetCode, keyPath, sinceP, untilP);

    ctx.log.info('Starting SDMX bulk download', {
      datasetCode,
      keyPath,
      sinceP,
      untilP,
      maxBytes: bulkMaxBytes,
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(url.toString(), bulkTimeoutMs, asReqCtx(ctx), {
        signal: ctx.signal,
        // 400 (bad filter value or arity) and 404 (unknown dataset) are modeled outcomes
        // reclassified below into the declared error contract, not service failures.
        expectedStatuses: [400, 404],
      });
    } catch (err) {
      // fetchWithTimeout throws for any non-2xx before the caller sees the body, so the
      // SOAP fault is only reachable through the captured excerpt on err.data. Faults run
      // well under the framework's 500-byte cap, so the excerpt carries the whole envelope.
      const body = (err as McpError).data as { body?: string } | undefined;
      if (typeof body?.body === 'string' && body.body.includes('<')) {
        classifyXmlBody(body.body, datasetCode);
      }
      throw err;
    }

    if (!response.body) {
      throw serviceUnavailable(
        `Eurostat SDMX endpoint returned an empty body for "${datasetCode}".`,
        { reason: 'upstream_fault', datasetCode },
      );
    }

    const stats: BulkStats = {
      bytesRead: 0,
      budgetExceeded: false,
      compressed: false,
      rowCount: 0,
      missingCount: 0,
      periodsSeen: [],
    };

    const decoded = await decodeBody(response.body, stats, bulkMaxBytes);
    const { header, remainder, iterator } = await readHeader(decoded, datasetCode);

    return {
      header,
      stats,
      url: url.toString(),
      rows: () => expandRows(iterator, remainder, header, stats),
    };
  }
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
 * across both encodings, and since a gzip body is never larger than what it
 * expands to, bounding the decoded size bounds the transfer as well. Hitting it
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
      stats.bytesRead += value.length;
      if (stats.bytesRead > maxBytes) {
        stats.budgetExceeded = true;
        return;
      }
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
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
 * header's own tail as a data line. The byte budget is what bounds this loop.
 */
async function readHeader(
  chunks: AsyncGenerator<string>,
  datasetCode: string,
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

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Expand the wide TSV body into one row per populated cell.
 *
 * Each data line carries a comma-joined dimension key and one cell per period
 * column, so a line becomes as many rows as it has populated cells. Cells that
 * are blank on both sides of the value/flag split carry no observation and are
 * skipped; `:` is kept, because Eurostat reporting a value as unavailable is
 * itself data.
 *
 * Only complete lines are parsed. When the byte budget cancels the transfer
 * mid-line the trailing fragment is dropped rather than parsed into a row with
 * silently truncated fields.
 */
async function* expandRows(
  chunks: AsyncGenerator<string>,
  remainder: string,
  header: TsvHeader,
  stats: BulkStats,
): AsyncGenerator<BulkRow> {
  const seen = new Set<string>();
  let buf = remainder;

  const emit = function* (line: string): Generator<BulkRow> {
    const trimmed = stripCr(line);
    if (trimmed === '') return;
    const fields = trimmed.split('\t');
    const keyParts = (fields[0] ?? '').split(',');
    const cellCount = Math.min(fields.length - 1, header.periods.length);

    for (let i = 0; i < cellCount; i++) {
      const parsed = parseCell(fields[i + 1] ?? '');
      if (!parsed) continue;
      const period = header.periods[i] ?? '';
      const row: BulkRow = {};
      for (let d = 0; d < header.dimensions.length; d++) {
        row[header.dimensions[d] as string] = keyParts[d]?.trim() ?? null;
      }
      row[TIME_COLUMN] = period;
      row[OBS_VALUE_COLUMN] = parsed.value;
      row[OBS_FLAG_COLUMN] = parsed.flag;
      row[OBS_FLAG_LABEL_COLUMN] = parsed.flag ? (OBS_FLAG_LABELS[parsed.flag] ?? null) : null;
      row[CONF_STATUS_COLUMN] = parsed.conf;
      row[CONF_STATUS_LABEL_COLUMN] = parsed.conf
        ? (CONF_STATUS_LABELS[parsed.conf] ?? null)
        : null;

      stats.rowCount++;
      if (parsed.value === null) stats.missingCount++;
      seen.add(period);
      yield row;
    }
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
    yield* flush();
    for await (const chunk of chunks) {
      buf += chunk;
      yield* flush();
    }
    // The final line of a complete body has no trailing newline. A budget-cancelled
    // body's trailing fragment is not a final line — it is a line cut in half.
    if (!stats.budgetExceeded) yield* emit(buf);

    stats.periodsSeen = [...seen].sort();
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
