/**
 * @fileoverview Unit tests for EurostatBulkService — positional key building,
 * SOAP fault and async-queue classification, gzip sniffing off the stream, the
 * streaming byte budget, and wide-TSV to long-row expansion.
 *
 * The TSV fixtures are literal bytes copied from live Eurostat responses,
 * including their CRLF line endings and the trailing space Eurostat pads every
 * period column and cell value with. Nothing here re-derives the cell grammar —
 * a helper that split cells the way the parser does would only prove the helper
 * and the parser agree.
 *
 * @module tests/services/eurostat-bulk-service.test
 */

import { gzipSync } from 'node:zlib';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import {
  buildKeyPath,
  bulkRowSchema,
  classifyXmlBody,
  EurostatBulkService,
  getEurostatBulkService,
  initEurostatBulkService,
  parseCell,
  parseHeader,
} from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import type { BulkRow, BulkStats, TsvHeader } from '@/services/eurostat-bulk/types.js';

const mockConfig = {} as never;
const mockStorage = {} as never;

/**
 * A three-period slice of `nama_10_gdp`, byte-for-byte as Eurostat serves it:
 * comma-joined dimension key, `\TIME_PERIOD` on the header's first field, a
 * trailing space on every period name and every cell value, CRLF line endings,
 * and a final CRLF.
 */
const NAMA_TSV =
  'freq,unit,na_item,geo\\TIME_PERIOD\t2022 \t2023 \t2024 \r\n' +
  'A,CP_MEUR,B1G,AT\t402767.1 \t429634.3 \t443546.0 \r\n' +
  'A,CP_MEUR,B1G,DE\t3591874.0 p\t3853937.0 p\t3921311.0 p\r\n';

/** A `sts_inpr_m` slice carrying both a missing cell and a confidential one. */
const CONF_TSV =
  'freq,indic_bt,nace_r2,s_adj,unit,geo\\TIME_PERIOD\t2023-01 \t2023-02 \r\n' +
  'M,PRD,B,CA,I21,BG\t94.4 p\t: \r\n' +
  'M,PRD,B,CA,I21,IE\t: @C\t: @C\r\n';

const FAULT_100 =
  '<?xml version="1.0" encoding="UTF-8"?><S:Fault xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>100</faultcode><faultstring>ERR_NOT_FOUND_2: DATA_SET:NO_SUCH is not available for dissemination.</faultstring></S:Fault>';
const FAULT_140 =
  '<?xml version="1.0" encoding="UTF-8"?><S:Fault xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>140</faultcode><faultstring>INVALID_QUERY_NB_FILTERS: Incorrect number of filters</faultstring></S:Fault>';
const FAULT_150 =
  '<?xml version="1.0" encoding="UTF-8"?><S:Fault xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>150</faultcode><faultstring>INVALID_QUERY_DIMENSION_VALUE: Query is invalid as per its structure&apos;s definition. The following values for dimension are not allowed: UNIT=NOTAUNIT.</faultstring></S:Fault>';
const FAULT_UNKNOWN =
  '<?xml version="1.0" encoding="UTF-8"?><S:Fault xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>999</faultcode><faultstring>SOMETHING_ELSE: unmodelled</faultstring></S:Fault>';
/** Arrives on HTTP 200 in place of data — parsed as TSV it would look like a header of XML. */
const QUEUE_ENVELOPE =
  '<?xml version="1.0" encoding="UTF-8" ?>\n<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Header/><env:Body><ns0:syncResponse xmlns:ns0="http://estat.ec.europa.eu/disschain/soap/extraction"><processingTime>92</processingTime><queued><id>e3d39a1b-27eb-4ce4-936d-8f95b23bf74f</id><status>SUBMITTED</status></queued></ns0:syncResponse></env:Body></env:Envelope>';

/** Wrap explicit byte chunks in a Response, so chunk boundaries are part of the fixture. */
function responseOf(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200 }) as Response;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Split a byte array at an explicit offset, to exercise cross-chunk buffering. */
function splitAt(bytes: Uint8Array, offset: number): Uint8Array[] {
  return [bytes.subarray(0, offset), bytes.subarray(offset)];
}

function mockBody(chunks: Uint8Array[]): void {
  vi.mocked(fetchWithTimeout).mockResolvedValue(responseOf(chunks));
}

async function drain(
  svc: EurostatBulkService,
  dataset = 'nama_10_gdp',
  order: string[] = [],
  filters: Record<string, string[]> = {},
): Promise<{ header: TsvHeader; rows: BulkRow[]; stats: BulkStats }> {
  const ctx = createMockContext();
  const dl = await svc.startDownload(dataset, order, filters, undefined, undefined, ctx);
  const rows: BulkRow[] = [];
  for await (const row of dl.rows()) rows.push(row);
  return { header: dl.header, rows, stats: dl.stats };
}

describe('parseHeader', () => {
  it('reads the dimension names off the key field and strips the TIME_PERIOD suffix', () => {
    const header = parseHeader('freq,unit,na_item,geo\\TIME_PERIOD\t2022 \t2023 ');
    expect(header.dimensions).toEqual(['freq', 'unit', 'na_item', 'geo']);
  });

  it('trims the trailing space Eurostat pads every period column with', () => {
    const header = parseHeader('freq,geo\\TIME_PERIOD\t2023-01 \t2023-02 ');
    expect(header.periods).toEqual(['2023-01', '2023-02']);
  });

  it('reads a seven-dimension header', () => {
    const header = parseHeader(
      'freq,unit,c_resid,citizen,sex,age,geo\\TIME_PERIOD\t2021 \t2022 \t2023 ',
    );
    expect(header.dimensions).toEqual(['freq', 'unit', 'c_resid', 'citizen', 'sex', 'age', 'geo']);
    expect(header.periods).toHaveLength(3);
  });

  it('rejects a header with no period columns', () => {
    expect(() => parseHeader('freq,geo\\TIME_PERIOD')).toThrow(McpError);
  });

  it('rejects a header with no dimension names', () => {
    expect(() => parseHeader('\t2023 ')).toThrow(McpError);
  });
});

describe('parseCell', () => {
  it('reads a plain value', () => {
    expect(parseCell('402767.1 ')).toEqual({ value: 402767.1, flag: null, conf: null });
  });

  it('reads a value carrying an observation flag', () => {
    expect(parseCell('3591874.0 p')).toEqual({ value: 3591874, flag: 'p', conf: null });
  });

  it('reads a composite observation flag as one code', () => {
    expect(parseCell('12.5 bdep')).toEqual({ value: 12.5, flag: 'bdep', conf: null });
  });

  it('reads the missing marker as a null value, not an absent cell', () => {
    expect(parseCell(': ')).toEqual({ value: null, flag: null, conf: null });
  });

  it('reads a confidential cell: no value, no obs flag, conf status after the @', () => {
    expect(parseCell(': @C')).toEqual({ value: null, flag: null, conf: 'C' });
  });

  it('reads an observation flag and a conf status together', () => {
    expect(parseCell('7.0 p@C')).toEqual({ value: 7, flag: 'p', conf: 'C' });
  });

  it('reports a wholly empty cell as no observation at all', () => {
    expect(parseCell('')).toBeUndefined();
    expect(parseCell('   ')).toBeUndefined();
  });

  it('reads a value with no trailing space at end of line', () => {
    expect(parseCell('100')).toEqual({ value: 100, flag: null, conf: null });
  });

  it('reports an unparseable value as missing rather than NaN', () => {
    expect(parseCell('n/a ')).toEqual({ value: null, flag: null, conf: null });
  });

  it('reads an empty value carrying a flag as missing, not as zero', () => {
    // Number('') is 0, so an empty value reaching the numeric branch would fabricate
    // an observation of zero where Eurostat reported none.
    expect(parseCell(' p')).toEqual({ value: null, flag: 'p', conf: null });
    expect(parseCell(' @C')).toEqual({ value: null, flag: null, conf: 'C' });
  });
});

describe('buildKeyPath', () => {
  const order = ['freq', 'unit', 'na_item', 'geo'];

  it('emits one position per dimension, including the unfiltered ones', () => {
    expect(buildKeyPath(order, { na_item: ['B1G'], geo: ['AT'] })).toBe('..B1G.AT');
  });

  it('joins multiple accepted values with +', () => {
    expect(buildKeyPath(order, { geo: ['AT', 'DE', 'FR'] })).toBe('...AT+DE+FR');
  });

  it('keeps the key arity equal to the dimension count whatever is filtered', () => {
    for (const filters of [
      { freq: ['A'] },
      { geo: ['AT'] },
      { freq: ['A'], unit: ['CP_MEUR'], na_item: ['B1G'], geo: ['AT'] },
    ]) {
      expect(buildKeyPath(order, filters)?.split('.')).toHaveLength(order.length);
    }
  });

  it('omits the key segment entirely when nothing is filtered', () => {
    expect(buildKeyPath(order, {})).toBeUndefined();
    expect(buildKeyPath(order, { geo: [] })).toBeUndefined();
  });

  it('rejects a filter naming a dimension the dataset does not have, listing the real ones', () => {
    try {
      buildKeyPath(order, { country: ['AT'] });
      expect.unreachable('expected a validation error');
    } catch (err) {
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_dimension' });
      expect((err as Error).message).toContain('freq, unit, na_item, geo');
    }
  });

  it('rejects "time" as a filter — it is not part of the positional key', () => {
    expect(() => buildKeyPath(order, { time: ['2024'] })).toThrow(McpError);
  });
});

describe('classifyXmlBody', () => {
  it('maps faultcode 100 to not_found', () => {
    try {
      classifyXmlBody(FAULT_100, 'no_such');
      expect.unreachable('expected a throw');
    } catch (err) {
      expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
      expect((err as McpError).data).toMatchObject({ reason: 'not_found', faultcode: '100' });
    }
  });

  it('maps faultcode 140 to filter_arity', () => {
    try {
      classifyXmlBody(FAULT_140, 'nama_10_gdp');
      expect.unreachable('expected a throw');
    } catch (err) {
      expect((err as McpError).data).toMatchObject({ reason: 'filter_arity', faultcode: '140' });
    }
  });

  it('maps faultcode 150 to invalid_dimension and decodes the entity-escaped detail', () => {
    try {
      classifyXmlBody(FAULT_150, 'nama_10_gdp');
      expect.unreachable('expected a throw');
    } catch (err) {
      expect((err as McpError).data).toMatchObject({
        reason: 'invalid_dimension',
        faultcode: '150',
      });
      expect((err as Error).message).toContain("structure's definition");
      expect((err as Error).message).not.toContain('&apos;');
    }
  });

  it('decodes an escaped ampersand once, not into the entity behind it', () => {
    // &amp; has to be decoded last: decoding it first turns &amp;lt; into a tag.
    try {
      classifyXmlBody(FAULT_150.replace('&apos;', '&amp;lt;'), 'x');
      expect.unreachable('expected a throw');
    } catch (err) {
      expect((err as Error).message).toContain('&lt;');
      expect((err as Error).message).not.toContain('<');
    }
  });

  it('maps an unmodelled faultcode to upstream_fault rather than guessing', () => {
    try {
      classifyXmlBody(FAULT_UNKNOWN, 'x');
      expect.unreachable('expected a throw');
    } catch (err) {
      expect((err as McpError).data).toMatchObject({ reason: 'upstream_fault', faultcode: '999' });
    }
  });

  it('maps the SUBMITTED queue envelope to async_queued and marks it non-retryable', () => {
    try {
      classifyXmlBody(QUEUE_ENVELOPE, 'migr_asyrescra');
      expect.unreachable('expected a throw');
    } catch (err) {
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((err as McpError).data).toMatchObject({ reason: 'async_queued', retryable: false });
    }
  });
});

describe('bulkRowSchema', () => {
  it('declares exactly the columns an expanded row carries, in the same order', async () => {
    const svc = new EurostatBulkService(mockConfig, mockStorage);
    mockBody([utf8(NAMA_TSV)]);
    const { header, rows } = await drain(svc);
    const schema = bulkRowSchema(header.dimensions);
    expect(schema.map((c) => c.name)).toEqual(Object.keys(rows[0] as BulkRow));
  });

  it('types the measure DOUBLE so an integer-only prefix is not inferred as BIGINT', () => {
    const schema = bulkRowSchema(['geo']);
    expect(schema.find((c) => c.name === 'obs_value')?.type).toBe('DOUBLE');
    expect(schema.every((c) => c.nullable)).toBe(true);
  });
});

describe('EurostatBulkService — streaming', () => {
  let svc: EurostatBulkService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new EurostatBulkService(mockConfig, mockStorage);
  });

  it('expands a wide CRLF body into one row per populated cell', async () => {
    mockBody([utf8(NAMA_TSV)]);
    const { rows, stats } = await drain(svc);

    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      freq: 'A',
      unit: 'CP_MEUR',
      na_item: 'B1G',
      geo: 'AT',
      time: '2022',
      obs_value: 402767.1,
      obs_flag: null,
      obs_flag_label: null,
      conf_status: null,
      conf_status_label: null,
    });
    expect(rows[3]).toMatchObject({ geo: 'DE', time: '2022', obs_value: 3591874, obs_flag: 'p' });
    expect(stats.rowCount).toBe(6);
  });

  it('emits the last line of a body that ends without a newline', async () => {
    mockBody([utf8(NAMA_TSV.trimEnd())]);
    const { rows } = await drain(svc);
    expect(rows).toHaveLength(6);
  });

  it('reassembles a line split across chunk boundaries', async () => {
    const bytes = utf8(NAMA_TSV);
    // Mid-way through the first data row, so the row spans both chunks.
    mockBody(splitAt(bytes, 60));
    const { rows } = await drain(svc);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toMatchObject({ geo: 'AT', time: '2023', obs_value: 429634.3 });
  });

  it('reassembles a body delivered one byte at a time', async () => {
    const bytes = utf8(NAMA_TSV);
    mockBody([...bytes].map((b) => Uint8Array.of(b)));
    const { rows } = await drain(svc);
    expect(rows).toHaveLength(6);
  });

  it('resolves flag labels from the static dictionary and leaves unknown codes unlabelled', async () => {
    mockBody([utf8('freq,geo\\TIME_PERIOD\t2023 \t2024 \r\nA,AT\t1.0 p\t2.0 zz\r\n')]);
    const { rows } = await drain(svc);
    expect(rows[0]).toMatchObject({ obs_flag: 'p', obs_flag_label: 'provisional' });
    expect(rows[1]).toMatchObject({ obs_flag: 'zz', obs_flag_label: null });
  });

  it('keeps a missing observation and decodes the confidentiality flag behind the @', async () => {
    mockBody([utf8(CONF_TSV)]);
    const { rows, stats } = await drain(svc);

    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ geo: 'BG', time: '2023-02', obs_value: null, obs_flag: null });
    expect(rows[2]).toMatchObject({
      geo: 'IE',
      obs_value: null,
      conf_status: 'C',
      conf_status_label: 'confidential',
    });
    expect(stats.missingCount).toBe(3);
  });

  it('drops cells the header names no period for rather than emitting a blank time', async () => {
    // A line with more cells than the header has period columns: the surplus has no
    // period to belong to, so it is not an observation.
    mockBody([utf8('freq,geo\\TIME_PERIOD\t2023 \r\nA,AT\t1.0 \t2.0 \t3.0 \r\n')]);
    const { rows } = await drain(svc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ time: '2023', obs_value: 1 });
  });

  it('skips a cell that is empty on both sides of the value/flag split', async () => {
    mockBody([utf8('freq,geo\\TIME_PERIOD\t2023 \t2024 \r\nA,AT\t\t5.0 \r\n')]);
    const { rows } = await drain(svc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ time: '2024', obs_value: 5 });
  });

  it('reports the periods that actually carried an observation', async () => {
    mockBody([utf8(NAMA_TSV)]);
    const { stats } = await drain(svc);
    expect(stats.periodsSeen).toEqual(['2022', '2023', '2024']);
  });

  it('returns no rows for a header-only body', async () => {
    mockBody([utf8('freq,geo\\TIME_PERIOD\t2023 \r\n')]);
    const { rows, stats } = await drain(svc);
    expect(rows).toEqual([]);
    expect(stats.rowCount).toBe(0);
  });

  it('reports periods ascending even when the body emits them out of order', async () => {
    // Period columns are not guaranteed ascending, and periodRange is read off the
    // ends of this list — so insertion order is not the same thing as sorted.
    mockBody([utf8('freq,geo\\TIME_PERIOD\t2024 \t2022 \t2023 \r\nA,AT\t3.0 \t1.0 \t2.0 \r\n')]);
    const { stats } = await drain(svc);
    expect(stats.periodsSeen).toEqual(['2022', '2023', '2024']);
  });

  it('reads a header line far longer than the XML peek window without losing columns', async () => {
    // A daily series carries one period field per business day — 13,852 fields and
    // 166 KB on ert_bil_eur_d. Buffering the header to a fixed window would parse a
    // prefix of it as the whole header, drop every period past the cap, and read the
    // header's own tail as a data line.
    const periods = Array.from({ length: 2_000 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      return `${1974 + Math.floor(i / 28)}-01-${day}`;
    });
    const body = `freq,geo\\TIME_PERIOD\t${periods.join(' \t')} \r\nA,AT\t${periods
      .map((_, i) => `${i}.0 `)
      .join('\t')}\r\n`;
    const bytes = utf8(body);
    expect(body.indexOf('\r\n')).toBeGreaterThan(20_000);

    // 4 KB chunks, so the header spans many reads.
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 4_096) chunks.push(bytes.subarray(at, at + 4_096));
    mockBody(chunks);

    const { header, rows, stats } = await drain(svc);
    expect(header.periods).toHaveLength(periods.length);
    expect(header.periods.at(-1)).toBe(periods.at(-1));
    expect(rows).toHaveLength(periods.length);
    expect(stats.rowCount).toBe(periods.length);
    // Every row is a real observation, not a fragment of the header line read as data.
    for (const row of rows) {
      expect(row.freq).toBe('A');
      expect(row.geo).toBe('AT');
      expect(row.obs_value).not.toBeNull();
    }
  });

  it('cancels the response body when the row generator is abandoned part-way', async () => {
    // A canvas append that throws mid-stream abandons the generator. Releasing the
    // reader's lock without cancelling would leave the transfer undrained.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8(NAMA_TSV));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.mocked(fetchWithTimeout).mockResolvedValue(new Response(body, { status: 200 }));

    const dl = await svc.startDownload('x', [], {}, undefined, undefined, createMockContext());
    const iterator = dl.rows();
    await iterator.next();
    await iterator.return(undefined);

    expect(cancelled).toBe(true);
  });

  describe('gzip sniffing', () => {
    it('decompresses a body whose only signal is the magic bytes', async () => {
      // No Content-Encoding and no Content-Disposition: only the stream says gzip.
      mockBody([new Uint8Array(gzipSync(Buffer.from(NAMA_TSV)))]);
      const { rows, stats } = await drain(svc);
      expect(stats.compressed).toBe(true);
      expect(rows).toHaveLength(6);
      expect(rows[0]).toMatchObject({ geo: 'AT', obs_value: 402767.1 });
    });

    it('sniffs correctly when the magic bytes are split across chunks', async () => {
      const gz = new Uint8Array(gzipSync(Buffer.from(NAMA_TSV)));
      mockBody([gz.subarray(0, 1), gz.subarray(1)]);
      const { rows, stats } = await drain(svc);
      expect(stats.compressed).toBe(true);
      expect(rows).toHaveLength(6);
    });

    it('leaves a plain body alone', async () => {
      mockBody([utf8(NAMA_TSV)]);
      const { stats } = await drain(svc);
      expect(stats.compressed).toBe(false);
    });

    it('needs both magic bytes, not just the first', async () => {
      const bytes = utf8(NAMA_TSV);
      const spoofed = new Uint8Array(bytes.length + 2);
      spoofed.set([0x1f, 0x00]);
      spoofed.set(bytes, 2);
      mockBody([spoofed]);
      const { stats } = await drain(svc);
      expect(stats.compressed).toBe(false);
    });

    it('counts decoded bytes, not wire bytes, for a compressed body', async () => {
      const gz = new Uint8Array(gzipSync(Buffer.from(NAMA_TSV)));
      mockBody([gz]);
      const { stats } = await drain(svc);
      expect(stats.bytesRead).toBe(utf8(NAMA_TSV).length);
      expect(stats.bytesRead).toBeGreaterThan(gz.length);
    });
  });

  describe('byte budget', () => {
    const original = process.env.EUROSTAT_BULK_MAX_BYTES;

    afterEach(() => {
      if (original === undefined) delete process.env.EUROSTAT_BULK_MAX_BYTES;
      else process.env.EUROSTAT_BULK_MAX_BYTES = original;
      vi.resetModules();
    });

    /**
     * A header chunk followed by one data row per chunk, so the budget can be
     * set to stop the transfer with chunks still unsent.
     */
    const ROW_CHUNKS = ['AT', 'BE', 'CZ', 'DE', 'ES', 'FI', 'FR', 'HU'].map((geo, i) =>
      utf8(`A,${geo}\t${i + 1}.0 \r\n`),
    );
    const HEADER_CHUNK = utf8('freq,geo\\TIME_PERIOD\t2023 \r\n');

    it('stops the transfer with chunks unsent rather than draining and reporting after', async () => {
      // Budget covers the header plus three rows. The remaining five chunks must never
      // be requested — a budget checked after the fact would have pulled all eight.
      const budget = HEADER_CHUNK.length + ROW_CHUNKS.slice(0, 3).reduce((n, c) => n + c.length, 0);
      const { svc: fresh, delivered } = await freshServiceWithBudget(budget, [
        HEADER_CHUNK,
        ...ROW_CHUNKS,
      ]);
      const ctx = createMockContext();
      const dl = await fresh.startDownload('x', [], {}, undefined, undefined, ctx);
      const rows: BulkRow[] = [];
      for await (const row of dl.rows()) rows.push(row);

      expect(dl.stats.budgetExceeded).toBe(true);
      expect(rows.map((r) => r.geo)).toEqual(['AT', 'BE', 'CZ']);
      expect(delivered()).toBeLessThan(1 + ROW_CHUNKS.length);
    });

    it('drops the line the budget cut in half instead of emitting a truncated row', async () => {
      const whole = utf8(
        'freq,geo\\TIME_PERIOD\t2023 \r\nA,AT\t1.0 \r\nA,BE\t2.0 \r\nA,CZ\t3.0 \r\nA,DE\t4.0 \r\n',
      );
      // Eight-byte chunks, with the budget landing part-way through the "CZ" row, so the
      // last text the parser sees ends in a fragment of a line rather than at a newline.
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < whole.length; at += 8) chunks.push(whole.subarray(at, at + 8));
      const { svc: fresh } = await freshServiceWithBudget(58, chunks);
      const ctx = createMockContext();
      const dl = await fresh.startDownload('x', [], {}, undefined, undefined, ctx);
      const rows: BulkRow[] = [];
      for await (const row of dl.rows()) rows.push(row);

      expect(dl.stats.budgetExceeded).toBe(true);
      // Every emitted row is whole: no null dimension, no null period.
      for (const row of rows) {
        expect(row.geo).toBeTruthy();
        expect(row.time).toBe('2023');
        expect(row.obs_value).not.toBeNull();
      }
      expect(rows.map((r) => r.geo)).toEqual(['AT', 'BE']);
    });

    it('leaves budgetExceeded false when the body fits', async () => {
      const bytes = utf8(NAMA_TSV);
      const { svc: fresh, delivered } = await freshServiceWithBudget(bytes.length * 10, [bytes]);
      const ctx = createMockContext();
      const dl = await fresh.startDownload('x', [], {}, undefined, undefined, ctx);
      for await (const _row of dl.rows()) {
        // drained for the counters
      }
      expect(dl.stats.budgetExceeded).toBe(false);
      expect(dl.stats.rowCount).toBe(6);
      expect(delivered()).toBe(1);
    });
  });

  describe('non-data responses', () => {
    it('detects the queue envelope arriving as HTTP 200 instead of parsing it as TSV', async () => {
      mockBody([utf8(QUEUE_ENVELOPE)]);
      await expect(drain(svc)).rejects.toMatchObject({ data: { reason: 'async_queued' } });
    });

    it('still classifies the queue envelope when a chunk ends at the XML declaration', async () => {
      // The declaration ends in a newline; buffering only to that break would hand the
      // classifier the declaration alone and lose the syncResponse marker behind it.
      const bytes = utf8(QUEUE_ENVELOPE);
      mockBody(splitAt(bytes, QUEUE_ENVELOPE.indexOf('\n') + 1));
      await expect(drain(svc)).rejects.toMatchObject({ data: { reason: 'async_queued' } });
    });

    it('still classifies a fault split across chunks', async () => {
      const bytes = utf8(FAULT_150);
      mockBody(splitAt(bytes, 60));
      await expect(drain(svc)).rejects.toMatchObject({
        data: { reason: 'invalid_dimension', faultcode: '150' },
      });
    });

    it('classifies a SOAP fault carried on the thrown non-2xx error body', async () => {
      vi.mocked(fetchWithTimeout).mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'HTTP 404', { body: FAULT_100, status: 404 }),
      );
      await expect(drain(svc, 'no_such')).rejects.toMatchObject({
        data: { reason: 'not_found', faultcode: '100' },
      });
    });

    it('rethrows a non-2xx error whose body is not a fault envelope', async () => {
      const raw = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'gateway down', {
        body: 'upstream timeout',
      });
      vi.mocked(fetchWithTimeout).mockRejectedValue(raw);
      await expect(drain(svc)).rejects.toBe(raw);
    });

    it('rejects an empty body rather than reporting an empty download', async () => {
      mockBody([]);
      await expect(drain(svc)).rejects.toMatchObject({ data: { reason: 'upstream_fault' } });
    });
  });

  it('builds the SDMX URL with the positional key and the period range', async () => {
    mockBody([utf8(NAMA_TSV)]);
    const ctx = createMockContext();
    const dl = await svc.startDownload(
      'nama_10_gdp',
      ['freq', 'unit', 'na_item', 'geo'],
      { na_item: ['B1G'], geo: ['AT', 'DE'] },
      '2022',
      '2024',
      ctx,
    );
    expect(dl.url).toContain('/sdmx/2.1/data/nama_10_gdp/');
    expect(decodeURIComponent(dl.url)).toContain('/nama_10_gdp/..B1G.AT+DE?');
    expect(dl.url).toContain('format=TSV');
    expect(dl.url).toContain('startPeriod=2022');
    expect(dl.url).toContain('endPeriod=2024');
  });

  it('omits the key segment when nothing is filtered', async () => {
    mockBody([utf8(NAMA_TSV)]);
    const ctx = createMockContext();
    const dl = await svc.startDownload('nama_10_gdp', [], {}, undefined, undefined, ctx);
    expect(dl.url).toContain('/sdmx/2.1/data/nama_10_gdp?');
  });
});

describe('init/accessor', () => {
  it('throws a directed error when the accessor runs before init', async () => {
    vi.resetModules();
    const mod = await import('@/services/eurostat-bulk/eurostat-bulk-service.js');
    expect(() => mod.getEurostatBulkService()).toThrow(/not initialized/);
  });

  it('returns the service after init', () => {
    initEurostatBulkService(mockConfig, mockStorage);
    expect(getEurostatBulkService()).toBeInstanceOf(EurostatBulkService);
  });
});

// ---------------------------------------------------------------------------
// Budget-test scaffolding
// ---------------------------------------------------------------------------

/**
 * Build a service against a freshly-parsed config so `EUROSTAT_BULK_MAX_BYTES`
 * takes effect — `getServerConfig` memoizes on first read.
 *
 * The response body hands out one chunk per pull, and `delivered` reports how
 * many were ever asked for. That count is what separates "stopped the transfer"
 * from "read the whole body and then reported a number": a budget enforced after
 * the fact still pulls every chunk.
 */
async function freshServiceWithBudget(
  maxBytes: number,
  chunks: Uint8Array[],
): Promise<{ delivered: () => number; svc: EurostatBulkService }> {
  process.env.EUROSTAT_BULK_MAX_BYTES = String(maxBytes);
  vi.resetModules();

  const utils = await import('@cyanheads/mcp-ts-core/utils');
  const mod = await import('@/services/eurostat-bulk/eurostat-bulk-service.js');

  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) controller.close();
      else controller.enqueue(chunks[index++] as Uint8Array);
    },
  });
  vi.mocked(utils.fetchWithTimeout).mockResolvedValue(new Response(body, { status: 200 }));

  return {
    delivered: () => index,
    svc: new mod.EurostatBulkService(mockConfig, mockStorage),
  };
}
