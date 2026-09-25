/**
 * @fileoverview Tests for the eurostat_query_dataset tool.
 * @module tests/tools/eurostat-query-dataset.tool.test
 */

import { readFileSync } from 'node:fs';
import type { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('applies default empty filters, a 50-row preview, and EN language', () => {
    const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
    expect(input.filters).toEqual({});
    expect(input.preview_limit).toBe(50);
    expect(input.lang).toBe('EN');
  });

  it('accepts preview_limit boundaries and rejects invalid values without adding an offset', () => {
    expect(
      eurostatQueryDataset.input.parse({ dataset_code: 'x', preview_limit: 1 }).preview_limit,
    ).toBe(1);
    expect(
      eurostatQueryDataset.input.parse({ dataset_code: 'x', preview_limit: 500 }).preview_limit,
    ).toBe(500);
    for (const preview_limit of [0, -1, 1.5, 501]) {
      expect(() =>
        eurostatQueryDataset.input.parse({ dataset_code: 'x', preview_limit }),
      ).toThrow();
    }
    expect(eurostatQueryDataset.input.shape).not.toHaveProperty('offset');
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

  const conflictingInputs: Array<[string, z.input<typeof eurostatQueryDataset.input>]> = [
    [
      'geo plus geo_level',
      { dataset_code: 'nama_10_gdp', filters: { geo: ['DE'] }, geo_level: 'country' },
    ],
    [
      'an upper-case GEO key plus geo_level (#54)',
      {
        dataset_code: 'une_rt_m',
        filters: { GEO: ['DE'] },
        geo_level: 'country',
        last_n_periods: 1,
      },
    ],
    [
      'since_period plus last_n_periods',
      { dataset_code: 'nama_10_gdp', since_period: '2020', last_n_periods: 5 },
    ],
    [
      'until_period plus last_n_periods',
      { dataset_code: 'nama_10_gdp', until_period: '2024', last_n_periods: 3 },
    ],
  ];
  for (const [label, input] of conflictingInputs) {
    it(`renders contract recovery for ${label} before any request`, async () => {
      const fetchMock = vi.fn(unmockedFetch);
      vi.stubGlobal('fetch', fetchMock);
      vi.mocked(getEurostatDataService).mockReturnValue(
        new EurostatDataService({} as never, {} as never),
      );

      try {
        const result = await runToolContract(eurostatQueryDataset, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            message: expect.any(String),
            data: {
              reason: 'conflicting_params',
              recovery: { hint: expect.stringContaining('not both') },
            },
          },
        });
        expect(result.content).toContainEqual(
          expect.objectContaining({ text: expect.stringContaining('Recovery:') }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }

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
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      filters: { geo: ['NONEXISTENT'] },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_results',
          recovery: {
            hint: expect.stringMatching(/dimension values.*nama_10_gdp.*period range/i),
          },
        },
      },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('Recovery:') }),
    );
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
      50,
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

  /** 6,000 cells — 1,000 past the staging threshold. */
  const oversized = () => jsonStatBody(PERIODS, GEOS, 6000);
  /** Exactly the staging threshold. */
  const atCap = () => jsonStatBody(PERIODS.slice(0, 50), GEOS, 5000);
  /** The smallest match that crosses the staging threshold. */
  const pastCap = () => jsonStatBody(PERIODS.slice(0, 51), GEOS, 5001);
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
    fetchMock = vi.fn(unmockedFetch);
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
    for (const [label, matchSize, previewLimit, expectedInline] of [
      ['shorter than the match', 5, 3, 3],
      ['equal to the match', 5, 5, 5],
      ['longer than the match', 5, 8, 5],
    ] as const) {
      it(`returns a deterministic preview ${label} without staging an under-cap match`, async () => {
        const acquire = vi.spyOn(canvas, 'acquire');
        fetchMock.mockImplementation(async () =>
          okResponse(jsonStatBody(['2023'], GEOS.slice(0, matchSize), matchSize)),
        );

        const result = await run({ preview_limit: previewLimit });

        expect(result.observations).toHaveLength(expectedInline);
        expect(result.obsCount).toBe(matchSize);
        expect(result.truncated).toBe(false);
        expect(result.tableName).toBeUndefined();
        expect(acquire).not.toHaveBeenCalled();
      });
    }

    it('stages the whole match and names it in the response', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const result = await run();

      expect(result.truncated).toBe(true);
      expect(result.observations).toHaveLength(50);
      expect(result.obsCount).toBe(6000);
      // The rows outside the inline preview are reachable, which is the whole point.
      expect(result.stagedRowCount).toBe(6000);
      expect(result.tableName).toMatch(/^df_[0-9a-f]{8}$/);
      expect(result.canvasId).toBeTypeOf('string');
    });

    it('does not stage exactly 5,000 matches even when preview_limit returns only a prefix', async () => {
      const acquire = vi.spyOn(canvas, 'acquire');
      fetchMock.mockImplementation(async () => okResponse(atCap()));
      const c = ctx();

      const result = await eurostatQueryDataset.handler(
        eurostatQueryDataset.input.parse({
          dataset_code: 'nama_10_gdp',
          preview_limit: 50,
        }),
        c,
      );

      expect(result.obsCount).toBe(5000);
      expect(result.observations).toHaveLength(50);
      expect(result.truncated).toBe(false);
      expect(result.tableName).toBeUndefined();
      expect(acquire).not.toHaveBeenCalled();
      expect(getEnrichment(c).notice).toMatch(/preview_limit.*filters/i);
    });

    it('stages the full 5,001-row match while preview_limit bounds only the inline prefix', async () => {
      fetchMock.mockImplementation(async () => okResponse(pastCap()));
      const result = await run({ preview_limit: 7 });

      expect(result.obsCount).toBe(5001);
      expect(result.observations).toHaveLength(7);
      expect(result.truncated).toBe(true);
      expect(result.stagedRowCount).toBe(5001);
    });

    it('keeps structuredContent and the full content array aligned on preview and staged guidance', async () => {
      fetchMock.mockImplementation(async () => okResponse(pastCap()));

      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        preview_limit: 3,
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        obsCount: 5001,
        truncated: true,
        stagedRowCount: 5001,
        observations: expect.arrayContaining([expect.any(Object)]),
        notice: expect.stringMatching(/eurostat_dataframe_describe.*eurostat_dataframe_query/i),
      });
      expect((result.structuredContent as { observations: unknown[] }).observations).toHaveLength(
        3,
      );
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text.split('\n').filter((line) => line.includes('→'))).toHaveLength(3);
      expect(text).toMatch(/eurostat_dataframe_describe.*eurostat_dataframe_query/is);
      expect(text).toContain('df_');
    });

    it('composes the unmatched, preview and staged sentences into one notice on both surfaces', async () => {
      fetchMock.mockImplementation(async () => okResponse(pastCap()));

      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        filters: { geo: ['G1', 'G2', 'XX'], time: ['2000', '1850'] },
        preview_limit: 3,
      });

      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(result.structuredContent).toMatchObject({
        stagedRowCount: 5001,
        unmatchedValues: { geo: ['XX'], time: ['1850'] },
      });
      expect(notice).toMatch(
        /geo=\[XX\]; time=\[1850\].*eurostat_get_dimension_values.*preview_limit=3 returns the first 3 of 5,001 matched rows inline.*eurostat_dataframe_describe.*eurostat_dataframe_query/s,
      );
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain('**Unmatched filter values:** geo=[XX]; time=[1850]');
      expect(text).toContain(`> ${notice}`);
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

      // …and the table carries periods the inline preview never reaches.
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

    it('stages nothing when the match stays below the threshold', async () => {
      const acquire = vi.spyOn(canvas, 'acquire');
      fetchMock.mockImplementation(async () => okResponse(small()));
      const result = await run();

      expect(result.truncated).toBe(false);
      expect(result.observations).toHaveLength(50);
      // No canvas is minted because the full match stays below the 5,000-row threshold.
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

    it('returns the preview with no canvas fields at all', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const result = await run();

      expect(result.truncated).toBe(true);
      expect(result.observations).toHaveLength(50);
      expect(result.obsCount).toBe(6000);
      // Every added field is optional and absent — not null, not an empty string — so a
      // caller on this deployment can distinguish an absent Canvas from an empty handle.
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
      expect(notice).not.toContain('eurostat_dataframe_describe');
      expect(notice).not.toContain('eurostat_dataframe_query');
    });

    it('does not advertise dataframe tools in either response surface', async () => {
      fetchMock.mockImplementation(async () => okResponse(pastCap()));
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        preview_limit: 3,
      });
      expect(result.structuredContent).not.toHaveProperty('tableName');
      const structuredText = JSON.stringify(result.structuredContent);
      const contentText = result.content
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
      expect(structuredText).not.toContain('eurostat_dataframe_describe');
      expect(structuredText).not.toContain('eurostat_dataframe_query');
      expect(contentText).not.toContain('eurostat_dataframe_describe');
      expect(contentText).not.toContain('eurostat_dataframe_query');
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
    expect(text).toContain('eurostat_dataframe_describe');
    expect(text).toContain('eurostat_dataframe_query');
    // The truncation banner itself changes when there is a table — it must not keep telling
    // the reader that narrowing the query is the way to the rest.
    expect(text).toContain('the whole match is staged on the canvas below');
    expect(text).not.toContain('Add dimension filters');
  });
});

// ---------------------------------------------------------------------------
// Period inputs and filter matching — run on the real service with fetch stubbed,
// so the period check, the error classifier, and the envelope diagnosis are all the
// production code. The fixtures are JSON-stat replies captured live for the requests
// their names describe.
// ---------------------------------------------------------------------------

const envelope = (name: string): object =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as object;

const jsonReply = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Any fetch a test did not arrange fails loudly instead of returning undefined. */
const unmockedFetch = async (input: unknown): Promise<Response> => {
  throw new Error(`Unmocked fetch: ${String(input)}`);
};

const contentText = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? '').join('\n');

const DE_UNEMPLOYMENT = {
  geo: ['DE'],
  unit: ['PC_ACT'],
  s_adj: ['SA'],
  age: ['TOTAL'],
  sex: ['T'],
};

describe('eurostatQueryDataset — period inputs and filter matching (real service)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
    setCanvas(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const requestedUrl = (): URL => new URL(String(fetchMock.mock.calls[0]?.[0]));

  describe('period bounds that reach Eurostat unchanged', () => {
    for (const [label, sent, expected] of [
      ['an empty string', '', null],
      ['a whitespace-only string', '   ', null],
      ['a padded year', '  2020  ', '2020'],
    ] as const) {
      it(`sends ${label} as ${expected === null ? 'no bound' : `"${expected}"`}`, async () => {
        fetchMock.mockImplementationOnce(async () =>
          jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
        );
        await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: DE_UNEMPLOYMENT,
          since_period: sent,
          until_period: sent,
        });
        expect(requestedUrl().searchParams.get('sinceTimePeriod')).toBe(expected);
        expect(requestedUrl().searchParams.get('untilTimePeriod')).toBe(expected);
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
        fetchMock.mockImplementation(async () =>
          jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
        );
        await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: DE_UNEMPLOYMENT,
          since_period: period,
        });
        await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: DE_UNEMPLOYMENT,
          until_period: period,
        });
        expect(
          new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('sinceTimePeriod'),
        ).toBe(period);
        expect(
          new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('untilTimePeriod'),
        ).toBe(period);
      });
    }
  });

  it('maps a JSON-stat 400 that is not about the period to conflicting_params', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonReply(
        { error: [{ status: 400, id: 400, label: "Invalid value for 'lang' parameter." }] },
        400,
      ),
    );
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'une_rt_m',
      filters: DE_UNEMPLOYMENT,
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'conflicting_params' } },
    });
  });

  it('keeps the generic no_results hint for an HTTP-200 NO_RESULTS reply, which carries no envelope', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonReply({
        error: [
          {
            status: 200,
            id: 100,
            label: 'NO_RESULTS: The query that has been sent did not return any results.',
          },
        ],
      }),
    );
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'tgs00010',
      filters: { isced11: ['ED0-2'], sex: ['T'] },
      geo_level: 'country',
      last_n_periods: 1,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'no_results',
          recovery: {
            hint: 'No observation cells matched. Verify dimension values for "tgs00010" using eurostat_get_dimension_values, and check the period range is inside the dataset\'s coverage — an unmatched value and an out-of-coverage range both return no data rather than an error.',
          },
        },
      },
    });
    const data = (result.structuredContent as { error: { data: Record<string, unknown> } }).error
      .data;
    expect(data).not.toHaveProperty('unmatchedValues');
    expect(data).not.toHaveProperty('matchedPeriods');
  });

  it('returns a fully matched query with no unmatchedValues and no notice', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonReply(envelope('une-rt-m-geo-de-lower-last3')),
    );
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'une_rt_m',
      filters: { ...DE_UNEMPLOYMENT, geo: ['de'] },
      last_n_periods: 3,
    });
    expect(result.isError).not.toBe(true);
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(
      [
        'appliedFilters',
        'datasetCode',
        'datasetLabel',
        'dimensionsUsed',
        'missingObsCount',
        'obsCount',
        'observations',
        'timeRange',
        'truncated',
      ].sort(),
    );
    expect(contentText(result as never)).not.toMatch(/unmatched/i);
  });

  it('keeps the preview-short response shape: structured keys and notice text', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonReply(envelope('une-rt-m-geo-de-lower-last3')),
    );
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'une_rt_m',
      filters: DE_UNEMPLOYMENT,
      last_n_periods: 3,
      preview_limit: 1,
    });
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(
      [
        'appliedFilters',
        'datasetCode',
        'datasetLabel',
        'dimensionsUsed',
        'missingObsCount',
        'notice',
        'obsCount',
        'observations',
        'timeRange',
        'truncated',
      ].sort(),
    );
    expect(result.structuredContent).toMatchObject({
      obsCount: 2,
      truncated: false,
      notice:
        'preview_limit=1 returns the first 1 of 2 matched rows inline; it does not reduce the match. Use dimension filters (freq, s_adj, age, unit, sex, geo) or a period range to reduce the match itself.',
    });
  });

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
      '2021-02-29',
      '2020-1',
      '2020Q1',
      '202001',
      'banana',
    ];
    for (const period of REJECTED) {
      for (const bound of ['since_period', 'until_period'] as const) {
        it(`rejects ${bound} "${period}" as invalid_period before any request`, async () => {
          const result = await runToolContract(eurostatQueryDataset, {
            dataset_code: 'une_rt_m',
            filters: DE_UNEMPLOYMENT,
            [bound]: `  ${period} `,
          });
          expect(fetchMock).not.toHaveBeenCalled();
          expect(result.isError).toBe(true);
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
          expect(contentText(result as never)).toMatch(/Recovery:.*YYYY-Qn/s);
        });
      }
    }

    it('checks the period before the since/last_n conflict, so a bad literal is named first', async () => {
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        since_period: '2020-13',
        last_n_periods: 3,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_period' } },
      });
    });

    it('rejects an inverted range before any request, naming both bounds (#53)', async () => {
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: DE_UNEMPLOYMENT,
        since_period: '2024-01',
        until_period: '2020-01',
      });
      expect(fetchMock).not.toHaveBeenCalled();
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
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: DE_UNEMPLOYMENT,
        since_period: '2020-06',
        until_period: '2020',
      });
      expect(result.isError).not.toBe(true);
      expect(requestedUrl().searchParams.get('sinceTimePeriod')).toBe('2020-06');
      expect(requestedUrl().searchParams.get('untilTimePeriod')).toBe('2020');
    });

    for (const [label, body] of [
      [
        "Eurostat's 400 naming sinceTimePeriod",
        {
          error: [
            { status: 400, id: 400, label: "Invalid value for 'sinceTimePeriod' parameter." },
          ],
        },
      ],
      [
        "Eurostat's error id 140",
        {
          error: [
            {
              status: 400,
              id: 140,
              label:
                'TIME_PERIOD_FILTER_SPEC_INVALID: Impossible to apply time dimension filtering',
            },
          ],
        },
      ],
    ] as const) {
      it(`maps ${label} to invalid_period with the contract recovery`, async () => {
        fetchMock.mockImplementationOnce(async () => jsonReply(body, 400));
        const result = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: DE_UNEMPLOYMENT,
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
        expect(contentText(result as never)).not.toContain('geo_level');
      });
    }

    it('declares invalid_period on the contract with the ValidationError code', () => {
      expect(eurostatQueryDataset.errors).toContainEqual(
        expect.objectContaining({
          reason: 'invalid_period',
          code: JsonRpcErrorCode.ValidationError,
        }),
      );
    });
  });

  describe('zero-padded period components (#47)', () => {
    for (const [sent, canonical] of [
      ['2020-Q01', '2020-Q1'],
      ['2020-q01', '2020-q1'],
      ['2020-S01', '2020-S1'],
      ['2020-W001', '2020-W01'],
      ['2020-M001', '2020-M01'],
      ['2026-D1', '2026-D001'],
      ['2020-A1', '2020'],
    ] as const) {
      it(`sends "${sent}" as "${canonical}" on either bound and echoes what was sent`, async () => {
        fetchMock.mockImplementation(async () =>
          jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
        );
        const since = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: DE_UNEMPLOYMENT,
          since_period: ` ${sent} `,
        });
        const until = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: DE_UNEMPLOYMENT,
          until_period: sent,
        });
        expect(
          new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('sinceTimePeriod'),
        ).toBe(canonical);
        expect(
          new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('untilTimePeriod'),
        ).toBe(canonical);
        expect(since.structuredContent).toMatchObject({
          appliedFilters: { sincePeriod: canonical },
        });
        expect(until.structuredContent).toMatchObject({
          appliedFilters: { untilPeriod: canonical },
        });
        expect(contentText(since as never)).toContain(`**Period:** ${canonical} – latest`);
      });
    }

    for (const period of ['2020-Q05', '2021-W053', '2020-M013']) {
      it(`rejects "${period}", whose canonical form is out of range, before any request`, async () => {
        const result = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          since_period: period,
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.structuredContent).toMatchObject({
          error: {
            message: expect.stringContaining(`since_period "${period}"`),
            data: { reason: 'invalid_period' },
          },
        });
      });
    }
  });

  describe('no_results diagnosis from the envelope (#48)', () => {
    const noResults = async (
      fixtureName: string,
      input: Record<string, unknown>,
    ): Promise<{ data: Record<string, unknown>; message: string; hint: string; text: string }> => {
      fetchMock.mockImplementationOnce(async () => jsonReply(envelope(fixtureName)));
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        ...input,
      } as never);
      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; message: string; data: Record<string, unknown> };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('no_results');
      return {
        data: error.data,
        message: error.message,
        hint: (error.data.recovery as { hint: string }).hint,
        text: contentText(result as never),
      };
    };

    it('names an unmatched geo value and points at eurostat_get_dimension_values for geo', async () => {
      const { data, message, hint, text } = await noResults('une-rt-m-geo-xx-last1', {
        filters: { geo: ['XX'] },
        last_n_periods: 1,
      });
      expect(data.unmatchedValues).toEqual({ geo: ['XX'] });
      expect(data).not.toHaveProperty('matchedPeriods');
      expect(message).toContain('geo=[XX]');
      expect(hint).toContain('eurostat_get_dimension_values');
      expect(hint).toContain('geo');
      expect(hint).not.toMatch(/last_n_periods counts/);
      expect(text).toContain('geo=[XX]');
      expect(text).toContain('eurostat_get_dimension_values');
    });

    it('names a dropped value beside a valid one and the valueless periods together', async () => {
      const { data, message, hint } = await noResults('une-rt-m-geo-de-xx-last1', {
        filters: { ...DE_UNEMPLOYMENT, geo: ['DE', 'XX'] },
        last_n_periods: 1,
      });
      expect(data.unmatchedValues).toEqual({ geo: ['XX'] });
      expect(data.matchedPeriods).toEqual(['2026-08']);
      expect(message).toContain('geo=[XX]');
      expect(message).toContain('2026-08');
      expect(hint).toContain('eurostat_get_dimension_values');
      expect(hint).toMatch(/last_n_periods/);
    });

    it('lists both unmatched dimensions', async () => {
      const { data, message, hint } = await noResults('une-rt-m-geo-xx-age-zzz-last1', {
        filters: { geo: ['XX'], age: ['ZZZ'] },
        last_n_periods: 1,
      });
      expect(data.unmatchedValues).toEqual({ geo: ['XX'], age: ['ZZZ'] });
      expect(message).toContain('geo=[XX]');
      expect(message).toContain('age=[ZZZ]');
      expect(hint).toMatch(/geo and age|age and geo/);
    });

    it('diagnoses an unmatched non-geo code the same way', async () => {
      const { data, hint } = await noResults('une-rt-m-unit-fake-last1', {
        filters: { geo: ['DE'], unit: ['QQQ_FAKE'] },
        last_n_periods: 1,
      });
      expect(data.unmatchedValues).toEqual({ unit: ['QQQ_FAKE'] });
      expect(hint).toContain('unit');
    });

    it('explains the last_n_periods counting rule when the slice has not published the latest period', async () => {
      const { data, message, hint } = await noResults('une-rt-m-geo-de-lower-last1', {
        filters: { ...DE_UNEMPLOYMENT, geo: ['de'] },
        last_n_periods: 1,
      });
      expect(data).not.toHaveProperty('unmatchedValues');
      expect(data.matchedPeriods).toEqual(['2026-08']);
      expect(message).toContain('The last period (2026-08) carries no value for this slice');
      expect(message).toMatch(/counts back from the dataset's latest period/);
      expect(hint).toMatch(/last_n_periods/);
      expect(hint).toMatch(/until_period/);
      expect(hint).not.toContain('eurostat_get_dimension_values');
    });

    it('says the combination carries no values when no period control was used', async () => {
      const { data, message, hint } = await noResults('une-rt-m-geo-de-lower-last1', {
        filters: { ...DE_UNEMPLOYMENT, geo: ['de'] },
      });
      expect(data.matchedPeriods).toEqual(['2026-08']);
      expect(message).toContain('carries no value in the 1 returned period (2026-08)');
      expect(`${message} ${hint}`).not.toMatch(/last_n_periods counts/);
    });

    it('names the span of several valueless last_n_periods', async () => {
      const valueless = { ...envelope('une-rt-m-geo-de-lower-last3'), value: {} };
      fetchMock.mockImplementationOnce(async () => jsonReply(valueless));
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: DE_UNEMPLOYMENT,
        last_n_periods: 3,
      });
      const error = (
        result.structuredContent as { error: { message: string; data: Record<string, unknown> } }
      ).error;
      expect(error.data.matchedPeriods).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(error.data.matchedPeriodCount).toBe(3);
      expect(error.message).toContain(
        'None of the last 3 periods (2026-06 – 2026-08) carries a value for this slice',
      );
    });

    describe('matchedPeriods cap', () => {
      /** Consecutive days from 1988-01-01, as a daily dataset's time index spells them. */
      const days = (count: number): string[] =>
        Array.from({ length: count }, (_, i) =>
          new Date(Date.UTC(1988, 0, 1 + i)).toISOString().slice(0, 10),
        );

      /** The DE unemployment envelope with `count` valueless periods and no period control. */
      const valuelessOver = async (count: number) => {
        const base = envelope('une-rt-m-geo-de-lower-last1') as {
          size: number[];
          dimension: Record<string, unknown>;
        };
        const periods = days(count);
        const body = {
          ...base,
          size: [...base.size.slice(0, -1), count],
          dimension: {
            ...base.dimension,
            time: {
              label: 'Time',
              category: {
                index: Object.fromEntries(periods.map((p, i) => [p, i])),
                label: Object.fromEntries(periods.map((p) => [p, p])),
              },
            },
          },
          value: {},
          status: {},
        };
        fetchMock.mockImplementationOnce(async () => jsonReply(body));
        const result = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: DE_UNEMPLOYMENT,
        });
        const error = (
          result.structuredContent as { error: { message: string; data: Record<string, unknown> } }
        ).error;
        return { periods, error, bytes: JSON.stringify(result.structuredContent).length };
      };

      it('lists all 24 periods when there are exactly 24', async () => {
        const { periods, error } = await valuelessOver(24);
        expect(error.data.matchedPeriods).toEqual(periods);
        expect(error.data.matchedPeriodCount).toBe(24);
        expect(error.message).toContain(`24 returned periods (${periods[0]} – ${periods[23]})`);
      });

      it('keeps the newest 24 of 25 and names the whole span and count', async () => {
        const { periods, error } = await valuelessOver(25);
        expect(error.data.matchedPeriods).toEqual(periods.slice(1));
        expect(error.data.matchedPeriodCount).toBe(25);
        expect(error.message).toContain(`25 returned periods (${periods[0]} – ${periods[24]})`);
      });

      it('bounds a 13,900-period daily index to 24 entries', async () => {
        const { periods, error, bytes } = await valuelessOver(13_900);
        expect(error.data.matchedPeriods).toEqual(periods.slice(-24));
        expect(error.data.matchedPeriodCount).toBe(13_900);
        expect(error.message).toContain(
          `13,900 returned periods (${periods[0]} – ${periods[13_899]})`,
        );
        expect(bytes).toBeLessThan(3_000);
      });
    });

    it('names the dataset latest period for a range past coverage', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('nama-10-gdp-de-since-2030')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        filters: { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE'] },
        since_period: '2030',
      });
      const error = (
        result.structuredContent as { error: { message: string; data: Record<string, unknown> } }
      ).error;
      expect(error.data).toMatchObject({ reason: 'no_results' });
      expect(error.data).not.toHaveProperty('matchedPeriods');
      expect(error.message).toContain('2025');
      expect((error.data.recovery as { hint: string }).hint).toContain('2025');
      expect(contentText(result as never)).toContain('2025');
    });

    it('lists the matched periods of a past range with a coverage hint, never the last_n_periods rule', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('nama-10-gdp-de-until-1980')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        filters: { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE'] },
        until_period: '1980',
      });
      const error = (
        result.structuredContent as { error: { message: string; data: Record<string, unknown> } }
      ).error;
      expect(error.data.matchedPeriods).toEqual(['1975', '1976', '1977', '1978', '1979', '1980']);
      expect(error.message).toContain('selects 6 periods (1975 – 1980)');
      const hint = (error.data.recovery as { hint: string }).hint;
      expect(hint).toMatch(/coverage/);
      expect(`${error.message} ${hint}`).not.toMatch(/last_n_periods/);
    });

    it('still returns the six observations of the all-confidential slice (#36)', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('sts-inpr-m-ie-confidential')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'sts_inpr_m',
        filters: { indic_bt: ['PRD'], nace_r2: ['B'], s_adj: ['CA'], unit: ['I21'], geo: ['IE'] },
        since_period: '2023-01',
        until_period: '2023-06',
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ obsCount: 6, missingObsCount: 6 });
      expect(result.structuredContent).not.toHaveProperty('unmatchedValues');
    });

    it('states the last_n_periods counting rule in its description', () => {
      expect(eurostatQueryDataset.input.shape.last_n_periods.description).toMatch(
        /counts back from the dataset's latest period/,
      );
    });
  });

  describe('unmatched filter values on a successful query (#52)', () => {
    it('returns the matched rows and names the dropped value on both surfaces', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: { ...DE_UNEMPLOYMENT, geo: ['DE', 'XX'] },
        since_period: '2024-01',
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        obsCount: 31,
        unmatchedValues: { geo: ['XX'] },
        appliedFilters: { filters: { geo: ['DE', 'XX'] } },
        notice: expect.stringMatching(/geo=\[XX\].*eurostat_get_dimension_values/),
      });
      const text = contentText(result as never);
      expect(text).toContain('**Unmatched filter values:** geo=[XX]');
      expect(text).toMatch(/> .*geo=\[XX\]/);
    });

    it('lists unmatched values in two dimensions', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('une-rt-m-geo-de-xx-age-zzz-since-2026-01')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: { ...DE_UNEMPLOYMENT, geo: ['DE', 'XX'], age: ['TOTAL', 'ZZZ'] },
        since_period: '2026-01',
      });
      expect(result.structuredContent).toMatchObject({
        obsCount: 7,
        unmatchedValues: { geo: ['XX'], age: ['ZZZ'] },
        notice: expect.stringMatching(/geo=\[XX\]; age=\[ZZZ\]/),
      });
      expect(contentText(result as never)).toContain('geo=[XX]; age=[ZZZ]');
    });

    it('diagnoses an unmatched value under an upper-case key as under the lower-case one (#54)', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
      );
      const { geo: _geo, ...rest } = DE_UNEMPLOYMENT;
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: { ...rest, GEO: ['DE', 'XX'] },
        since_period: '2024-01',
      });
      expect(result.structuredContent).toMatchObject({
        obsCount: 31,
        unmatchedValues: { GEO: ['XX'] },
        notice: expect.stringMatching(/GEO=\[XX\].*eurostat_get_dimension_values/),
      });
    });

    it('composes the unmatched and preview sentences into one notice', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: { ...DE_UNEMPLOYMENT, geo: ['DE', 'XX'] },
        since_period: '2024-01',
        preview_limit: 3,
      });
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringMatching(
          /geo=\[XX\].*eurostat_get_dimension_values.*preview_limit=3 returns the first 3 of 31 matched rows inline/s,
        ),
      });
    });

    it('advertises unmatchedValues as an optional output field', () => {
      const parsed = eurostatQueryDataset.output.parse({
        ...mockQueryResult,
        truncated: false,
        unmatchedValues: { geo: ['XX'] },
      });
      expect(parsed.unmatchedValues).toEqual({ geo: ['XX'] });
      expect(
        eurostatQueryDataset.output.parse({ ...mockQueryResult, truncated: false }),
      ).not.toHaveProperty('unmatchedValues');
    });
  });
});
