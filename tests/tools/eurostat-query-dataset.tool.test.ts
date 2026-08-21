/**
 * @fileoverview Tests for the eurostat_query_dataset tool.
 * @module tests/tools/eurostat-query-dataset.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatQueryDataset } from '@/mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

// Only the accessor is replaced — the tool also imports the real row builder and column
// schema from this module, and a bare factory would blank them out.
vi.mock('@/services/eurostat-data/eurostat-data-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/eurostat-data/eurostat-data-service.js')>()),
  getEurostatDataService: vi.fn(),
}));

import {
  EurostatDataService,
  getEurostatDataService,
  observationRowSchema,
} from '@/services/eurostat-data/eurostat-data-service.js';

const makeObs = (
  geo: string,
  geoLabel: string,
  year: string,
  value: number | null,
  statusCode?: string,
) => ({
  dimensions: {
    unit: { code: 'CP_MEUR', label: 'Current prices, million euro' },
    na_item: { code: 'B1GQ', label: 'Gross domestic product at market prices' },
    geo: { code: geo, label: geoLabel },
    time: { code: year, label: year },
  },
  value,
  status: statusCode
    ? { code: statusCode, label: statusCode === 'p' ? 'provisional' : 'estimated' }
    : undefined,
});

const mockQueryResult = {
  datasetCode: 'nama_10_gdp',
  datasetLabel: 'GDP and main components',
  dimensionsUsed: ['unit', 'na_item', 'geo', 'time'],
  observations: [
    makeObs('DE', 'Germany', '2023', 3_867_000),
    makeObs('FR', 'France', '2023', 2_785_000, 'p'),
    makeObs('IT', 'Italy', '2023', null),
  ],
  obsCount: 3,
  truncated: false,
  timeRange: { start: '2023', end: '2023' },
  missingObsCount: 1,
  appliedFilters: { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE', 'FR', 'IT'] },
};

describe('eurostatQueryDataset', () => {
  beforeEach(() => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi.fn().mockResolvedValue(mockQueryResult),
    } as never);
  });

  it('returns observations for a valid filtered query', async () => {
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({
      dataset_code: 'nama_10_gdp',
      filters: { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE', 'FR', 'IT'] },
      since_period: '2023',
    });
    const result = await eurostatQueryDataset.handler(input, ctx);
    expect(result.obsCount).toBe(3);
    expect(result.missingObsCount).toBe(1);
    expect(result.datasetCode).toBe('nama_10_gdp');
    expect(result.observations).toHaveLength(3);
    const enrichment = getEnrichment(ctx) as {
      appliedFilters?: { filters: Record<string, string[]>; sincePeriod?: string };
      notice?: string;
    };
    expect(enrichment.appliedFilters?.filters).toEqual({
      unit: ['CP_MEUR'],
      na_item: ['B1GQ'],
      geo: ['DE', 'FR', 'IT'],
    });
    expect(enrichment.appliedFilters?.sincePeriod).toBe('2023');
    expect(enrichment.notice).toBeUndefined();
  });

  it('reports only the filters the service actually applied', async () => {
    // The service drops zero-length arrays before building the request; both response
    // surfaces must echo that set, not the raw input that claimed a geo restriction.
    const mockQuery = vi.fn().mockResolvedValue({
      ...mockQueryResult,
      appliedFilters: { unit: ['CP_MEUR'] },
    });
    vi.mocked(getEurostatDataService).mockReturnValue({ queryDataset: mockQuery } as never);
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({
      dataset_code: 'nama_10_gdp',
      filters: { unit: ['CP_MEUR'], geo: [] },
    });
    const result = await eurostatQueryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx) as {
      appliedFilters?: { filters: Record<string, string[]> };
    };
    expect(enrichment.appliedFilters?.filters).toEqual({ unit: ['CP_MEUR'] });
    expect(enrichment.appliedFilters?.filters).not.toHaveProperty('geo');
    // The rendered trailer reads from the same enrichment value.
    const trailer = eurostatQueryDataset.enrichmentTrailer!.appliedFilters as {
      render: (f: unknown) => string;
    };
    expect(trailer.render(enrichment.appliedFilters)).not.toContain('geo=[]');
    // The service's applied-filter bookkeeping stays out of the tool's output schema.
    expect(result).not.toHaveProperty('appliedFilters');
  });

  it('applies default empty filters and EN language', () => {
    const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
    expect(input.filters).toEqual({});
    expect(input.lang).toBe('EN');
  });

  it('throws conflicting_params when geo filter and geo_level are both set', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi.fn().mockRejectedValue(
        Object.assign(new Error('conflicting params'), {
          data: { reason: 'conflicting_params' },
        }),
      ),
    } as never);
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({
      dataset_code: 'nama_10_gdp',
      filters: { geo: ['DE'] },
      geo_level: 'country',
    });
    await expect(eurostatQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_params' },
    });
  });

  it('throws not_found for an unknown dataset code', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not found'), { data: { reason: 'not_found' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({ dataset_code: 'nonexistent_xyz' });
    await expect(eurostatQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found', recovery: { hint: expect.stringContaining('nonexistent_xyz') } },
    });
  });

  it('throws no_results with dataset-contextual recovery hint', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('no results'), { data: { reason: 'no_results' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({
      dataset_code: 'nama_10_gdp',
      filters: { geo: ['NONEXISTENT'] },
    });
    await expect(eurostatQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'no_results',
        recovery: { hint: expect.stringContaining('nama_10_gdp') },
      },
    });
  });

  it('throws async_response with dataset-contextual recovery hint', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('async response'), { data: { reason: 'async_response' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
    await expect(eurostatQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'async_response',
        recovery: { hint: expect.stringContaining('nama_10_gdp') },
      },
    });
  });

  it('throws invalid_dimension with dataset-contextual recovery hint', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('invalid dimension'), { data: { reason: 'invalid_dimension' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({
      dataset_code: 'nama_10_gdp',
      filters: { bad_dim: ['X'] },
    });
    await expect(eurostatQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'invalid_dimension',
        recovery: { hint: expect.stringContaining('nama_10_gdp') },
      },
    });
  });

  it('passes last_n_periods to service', async () => {
    const mockQuery = vi.fn().mockResolvedValue(mockQueryResult);
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: mockQuery,
    } as never);
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({
      dataset_code: 'nama_10_gdp',
      last_n_periods: 5,
    });
    await eurostatQueryDataset.handler(input, ctx);
    expect(mockQuery).toHaveBeenCalledWith(
      'nama_10_gdp',
      {},
      undefined,
      undefined,
      undefined,
      5,
      'EN',
      ctx,
    );
  });

  it('formats output with all observations and dimensions', () => {
    const blocks = eurostatQueryDataset.format!(mockQueryResult);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nama_10_gdp');
    expect(text).toContain('GDP and main components');
    expect(text).toContain('3');
    expect(text).toContain('DE');
    expect(text).toContain('Germany');
    expect(text).toContain('3867000');
    expect(text).toContain('N/A');
    expect(text).toContain('provisional');
  });

  it('advertises both period bounds as optional in the output schema', () => {
    // The wire contract, not just the handler: a result whose period neither the observations
    // nor Eurostat report must validate without a fabricated empty bound.
    const parsed = eurostatQueryDataset.output.parse({
      ...mockQueryResult,
      truncated: false,
      timeRange: {},
    });
    expect(parsed.timeRange).toEqual({});
  });

  it('names an unreported period rather than rendering a blank range', () => {
    const blocks = eurostatQueryDataset.format!({ ...mockQueryResult, timeRange: {} });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('**Period:** not reported by Eurostat');
    // The pre-fix rendering of the same payload.
    expect(text).not.toContain('**Period:**  – ');
  });

  it('renders a half-known period without inventing the missing bound', () => {
    const blocks = eurostatQueryDataset.format!({
      ...mockQueryResult,
      timeRange: { start: '2023' },
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('**Period:** 2023 – not reported by Eurostat');
  });

  it('renders a confidentiality marker apart from the observation flag (#35)', () => {
    const confidential = {
      ...mockQueryResult,
      observations: [
        {
          dimensions: {
            geo: { code: 'IE', label: 'Ireland' },
            time: { code: '2023-01', label: '2023-01' },
          },
          value: null,
          confStatus: { code: 'C', label: 'confidential' },
        },
      ],
      dimensionsUsed: ['geo', 'time'],
      obsCount: 1,
      missingObsCount: 1,
    };
    const blocks = eurostatQueryDataset.format!(confidential);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('[CONF_STATUS C: confidential]');
    // The pre-fix rendering put the confidentiality code in the OBS_FLAG slot.
    expect(text).not.toContain('|C');
    expect(text).not.toContain('|confidential');
  });

  it('accepts an observation carrying both markers on the wire (#35)', () => {
    const parsed = eurostatQueryDataset.output.parse({
      ...mockQueryResult,
      truncated: false,
      observations: [
        {
          dimensions: { geo: { code: 'IE', label: 'Ireland' } },
          value: 88.1,
          status: { code: 'p', label: 'provisional' },
          confStatus: { code: 'C', label: 'confidential' },
        },
      ],
    });
    expect(parsed.observations[0]?.confStatus).toEqual({ code: 'C', label: 'confidential' });
    expect(parsed.observations[0]?.status).toEqual({ code: 'p', label: 'provisional' });
  });

  it('formats sparse observations where value is null', () => {
    const sparseResult = {
      ...mockQueryResult,
      observations: [makeObs('IT', 'Italy', '2023', null)],
      obsCount: 1,
      missingObsCount: 1,
    };
    const blocks = eurostatQueryDataset.format!(sparseResult);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('N/A');
    expect(text).toContain('Italy');
  });

  it('renders every observation past row 200 with no text-side truncation', () => {
    const manyObs = Array.from({ length: 205 }, (_, i) =>
      makeObs(`G${i}`, `Country ${i}`, '2023', i * 100),
    );
    const largeResult = {
      ...mockQueryResult,
      observations: manyObs,
      obsCount: 205,
      missingObsCount: 0,
    };
    const blocks = eurostatQueryDataset.format!(largeResult);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    // Previously capped at 200 rows with an "N more not shown" note — now every row renders.
    expect(text).not.toContain('not shown');
    expect(text).toContain('geo=G0');
    expect(text).toContain('geo=G204');
    const renderedRows = text.split('\n').filter((l) => l.includes('→')).length;
    expect(renderedRows).toBe(205);
  });

  it('content[] carries every structuredContent observation (full parity)', async () => {
    const manyObs = Array.from({ length: 300 }, (_, i) =>
      makeObs(`G${i}`, `Country ${i}`, '2023', i),
    );
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi.fn().mockResolvedValue({
        ...mockQueryResult,
        observations: manyObs,
        obsCount: 300,
        missingObsCount: 0,
      }),
    } as never);
    const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
    const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
    // What structuredContent carries (already bounded by the decoder's row cap)…
    const structured = await eurostatQueryDataset.handler(input, ctx);
    // …must match what content[] renders, row for row.
    const blocks = eurostatQueryDataset.format!(structured);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const renderedRows = text.split('\n').filter((l) => l.includes('→')).length;
    expect(structured.observations).toHaveLength(300);
    expect(renderedRows).toBe(structured.observations.length);
    expect(text).toContain('geo=G299');
  });
});

// ---------------------------------------------------------------------------
// DataCanvas spillover (#8) — the same query run against a real service, with
// and without a canvas. The service is real (fetch-stubbed) so the rows the
// canvas receives come from the production decoder, not a test-built lookalike.
// ---------------------------------------------------------------------------

describe('eurostatQueryDataset — dataframe spillover (#8)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const PERIODS = Array.from({ length: 60 }, (_, i) => String(2000 + i));
  const GEOS = Array.from({ length: 100 }, (_, i) => `G${i}`);

  /** A JSON-stat body with `cells` populated cells across a time × geo grid. */
  function jsonStatBody(times: string[], geos: string[], cells: number): object {
    const axis = (codes: string[]) => ({
      label: 'dim',
      category: {
        index: Object.fromEntries(codes.map((c, i) => [c, i])),
        label: Object.fromEntries(codes.map((c) => [c, `${c} label`])),
      },
    });
    const value: Record<string, number> = {};
    for (let i = 0; i < cells; i++) value[String(i)] = i;
    return {
      id: ['time', 'geo'],
      size: [times.length, geos.length],
      label: 'GDP and main components',
      dimension: { time: axis(times), geo: axis(geos) },
      value,
    };
  }

  const okResponse = (body: object) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  /** 6,000 cells — 1,000 past the inline cap. */
  const oversized = () => jsonStatBody(PERIODS, GEOS, 6000);
  /** 100 cells — comfortably inside the cap. */
  const small = () => jsonStatBody(PERIODS.slice(0, 10), GEOS.slice(0, 10), 100);

  const ctx = () => createMockContext({ errors: eurostatQueryDataset.errors, tenantId: 'default' });

  const run = (input?: Record<string, unknown>) =>
    eurostatQueryDataset.handler(
      eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp', ...input }),
      ctx(),
    );

  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
    setCanvas(canvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setCanvas(canvas);
  });

  describe('with a canvas', () => {
    it('stages the whole match and names it in the response', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const result = await run();

      expect(result.truncated).toBe(true);
      expect(result.observations).toHaveLength(5000);
      expect(result.obsCount).toBe(6000);
      // The rows past the inline cap are reachable, which is the whole point.
      expect(result.stagedRowCount).toBe(6000);
      expect(result.tableName).toMatch(/^df_[0-9a-f]{8}$/);
      expect(result.canvasId).toBeTypeOf('string');
    });

    it('stages exactly what the inline rows show, in the same order', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const result = await run();

      const instance = await canvas.acquire(result.canvasId, ctx());
      const staged = await instance.query(`SELECT * FROM ${result.tableName} LIMIT 3`);
      const inline = result.observations.slice(0, 3).map((obs) => {
        const dims = obs.dimensions as Record<string, { code: string; label: string }>;
        return {
          time: dims.time?.code,
          time_label: dims.time?.label,
          geo: dims.geo?.code,
          geo_label: dims.geo?.label,
          obs_value: obs.value,
          obs_flag: null,
          obs_flag_label: null,
          conf_status: null,
          conf_status_label: null,
        };
      });
      expect(staged.rows).toEqual(inline);

      // …and the table carries periods the capped inline list never reaches.
      const beyond = await instance.query(
        `SELECT DISTINCT time FROM ${result.tableName} WHERE time > '2049' ORDER BY time`,
      );
      expect(beyond.rowCount).toBeGreaterThan(0);
    });

    it('declares the flat column set rather than letting DuckDB guess it', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const result = await run();
      const instance = await canvas.acquire(result.canvasId, ctx());
      const [table] = await instance.describe(
        result.tableName ? { tableName: result.tableName } : {},
      );
      expect(table?.columns.map((c) => c.name)).toEqual(
        observationRowSchema(['time', 'geo']).map((c) => c.name),
      );
      // A sniffed schema over all-integer leading rows would type the measure as BIGINT,
      // which the canvas then returns as a string.
      expect(table?.columns.find((c) => c.name === 'obs_value')?.type).toBe('DOUBLE');
    });

    it('points the notice at the staged table instead of only at narrowing filters', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const c = ctx();
      const result = await eurostatQueryDataset.handler(
        eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' }),
        c,
      );
      // Asserted before the substring check — `toContain(undefined ?? '')` passes on any string.
      expect(result.tableName).toBeTypeOf('string');
      const notice = getEnrichment(c).notice ?? '';
      expect(notice).toContain(result.tableName);
      expect(notice).toContain(result.canvasId);
      expect(notice).toContain('eurostat_dataframe_query');
    });

    it('stages nothing when the result fits inline', async () => {
      const acquire = vi.spyOn(canvas, 'acquire');
      fetchMock.mockImplementation(async () => okResponse(small()));
      const result = await run();

      expect(result.truncated).toBe(false);
      expect(result.observations).toHaveLength(100);
      // No canvas is minted for a result the caller already holds in full.
      expect(acquire).not.toHaveBeenCalled();
      expect(result.canvasId).toBeUndefined();
      expect(result.tableName).toBeUndefined();
      expect(result.stagedRowCount).toBeUndefined();
    });

    it('reuses a caller-supplied canvas so two results can be joined', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const first = await run();
      const second = await run({ canvas_id: first.canvasId });

      expect(second.canvasId).toBe(first.canvasId);
      expect(second.tableName).not.toBe(first.tableName);

      const instance = await canvas.acquire(first.canvasId, ctx());
      const names = (await instance.describe()).map((t) => t.name);
      expect(names).toContain(first.tableName);
      expect(names).toContain(second.tableName);
    });

    it('surfaces an unknown caller-supplied canvas rather than silently minting a new one', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      await expect(run({ canvas_id: 'zzzzzzzzzz' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found' },
      });
    });
  });

  describe('without a canvas', () => {
    beforeEach(() => {
      setCanvas(undefined);
    });

    it('returns the capped result unchanged, with no canvas fields at all', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const result = await run();

      expect(result.truncated).toBe(true);
      expect(result.observations).toHaveLength(5000);
      expect(result.obsCount).toBe(6000);
      // Every added field is optional and absent — not null, not an empty string — so a
      // caller on this deployment sees exactly the payload it saw before spillover existed.
      expect('canvasId' in result).toBe(false);
      expect('tableName' in result).toBe(false);
      expect('stagedRowCount' in result).toBe(false);
    });

    it('keeps the notice pointed at narrowing the query', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const c = ctx();
      await eurostatQueryDataset.handler(
        eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' }),
        c,
      );
      const notice = getEnrichment(c).notice ?? '';
      expect(notice).toContain('dimension filters');
      // Naming a tool this deployment does not list would send the agent nowhere.
      expect(notice).not.toContain('eurostat_dataframe_query');
    });

    it('ignores a canvas_id it cannot honour instead of failing the query', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const result = await run({ canvas_id: 'zzzzzzzzzz' });
      expect(result.obsCount).toBe(6000);
      expect(result.tableName).toBeUndefined();
    });

    it('validates the output schema without the canvas fields', () => {
      const parsed = eurostatQueryDataset.output.parse({
        ...mockQueryResult,
        truncated: true,
      });
      expect(parsed.canvasId).toBeUndefined();
      expect(parsed.tableName).toBeUndefined();
      expect(parsed.stagedRowCount).toBeUndefined();
    });

    it('renders the pre-spillover truncation banner in content[]', () => {
      const blocks = eurostatQueryDataset.format!({
        ...mockQueryResult,
        truncated: true,
        obsCount: 6000,
      });
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('**Truncated:** true');
      expect(text).toContain('5,000');
      // Narrowing the query is the only route to the rest here, and the banner must say so
      // rather than point at a canvas this deployment does not have.
      expect(text).toContain('Add dimension filters');
      expect(text).not.toContain('**Staged:**');
      expect(text).not.toContain('canvas');
    });
  });

  it('renders the staged handle into content[] when there is one (format parity)', () => {
    const blocks = eurostatQueryDataset.format!({
      ...mockQueryResult,
      truncated: true,
      obsCount: 6000,
      canvasId: 'cnv0000001',
      tableName: 'df_abcd1234',
      stagedRowCount: 6000,
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('df_abcd1234');
    expect(text).toContain('cnv0000001');
    expect(text).toContain('6000');
    expect(text).toContain('eurostat_dataframe_query');
    // The truncation banner itself changes when there is a table — it must not keep telling
    // the reader that narrowing the query is the way to the rest.
    expect(text).toContain('the whole match is staged on the canvas below');
    expect(text).not.toContain('Add dimension filters');
  });
});
