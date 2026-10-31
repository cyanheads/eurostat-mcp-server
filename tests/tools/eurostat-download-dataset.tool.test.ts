/**
 * @fileoverview Tests for the eurostat_download_dataset tool — staging a bulk
 * download on a real canvas, the honest degradation when there is no canvas,
 * the preview/full-download split, and the mapping of SDMX faults onto the
 * declared error contract.
 * @module tests/tools/eurostat-download-dataset.tool.test
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

  it('counts the rows shown, not the download, in the hoist header of a staged result (#86)', async () => {
    mockDownload(stubDownload(makeRows(4)));

    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'nama_10_gdp',
      preview_limit: 3,
    });

    expect(result.structuredContent).toMatchObject({
      rowCount: 12,
      stagedRowCount: 12,
      tableName: expect.stringMatching(/^df_[0-9a-f]{8}$/),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text.split('\n')).toContain(
      '**Same in all 3 rows shown:** freq=A | unit=CP_MEUR | na_item=B1G | geo=G0',
    );
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

// ---------------------------------------------------------------------------
// Single-valued dimension columns in content[] (#86). The rebuild parses the rendered
// text back and compares it with structuredContent: format-parity's synthetic row
// never reaches the hoisted path. hoistDimensions is tabled in the query tool's tests.
// ---------------------------------------------------------------------------

describe('eurostatDownloadDataset — single-valued dimension columns in content[] (#86)', () => {
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

  const MEASURES = ['obs_value', 'obs_flag', 'obs_flag_label', 'conf_status', 'conf_status_label'];
  const DS_MEASURES = ['obs_value', 'obs_value_text', ...MEASURES.slice(1)];

  const parseColumns = (columns: string): Array<readonly [string, string]> =>
    columns
      .split(' | ')
      .filter((cell) => cell !== '')
      .map((cell) => {
        const equals = cell.indexOf('=');
        return [cell.slice(0, equals), cell.slice(equals + 1)];
      });

  const headerColumns = (text: string): string | undefined =>
    text
      .split('\n')
      .map((line) => /^\*\*Same in all \d+ rows shown:\*\* (.*)$/.exec(line))
      .find((match) => match)?.[1];

  const rowLines = (text: string) =>
    text.split('\n').filter((line) => /(^| \| )obs_value=/.test(line));

  /** Every column of every row, read back from the header and that row's line alone. */
  function rebuild(text: string): BulkRow[] {
    const shared = parseColumns(headerColumns(text) ?? '');
    return rowLines(text).map((line) =>
      Object.fromEntries(
        [...shared, ...parseColumns(line)].map(([column, value]) => [
          column,
          value === 'NULL' ? null : column === 'obs_value' ? Number(value) : value,
        ]),
      ),
    );
  }

  /** The row section: what follows the `## First N observations` heading. */
  const rowSection = (text: string) => text.slice(text.indexOf('observations\n') + 13);

  const payload = (observations: BulkRow[]) => ({
    datasetCode: 'nama_10_gdp',
    dimensionsUsed: DIMENSIONS,
    rowCount: observations.length,
    missingCount: 0,
    periodRange: { start: '2022', end: '2023' },
    bytesRead: 4096,
    compressed: false,
    budgetExceeded: false,
    observations,
  });

  describe('what stays as it was', () => {
    it('renders a single row with every column on it', () => {
      expect(rowSection(renderedText(payload([row('AT', '2022', 402767.1)])))).toBe(
        'freq=A | unit=CP_MEUR | na_item=B1G | geo=AT | time=2022 | obs_value=402767.1 | obs_flag=NULL | obs_flag_label=NULL | conf_status=NULL | conf_status_label=NULL',
      );
    });

    it('renders rows sharing no dimension column with every column on each row', () => {
      const text = renderedText(
        payload([
          row('AT', '2022', 1),
          { ...row('DE', '2023', 2), freq: 'Q', unit: 'PC_GDP', na_item: 'B1GQ' },
        ]),
      );
      expect(rowSection(text)).toBe(
        'freq=A | unit=CP_MEUR | na_item=B1G | geo=AT | time=2022 | obs_value=1 | obs_flag=NULL | obs_flag_label=NULL | conf_status=NULL | conf_status_label=NULL\nfreq=Q | unit=PC_GDP | na_item=B1GQ | geo=DE | time=2023 | obs_value=2 | obs_flag=NULL | obs_flag_label=NULL | conf_status=NULL | conf_status_label=NULL',
      );
    });

    it('renders an empty preview with no header', () => {
      expect(renderedText(payload([]))).not.toContain('rows shown');
    });
  });

  const fixture = (name: string) =>
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

  const REAL_DOWNLOADS = [
    {
      name: 'DS-059358, text values and confidential cells over one period',
      body: () => fixture('comext/ds-059358-de-2022.tsv'),
      datasetCode: 'DS-059358',
      count: 58,
      hoisted: ['freq', 'reporter', 'time'],
      columns: ['product', 'indicators', ...DS_MEASURES],
      sha256: 'a36fc6ca21bfd588d8bbdb9afdc594c8774458480ba47fa023811dcbc81a25a5',
    },
    {
      name: 'DS-045409, products and months varying',
      body: () => fixture('comext/ds-045409-de-us-m-2026-06-07.tsv'),
      datasetCode: 'DS-045409',
      count: 6,
      hoisted: ['freq', 'reporter', 'partner', 'flow', 'indicators'],
      columns: ['product', 'time', ...DS_MEASURES],
      sha256: '9cbcd377199c7c6518de4ab10234448c02c65d9730bac97434e2e150f0878388',
    },
    {
      name: 'nama_10_gdp, a flagged provisional value',
      // Captured whole, CRLF line ends and padded cells included.
      body: () =>
        'freq,unit,na_item,geo\\TIME_PERIOD\t2022 \t2023 \r\nA,CP_MEUR,B1GQ,DE\t4010630.0 \t4254930.0 p\r\n',
      datasetCode: 'nama_10_gdp',
      count: 2,
      hoisted: ['freq', 'unit', 'na_item', 'geo'],
      columns: ['time', ...MEASURES],
      sha256: '41ee8044906b1f2246323a2ef2c980d83577bd92471aa2597ca4133b399061cd',
    },
  ];

  for (const { name, body, datasetCode, count, hoisted, columns, sha256 } of REAL_DOWNLOADS) {
    describe(name, () => {
      const call = async () => {
        fetchMock.mockImplementation(async () => new Response(body(), { status: 200 }));
        const result = await runToolContract(eurostatDownloadDataset, {
          dataset_code: datasetCode,
          preview_limit: 500,
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { observations: BulkRow[] };
        expect(structured.observations).toHaveLength(count);
        const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
        return { structured, text };
      };

      it('rebuilds every row from the header and its line', async () => {
        const { structured, text } = await call();
        expect(rebuild(text)).toStrictEqual(structured.observations);
        expect(rebuild(renderedText(structured as never))).toStrictEqual(structured.observations);
      });

      it('lists the single-valued dimension columns once and keeps the rest on each row', async () => {
        const { text } = await call();
        expect(parseColumns(headerColumns(text) ?? '').map(([column]) => column)).toEqual(hoisted);
        expect(text).toContain(`**Same in all ${count} rows shown:**`);
        expect(rowLines(text)).toHaveLength(count);
        for (const line of rowLines(text)) {
          expect(parseColumns(line).map(([column]) => column)).toEqual(columns);
        }
      });

      it('leaves structuredContent untouched', async () => {
        const { structured } = await call();
        const digest = createHash('sha256').update(JSON.stringify(structured.observations));
        expect(digest.digest('hex')).toBe(sha256);
      });
    });
  }

  it('hoists a dimension the preview shows one value of, stating it only of the rows shown', async () => {
    fetchMock.mockImplementation(
      async () => new Response(fixture('comext/ds-059358-de-2022.tsv'), { status: 200 }),
    );
    const call = async (preview_limit: number) => {
      const result = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'DS-059358',
        preview_limit,
      });
      return result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
    };

    const whole = await call(500);
    expect(headerColumns(whole)).not.toContain('product=');

    const preview = await call(3);
    expect(preview).toContain('## First 3 observations');
    const named = preview.split('\n').filter((line) => line.includes('product=20143420'));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/^\*\*Same in all 3 rows shown:\*\* .*product=20143420/);
  });

  it('hoists a constant time column, which dimensionsUsed does not list', () => {
    const text = renderedText(payload([row('AT', '2022', 1), row('DE', '2022', 2)]));
    expect(headerColumns(text)).toBe('freq=A | unit=CP_MEUR | na_item=B1G | time=2022');
    expect(rowLines(text)[0]).toMatch(/^geo=AT \| obs_value=1 \| /);
  });

  it('keeps the value and flag columns on every row, however constant', () => {
    const flagged = {
      ...row('AT', '2022', 7, 'p'),
      conf_status: 'C',
      conf_status_label: 'confidential',
    };
    const text = renderedText(payload([flagged, { ...flagged, geo: 'DE' }]));
    expect(headerColumns(text)).toBe('freq=A | unit=CP_MEUR | na_item=B1G | time=2022');
    for (const line of rowLines(text)) {
      expect(line).toContain(
        ' | obs_value=7 | obs_flag=p | obs_flag_label=provisional | conf_status=C | conf_status_label=confidential',
      );
    }
  });

  it('keeps a dimension column on the rows when a later row carries null', () => {
    const rows = [
      row('AT', '2022', 1),
      row('DE', '2022', 2),
      { ...row('FR', '2022', 3), unit: null },
    ];
    const text = renderedText(payload(rows));
    expect(headerColumns(text)).toBe('freq=A | na_item=B1G | time=2022');
    expect(rebuild(text)).toStrictEqual(rows);
  });

  it('keeps a dimension column on the rows when a later row lacks it', () => {
    const { unit: _, ...lacking } = row('FR', '2022', 3);
    const rows = [row('AT', '2022', 1), row('DE', '2022', 2), lacking];
    const text = renderedText(payload(rows));
    expect(headerColumns(text)).toBe('freq=A | na_item=B1G | time=2022');
    expect(rebuild(text)).toStrictEqual(rows);
  });

  it('never states a dimension column that is null on every row', () => {
    const rows = [
      { ...row('AT', '2022', 1), unit: null },
      { ...row('DE', '2022', 2), unit: null },
    ];
    const text = renderedText(payload(rows));
    expect(headerColumns(text)).toBe('freq=A | na_item=B1G | time=2022');
    expect(rebuild(text)).toStrictEqual(rows);
  });

  it('states rows shown on a download the byte budget cut short', () => {
    const text = renderedText({
      ...payload([row('AT', '2022', 1), row('AT', '2023', 2)]),
      budgetExceeded: true,
      rowCount: 900,
    });
    expect(text).toContain(
      '**Same in all 2 rows shown:** freq=A | unit=CP_MEUR | na_item=B1G | geo=AT',
    );
  });
});

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

  describe('the structure read behind an extraction_too_big (#85)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Far past the deadline on both, so neither default stall timeout can end a read for it.
      vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
        ...serverConfig.getServerConfig(),
        requestTimeoutMs: 600_000,
        metadataTimeoutMs: 600_000,
      });
      vi.mocked(getEurostatDataService).mockReturnValue(
        new EurostatDataService({} as never, {} as never),
      );
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('gives up on a read that never answers at 5 s, keeping the refusal', async () => {
      const refusal = readFileSync(
        new URL('../fixtures/comext/ds-045409-fault-413.xml', import.meta.url),
        'utf8',
      );
      fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
        new URL(String(input)).pathname.includes('/sdmx/2.1/datastructure/')
          ? new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
            })
          : new Response(refusal, { status: 413 }),
      );
      let settled = false;
      const pending = runToolContract(eurostatDownloadDataset, {
        dataset_code: 'earn_ses_annual',
      }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'extraction_too_big',
            recovery: {
              hint: expect.stringContaining(
                'Add dimension filters — eurostat_get_dataset_info lists the dimensions of "earn_ses_annual"',
              ),
            },
          },
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
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

/** Every TSV and fault below is a live reply to the bounds its test sends. */
describe('eurostatDownloadDataset — what Eurostat keeps of a period range (#84, #88)', () => {
  const NAMA_2023_2024 =
    'freq,unit,na_item,geo\\TIME_PERIOD\t2023 \t2024 \r\nA,CP_MEUR,B1GQ,DE\t4254930.0 p\t4386940.0 p\r\n';
  const NAMA_2022_2023 =
    'freq,unit,na_item,geo\\TIME_PERIOD\t2022 \t2023 \r\nA,CP_MEUR,B1GQ,DE\t4010630.0 \t4254930.0 p\r\n';
  const NAMA_2024_2025 =
    'freq,unit,na_item,geo\\TIME_PERIOD\t2024 \t2025 \r\nA,CP_MEUR,B1GQ,DE\t4386940.0 p\t4529710.0 p\r\n';
  const NRG_FROM_S2 =
    'freq,siec,nrg_cons,unit,tax,currency,geo\\TIME_PERIOD\t2022-S2 \t2023-S1 \t2023-S2 \r\nS,E7000,KWH2500-4999,KWH,I_TAX,EUR,DE\t0.3357 \t0.4125 \t0.4020 \r\n';
  const NRG_FROM_S1 =
    'freq,siec,nrg_cons,unit,tax,currency,geo\\TIME_PERIOD\t2022-S1 \t2022-S2 \t2023-S1 \t2023-S2 \r\nS,E7000,KWH2500-4999,KWH,I_TAX,EUR,DE\t0.3279 \t0.3357 \t0.4125 \t0.4020 \r\n';
  const DS_HEADER_ONLY = 'freq,reporter,partner,product,flow,indicators\\TIME_PERIOD\t\r\n';
  const RATES = 'freq,statinfo,unit,currency\\TIME_PERIOD';
  const WEDNESDAY_THURSDAY = `${RATES}\t2022-06-15 \t2022-06-16 \r\nD,AVG,NAC,USD\t1.0431 \t1.0400 \r\n`;
  const MONDAY_ONLY = `${RATES}\t2022-06-20 \r\nD,AVG,NAC,USD\t1.0517 \r\n`;

  const tsv = (name: string) =>
    readFileSync(new URL(`../fixtures/${name}.tsv`, import.meta.url), 'utf8');
  const fault150 = (tail: string) =>
    soapFault(
      '150',
      `INVALID_QUERY_DIMENSION_VALUE: Query is invalid as per its structure&apos;s definition. The following values for dimension are not allowed: ${tail}`,
    );
  const inside = (literal: string, label: string, period: string, bound = 'since_period') =>
    `${bound} "${literal}" falls inside ${label} period ${period}, which Eurostat excludes: it keeps only periods wholly inside the range. ${bound} "${period}" includes that period if this slice has it.`;

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

  const download = (
    body: string,
    dataset_code: string,
    since_period: string,
    until_period: string,
    status = 200,
  ) => {
    fetchMock.mockImplementationOnce(async () => new Response(body, { status }));
    return runToolContract(eurostatDownloadDataset, { dataset_code, since_period, until_period });
  };
  const requested = (): URL => new URL(String(fetchMock.mock.calls[0]?.[0]));
  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? '').join('\n');
  const noticeOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { notice?: string }).notice ?? '';
  const failureOf = (result: { structuredContent?: unknown }) => {
    const { error } = result.structuredContent as {
      error: { data: { reason: string; recovery: { hint: string } }; message: string };
    };
    return { hint: error.data.recovery.hint, message: error.message, reason: error.data.reason };
  };

  describe('a bound that falls inside a period, on a success', () => {
    for (const [label, body, dataset, since, until, rowCount, notice] of [
      [
        'annual data (step 1)',
        NAMA_2023_2024,
        'nama_10_gdp',
        '2022-06',
        '2024',
        2,
        inside('2022-06', 'annual', '2022'),
      ],
      [
        'semester data (step 4)',
        NRG_FROM_S2,
        'nrg_pc_204',
        '2022-06',
        '2023',
        3,
        inside('2022-06', 'semester', '2022-S1'),
      ],
      [
        'a coarser bound on weekly data',
        tsv('demo-r-mwk-ts-de-2022-to-2023'),
        'demo_r_mwk_ts',
        '2022',
        '2023',
        104,
        inside('2022', 'weekly', '2021-W52'),
      ],
      [
        'annual only on mixed frequencies',
        tsv('comext/ds-045409-de-fr-2023-06-to-2024'),
        'DS-045409',
        '2023-06',
        '2024',
        40,
        inside('2023-06', 'annual', '2023'),
      ],
    ] as const) {
      it(`names it on ${label}, on both surfaces and with the same rows`, async () => {
        const result = await download(body, dataset, since, until);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ rowCount });
        expect(noticeOf(result)).toContain(notice);
        expect(text(result)).toContain(notice);
        expect(requested().searchParams.get('startPeriod')).toBe(since);
        expect(requested().searchParams.get('endPeriod')).toBe(until);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    }

    for (const [label, body, dataset, since, until] of [
      ['a year on annual data', NAMA_2022_2023, 'nama_10_gdp', '2022', '2023'],
      ['a month starting a semester', NRG_FROM_S1, 'nrg_pc_204', '2022-01', '2023'],
      [
        'an annual period the header hides',
        tsv('comext/ds-045409-de-fr-2023-06-to-2023-12'),
        'DS-045409',
        '2023-06',
        '2023-12',
      ],
    ] as const) {
      it(`stays silent for ${label}`, async () => {
        const result = await download(body, dataset, since, until);
        expect(result.isError).not.toBe(true);
        expect(noticeOf(result)).not.toContain('falls inside');
        expect(text(result)).not.toContain('falls inside');
      });
    }

    it('decides from the bound alone, the TSV reporting no coverage', async () => {
      const result = await download(NAMA_2024_2025, 'nama_10_gdp', '2024', '2031-06');
      expect(noticeOf(result)).toContain(inside('2031-06', 'annual', '2031', 'until_period'));
    });

    it('stays silent with no bound', async () => {
      fetchMock.mockImplementationOnce(async () => new Response(NAMA_2022_2023, { status: 200 }));
      const result = await runToolContract(eurostatDownloadDataset, {
        dataset_code: 'nama_10_gdp',
      });
      expect(noticeOf(result)).not.toContain('falls inside');
    });

    it('quotes the literal as the caller sent it, trimmed', async () => {
      const result = await download(NAMA_2023_2024, 'nama_10_gdp', ' 2022-Q02 ', '2024');
      expect(requested().searchParams.get('startPeriod')).toBe('2022-Q2');
      expect(noticeOf(result)).toContain(inside('2022-Q02', 'annual', '2022'));
    });

    it('keeps the staging sentences beside the notice', async () => {
      const result = await download(NAMA_2023_2024, 'nama_10_gdp', '2022-06', '2024');
      expect(noticeOf(result)).toContain('without a dataframe canvas');
    });
  });

  describe('fault 150 on the period range', () => {
    const RANGE_HINT =
      'Eurostat keeps only periods wholly inside the range, so a bound that falls inside a period excludes it, and a range outside the dataset\'s coverage selects nothing. List the periods "nama_10_gdp" publishes with eurostat_get_dimension_values, dimension "time", then set since_period/until_period on them.';

    for (const [label, tail, since, until] of [
      [
        'both bounds (step 3)',
        'TIME_PERIOD: &gt;=2022-06-01 and &lt;=2023-06-30.',
        '2022-06',
        '2023-06',
      ],
      [
        'a range past coverage',
        'TIME_PERIOD: &gt;=2030-01-01 and &lt;=2031-12-31.',
        '2030',
        '2031',
      ],
    ] as const) {
      it(`keeps invalid_dimension, about the range: ${label}`, async () => {
        const result = await download(fault150(tail), 'nama_10_gdp', since, until, 400);
        const failure = failureOf(result);
        expect(failure.reason).toBe('invalid_dimension');
        expect(failure.message).toBe(
          'Eurostat rejected the period range for "nama_10_gdp": it selects no period of the dataset (fault 150).',
        );
        expect(failure.hint).toBe(RANGE_HINT);
        expect(text(result)).toContain(failure.hint);
      });
    }

    for (const tail of ['GEO=QQ.', 'GEO=QQ, UNIT=FAKE.', 'REPORTER=QQ.', 'GEO=TIME_PERIOD:.']) {
      it(`keeps the filter hint for ${tail}`, async () => {
        const failure = failureOf(
          await download(fault150(tail), 'nama_10_gdp', '2022', '2023', 400),
        );
        expect(failure.reason).toBe('invalid_dimension');
        expect(failure.hint).toBe(
          'Check the dimension codes for "nama_10_gdp" with eurostat_get_dataset_info and their values with eurostat_get_dimension_values, and keep since_period/until_period inside the dataset\'s coverage.',
        );
      });
    }

    it('never shows a one-day caller the next day it did not send', async () => {
      const result = await download(
        fault150('TIME_PERIOD: &gt;=2022-06-15 and &lt;=2022-06-16.'),
        'nama_10_gdp',
        '2022-06-15',
        '2022-06-15',
        400,
      );
      const failure = failureOf(result);
      expect(failure.reason).toBe('invalid_dimension');
      expect(failure.hint).toBe(RANGE_HINT);
      expect(`${failure.message} ${failure.hint} ${text(result)}`).not.toContain('2022-06-16');
    });

    it('treats a Saturday the same way, its Sunday published nothing either', async () => {
      const failure = failureOf(
        await download(
          fault150('TIME_PERIOD: &gt;=2022-06-18 and &lt;=2022-06-19.'),
          'ert_bil_eur_d',
          '2022-06-18',
          '2022-06-18',
          400,
        ),
      );
      expect(failure.reason).toBe('invalid_dimension');
      expect(failure.message).toContain('selects no period');
    });
  });

  describe('a table with no rows', () => {
    it('fails a header-only table as no_results, with the rule in its hint', async () => {
      const result = await download(DS_HEADER_ONLY, 'DS-045409', '2023-06', '2023-12');
      const failure = failureOf(result);
      expect(failure.reason).toBe('no_results');
      expect(failure.hint).toContain('Eurostat keeps only periods wholly inside the range');
      expect(failure.hint).toContain('since_period "2023-06" and until_period "2023-12"');
      expect(text(result)).toContain('Eurostat keeps only periods wholly inside the range');
    });

    it('fails a one-day download whose reply holds only the next day the same way', async () => {
      const result = await download(MONDAY_ONLY, 'ert_bil_eur_d', '2022-06-19', '2022-06-19');
      const failure = failureOf(result);
      expect(failure.reason).toBe('no_results');
      expect(failure.hint).toContain('since_period "2022-06-19" and until_period "2022-06-19"');
      expect(`${failure.message} ${failure.hint}`).not.toContain('2022-06-20');
    });
  });

  describe('a one-day range', () => {
    for (const [since, until] of [
      ['2022-06-15', '2022-06-15'],
      ['2022-D166', '2022-D166'],
      ['2022-06-15', '2022-D166'],
    ] as const) {
      it(`returns the one row for ${since} to ${until} (#88 step 2)`, async () => {
        const result = await download(WEDNESDAY_THURSDAY, 'ert_bil_eur_d', since, until);
        expect(requested().searchParams.get('startPeriod')).toBe('2022-06-15');
        expect(requested().searchParams.get('endPeriod')).toBe('2022-06-16');
        expect(result.structuredContent).toMatchObject({
          rowCount: 1,
          missingCount: 0,
          totalCount: 1,
          periodRange: { start: '2022-06-15', end: '2022-06-15' },
        });
        const { observations } = result.structuredContent as {
          observations: Array<{ time: string }>;
        };
        expect(observations.map((row) => row.time)).toEqual(['2022-06-15']);
        expect(text(result)).toContain('**Observations:** 1 (0 missing)');
        expect(text(result)).not.toMatch(/time=2022-06-16/);
      });
    }

    it('echoes the bounds as the caller set them, and the request as it went out', async () => {
      const result = await download(WEDNESDAY_THURSDAY, 'ert_bil_eur_d', '2022-D166', '2022-06-15');
      const { appliedQuery } = result.structuredContent as {
        appliedQuery: { sincePeriod: string; untilPeriod: string; url: string };
      };
      expect(appliedQuery.sincePeriod).toBe('2022-D166');
      expect(appliedQuery.untilPeriod).toBe('2022-06-15');
      expect(appliedQuery.url).toContain('endPeriod=2022-06-16');
    });

    it('leaves two consecutive days as the bounds (#88 step 4)', async () => {
      const result = await download(
        WEDNESDAY_THURSDAY,
        'ert_bil_eur_d',
        '2022-06-15',
        '2022-06-16',
      );
      expect(requested().searchParams.get('startPeriod')).toBe('2022-06-15');
      expect(requested().searchParams.get('endPeriod')).toBe('2022-06-16');
      expect(result.structuredContent).toMatchObject({ rowCount: 2 });
    });

    it('stages the day alone', async () => {
      const { canvas, teardown } = withRealCanvas();
      try {
        setCanvas(canvas);
        fetchMock.mockImplementationOnce(
          async () => new Response(WEDNESDAY_THURSDAY, { status: 200 }),
        );
        const ctx = createMockContext({
          errors: eurostatDownloadDataset.errors,
          tenantId: 'default',
        });
        const result = await eurostatDownloadDataset.handler(
          eurostatDownloadDataset.input.parse({
            dataset_code: 'ert_bil_eur_d',
            since_period: '2022-06-15',
            until_period: '2022-06-15',
          }),
          ctx,
        );
        expect(result.stagedRowCount).toBe(1);
        const instance = await canvas.acquire(result.canvasId, ctx);
        const staged = await instance.query(
          `SELECT time, obs_value FROM ${result.tableName} ORDER BY time`,
        );
        expect(staged.rows).toEqual([{ time: '2022-06-15', obs_value: 1.0431 }]);
      } finally {
        await teardown();
      }
    });
  });

  describe('the descriptions', () => {
    const since = eurostatDownloadDataset.input.shape.since_period.description ?? '';
    const until = eurostatDownloadDataset.input.shape.until_period.description ?? '';

    it('state the wholly-inside rule', () => {
      expect(since).toContain('Eurostat keeps only periods wholly inside the range');
      expect(until).toContain('falls inside a period');
    });

    it('state how a one-day range is sent', () => {
      expect(since).toMatch(/same day is requested as that day and the next/);
    });

    it('claim no mapping and offer no range that holds nothing as a working example', () => {
      for (const description of [since, until]) {
        expect(description).not.toMatch(/mapped onto/);
        expect(description).not.toMatch(/"2020-06" to "2020"/);
      }
    });
  });
});
