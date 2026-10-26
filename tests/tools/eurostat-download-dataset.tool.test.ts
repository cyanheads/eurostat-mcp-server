/**
 * @fileoverview Tests for the eurostat_download_dataset tool — staging a bulk
 * download on a real canvas, the honest degradation when there is no canvas,
 * the preview/full-download split, and the mapping of SDMX faults onto the
 * declared error contract.
 * @module tests/tools/eurostat-download-dataset.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as serverConfig from '@/config/server-config.js';
import { eurostatDownloadDataset } from '@/mcp-server/tools/definitions/eurostat-download-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

// Only the accessors are replaced — the tool also imports the real column schema builder
// from the bulk service module, and a bare factory would blank it out.
vi.mock('@/services/eurostat-bulk/eurostat-bulk-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/eurostat-bulk/eurostat-bulk-service.js')>()),
  getEurostatBulkService: vi.fn(),
}));
vi.mock('@/services/eurostat-data/eurostat-data-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/eurostat-data/eurostat-data-service.js')>()),
  getEurostatDataService: vi.fn(),
}));

import {
  EurostatBulkService,
  getEurostatBulkService,
} from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import type { BulkDownload, BulkRow } from '@/services/eurostat-bulk/types.js';
import {
  EurostatDataService,
  getEurostatDataService,
} from '@/services/eurostat-data/eurostat-data-service.js';
import {
  EARN_SES_ANNUAL_DIMENSIONS,
  sdmxDataStructureXml,
} from '../fixtures/eurostat-sdmx-metadata.js';

const DIMENSIONS = ['freq', 'unit', 'na_item', 'geo'];
const PERIODS = ['2022', '2023', '2024'];

function row(geo: string, time: string, value: number | null, flag: string | null = null): BulkRow {
  return {
    freq: 'A',
    unit: 'CP_MEUR',
    na_item: 'B1G',
    geo,
    time,
    obs_value: value,
    obs_flag: flag,
    obs_flag_label: flag === 'p' ? 'provisional' : null,
    conf_status: null,
    conf_status_label: null,
  };
}

/** A synthetic download of `count` geos × three periods, every third value missing. */
function makeRows(count: number): BulkRow[] {
  const rows: BulkRow[] = [];
  for (let g = 0; g < count; g++) {
    for (const period of PERIODS) {
      const n = rows.length;
      rows.push(row(`G${g}`, period, n % 3 === 0 ? null : n, n % 5 === 0 ? 'p' : null));
    }
  }
  return rows;
}

/**
 * Stand in for a started download. `stats` is filled in as the generator drains,
 * mirroring the service: nothing about the size of a chunked body is knowable
 * before it is consumed.
 */
function stubDownload(
  rows: BulkRow[],
  overrides: { budgetExceeded?: boolean; bytesRead?: number; compressed?: boolean } = {},
): BulkDownload {
  const download: BulkDownload = {
    header: { dimensions: DIMENSIONS, periods: PERIODS },
    url: 'https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data/nama_10_gdp?format=TSV',
    valueText: false,
    stats: {
      bytesRead: 0,
      budgetExceeded: false,
      compressed: false,
      rowCount: 0,
      missingCount: 0,
      periodsSeen: [],
    },
    rows: async function* () {
      for (const r of rows) {
        download.stats.rowCount++;
        if (r.obs_value === null) download.stats.missingCount++;
        yield r;
      }
      download.stats.periodsSeen = [...new Set(rows.map((r) => String(r.time)))].sort();
      download.stats.bytesRead = overrides.bytesRead ?? rows.length * 40;
      download.stats.budgetExceeded = overrides.budgetExceeded ?? false;
      download.stats.compressed = overrides.compressed ?? false;
    },
  };
  return download;
}

function mockDownload(download: BulkDownload): { startDownload: ReturnType<typeof vi.fn> } {
  const startDownload = vi.fn().mockResolvedValue(download);
  vi.mocked(getEurostatBulkService).mockReturnValue({ startDownload } as never);
  return { startDownload };
}

function mockDimensionOrder(order: string[] = DIMENSIONS): {
  getDimensionOrder: ReturnType<typeof vi.fn>;
} {
  const getDimensionOrder = vi.fn().mockResolvedValue(order);
  vi.mocked(getEurostatDataService).mockReturnValue({ getDimensionOrder } as never);
  return { getDimensionOrder };
}

const parse = (input: Record<string, unknown>) =>
  eurostatDownloadDataset.input.parse({ dataset_code: 'nama_10_gdp', ...input });

const renderedText = (result: Parameters<NonNullable<typeof eurostatDownloadDataset.format>>[0]) =>
  eurostatDownloadDataset.format!(result)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');

describe('eurostatDownloadDataset — input schema', () => {
  it('bounds a large requested preview and preserves full counts and composed notices', async () => {
    const previousCanvas = withRealCanvas();
    setCanvas(undefined);
    try {
      mockDownload(stubDownload(makeRows(200), { budgetExceeded: true }));
      const result = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'nama_10_gdp',
        preview_limit: 1000,
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as {
        observations: BulkRow[];
        rowCount: number;
        notice: string;
      };
      expect(structured.observations).toHaveLength(500);
      expect(structured.rowCount).toBe(600);
      expect(structured.notice).toMatch(
        /preview_limit requested 1000; applied 500.*byte budget.*preview_limit=500.*without a dataframe canvas/s,
      );
      expect(structured.notice).not.toContain('preview_limit=1,000');
      const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toContain(structured.notice);
      expect(text).toContain('G166');
    } finally {
      await previousCanvas.teardown();
    }
  });
  it('defaults filters to an empty map and preview_limit to 25', () => {
    const input = parse({});
    expect(input.filters).toEqual({});
    expect(input.preview_limit).toBe(25);
  });

  it('accepts an oversized positive preview_limit and rejects zero', () => {
    expect(parse({ preview_limit: 501 }).preview_limit).toBe(501);
    expect(() => parse({ preview_limit: 0 })).toThrow();
  });

  it('rejects an empty dataset_code', () => {
    expect(() => eurostatDownloadDataset.input.parse({ dataset_code: '' })).toThrow();
  });
});

describe('eurostatDownloadDataset — with a canvas', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;

  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setCanvas(canvas);
  });

  it('stages every downloaded row and names the table', async () => {
    const rows = makeRows(40);
    mockDownload(stubDownload(rows));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });

    const result = await eurostatDownloadDataset.handler(parse({ preview_limit: 10 }), ctx);

    expect(result.rowCount).toBe(rows.length);
    expect(result.stagedRowCount).toBe(rows.length);
    expect(result.tableName).toMatch(/^df_[0-9a-f]{8}$/);
    expect(result.canvasId).toBeTruthy();
  });

  it('guides callers to describe the staged table before querying it on both response paths', async () => {
    mockDownload(stubDownload(makeRows(4)));

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
      preview_limit: 3,
    });

    expect(result.structuredContent).toMatchObject({
      tableName: expect.stringMatching(/^df_[0-9a-f]{8}$/),
      notice: expect.stringMatching(/eurostat_dataframe_describe.*eurostat_dataframe_query/i),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toMatch(/eurostat_dataframe_describe.*eurostat_dataframe_query/is);
  });

  it('returns a preview that is a prefix of the staged table, not a sample', async () => {
    const rows = makeRows(40);
    mockDownload(stubDownload(rows));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });

    const result = await eurostatDownloadDataset.handler(parse({ preview_limit: 7 }), ctx);
    expect(result.observations).toHaveLength(7);

    const instance = await canvas.acquire(result.canvasId, ctx);
    const staged = await instance.query(
      `SELECT geo, time, obs_value FROM ${result.tableName} LIMIT 7`,
    );
    expect(staged.rows.map((r) => [r.geo, r.time])).toEqual(
      result.observations.map((r) => [r.geo, r.time]),
    );
  });

  it('declares the column schema rather than letting an integer prefix infer BIGINT', async () => {
    mockDownload(stubDownload(makeRows(5)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    const result = await eurostatDownloadDataset.handler(parse({}), ctx);

    const instance = await canvas.acquire(result.canvasId, ctx);
    const [table] = await instance.describe(
      result.tableName ? { tableName: result.tableName } : {},
    );
    expect(table?.columns.map((c) => c.name)).toEqual([
      ...DIMENSIONS,
      'time',
      'obs_value',
      'obs_flag',
      'obs_flag_label',
      'conf_status',
      'conf_status_label',
    ]);
    expect(table?.columns.find((c) => c.name === 'obs_value')?.type).toBe('DOUBLE');
  });

  it('stages onto an existing canvas when canvas_id is passed back', async () => {
    mockDownload(stubDownload(makeRows(3)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    const first = await eurostatDownloadDataset.handler(parse({}), ctx);

    mockDownload(stubDownload(makeRows(3)));
    const second = await eurostatDownloadDataset.handler(
      parse({ canvas_id: first.canvasId }),
      createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' }),
    );

    expect(second.canvasId).toBe(first.canvasId);
    const instance = await canvas.acquire(first.canvasId, ctx);
    const names = (await instance.describe()).map((t) => t.name);
    expect(names).toContain(first.tableName);
    expect(names).toContain(second.tableName);
  });

  it('reports the counters the whole download produced, not the preview', async () => {
    const rows = makeRows(20);
    mockDownload(stubDownload(rows));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });

    const result = await eurostatDownloadDataset.handler(parse({ preview_limit: 3 }), ctx);
    expect(result.observations).toHaveLength(3);
    expect(result.rowCount).toBe(60);
    expect(result.missingCount).toBe(rows.filter((r) => r.obs_value === null).length);
    expect(result.periodRange).toEqual({ start: '2022', end: '2024' });
  });

  it('discloses a short inline preview in the notice and the total, never as truncated (#49)', async () => {
    mockDownload(stubDownload(makeRows(4)));
    setCanvas(undefined);

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
      preview_limit: 3,
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('shown');
    expect(structured).not.toHaveProperty('cap');
    expect(structured).toMatchObject({
      rowCount: 12,
      totalCount: 12,
      budgetExceeded: false,
      notice: expect.stringContaining(
        'preview_limit=3 returns the first 3 of 12 downloaded observations inline',
      ),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).not.toMatch(/\*\*(truncated|shown|cap):\*\*/);
    expect(text).toContain('**12 total**');
    expect(text).toContain(
      'preview_limit=3 returns the first 3 of 12 downloaded observations inline',
    );
  });

  it('adds no preview sentence when the preview holds every row, and still reports the total', async () => {
    mockDownload(stubDownload(makeRows(1)));

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
      preview_limit: 3,
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ rowCount: 3, totalCount: 3 });
    expect(structured).not.toHaveProperty('truncated');
    expect(structured.notice).not.toContain('preview_limit');
  });

  it('surfaces a budget-truncated download as a flag plus a notice naming the knob', async () => {
    mockDownload(stubDownload(makeRows(5), { budgetExceeded: true, bytesRead: 52_428_912 }));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });

    const result = await eurostatDownloadDataset.handler(parse({}), ctx);
    expect(result.budgetExceeded).toBe(true);
    expect(result.bytesRead).toBe(52_428_912);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('byte budget');
    expect(notice).toContain('EUROSTAT_BULK_MAX_BYTES');
  });

  it('composes staged guidance with byte-budget and inline-preview disclosure', async () => {
    mockDownload(stubDownload(makeRows(5), { budgetExceeded: true, bytesRead: 52_428_912 }));

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
      preview_limit: 3,
    });

    expect(result.structuredContent).toMatchObject({
      budgetExceeded: true,
      rowCount: 15,
      totalCount: 15,
      notice: expect.stringMatching(
        /byte budget.*preview_limit=3 returns the first 3 of 15 downloaded observations inline.*eurostat_dataframe_describe.*eurostat_dataframe_query/is,
      ),
    });
    expect(result.structuredContent).not.toHaveProperty('truncated');
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).not.toContain('**truncated:**');
    expect(text).toContain('**15 total**');
    expect(text).toContain('EUROSTAT_BULK_MAX_BYTES');
    expect(text).toMatch(
      /byte budget.*preview_limit=3 returns the first 3 of 15.*eurostat_dataframe_describe.*eurostat_dataframe_query/is,
    );
  });

  it('keeps the no-canvas sentence after the budget and preview sentences', async () => {
    setCanvas(undefined);
    mockDownload(stubDownload(makeRows(5), { budgetExceeded: true, bytesRead: 52_428_912 }));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    await eurostatDownloadDataset.handler(parse({ preview_limit: 3 }), ctx);
    expect(getEnrichment(ctx).notice).toMatch(
      /^The byte budget stopped.*preview_limit=3 returns the first 3 of 15 downloaded observations inline.*without a dataframe canvas.*other 12 were counted and discarded/s,
    );
    expect(getEnrichment(ctx).totalCount).toBe(15);
  });

  it('reports a gzip-compressed body as compressed', async () => {
    mockDownload(stubDownload(makeRows(2), { compressed: true }));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    const result = await eurostatDownloadDataset.handler(parse({}), ctx);
    expect(result.compressed).toBe(true);
  });

  it('says nothing about the budget when the download completed', async () => {
    mockDownload(stubDownload(makeRows(2)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    await eurostatDownloadDataset.handler(parse({}), ctx);
    expect(getEnrichment(ctx).notice).not.toContain('byte budget');
  });

  it('echoes the request it actually sent, dropping empty filter arrays', async () => {
    mockDimensionOrder();
    mockDownload(stubDownload(makeRows(2)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });

    await eurostatDownloadDataset.handler(
      parse({ filters: { geo: ['AT'], unit: [] }, since_period: ' 2022 ', until_period: '2024' }),
      ctx,
    );

    expect(getEnrichment(ctx).appliedQuery).toMatchObject({
      filters: { geo: ['AT'] },
      sincePeriod: '2022',
      untilPeriod: '2024',
    });
  });

  it('reads the dimension order only when a filter needs a positional key', async () => {
    const { getDimensionOrder } = mockDimensionOrder();
    mockDownload(stubDownload(makeRows(2)));
    await eurostatDownloadDataset.handler(
      parse({}),
      createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' }),
    );
    expect(getDimensionOrder).not.toHaveBeenCalled();

    mockDownload(stubDownload(makeRows(2)));
    await eurostatDownloadDataset.handler(
      parse({ filters: { geo: ['AT'] } }),
      createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' }),
    );
    expect(getDimensionOrder).toHaveBeenCalledWith('nama_10_gdp', expect.anything());
  });

  it('passes the resolved dimension order through to the service', async () => {
    mockDimensionOrder();
    const { startDownload } = mockDownload(stubDownload(makeRows(2)));
    await eurostatDownloadDataset.handler(
      parse({ filters: { geo: ['AT', 'DE'] }, since_period: '2022' }),
      createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' }),
    );
    expect(startDownload).toHaveBeenCalledWith(
      'nama_10_gdp',
      DIMENSIONS,
      { geo: ['AT', 'DE'] },
      '2022',
      undefined,
      expect.anything(),
    );
  });

  it('fails a download that carried no observations', async () => {
    mockDownload(stubDownload([]));
    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_results', recovery: { hint: expect.any(String) } },
      },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('Recovery:') }),
    );
  });
});

describe('eurostatDownloadDataset — without a canvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCanvas(undefined);
  });

  it('stages nothing and says so rather than reporting a table', async () => {
    mockDownload(stubDownload(makeRows(20)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });

    const result = await eurostatDownloadDataset.handler(parse({ preview_limit: 5 }), ctx);

    expect(result.tableName).toBeUndefined();
    expect(result.canvasId).toBeUndefined();
    expect(result.stagedRowCount).toBeUndefined();
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('without a dataframe canvas');
    expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });

  it('still drains the download so the counters describe it, not the preview', async () => {
    mockDownload(stubDownload(makeRows(20)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });

    const result = await eurostatDownloadDataset.handler(parse({ preview_limit: 5 }), ctx);

    expect(result.observations).toHaveLength(5);
    expect(result.rowCount).toBe(60);
    expect(result.periodRange).toEqual({ start: '2022', end: '2024' });
  });

  it('names how many rows were counted and discarded', async () => {
    mockDownload(stubDownload(makeRows(10)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    await eurostatDownloadDataset.handler(parse({ preview_limit: 4 }), ctx);
    expect(getEnrichment(ctx).notice as string).toContain('26');
  });

  /**
   * The no-canvas sentence must not send the caller to a narrower query when the rows
   * already fit inline: either they all came back, or preview_limit can reach them.
   */
  it('says every row came back when the preview holds the whole download', async () => {
    mockDownload(stubDownload(makeRows(2)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    await eurostatDownloadDataset.handler(parse({ preview_limit: 6 }), ctx);
    expect(getEnrichment(ctx).notice).toBe(
      'This deployment runs without a dataframe canvas, so nothing was staged; all 6 downloaded observations are returned inline.',
    );
  });

  it('points at preview_limit rather than a narrower query when the download fits under its maximum', async () => {
    mockDownload(stubDownload(makeRows(10)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    await eurostatDownloadDataset.handler(parse({ preview_limit: 4 }), ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(
      'only the 4 observations returned inline are retained, and the other 26 were counted and discarded. Raise preview_limit to 30 to return every one inline, or set CANVAS_PROVIDER_TYPE=duckdb to keep the download.',
    );
    expect(notice).not.toContain('small enough to return whole');
  });

  it('suggests a narrower query only when the download exceeds what preview_limit can return', async () => {
    mockDownload(stubDownload(makeRows(200)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    await eurostatDownloadDataset.handler(parse({}), ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(
      'only the 25 observations returned inline are retained, and the other 575 were counted and discarded. Set CANVAS_PROVIDER_TYPE=duckdb to keep the download, or use eurostat_query_dataset with dimension filters to fetch a slice small enough to return whole.',
    );
    expect(notice).not.toContain('Raise preview_limit');
  });

  it('carries both the budget notice and the no-canvas notice when both apply', async () => {
    mockDownload(stubDownload(makeRows(10), { budgetExceeded: true }));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    await eurostatDownloadDataset.handler(parse({}), ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('byte budget');
    expect(notice).toContain('without a dataframe canvas');
  });

  it('never advertises dataframe tools when the canvas is disabled', async () => {
    mockDownload(stubDownload(makeRows(4), { budgetExceeded: true }));
    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
      preview_limit: 3,
    });

    const structuredText = JSON.stringify(result.structuredContent);
    const contentText = result.content
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
    expect(structuredText).not.toContain('eurostat_dataframe_describe');
    expect(structuredText).not.toContain('eurostat_dataframe_query');
    expect(contentText).not.toContain('eurostat_dataframe_describe');
    expect(contentText).not.toContain('eurostat_dataframe_query');
  });
});

describe('eurostatDownloadDataset — error contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCanvas(undefined);
  });

  const cases: Array<[string, string, JsonRpcErrorCode]> = [
    ['not_found', 'not_found', JsonRpcErrorCode.NotFound],
    ['invalid_dimension', 'invalid_dimension', JsonRpcErrorCode.ValidationError],
    ['filter_arity', 'filter_arity', JsonRpcErrorCode.ValidationError],
    ['invalid_period', 'invalid_period', JsonRpcErrorCode.ValidationError],
    ['async_queued', 'async_queued', JsonRpcErrorCode.ServiceUnavailable],
    ['upstream_fault', 'upstream_fault', JsonRpcErrorCode.ServiceUnavailable],
  ];

  for (const [label, reason, code] of cases) {
    it(`maps a service ${label} failure onto the declared contract with a recovery hint`, async () => {
      vi.mocked(getEurostatBulkService).mockReturnValue({
        startDownload: vi
          .fn()
          .mockRejectedValue(
            new McpError(JsonRpcErrorCode.InternalError, `upstream said ${label}`, { reason }),
          ),
      } as never);
      const ctx = createMockContext({
        errors: eurostatDownloadDataset.errors,
        tenantId: 'default',
      });

      try {
        await eurostatDownloadDataset.handler(parse({}), ctx);
        expect.unreachable('expected a throw');
      } catch (err) {
        expect((err as McpError).code).toBe(code);
        expect((err as McpError).data).toMatchObject({ reason });
        const hint = ((err as McpError).data as { recovery?: { hint?: string } }).recovery?.hint;
        expect(hint).toBeTruthy();
        expect(hint).toContain('nama_10_gdp');
      }
    });
  }

  it('counts a dimension whose values are all blank as unfiltered in the too-large hint (#61)', async () => {
    mockDimensionOrder();
    vi.mocked(getEurostatBulkService).mockReturnValue({
      startDownload: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'too big', {
          reason: 'extraction_too_big',
        }),
      ),
    } as never);
    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
      filters: { unit: ['CP_MEUR'], geo: [''] },
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'extraction_too_big',
          recovery: { hint: expect.stringContaining('Filter on freq, na_item, geo —') },
        },
      },
    });
  });

  it('lets an unmodelled failure bubble unchanged', async () => {
    const raw = new McpError(JsonRpcErrorCode.Timeout, 'request timed out');
    vi.mocked(getEurostatBulkService).mockReturnValue({
      startDownload: vi.fn().mockRejectedValue(raw),
    } as never);
    await expect(
      eurostatDownloadDataset.handler(
        parse({}),
        createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' }),
      ),
    ).rejects.toBe(raw);
  });

  it('maps a failure raised while resolving the dimension order', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionOrder: vi
        .fn()
        .mockRejectedValue(
          new McpError(JsonRpcErrorCode.NotFound, 'no such dataset', { reason: 'not_found' }),
        ),
    } as never);
    await expect(
      eurostatDownloadDataset.handler(
        parse({ filters: { geo: ['AT'] } }),
        createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });
});

describe('eurostatDownloadDataset — format()', () => {
  const result = {
    datasetCode: 'nama_10_gdp',
    dimensionsUsed: DIMENSIONS,
    rowCount: 120,
    missingCount: 7,
    periodRange: { start: '2022', end: '2024' },
    bytesRead: 4096,
    compressed: true,
    budgetExceeded: false,
    observations: [row('AT', '2022', 402767.1), row('DE', '2022', null, 'p')],
    canvasId: 'cv_1',
    tableName: 'df_abcd1234',
    stagedRowCount: 120,
  };

  it('renders every output field into content[]', () => {
    const text = renderedText(result);
    for (const fragment of [
      'nama_10_gdp',
      '120',
      '7',
      '2022',
      '2024',
      '4096',
      'df_abcd1234',
      'cv_1',
      'freq, unit, na_item, geo',
    ]) {
      expect(text).toContain(fragment);
    }
    expect(text).toMatch(/eurostat_dataframe_describe.*eurostat_dataframe_query/is);
  });

  it('renders a missing value as NULL rather than a blank', () => {
    const text = renderedText(result);
    expect(text).toContain('obs_value=NULL');
  });

  it('says nothing was staged when there is no table', () => {
    const text = renderedText({
      ...result,
      canvasId: undefined,
      tableName: undefined,
      stagedRowCount: undefined,
    });
    expect(text).toContain('without a dataframe canvas');
  });

  it('marks a budget-truncated download in the rendered text', () => {
    const text = renderedText({ ...result, budgetExceeded: true });
    expect(text).toContain('not all of it');
  });

  it('names an unreported period range instead of rendering a blank', () => {
    const text = renderedText({ ...result, periodRange: {} });
    expect(text).toContain('not reported by Eurostat');
  });
});

describe('eurostatDownloadDataset — notice text when the preview holds every row', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;

  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const BUDGET_TEXT =
    'The byte budget stopped this transfer after 52,428,912 bytes, so these 6 observations are the start of "nama_10_gdp" and not all of it. Add dimension filters or a since_period/until_period range to fit the dataset inside the budget, or raise EUROSTAT_BULK_MAX_BYTES.';

  it('carries the staged sentence alone for a complete download', async () => {
    setCanvas(canvas);
    mockDownload(stubDownload(makeRows(2)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    const result = await eurostatDownloadDataset.handler(parse({ preview_limit: 6 }), ctx);
    expect(getEnrichment(ctx).notice).toBe(
      `All 6 downloaded observations are staged as table "${result.tableName}" on canvas "${result.canvasId}". Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query.`,
    );
  });

  it('puts the budget sentence ahead of the staged sentence', async () => {
    setCanvas(canvas);
    mockDownload(stubDownload(makeRows(2), { budgetExceeded: true, bytesRead: 52_428_912 }));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    const result = await eurostatDownloadDataset.handler(parse({ preview_limit: 6 }), ctx);
    expect(getEnrichment(ctx).notice).toBe(
      `${BUDGET_TEXT} All 6 downloaded observations are staged as table "${result.tableName}" on canvas "${result.canvasId}". Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query.`,
    );
  });

  it('puts the budget sentence ahead of the no-canvas sentence', async () => {
    setCanvas(undefined);
    mockDownload(stubDownload(makeRows(2), { budgetExceeded: true, bytesRead: 52_428_912 }));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });
    await eurostatDownloadDataset.handler(parse({ preview_limit: 6 }), ctx);
    expect(getEnrichment(ctx).notice).toBe(
      `${BUDGET_TEXT} This deployment runs without a dataframe canvas, so nothing was staged; all 6 downloaded observations are returned inline.`,
    );
  });
});

// ---------------------------------------------------------------------------
// Period inputs and SDMX faults on the real bulk service — fetch is stubbed, so the
// request builder, the fault classifier, and the tool's contract mapping all run.
// ---------------------------------------------------------------------------

/** A two-period `une_rt_m` slice as the SDMX TSV endpoint serves it. */
const UNE_TSV =
  'freq,s_adj,age,unit,sex,geo\\TIME_PERIOD\t2026-06 \t2026-07 \r\n' +
  'M,SA,TOTAL,PC_ACT,T,DE\t3.8 \t3.9 \r\n';

const soapFault = (code: string, text: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><S:Fault xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>${code}</faultcode><faultstring>${text}</faultstring></S:Fault>`;

/** Any fetch a test did not arrange fails loudly instead of returning undefined. */
const unmockedFetch = async (input: unknown): Promise<Response> => {
  throw new Error(`Unmocked fetch: ${String(input)}`);
};

describe('eurostatDownloadDataset — period inputs and SDMX faults (real bulk service)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatBulkService).mockReturnValue(
      new EurostatBulkService({} as never, {} as never),
    );
    setCanvas(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tsvReply = () => new Response(UNE_TSV, { status: 200 });
  const requestedUrl = (call = 0): URL => new URL(String(fetchMock.mock.calls[call]?.[0]));

  for (const [label, sent, expected] of [
    ['an empty string', '', null],
    ['a whitespace-only string', '   ', null],
    ['a padded year', '  2020  ', '2020'],
  ] as const) {
    it(`sends ${label} as ${expected === null ? 'no bound' : `"${expected}"`}`, async () => {
      fetchMock.mockImplementationOnce(async () => tsvReply());
      await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        since_period: sent,
        until_period: sent,
      });
      expect(requestedUrl().searchParams.get('startPeriod')).toBe(expected);
      expect(requestedUrl().searchParams.get('endPeriod')).toBe(expected);
    });
  }

  for (const period of [
    '2020',
    '2020-01',
    '2020-01-15',
    '2020-Q1',
    '2020-q1',
    '2020-s1',
    '2020-W1',
    '2020-w01',
    '2020-W53',
    '2020-M01',
    '2020-M1',
    '2020-m01',
    '2024-02-29',
    '2020-T1',
    '2026-D001',
    '2024-D366',
  ]) {
    it(`passes "${period}" through on either bound`, async () => {
      fetchMock.mockImplementation(async () => tsvReply());
      await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        since_period: period,
      });
      await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        until_period: period,
      });
      expect(requestedUrl(0).searchParams.get('startPeriod')).toBe(period);
      expect(requestedUrl(1).searchParams.get('endPeriod')).toBe(period);
    });
  }

  describe('malformed period bounds (#47)', () => {
    const REJECTED = [
      '2020-13',
      '2020-00',
      '2020-Q5',
      '2020-Q9',
      '2020-S3',
      '2020-W54',
      '2021-W53',
      '2026-02-30',
      '2020-1',
      '2020Q1',
      '202001',
      'banana',
      '2020-Q05',
      '2021-W053',
    ];
    for (const period of REJECTED) {
      for (const bound of ['since_period', 'until_period'] as const) {
        it(`rejects ${bound} "${period}" as invalid_period before any request`, async () => {
          const result = await runToolContract(eurostatDownloadDataset, {
            dataset_code: 'une_rt_m',
            [bound]: period,
          });
          expect(fetchMock).not.toHaveBeenCalled();
          expect(result.structuredContent).toMatchObject({
            error: {
              code: JsonRpcErrorCode.ValidationError,
              message: expect.stringContaining(`${bound} "${period}"`),
              data: {
                reason: 'invalid_period',
                recovery: { hint: expect.stringMatching(/YYYY-MM-DD.*YYYY-Qn.*YYYY-Wnn/) },
              },
            },
          });
          const text = result.content
            .map((block) => ('text' in block ? block.text : ''))
            .join('\n');
          expect(text).toMatch(/Recovery:.*YYYY-Qn/s);
        });
      }
    }

    for (const [sent, canonical] of [
      ['2020-Q01', '2020-Q1'],
      ['2020-q01', '2020-q1'],
      ['2020-S01', '2020-S1'],
      ['2020-W001', '2020-W01'],
      ['2020-M001', '2020-M01'],
      ['2026-D1', '2026-D001'],
      ['2020-A1', '2020'],
    ] as const) {
      it(`sends the zero-padded "${sent}" as "${canonical}" on either bound and echoes it`, async () => {
        fetchMock.mockImplementation(async () => tsvReply());
        const since = await runToolContract(eurostatDownloadDataset, {
          dataset_code: 'une_rt_m',
          since_period: sent,
        });
        const until = await runToolContract(eurostatDownloadDataset, {
          dataset_code: 'une_rt_m',
          until_period: ` ${sent} `,
        });
        expect(requestedUrl(0).searchParams.get('startPeriod')).toBe(canonical);
        expect(requestedUrl(1).searchParams.get('endPeriod')).toBe(canonical);
        expect(since.structuredContent).toMatchObject({
          appliedQuery: { sincePeriod: canonical },
        });
        expect(until.structuredContent).toMatchObject({
          appliedQuery: { untilPeriod: canonical },
        });
      });
    }

    it('rejects a bad period before the dimension-order lookup a filtered download makes', async () => {
      const getDimensionOrder = vi.fn();
      vi.mocked(getEurostatDataService).mockReturnValue({ getDimensionOrder } as never);
      const result = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        filters: { geo: ['DE'] },
        since_period: '2020-13',
      });
      expect(getDimensionOrder).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_period' } },
      });
    });

    it('rejects an inverted range before any request, naming both bounds (#53)', async () => {
      const getDimensionOrder = vi.fn();
      vi.mocked(getEurostatDataService).mockReturnValue({ getDimensionOrder } as never);
      const result = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        filters: { geo: ['DE'] },
        since_period: '2024-01',
        until_period: '2020-01',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getDimensionOrder).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message:
            'since_period "2024-01" starts after until_period "2020-01" ends, so the range holds no period.',
          data: { reason: 'invalid_period' },
        },
      });
    });

    it('sends a cross-frequency range that holds periods (#53)', async () => {
      fetchMock.mockImplementationOnce(async () => tsvReply());
      await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        since_period: '2020-06',
        until_period: '2020',
      });
      expect(requestedUrl().searchParams.get('startPeriod')).toBe('2020-06');
      expect(requestedUrl().searchParams.get('endPeriod')).toBe('2020');
    });

    it('builds the same key for an upper-case filter key as for its lower-case form (#54)', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDimensionOrder: vi
          .fn()
          .mockResolvedValue(['freq', 's_adj', 'age', 'unit', 'sex', 'geo']),
      } as never);
      fetchMock.mockImplementation(async () => tsvReply());
      const upper = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        filters: { GEO: ['DE'], Unit: ['PC_ACT'] },
      });
      await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        filters: { geo: ['DE'], unit: ['PC_ACT'] },
      });
      expect(upper.isError).not.toBe(true);
      expect(requestedUrl(0).pathname).toBe(requestedUrl(1).pathname);
      expect(requestedUrl(0).pathname).toMatch(/\/une_rt_m\/\.\.\.PC_ACT\.\.DE$/);
    });

    it('builds the key for ["", "DE"] as for ["DE"], with no empty position (#61)', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDimensionOrder: vi
          .fn()
          .mockResolvedValue(['freq', 's_adj', 'age', 'unit', 'sex', 'geo']),
      } as never);
      fetchMock.mockImplementation(async () => tsvReply());
      const blank = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        filters: { geo: ['', 'DE', '  '], unit: ['PC_ACT'] },
      });
      await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        filters: { geo: ['DE'], unit: ['PC_ACT'] },
      });
      expect(blank.isError).not.toBe(true);
      expect(requestedUrl(0).pathname).toBe(requestedUrl(1).pathname);
      expect(requestedUrl(0).pathname).toMatch(/\/une_rt_m\/\.\.\.PC_ACT\.\.DE$/);
      expect(blank.structuredContent).toMatchObject({
        appliedQuery: { filters: { geo: ['DE'], unit: ['PC_ACT'] } },
      });
    });

    it('sends a blank-only filter as no key at all, the same request as an empty array (#61)', async () => {
      const getDimensionOrder = vi.fn();
      vi.mocked(getEurostatDataService).mockReturnValue({ getDimensionOrder } as never);
      fetchMock.mockImplementation(async () => tsvReply());
      const results = [];
      for (const geo of [[''], ['  '], []]) {
        results.push(
          await runToolContract(eurostatDownloadDataset, {
            dataset_code: 'une_rt_m',
            filters: { geo },
          }),
        );
      }
      expect(requestedUrl(0).toString()).toBe(requestedUrl(2).toString());
      expect(requestedUrl(1).toString()).toBe(requestedUrl(2).toString());
      expect(requestedUrl(0).pathname).toMatch(/\/data\/une_rt_m$/);
      expect(getDimensionOrder).not.toHaveBeenCalled();
      for (const result of results) {
        expect(result.isError).not.toBe(true);
        expect(
          (result.structuredContent as { appliedQuery: { filters: object } }).appliedQuery.filters,
        ).toEqual({});
      }
    });

    it('maps fault 140 TIME_PERIOD_FILTER_SPEC_INVALID to invalid_period, not filter_arity', async () => {
      fetchMock.mockImplementationOnce(
        async () =>
          new Response(
            soapFault(
              '140',
              'TIME_PERIOD_FILTER_SPEC_INVALID: Impossible to apply time dimension filtering',
            ),
            { status: 400 },
          ),
      );
      const result = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'une_rt_m',
        since_period: '2020',
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_period',
            recovery: { hint: expect.stringContaining('YYYY-Qn') },
          },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).not.toMatch(/filter positions/);
    });

    it('names the period range in the no_results hint for an empty table', async () => {
      fetchMock.mockImplementationOnce(
        async () =>
          new Response('freq,unit,na_item,geo\\TIME_PERIOD\t1975 \t1976 \r\n', { status: 200 }),
      );
      const result = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'nama_10_gdp',
        until_period: '1980',
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'no_results',
            recovery: {
              hint: expect.stringMatching(/eurostat_get_dimension_values.*until_period "1980"/s),
            },
          },
        },
      });
    });

    it('keeps the no_results hint about filter values when no range was given', async () => {
      fetchMock.mockImplementationOnce(
        async () =>
          new Response('freq,unit,na_item,geo\\TIME_PERIOD\t1975 \t1976 \r\n', { status: 200 }),
      );
      const result = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'nama_10_gdp',
      });
      const hint = (result.structuredContent as { error: { data: { recovery: { hint: string } } } })
        .error.data.recovery.hint;
      expect(hint).toContain('eurostat_get_dimension_values');
      expect(hint).not.toMatch(/since_period "|until_period "/);
    });
  });

  it('runs a filtered download when the unfiltered latest-period slice exceeds the extraction limit (#57)', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
    const EARN_TSV =
      'freq,nace_r2,isco08,worktime,age,sex,indic_se,geo\\TIME_PERIOD\t2018 \t2022 \r\n' +
      'A,B-S_X_O,TOTAL,FT,TOTAL,T,MEAN_E_EUR,DE\t48000 \t53000 \r\n';
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/statistics/1.0/data/')) {
        return new Response(
          '{ "error": [{"status": 413,"id": 413,"label": "EXTRACTION_TOO_BIG: The requested extraction is too big"}]}',
          { status: 413 },
        );
      }
      if (url.pathname.includes('/sdmx/2.1/datastructure/')) {
        return new Response(sdmxDataStructureXml(), { status: 200 });
      }
      if (url.pathname.includes('/sdmx/2.1/data/')) return new Response(EARN_TSV, { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'earn_ses_annual',
      filters: { geo: ['DE'] },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      rowCount: 2,
      dimensionsUsed: EARN_SES_ANNUAL_DIMENSIONS,
    });
    const dataUrl = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .find(({ pathname }) => pathname.includes('/sdmx/2.1/data/'));
    // Eight positions, the filter on the last: the key the structure definition orders.
    expect(dataUrl?.pathname).toMatch(/\/earn_ses_annual\/\.\.\.\.\.\.\.DE$/);
  });

  it('fails a filtered download whose structure read meets a 503 outage as a retryable upstream_fault', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
    fetchMock.mockImplementation(
      async () => new Response('Service Unavailable', { status: 503, statusText: 'Unavailable' }),
    );
    vi.useFakeTimers();
    try {
      const pending = runToolContract(eurostatDownloadDataset, {
        dataset_code: 'DS-045409',
        filters: { freq: ['A'] },
      });
      // Past the structure read's 1 s / 2 s / 4 s backoff, jitter included.
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_fault', retryable: true },
        },
      });
      const hint = (result.structuredContent as { error: { data: { recovery: { hint: string } } } })
        .error.data.recovery.hint;
      expect(hint).toContain('DS-045409');
      expect(hint).toMatch(/retry in a few minutes/i);
      expect(hint).not.toContain('TSV');
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).toContain('reason upstream_fault · retryable');
      // The structure read retried to exhaustion; no bulk request followed it.
      const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
      expect(paths).toHaveLength(4);
      expect(paths.every((p) => p.includes('/sdmx/2.1/datastructure/'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('an unavailable SDMX data endpoint on an unfiltered download (#71)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Run the call past the 1 s / 2 s / 4 s backoff (plus jitter) without waiting it out. */
    const callSettled = async (context?: { signal: AbortSignal }) => {
      const pending = runToolContract(
        eurostatDownloadDataset,
        { dataset_code: 'nama_10_gdp' },
        context && { context },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      return pending;
    };
    const errorOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { error: { code: number; data: Record<string, unknown> } })
        .error;
    const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
      result.content.map((block) => block.text ?? '').join('\n');

    it.each([
      ['a plain-text 503', 'Service Unavailable'],
      ['an HTML 503 page', '<!DOCTYPE html><html><body><h1>503</h1></body></html>'],
    ])(
      'retries %s, then fails as a retryable upstream_fault on both surfaces',
      async (_label, body) => {
        fetchMock.mockImplementation(
          async () => new Response(body, { status: 503, statusText: 'Unavailable' }),
        );
        const result = await callSettled();
        expect(result.isError).toBe(true);
        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({
          reason: 'upstream_fault',
          retryable: true,
          recovery: { hint: expect.stringContaining('"nama_10_gdp"') },
        });
        const hint = (error.data.recovery as { hint: string }).hint;
        expect(hint).toContain('HTTP 503');
        expect(hint).toMatch(/retry in a few minutes/i);
        expect(hint).not.toContain('TSV');
        expect(hint).not.toContain('dimension order');
        const text = textOf(result);
        expect(text).toContain(`Recovery: ${hint}`);
        expect(text).toContain('reason upstream_fault · retryable');
        const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
        expect(paths).toHaveLength(4);
        expect(paths.every((p) => p.includes('/sdmx/2.1/data/'))).toBe(true);
      },
    );

    it('fails an unreachable host the same way', async () => {
      fetchMock.mockImplementation(async () => {
        throw new TypeError('fetch failed');
      });
      const result = await callSettled();
      const error = errorOf(result);
      expect(error.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
      expect((error.data.recovery as { hint: string }).hint).toContain('could not be reached');
      expect(textOf(result)).toContain('reason upstream_fault · retryable');
    });

    it('downloads once the endpoint recovers inside the retry budget', async () => {
      fetchMock
        .mockImplementationOnce(async () => new Response('Service Unavailable', { status: 503 }))
        .mockImplementation(async () => new Response(UNE_TSV, { status: 200 }));
      const result = await callSettled();
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as { rowCount: number }).rowCount).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the non-TSV hint, with no retryable flag, for an unmodeled fault on a 4xx', async () => {
      fetchMock.mockImplementation(
        async () => new Response(soapFault('999', 'SOMETHING_ELSE: unmodelled'), { status: 400 }),
      );
      const result = await callSettled();
      const error = errorOf(result);
      expect(error.data).toMatchObject({ reason: 'upstream_fault' });
      expect(error.data.retryable).toBeUndefined();
      expect((error.data.recovery as { hint: string }).hint).toContain(
        'did not return a TSV table',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('leaves a cancelled download as a cancellation, not an outage', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(async () => {
        controller.abort();
        return new Response('Service Unavailable', { status: 503 });
      });
      const error = errorOf(await callSettled({ signal: controller.signal }));
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.data?.reason).not.toBe('upstream_fault');
    });
  });

  it('maps fault 140 INVALID_QUERY_NB_FILTERS to filter_arity', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(soapFault('140', 'INVALID_QUERY_NB_FILTERS: Incorrect number of filters'), {
          status: 400,
        }),
    );
    const result = await runToolContract(eurostatDownloadDataset, { dataset_code: 'une_rt_m' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'filter_arity', recovery: { hint: expect.stringContaining('une_rt_m') } },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// An empty download on a canvas deployment — real bulk service, real canvas (#56)
// ---------------------------------------------------------------------------

/** The header-only TSV Eurostat answers `nama_10_gdp` CP_MEUR/B1GQ/DE 1975–1985 with. */
const HEADER_ONLY_TSV =
  'freq,unit,na_item,geo\\TIME_PERIOD\t1975 \t1976 \t1977 \t1978 \t1979 \t1980 \t1981 \t1982 \t1983 \t1984 \t1985 \n';

/**
 * A body that delivers `text` and then stays open, recording whether the reader
 * cancelled it. A download abandoned without cancelling holds its connection.
 */
function openBody(text: string): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

describe('eurostatDownloadDataset — an empty download leaves every canvas untouched (#56)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    ({ canvas, teardown } = withRealCanvas());
    // Loads the DuckDB binding once, so no single test pays for it against its timeout.
    await canvas.acquire(undefined, createMockContext({ tenantId: 'default' }));
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    setCanvas(canvas);
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatBulkService).mockReturnValue(
      new EurostatBulkService({} as never, {} as never),
    );
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionOrder: vi.fn().mockResolvedValue(['freq', 'unit', 'na_item', 'geo']),
    } as never);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const EMPTY_REQUEST = {
    dataset_code: 'nama_10_gdp',
    filters: { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE'] },
    since_period: '1975',
    until_period: '1985',
  };

  /** A canvas holding one staged table, made through the tool itself. */
  async function canvasWithOneTable(): Promise<{ canvasId: string; tableName: string }> {
    fetchMock.mockImplementationOnce(async () => new Response(UNE_TSV, { status: 200 }));
    const result = await runToolContract(eurostatDownloadDataset, { dataset_code: 'une_rt_m' });
    const { canvasId, tableName } = result.structuredContent as {
      canvasId: string;
      tableName: string;
    };
    return { canvasId, tableName };
  }

  it('fails no_results without acquiring a canvas when canvas_id is omitted', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(HEADER_ONLY_TSV, { status: 200 }));
    const acquire = vi.spyOn(canvas, 'acquire');

    const result = await runToolContract(eurostatDownloadDataset, EMPTY_REQUEST);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'no_results',
          recovery: {
            hint: expect.stringContaining('since_period "1975" and until_period "1985"'),
          },
        },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('Recovery:');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('stages nothing on a caller-supplied canvas', async () => {
    const { canvasId, tableName } = await canvasWithOneTable();
    fetchMock.mockImplementationOnce(async () => new Response(HEADER_ONLY_TSV, { status: 200 }));

    const result = await runToolContract(eurostatDownloadDataset, {
      ...EMPTY_REQUEST,
      canvas_id: canvasId,
    });

    expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'no_results' } } });
    const instance = await canvas.acquire(canvasId, createMockContext({ tenantId: 'default' }));
    expect((await instance.describe()).map((t) => t.name)).toEqual([tableName]);
  });

  it('reports no_results, not canvas_not_found, for an unknown canvas_id', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(HEADER_ONLY_TSV, { status: 200 }));
    const result = await runToolContract(eurostatDownloadDataset, {
      ...EMPTY_REQUEST,
      canvas_id: 'Zz9Zz9Zz9Z',
    });
    expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'no_results' } } });
  });

  it('still stages a download that yields rows onto the caller-supplied canvas', async () => {
    const { canvasId, tableName } = await canvasWithOneTable();
    fetchMock.mockImplementationOnce(async () => new Response(UNE_TSV, { status: 200 }));

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'une_rt_m',
      canvas_id: canvasId,
    });

    expect(result.structuredContent).toMatchObject({ canvasId, rowCount: 2, stagedRowCount: 2 });
    const instance = await canvas.acquire(canvasId, createMockContext({ tenantId: 'default' }));
    expect((await instance.describe()).map((t) => t.name).sort()).toEqual(
      [tableName, (result.structuredContent as { tableName: string }).tableName].sort(),
    );
  });

  it('cancels the response body when staging fails on an unknown canvas_id', async () => {
    const { body, cancelled } = openBody(UNE_TSV);
    fetchMock.mockImplementationOnce(async () => new Response(body, { status: 200 }));

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'une_rt_m',
      canvas_id: 'Zz9Zz9Zz9Z',
    });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'canvas_not_found' } },
    });
    expect(cancelled()).toBe(true);
  });

  it('carries its declared canvas_not_found recovery on both surfaces, not the canvas service hint', async () => {
    const declared = eurostatDownloadDataset.errors?.find(
      (e) => e.reason === 'canvas_not_found',
    )?.recovery;
    expect(declared).toContain('Omit canvas_id');
    fetchMock.mockImplementationOnce(async () => new Response(UNE_TSV, { status: 200 }));

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'une_rt_m',
      canvas_id: 'Zz9Zz9Zz9Z',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', canvasId: 'Zz9Zz9Zz9Z', recovery: { hint: declared } },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(`Recovery: ${declared}`);
    expect(text).not.toContain('stage fresh data');
  });

  it('ignores an unknown canvas_id on a deployment without a canvas', async () => {
    setCanvas(undefined);
    fetchMock.mockImplementationOnce(async () => new Response(UNE_TSV, { status: 200 }));

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'une_rt_m',
      canvas_id: 'Zz9Zz9Zz9Z',
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ rowCount: 2 });
    expect(result.structuredContent).not.toHaveProperty('canvasId');
  });
});

describe('eurostatDownloadDataset — local transfer limits on both surfaces (#72, #76)', () => {
  beforeEach(() => {
    setCanvas(undefined);
    vi.mocked(getEurostatBulkService).mockReturnValue(
      new EurostatBulkService({} as never, {} as never),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([10, 22, 25, 40])(
    'discloses an accepted %s-byte prefix or a local budget failure',
    async (budget) => {
      vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
        ...serverConfig.getServerConfig(),
        bulkMaxBytes: budget,
      });
      const requests: Request[] = [];
      let cancelled = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new Request(input, init));
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('geo\\TIME_PERIOD\t2024 \nDE\t42 \nFR\t43 \nIT\t44 \n'),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
          );
        }),
      );
      const result = await runToolContract(eurostatDownloadDataset, { dataset_code: 'x' });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      if (budget === 40) {
        expect(result.structuredContent).toMatchObject({
          budgetExceeded: true,
          bytesRead: 40,
          rowCount: 2,
          observations: [
            { geo: 'DE', obs_value: 42 },
            { geo: 'FR', obs_value: 43 },
          ],
          notice: expect.stringContaining('filters'),
        });
        expect(text).toContain('40 bytes decoded');
        expect(text).toContain('these 2 observations');
      } else {
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'byte_budget_exceeded',
              maxBytes: budget,
              bytesRead: budget,
              rowCount: 0,
              recovery: { hint: expect.stringContaining('filters') },
            },
          },
        });
        expect(text).toContain('byte_budget_exceeded');
        expect(text).toContain(`${budget}-byte`);
      }
      expect(text).toContain('since_period/until_period');
      expect(text).toContain('EUROSTAT_BULK_MAX_BYTES');
      expect(cancelled).toBe(true);
      expect(requests).toHaveLength(1);
    },
  );

  it('keeps a body deadline as Timeout/retry_deadline_exceeded on both surfaces', async () => {
    vi.useFakeTimers();
    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      ...serverConfig.getServerConfig(),
      bulkTimeoutMs: 50,
    });
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('geo\\TIME_PERIOD\t2024 \nDE\t42 \n'));
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                { once: true },
              );
            },
          }),
        );
      }),
    );
    const pending = runToolContract(eurostatDownloadDataset, { dataset_code: 'x' });
    await vi.advanceTimersByTimeAsync(51);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 50 },
      },
    });
    expect(result.content.map((block) => ('text' in block ? block.text : '')).join('\n')).toContain(
      'retry_deadline_exceeded',
    );
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('eurostatDownloadDataset — enrichment trailer', () => {
  it('renders the bulk request as markdown, not a JSON blob', () => {
    const render = eurostatDownloadDataset.enrichmentTrailer?.appliedQuery?.render;
    expect(render).toBeTypeOf('function');
    const text = render?.({
      filters: { geo: ['AT', 'DE'] },
      sincePeriod: '2022',
      url: 'https://example.invalid/x',
    } as never);
    expect(text).toContain('geo=[AT, DE]');
    expect(text).toContain('2022');
    expect(text).toContain('https://example.invalid/x');
  });

  it('says so plainly when no filter was applied', () => {
    const render = eurostatDownloadDataset.enrichmentTrailer?.appliedQuery?.render;
    const text = render?.({ filters: {}, url: 'https://example.invalid/x' } as never);
    expect(text).toContain('whole dataset');
  });
});
