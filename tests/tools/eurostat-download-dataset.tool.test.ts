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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { getEurostatBulkService } from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import type { BulkDownload, BulkRow } from '@/services/eurostat-bulk/types.js';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

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
  it('defaults filters to an empty map and preview_limit to 50', () => {
    const input = parse({});
    expect(input.filters).toEqual({});
    expect(input.preview_limit).toBe(50);
  });

  it('rejects a preview_limit above the 500-row cap', () => {
    expect(() => parse({ preview_limit: 501 })).toThrow();
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

  it('discloses a truncated inline preview on structuredContent and content[]', async () => {
    mockDownload(stubDownload(makeRows(4)));
    setCanvas(undefined);

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
      preview_limit: 3,
    });

    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 3, cap: 3 });
    expect(result.content).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining('**truncated:** true\n**shown:** 3\n**cap:** 3'),
      }),
    );
  });

  it('does not mark a complete inline preview as truncated', async () => {
    mockDownload(stubDownload(makeRows(1)));
    const ctx = createMockContext({ errors: eurostatDownloadDataset.errors, tenantId: 'default' });

    await eurostatDownloadDataset.handler(parse({ preview_limit: 3 }), ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
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
      truncated: true,
      shown: 3,
      cap: 3,
      notice: expect.stringMatching(
        /byte budget.*eurostat_dataframe_describe.*eurostat_dataframe_query/is,
      ),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**shown:** 3');
    expect(text).toContain('**cap:** 3');
    expect(text).toContain('EUROSTAT_BULK_MAX_BYTES');
    expect(text).toMatch(/eurostat_dataframe_describe.*eurostat_dataframe_query/is);
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
