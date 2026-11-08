/**
 * @fileoverview Tests for the eurostat_query_dataset tool.
 * @module tests/tools/eurostat-query-dataset.tool.test
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as serverConfig from '@/config/server-config.js';
import { eurostatQueryDataset } from '@/mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { hoistDimensions } from '@/mcp-server/tools/hoist-dimensions.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { sdmxDataStructureXml } from '../fixtures/eurostat-sdmx-metadata.js';
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
  absentCellCount: 0,
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

  it('composes last-N selected-period gaps with clamp, unmatched and preview notices on both surfaces', async () => {
    setCanvas(undefined);
    // Thirty selected years, cells only in 1996–1999: the 26 empty ones trail the span.
    const trailing = Array.from({ length: 26 }, (_, i) => String(2000 + i));
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi.fn().mockResolvedValue({
        ...mockQueryResult,
        obsCount: 600,
        unpopulatedPeriods: trailing,
        outsideSpans: [
          {
            frequency: 'A',
            kind: 'edges',
            first: '1996',
            last: '1999',
            before: [],
            after: trailing,
          },
        ],
        latestWithCell: '1999',
        unmatchedValues: { geo: ['XX'] },
      }),
    } as never);
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      last_n_periods: 30,
      preview_limit: 1000,
      stage: true,
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('26 selected periods');
    expect(notice).toContain('2002, 2003');
    expect(notice).toContain('2025');
    expect(notice).toContain('2 earlier periods omitted');
    expect(notice).toContain(
      'Set last_n_periods to 56 for the 30 periods ending at 1999, or set a since_period/until_period range ending at 1999, the latest period with a cell in this match; until_period alone selects every period up to it.',
    );
    expect(notice).toContain(
      '2000 – 2025 carry no cell in any series, after the latest period with one (1999).',
    );
    expect(notice).toContain('preview_limit requested 1000; applied 500');
    expect(notice).toContain('geo=[XX]');
    expect(notice).toContain('first 3 of 600');
    expect(notice).toContain('staging is unavailable');
    expect(contentText(result)).toContain(notice);
    expect(result.structuredContent).not.toHaveProperty('unpopulatedPeriods');
    expect(result.structuredContent).not.toHaveProperty('outsideSpans');
    expect(result.structuredContent).not.toHaveProperty('latestWithCell');
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

  it('applies default empty filters, a 25-row preview, and EN language', () => {
    const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
    expect(input.filters).toEqual({});
    expect(input.preview_limit).toBe(25);
    expect(input.stage).toBe(false);
    expect(input.lang).toBe('EN');
  });

  it('accepts preview_limit boundaries and rejects invalid values without adding an offset', () => {
    expect(
      eurostatQueryDataset.input.parse({ dataset_code: 'x', preview_limit: 1 }).preview_limit,
    ).toBe(1);
    expect(
      eurostatQueryDataset.input.parse({ dataset_code: 'x', preview_limit: 500 }).preview_limit,
    ).toBe(500);
    expect(
      eurostatQueryDataset.input.parse({ dataset_code: 'x', preview_limit: 501 }).preview_limit,
    ).toBe(501);
    for (const preview_limit of [0, -1, 1.5, NaN, Infinity, '501']) {
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
      25,
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

  beforeAll(async () => {
    ({ canvas, teardown } = withRealCanvas());
    // Loads the DuckDB binding once, so no single test pays for it against its timeout.
    await canvas.acquire(undefined, ctx());
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
    for (const count of [5000, 5001]) {
      for (const stage of [undefined, false, true]) {
        it(`preserves truncation and staging for ${count} rows with stage=${stage}`, async () => {
          fetchMock.mockImplementation(async () =>
            okResponse(count === 5000 ? atCap() : pastCap()),
          );
          const result = await run({ ...(stage === undefined ? {} : { stage }), preview_limit: 1 });
          expect(result.truncated).toBe(count > 5000);
          expect(result.stagedRowCount).toBe(stage || count > 5000 ? count : undefined);
          expect(result.observations).toHaveLength(1);
          expect(fetchMock).toHaveBeenCalledTimes(1);
        });
      }
    }
    it('looks up an unknown canvas for an explicitly staged small match', async () => {
      fetchMock.mockImplementation(async () => okResponse(small()));
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        stage: true,
        canvas_id: 'zzzzzzzzzz',
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'canvas_not_found',
            recovery: { hint: expect.stringContaining('Omit canvas_id') },
          },
        },
      });
      expect(contentText(result)).toContain('Recovery: Omit canvas_id');
    });
    for (const preview_limit of [3, 5, 8]) {
      it(`explicitly stages all five rows with preview ${preview_limit}`, async () => {
        fetchMock.mockImplementation(async () =>
          okResponse(jsonStatBody(['2023'], GEOS.slice(0, 5), 5)),
        );
        const response = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'nama_10_gdp',
          stage: true,
          preview_limit,
        });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({
          obsCount: 5,
          truncated: false,
          stagedRowCount: 5,
          notice: expect.stringContaining('eurostat_dataframe_describe'),
        });
        const result = response.structuredContent as {
          canvasId: string;
          tableName: string;
          notice: string;
          observations: unknown[];
        };
        expect(result.observations).toHaveLength(Math.min(5, preview_limit));
        expect(contentText(response)).toContain(result.notice);
        const instance = await canvas.acquire(result.canvasId, ctx());
        const staged = await instance.query(
          `SELECT geo, geo_label, obs_value FROM ${result.tableName} ORDER BY obs_value`,
        );
        expect(staged.rows).toEqual(
          Array.from({ length: 5 }, (_, i) => ({
            geo: `G${i}`,
            geo_label: `G${i} label`,
            obs_value: i,
          })),
        );
      });
    }

    it('clamps over-cap previews without changing full-match counts or staging threshold', async () => {
      fetchMock.mockImplementation(async () =>
        okResponse(jsonStatBody(PERIODS.slice(0, 6), GEOS, 550)),
      );
      const result = await runToolContract(
        eurostatQueryDataset,
        { dataset_code: 'nama_10_gdp', preview_limit: 1000 },
        { context: { tenantId: 'default' } },
      );
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { observations: unknown[]; notice: string };
      expect(structured.observations).toHaveLength(500);
      expect(result.structuredContent).toMatchObject({
        obsCount: 550,
        truncated: false,
        notice: expect.stringMatching(
          /preview_limit requested 1000; applied 500.*preview_limit=500 returns the first 500 of 550/,
        ),
      });
      expect(result.structuredContent).not.toHaveProperty('tableName');
      expect(result.content.map((b) => ('text' in b ? b.text : '')).join('\n')).toContain(
        structured.notice,
      );
    });
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
      expect(result.observations).toHaveLength(25);
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

    it('counts the rows shown, not the match, in the hoist header of a staged truncated result (#86)', async () => {
      fetchMock.mockImplementation(async () => okResponse(pastCap()));

      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        preview_limit: 3,
      });

      const structured = result.structuredContent as {
        obsCount: number;
        observations: unknown[];
        stagedRowCount: number;
        tableName: string;
        truncated: boolean;
      };
      expect(structured.tableName).toMatch(/^df_/);
      expect(structured).toMatchObject({ obsCount: 5001, stagedRowCount: 5001, truncated: true });
      expect(structured.observations).toHaveLength(3);
      const header = '**Same in all 3 rows shown:** time=2000 (2000 label)';
      expect(contentText(result).split('\n')).toContain(header);
      const formatted = eurostatQueryDataset.format!(structured as never);
      expect(formatted.map((b) => (b.type === 'text' ? b.text : '')).join('')).toContain(
        `${header}\n\ngeo=G0 (G0 label) → 0\n`,
      );
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
      expect(result.observations).toHaveLength(25);
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

    it('carries its declared canvas_not_found recovery on both surfaces, not the canvas service hint', async () => {
      fetchMock.mockImplementation(async () => okResponse(pastCap()));
      const declared = eurostatQueryDataset.errors?.find(
        (e) => e.reason === 'canvas_not_found',
      )?.recovery;
      expect(declared).toContain('Omit canvas_id');

      const result = await runToolContract(
        eurostatQueryDataset,
        { dataset_code: 'nama_10_gdp', canvas_id: 'zzzzzzzzzz' },
        { context: { tenantId: 'default' } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'canvas_not_found',
            canvasId: 'zzzzzzzzzz',
            recovery: { hint: declared },
          },
        },
      });
      const text = contentText(result);
      expect(text).toContain(`Recovery: ${declared}`);
      expect(text).not.toContain('stage fresh data');
    });

    it('never looks up a supplied canvas_id when the match stays at or below the threshold', async () => {
      fetchMock.mockImplementation(async () => okResponse(atCap()));
      const result = await run({ canvas_id: 'zzzzzzzzzz' });
      expect(result.obsCount).toBe(5000);
      expect(result.truncated).toBe(false);
      expect(result.canvasId).toBeUndefined();
    });

    it('keeps the staged notice and banner word for word', async () => {
      fetchMock.mockImplementation(async () => okResponse(pastCap()));
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        preview_limit: 3,
      });
      const { canvasId, tableName, notice } = result.structuredContent as {
        canvasId: string;
        notice: string;
        tableName: string;
      };
      expect(tableName).toMatch(/^df_[0-9a-f]{8}$/);
      // pastCap() fills 2050 for G0 alone, so the other 99 geos each lack that period (#90).
      expect(notice).toBe(
        `99 absent cells in 99 of 100 series: periods a series lacks at a frequency it carries (no value, no flag). They are not observations: obsCount, missingObsCount, the rows and any staged table leave them out, so a per-period total across series covers only the series present. preview_limit=3 returns the first 3 of 5,001 matched rows inline; it does not reduce the match. All 5,001 matched rows are staged as table \`${tableName}\` on canvas \`${canvasId}\`. Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query. Use dimension filters (geo) or a period range when the match itself should be smaller.`,
      );
      const text = contentText(result);
      expect(text).toContain(
        '**Truncated:** true — the match crossed the 5,000-row staging threshold; the whole match is staged on the canvas below\n',
      );
      expect(text).toContain(`> ${notice}`);
    });

    // Root bypasses the permission bit, and Windows ignores it, so neither can reproduce it.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'passes a scratch-directory failure through as canvas_unavailable, untouched',
      async () => {
        fetchMock.mockImplementation(async () => okResponse(pastCap()));
        const readOnly = mkdtempSync(join(tmpdir(), 'eurostat-canvas-readonly-'));
        chmodSync(readOnly, 0o500);
        const broken = withRealCanvas({ tempRootPath: join(readOnly, 'scratch') });
        try {
          const result = await runToolContract(eurostatQueryDataset, {
            dataset_code: 'nama_10_gdp',
          });
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: JsonRpcErrorCode.ConfigurationError,
              data: { reason: 'canvas_unavailable', errno: 'EACCES' },
            },
          });
          expect(contentText(result)).toContain('CANVAS_PROVIDER_TYPE=none');
        } finally {
          await broken.teardown();
          setCanvas(canvas);
          chmodSync(readOnly, 0o700);
          rmSync(readOnly, { recursive: true, force: true });
        }
      },
    );
  });

  describe('without a canvas', () => {
    beforeEach(() => {
      setCanvas(undefined);
    });

    it('discloses unavailable explicit staging even when the preview is complete', async () => {
      fetchMock.mockImplementation(async () => okResponse(jsonStatBody(['2023'], ['DE'], 1)));
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        stage: true,
        canvas_id: 'zzzzzzzzzz',
      });
      expect(result.isError).not.toBe(true);
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('staging is unavailable');
      expect(notice).not.toContain('eurostat_dataframe_');
      expect(contentText(result)).toContain(notice);
    });

    it('returns the preview with no canvas fields at all', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));
      const result = await run();

      expect(result.truncated).toBe(true);
      expect(result.observations).toHaveLength(25);
      expect(result.obsCount).toBe(6000);
      // Every added field is optional and absent — not null, not an empty string — so a
      // caller on this deployment can distinguish an absent Canvas from an empty handle.
      expect('canvasId' in result).toBe(false);
      expect('tableName' in result).toBe(false);
      expect('stagedRowCount' in result).toBe(false);
    });

    it('counts the rows shown, not the match, in the hoist header of a truncated result with no table (#86)', async () => {
      fetchMock.mockImplementation(async () => okResponse(oversized()));

      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        preview_limit: 4,
      });

      const structured = result.structuredContent as {
        obsCount: number;
        observations: unknown[];
        truncated: boolean;
      };
      expect(structured).toMatchObject({ obsCount: 6000, truncated: true });
      expect('tableName' in structured).toBe(false);
      expect(structured.observations).toHaveLength(4);
      expect(contentText(result).split('\n')).toContain(
        '**Same in all 4 rows shown:** time=2000 (2000 label)',
      );
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
      expect(notice).toContain('period range');
      // Naming a tool this deployment does not list would send the agent nowhere.
      expect(notice).not.toContain('eurostat_dataframe_describe');
      expect(notice).not.toContain('eurostat_dataframe_query');
      // Without a canvas a download keeps only its preview, so it is no route to the rest.
      expect(notice).not.toContain('eurostat_download_dataset');
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
      // …nor a download, which keeps only its preview here: narrowing is the one route offered.
      expect(structuredText).not.toContain('eurostat_download_dataset');
      expect(contentText).not.toContain('eurostat_download_dataset');
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        notice: expect.stringContaining('dimension filters (geo) or a period range'),
      });
      expect(contentText).toMatch(/\*\*Truncated:\*\* true — .*Add dimension filters/);
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
      expect(text).toContain('period range');
      expect(text).not.toContain('**Staged:**');
      expect(text).not.toContain('canvas');
      expect(text).not.toContain('eurostat_download_dataset');
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

/**
 * {@link unmockedFetch}, except that every SDMX structure read answers 404 at once: a
 * failure whose hint reads the dataset's structure then keeps its generic hint without
 * waiting out the read's retries.
 */
const noStructure = async (input: unknown): Promise<Response> =>
  new URL(String(input)).pathname.includes('/sdmx/2.1/')
    ? new Response('<fault/>', { status: 404 })
    : unmockedFetch(input);

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

  it('keeps the generic no_results hint for an HTTP-200 NO_RESULTS reply to a call without geo_level, with no structure read', async () => {
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
    expect(contentText(result as never)).toContain(
      "Eurostat returned no observations for this query. Verify the dimension filters with eurostat_get_dimension_values and keep the period range inside the dataset's coverage.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = (result.structuredContent as { error: { data: Record<string, unknown> } }).error
      .data;
    expect(data).not.toHaveProperty('unmatchedValues');
    expect(data).not.toHaveProperty('matchedPeriods');
  });

  it('reports the selected period gap even when every filter value matched', async () => {
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
        'absentCellCount',
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
    expect(contentText(result as never)).not.toMatch(/unmatched/i);
    expect(result.structuredContent).toMatchObject({
      obsCount: 2,
      timeRange: { start: '2026-06', end: '2026-07' },
      notice: expect.stringContaining(
        '1 selected period (2026-08) carries no populated cells anywhere in this match',
      ),
    });
    expect(contentText(result)).toContain('1 selected period (2026-08)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
        'absentCellCount',
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
      notice: expect.stringContaining(
        'preview_limit=1 returns the first 1 of 2 matched rows inline; it does not reduce the match. Use dimension filters (freq, s_adj, age, unit, sex, geo) or a period range to reduce the match itself.',
      ),
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
      fetchMock
        .mockImplementation(noStructure)
        .mockImplementationOnce(async () => jsonReply(envelope(fixtureName)));
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
      expect(text).toContain('geo=\\[XX\\]');
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
      // until_period excludes last_n_periods, so alone it would select the whole history.
      expect(hint).toContain('a since_period/until_period range ending at a period');
      expect(hint).toContain('until_period alone selects every period up to it');
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

  describe('blank filter values (#61)', () => {
    it('sends ["", "DE", "XX"] as ["DE", "XX"] and echoes and diagnoses only those', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: { ...DE_UNEMPLOYMENT, geo: ['', 'DE', '  ', 'XX'] },
        since_period: '2024-01',
      });
      expect(result.isError).not.toBe(true);
      expect(requestedUrl().searchParams.getAll('geo')).toEqual(['DE', 'XX']);
      expect(result.structuredContent).toMatchObject({
        unmatchedValues: { geo: ['XX'] },
        appliedFilters: { filters: { geo: ['DE', 'XX'] } },
      });
      const text = contentText(result as never);
      expect(text).toContain('geo=[DE, XX]');
      expect(text).not.toMatch(/geo=\[, /);
    });

    for (const dim of ['geo', 'unit', 'age']) {
      it(`leaves ${dim} unrestricted when its array holds only blanks`, async () => {
        fetchMock.mockImplementationOnce(async () =>
          jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
        );
        const result = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: { ...DE_UNEMPLOYMENT, [dim]: ['', ' '] },
          last_n_periods: 1,
        });
        expect(requestedUrl().searchParams.has(dim)).toBe(false);
        expect(result.isError).not.toBe(true);
        const applied = (result.structuredContent as { appliedFilters: { filters: object } })
          .appliedFilters.filters;
        expect(applied).not.toHaveProperty(dim);
        expect(contentText(result as never)).not.toContain(`${dim}=[`);
      });
    }

    it('raises no conflicting_params for a blank-only geo beside geo_level', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
      );
      const { geo: _geo, ...rest } = DE_UNEMPLOYMENT;
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: { ...rest, geo: [''] },
        geo_level: 'country',
        last_n_periods: 1,
      });
      expect(result.isError).not.toBe(true);
      expect(requestedUrl().searchParams.get('geoLevel')).toBe('country');
      expect(requestedUrl().searchParams.has('geo')).toBe(false);
      expect(result.structuredContent).toMatchObject({ appliedFilters: { geoLevel: 'country' } });
    });
  });

  describe('control-named filter keys (#62)', () => {
    for (const [key, input, extra] of [
      ['lang', 'lang', { lang: 'EN' }],
      ['LASTTIMEPERIOD', 'last_n_periods', { last_n_periods: 1 }],
      ['sinceTimePeriod', 'since_period', {}],
      ['GEOLEVEL', 'geo_level', { geo_level: 'country' }],
    ] as const) {
      it(`fails filters.${key} as invalid_dimension naming ${input} on both surfaces, before any request`, async () => {
        const { geo: _geo, ...rest } = DE_UNEMPLOYMENT;
        const result = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: { ...rest, [key]: ['3'] },
          ...extra,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'invalid_dimension',
              // Whole hint: for `lang` the quoted key alone already contains the input name.
              recovery: { hint: `Remove "${key}" from filters and set ${input} instead.` },
            },
          },
        });
        expect(contentText(result as never)).toContain(
          `Recovery: Remove "${key}" from filters and set ${input} instead.`,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it('names every control key, and the input that sets each, in one rejection', async () => {
      const { geo: _geo, ...rest } = DE_UNEMPLOYMENT;
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: { ...rest, lang: ['FR'], LASTTIMEPERIOD: ['3'] },
      });
      const error = (
        result.structuredContent as {
          error: {
            code: number;
            message: string;
            data: { reason: string; recovery: { hint: string } };
          };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_dimension');
      expect(error.message).toBe(
        'Filter keys "lang", "LASTTIMEPERIOD" name a Statistics API control, not a dimension of "une_rt_m".',
      );
      expect(error.data.recovery.hint).toBe(
        'Remove "lang", "LASTTIMEPERIOD" from filters and set lang for "lang", last_n_periods for "LASTTIMEPERIOD" instead.',
      );
      expect(contentText(result as never)).toContain(`Recovery: ${error.data.recovery.hint}`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still sends filters.TIME and filters.time_period as time-dimension filters', async () => {
      for (const key of ['TIME', 'time_period']) {
        fetchMock.mockImplementationOnce(async () =>
          jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
        );
        const result = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'une_rt_m',
          filters: { ...DE_UNEMPLOYMENT, [key]: ['2024-01'] },
        });
        expect(result.isError).not.toBe(true);
      }
      const sent = fetchMock.mock.calls.map(([u]) => new URL(String(u)).searchParams);
      expect(sent[0]?.getAll('TIME')).toEqual(['2024-01']);
      expect(sent[1]?.getAll('time_period')).toEqual(['2024-01']);
    });

    it('names an unknown dimension Eurostat rejects beside the dimensions its structure lists (#104)', async () => {
      const structure = sdmxDataStructureXml(
        ['freq', 's_adj', 'age', 'unit', 'sex', 'geo'].map((id, i) => ({ id, position: i + 1 })),
      );
      fetchMock.mockImplementation(async (input: unknown) =>
        new URL(String(input)).pathname.includes('/sdmx/2.1/datastructure/')
          ? new Response(structure)
          : jsonReply(
              {
                error: [
                  {
                    status: 400,
                    id: 150,
                    label: 'INVALID_QUERY_DIMENSION: Dimension "PRECISION" is not defined',
                  },
                ],
              },
              400,
            ),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: { ...DE_UNEMPLOYMENT, precision: ['1'] },
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message:
            'Filter names "precision", which is not a dimension of this dataset. Filterable dimensions, in key order: freq, s_adj, age, unit, sex, geo.',
          data: {
            reason: 'invalid_dimension',
            unknownDimensions: ['precision'],
            recovery: {
              hint: 'Rename each filter key the error names to one of the dimensions it lists.',
            },
          },
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('a time filter beside a period input (#70)', () => {
    it('fails the reported call as conflicting_params naming filters.time and last_n_periods', async () => {
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        filters: { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE'], time: ['2020'] },
        last_n_periods: 1,
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'conflicting_params' },
        },
      });
      const hint = (result.structuredContent as { error: { data: { recovery: { hint: string } } } })
        .error.data.recovery.hint;
      expect(hint).toContain('filters.time');
      expect(hint).toContain('last_n_periods');
      expect(hint).not.toContain('geo_level');
      expect(hint).not.toContain('YYYY');
      expect(contentText(result as never)).toContain(hint);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    for (const [key, extra, input] of [
      ['TIME', { since_period: '2020' }, 'since_period'],
      ['time_period', { until_period: '2022' }, 'until_period'],
    ] as const) {
      it(`fails filters.${key} with ${input} the same way`, async () => {
        const result = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'nama_10_gdp',
          filters: { geo: ['DE'], [key]: ['2020'] },
          ...extra,
        });
        expect(result.structuredContent).toMatchObject({
          error: {
            data: {
              reason: 'conflicting_params',
              recovery: { hint: expect.stringContaining(`filters.${key}`) },
            },
          },
        });
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it("reports Eurostat's own time-selection conflict as conflicting_params, not invalid_period", async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(
          {
            error: [
              {
                status: 400,
                id: 400,
                label:
                  "'TIME' parameter, 'TIME_PERIOD' parameter, 'lastTimePeriod' parameter and 'sinceTimePeriod' parameter cannot be set at the same time. Please choose one or the other.",
              },
            ],
          },
          400,
        ),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        filters: { geo: ['DE'], time: ['2020'], time_period: ['2021'] },
      });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'conflicting_params' } },
      });
      const hint = (result.structuredContent as { error: { data: { recovery: { hint: string } } } })
        .error.data.recovery.hint;
      expect(hint).toMatch(/one time selection/);
      expect(hint).not.toContain('YYYY');
      expect(hint).not.toContain('geo_level');
      // The label already ends in a period; the message adds no second one.
      const message = (result.structuredContent as { error: { message: string } }).error.message;
      expect(message).toContain('Please choose one or the other.');
      expect(message).not.toContain('..');
      expect(contentText(result as never)).not.toContain('other..');
    });

    it("gives Eurostat's geo/geoLevel refusal the generic conflicting_params hint, not the time one", async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(
          {
            error: [
              {
                status: 400,
                id: 400,
                label:
                  "'geo' parameter and 'geoLevel' parameter cannot be set at the same time. Please choose one or the other.",
              },
            ],
          },
          400,
        ),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        filters: { unit: ['CP_MEUR'] },
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'conflicting_params' } },
      });
      const hint = (result.structuredContent as { error: { data: { recovery: { hint: string } } } })
        .error.data.recovery.hint;
      expect(hint).toContain('filters.geo or geo_level');
      expect(hint).not.toMatch(/one time selection/);
      expect(contentText(result as never)).toContain(`Recovery: ${hint}`);
    });
  });
});

describe('hoistDimensions (#86)', () => {
  type Row = Record<string, string>;
  const cell = (row: Row, dimension: string) =>
    dimension in row ? `${dimension}=${row[dimension]}` : undefined;
  const same = (dimension: string, rows: number) =>
    Array.from({ length: rows }, (_, i) => ({ [dimension]: '1', row: String(i) }));

  for (const [label, rows, hoisted, header] of [
    ['no rows', [], [], undefined],
    ['one row, however constant', [{ a: '1', b: '2', c: '3' }], [], undefined],
    ['rows that differ on every dimension', [{ a: '1' }, { a: '2' }], [], undefined],
    [
      'the constant dimensions, in dimension order',
      [
        { c: '3', a: '1', b: '1' },
        { c: '3', a: '1', b: '2' },
      ],
      ['a', 'c'],
      '**Same in all 2 rows shown:** a=1 | c=3',
    ],
    ['nothing that differs only on the last row', [...same('a', 3), { a: '2' }], [], undefined],
    ['nothing that is absent from the last row', [...same('a', 3), {}], [], undefined],
    ['nothing that is absent from the first row', [{}, ...same('a', 3)], [], undefined],
    ['nothing that is absent from every row', [{}, {}, {}], [], undefined],
  ] as Array<[string, Row[], string[], string | undefined]>) {
    it(`hoists ${label}`, () => {
      const result = hoistDimensions(rows, ['a', 'b', 'c'], cell);
      expect(result.header).toBe(header);
      expect([...result.hoisted]).toEqual(hoisted);
    });
  }
});

// ---------------------------------------------------------------------------
// Single-valued dimensions in content[] (#86). The rebuild parses the rendered text
// back and compares it with structuredContent: format-parity samples one observation
// with no dimensions, so it never reaches the hoisted path.
// ---------------------------------------------------------------------------

describe('eurostatQueryDataset — single-valued dimensions in content[] (#86)', () => {
  type Marker = { code: string; label: string };
  type Observation = {
    confStatus?: Marker;
    dimensions: Record<string, Marker>;
    status?: Marker;
    value: number | null;
    valueText?: string;
  };

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

  const HEADER = /^\*\*Same in all (\d+) rows shown:\*\* (.*)$/;
  const MEASURE =
    /^(\S+)(?: \[valueText "(.*)"\])?(?: \[(?!CONF_STATUS )([^:]+): ([^\]]*)\])?(?: \[CONF_STATUS ([^:]+): ([^\]]*)\])?$/;

  /** `dim=code (label)`, the greedy label keeping nested parentheses whole. */
  const parseCells = (cells: string): Array<readonly [string, Marker]> =>
    cells
      .split(' | ')
      .filter((cell) => cell !== '')
      .map((cell) => {
        const match = /^([^=]+)=(\S+) \((.*)\)$/.exec(cell);
        if (!match) throw new Error(`Unparseable cell: ${cell}`);
        return [match[1] as string, { code: match[2] as string, label: match[3] as string }];
      });

  const headerCells = (text: string): string | undefined =>
    text
      .split('\n')
      .map((line) => HEADER.exec(line))
      .find((match) => match)?.[2];

  const rowLines = (text: string) => text.split('\n').filter((line) => line.includes(' → '));

  /** Everything an observation holds, read back from the header and its row alone. */
  function rebuild(text: string): Observation[] {
    const shared = parseCells(headerCells(text) ?? '');
    return rowLines(text).map((line) => {
      const [cells = '', measure = ''] = line.split(' → ');
      const match = MEASURE.exec(measure);
      if (!match) throw new Error(`Unparseable measure: ${measure}`);
      const [, value, valueText, statusCode, statusLabel, confCode, confLabel] = match;
      return {
        dimensions: Object.fromEntries([...shared, ...parseCells(cells)]),
        value: value === 'N/A' ? null : Number(value),
        ...(valueText !== undefined && { valueText }),
        ...(statusCode !== undefined && {
          status: { code: statusCode, label: statusLabel as string },
        }),
        ...(confCode !== undefined && {
          confStatus: { code: confCode, label: confLabel as string },
        }),
      };
    });
  }

  const rendered = (result: unknown) =>
    (eurostatQueryDataset.format!(result as never) as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('');
  /** The row section: what follows the blank line closing the summary lines. */
  const rows = (text: string) => text.slice(text.indexOf('\n\n') + 2);

  const observation = (cells: Record<string, string>, value: number): Observation => ({
    dimensions: Object.fromEntries(
      Object.entries(cells).map(([dim, code]) => [dim, { code, label: `${code} label` }]),
    ),
    value,
  });
  const payload = (dimensionsUsed: string[], observations: Observation[]) => ({
    ...mockQueryResult,
    dimensionsUsed,
    observations,
    obsCount: observations.length,
    missingObsCount: 0,
  });

  describe('what stays as it was', () => {
    it('renders a single observation with every dimension on its row', () => {
      const text = rendered({
        ...mockQueryResult,
        observations: [makeObs('DE', 'Germany', '2023', 3_867_000)],
        obsCount: 1,
        missingObsCount: 0,
      });
      expect(rows(text)).toBe(
        'unit=CP_MEUR (Current prices, million euro) | na_item=B1GQ (Gross domestic product at market prices) | geo=DE (Germany) | time=2023 (2023) → 3867000',
      );
    });

    it('renders a result with no single-valued dimension with every dimension on each row', () => {
      const text = rendered(
        payload(
          ['geo', 'time'],
          [
            observation({ geo: 'DE', time: '2022' }, 1),
            observation({ geo: 'FR', time: '2023' }, 2),
          ],
        ),
      );
      expect(rows(text)).toBe(
        'geo=DE (DE label) | time=2022 (2022 label) → 1\ngeo=FR (FR label) | time=2023 (2023 label) → 2',
      );
    });

    it('renders an empty preview with no header', () => {
      expect(rendered(payload(['geo', 'time'], []))).not.toContain('rows shown');
    });
  });

  const REAL_CALLS = [
    {
      name: 'urb_cpop1, cities varying and estimates flagged',
      fixture: 'urb-cpop1-de1001v-last1-excerpt',
      input: {
        dataset_code: 'urb_cpop1',
        filters: { indic_ur: ['DE1001V'] },
        last_n_periods: 1,
        preview_limit: 500,
      },
      count: 9,
      hoisted: ['freq', 'indic_ur', 'time'],
      varying: ['cities'],
      sha256: '5099167db84176c5f5fbfa5a18917f91bbb990bab8af1320663d458a7ac9a2f6',
    },
    {
      name: 'DS-059358, text values and confidential cells',
      fixture: 'comext/ds-059358-de-2022',
      input: {
        dataset_code: 'DS-059358',
        filters: { reporter: ['DE'] },
        since_period: '2022',
        until_period: '2022',
        preview_limit: 500,
      },
      count: 58,
      hoisted: ['freq', 'reporter', 'time'],
      varying: ['product', 'indicators'],
      sha256: '59b15d2d6407f5a4a084e15383c6a9acc134e76c05e18faeeafe5483cb2f68d6',
    },
    {
      name: 'DS-045409, a hoisted label with nested parentheses',
      fixture: 'comext/ds-045409-eu27-us-total-2024-01-02',
      input: {
        dataset_code: 'DS-045409',
        filters: { partner: ['US'] },
        since_period: '2024-01',
        until_period: '2024-02',
      },
      count: 2,
      hoisted: ['freq', 'reporter', 'partner', 'product', 'flow', 'indicators'],
      varying: ['time'],
      sha256: 'f90b65213910d4237cb48d4cae992f362648e5e7a766816d2cd479970feef8ee',
    },
  ];

  for (const { name, fixture, input, count, hoisted, varying, sha256 } of REAL_CALLS) {
    describe(name, () => {
      const call = async () => {
        fetchMock.mockImplementation(async () => jsonReply(envelope(fixture)));
        const result = await runToolContract(eurostatQueryDataset, input);
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as { observations: Observation[] };
        expect(structured.observations).toHaveLength(count);
        return { structured, text: contentText(result) };
      };

      it('rebuilds every observation from the header and its row', async () => {
        const { structured, text } = await call();
        expect(rebuild(text)).toStrictEqual(structured.observations);
        expect(rebuild(rendered(structured))).toStrictEqual(structured.observations);
      });

      it('lists the single-valued dimensions once and leaves the rest on each row', async () => {
        const { text } = await call();
        expect(parseCells(headerCells(text) ?? '').map(([dim]) => dim)).toEqual(hoisted);
        expect(text).toContain(`**Same in all ${count} rows shown:**`);
        expect(rowLines(text)).toHaveLength(count);
        for (const line of rowLines(text)) {
          const [cells = ''] = line.split(' → ');
          expect(parseCells(cells).map(([dim]) => dim)).toEqual(varying);
        }
      });

      it('leaves structuredContent untouched', async () => {
        const { structured } = await call();
        const digest = createHash('sha256').update(JSON.stringify(structured.observations));
        expect(digest.digest('hex')).toBe(sha256);
      });
    });
  }

  it('carries cities alone on each urb_cpop1 row, with the shared dimensions fully labelled above', async () => {
    fetchMock.mockImplementation(async () =>
      jsonReply(envelope('urb-cpop1-de1001v-last1-excerpt')),
    );
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'urb_cpop1',
      filters: { indic_ur: ['DE1001V'] },
      last_n_periods: 1,
      preview_limit: 500,
    });
    const text = contentText(result);
    expect(text).toContain(
      '**Same in all 9 rows shown:** freq=A (Annual) | indic_ur=DE1001V (Population on the 1st of January, total) | time=2025 (2025)\n\ncities=BE (Belgium) → 11883495\n',
    );
    expect(text).toContain('cities=BE001C (Bruxelles/Brussel (greater city)) → 1271709\n');
    expect(text).toContain('cities=SE015C (Växjö) → 98335 [e: estimated]');
    expect(headerCells(text)).not.toContain('→');
  });

  it('keeps a text value and a confidentiality marker on their rows', async () => {
    fetchMock.mockImplementation(async () => jsonReply(envelope('comext/ds-059358-de-2022')));
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'DS-059358',
      filters: { reporter: ['DE'] },
      since_period: '2022',
      until_period: '2022',
      preview_limit: 500,
    });
    const text = contentText(result);
    expect(text).toMatch(/\| indicators=QNTUNIT \(Quantity unit\) → N\/A \[valueText "KG"\]\n/);
    expect(text).toMatch(/\| indicators=PVALFLAG \(.*\) → N\/A \[CONF_STATUS C: confidential\]\n/);
  });

  it('rebuilds a nested-parenthesis label on a row as well as in the header', () => {
    const us = "United States (incl. Navassa Island (part of 'UM') from 1995 -> 2000)";
    const fr =
      "France (incl. Saint Barthélemy 'BL' -> 2012; incl. French Guiana 'GF', Guadeloupe 'GP', Martinique 'MQ', Réunion 'RE' from 1997; incl. Mayotte 'YT' from 2014)";
    const reporter = {
      code: 'DE',
      label: "Germany (incl. German Democratic Republic 'DD' from 1991)",
    };
    const observations: Observation[] = [
      { dimensions: { reporter, partner: { code: 'US', label: us } }, value: 1 },
      {
        dimensions: { reporter, partner: { code: 'FR', label: fr } },
        value: null,
        confStatus: { code: 'C', label: 'confidential' },
      },
    ];
    const text = rendered(payload(['reporter', 'partner'], observations));
    expect(headerCells(text)).toBe(`reporter=DE (${reporter.label})`);
    expect(rebuild(text)).toStrictEqual(observations);
  });

  it('hoists a dimension the preview shows one value of, stating it only of the rows shown', async () => {
    fetchMock.mockImplementation(async () => jsonReply(envelope('comext/ds-059358-de-2022')));
    const call = async (preview_limit: number) =>
      contentText(
        await runToolContract(eurostatQueryDataset, {
          dataset_code: 'DS-059358',
          filters: { reporter: ['DE'] },
          since_period: '2022',
          until_period: '2022',
          preview_limit,
        }),
      );

    const whole = await call(500);
    expect(headerCells(whole)).not.toContain('product=');

    const preview = await call(3);
    expect(preview).toContain('**Inline preview:** first 3 of 58 matched rows');
    const named = preview.split('\n').filter((line) => line.includes('product=20143420'));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/^\*\*Same in all 3 rows shown:\*\* .*product=20143420 \(/);
  });

  it('compares every row of a full 500-row preview, down to the last', () => {
    const full = Array.from({ length: 500 }, (_, i) => makeObs(`G${i}`, `Country ${i}`, '2023', i));
    const render = (observations: typeof full) =>
      rendered({ ...mockQueryResult, observations, obsCount: 900, missingObsCount: 0 });

    const text = render(full);
    expect(text).toContain('**Same in all 500 rows shown:** unit=CP_MEUR');
    expect(rebuild(text)).toStrictEqual(JSON.parse(JSON.stringify(full)));

    const lastDiffers = render([
      ...full.slice(0, 499),
      makeObs('G499', 'Country 499', '2024', 499),
    ]);
    expect(headerCells(lastDiffers)).not.toContain('time=');
    expect(rowLines(lastDiffers).at(-1)).toContain('| time=2024 (2024) → 499');
  });

  it('keeps a dimension on the rows when a later row has no value for it', () => {
    const lacking = makeObs('IT', 'Italy', '2023', 3);
    const { na_item: _, ...dimensions } = lacking.dimensions;
    const text = rendered({
      ...mockQueryResult,
      observations: [
        makeObs('DE', 'Germany', '2023', 1),
        makeObs('FR', 'France', '2023', 2),
        { ...lacking, dimensions },
      ],
    });
    expect(headerCells(text)).toBe(
      'unit=CP_MEUR (Current prices, million euro) | time=2023 (2023)',
    );
    expect(rows(text).split('\n').slice(-3)).toEqual([
      'na_item=B1GQ (Gross domestic product at market prices) | geo=DE (Germany) → 1',
      'na_item=B1GQ (Gross domestic product at market prices) | geo=FR (France) → 2',
      'na_item=? (?) | geo=IT (Italy) → 3',
    ]);
  });

  it('never states a dimension no row has a value for', () => {
    const text = rendered(
      payload(['geo', 'age'], [observation({ geo: 'DE' }, 1), observation({ geo: 'FR' }, 2)]),
    );
    expect(headerCells(text)).toBeUndefined();
    expect(rows(text)).toBe('geo=DE (DE label) | age=? (?) → 1\ngeo=FR (FR label) | age=? (?) → 2');
  });

  it('keeps a code on the rows when it carries two labels', () => {
    const relabelled = observation({ unit: 'PC', geo: 'FR' }, 2);
    relabelled.dimensions.unit = { code: 'PC', label: 'Percentage of total' };
    const observations = [observation({ unit: 'PC', geo: 'DE' }, 1), relabelled];
    const text = rendered(payload(['unit', 'geo'], observations));
    expect(headerCells(text)).toBeUndefined();
    expect(rebuild(text)).toStrictEqual(observations);
  });
});

describe('eurostatQueryDataset — too-large refusal hint with blank filter values (#61)', () => {
  it('counts a dimension whose values are all blank as unfiltered', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('async response'), { data: { reason: 'async_response' } }),
        ),
      getDimensionOrder: vi.fn().mockResolvedValue(['freq', 'unit', 'na_item', 'geo']),
    } as never);
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      filters: { unit: ['CP_MEUR'], geo: ['', '  '] },
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'async_response',
          recovery: { hint: expect.stringContaining('Filter on freq, na_item, geo —') },
        },
      },
    });
  });
});

describe('eurostatQueryDataset — an unavailable Statistics API (#71)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
    setCanvas(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const errorOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { error: { code: number; data: Record<string, unknown> } }).error;

  /** Run the call past the 1 s / 2 s / 4 s backoff (plus jitter) without waiting it out. */
  const callSettled = async () => {
    const pending = runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      filters: { geo: ['DE'] },
      last_n_periods: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    return pending;
  };

  it('fails a Statistics API answering 503 on every attempt as a retryable upstream_fault on both surfaces', async () => {
    fetchMock.mockImplementation(
      async () => new Response('Service Unavailable', { status: 503, statusText: 'Unavailable' }),
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
    const text = contentText(result as never);
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('reason upstream_fault · retryable');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('fails an unreachable host the same way', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await callSettled();
    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
    expect((error.data.recovery as { hint: string }).hint).toContain('could not be reached');
    expect(contentText(result as never)).toContain('reason upstream_fault · retryable');
  });

  it('reports a 501 as an upstream_fault that is not retryable', async () => {
    fetchMock.mockImplementation(
      async () => new Response('Not Implemented', { status: 501, statusText: 'Not Implemented' }),
    );
    const result = await callSettled();
    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'upstream_fault', retryable: false });
    expect(contentText(result as never)).toContain('reason upstream_fault · not retryable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a cancelled call as a cancellation, not an outage', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      return new Response('Service Unavailable', { status: 503 });
    });
    /**
     * The handler, not runToolContract: the contract runner reports anything thrown after
     * the abort as RequestCancelled, so only the handler's own throw shows whether the
     * cancellation was kept or turned into an outage.
     */
    const outcome = Promise.resolve(
      eurostatQueryDataset.handler(
        eurostatQueryDataset.input.parse({
          dataset_code: 'nama_10_gdp',
          filters: { geo: ['DE'] },
          last_n_periods: 1,
        }),
        createMockContext({ signal: controller.signal, errors: eurostatQueryDataset.errors }),
      ),
    ).then(
      () => undefined,
      (error: unknown) => error as { data?: { reason?: string; status?: number } },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await outcome;
    expect(error?.data).toMatchObject({ status: 503 });
    expect(error?.data?.reason).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('eurostatQueryDataset — what Eurostat keeps of a period range (#84, #88)', () => {
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

  const NAMA = { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE'] };
  const NRG = {
    geo: ['DE'],
    nrg_cons: ['KWH2500-4999'],
    tax: ['I_TAX'],
    currency: ['EUR'],
  };
  const WEEKLY = { sex: ['T'], unit: ['NR'], geo: ['DE'] };
  const USD = { statinfo: ['AVG'], unit: ['NAC'], currency: ['USD'] };
  const DS = {
    reporter: ['DE'],
    partner: ['FR'],
    product: ['TOTAL'],
    flow: ['1'],
    indicators: ['VALUE_IN_EUROS'],
  };

  const query = (
    fixture: string,
    dataset_code: string,
    filters: Record<string, readonly string[]>,
    since_period: string | undefined,
    until_period: string | undefined,
  ) => {
    fetchMock.mockImplementationOnce(async () => jsonReply(envelope(fixture)));
    return runToolContract(eurostatQueryDataset, {
      dataset_code,
      filters,
      preview_limit: 500, // the weekly fixture's 104 rows would otherwise add a preview notice
      ...(since_period !== undefined && { since_period }),
      ...(until_period !== undefined && { until_period }),
    } as never);
  };
  const requested = (): URL => new URL(String(fetchMock.mock.calls[0]?.[0]));
  const noticeOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { notice?: string }).notice;
  const failureOf = (result: { structuredContent?: unknown }) => {
    const { error } = result.structuredContent as {
      error: { data: { reason: string; recovery: { hint: string } }; message: string };
    };
    return { hint: error.data.recovery.hint, message: error.message, reason: error.data.reason };
  };
  const inside = (literal: string, label: string, period: string) =>
    `since_period "${literal}" falls inside ${label} period ${period}, which Eurostat excludes: it keeps only periods wholly inside the range. since_period "${period}" includes that period if this slice has it.`;

  describe('a bound that falls inside a period, on a success', () => {
    for (const [label, fixture, dataset, filters, since, until, obsCount, notice] of [
      [
        'annual data (step 1)',
        'nama-10-gdp-de-2022-06-to-2024',
        'nama_10_gdp',
        NAMA,
        '2022-06',
        '2024',
        2,
        inside('2022-06', 'annual', '2022'),
      ],
      [
        'semester data (step 4)',
        'nrg-pc-204-de-2022-06-to-2023',
        'nrg_pc_204',
        NRG,
        '2022-06',
        '2023',
        3,
        inside('2022-06', 'semester', '2022-S1'),
      ],
      [
        'a coarser bound on weekly data',
        'demo-r-mwk-ts-de-2022-to-2023',
        'demo_r_mwk_ts',
        WEEKLY,
        '2022',
        '2023',
        104,
        inside('2022', 'weekly', '2021-W52'),
      ],
      [
        'annual only on mixed frequencies',
        'comext/ds-045409-de-fr-2023-06-to-2024',
        'DS-045409',
        DS,
        '2023-06',
        '2024',
        20,
        inside('2023-06', 'annual', '2023'),
      ],
      [
        'an annual period time does not show',
        'comext/ds-045409-de-fr-2023-06-to-2023-12',
        'DS-045409',
        DS,
        '2023-06',
        '2023-12',
        7,
        inside('2023-06', 'annual', '2023'),
      ],
    ] as const) {
      it(`names it on ${label}, on both surfaces and with the same rows`, async () => {
        const result = await query(fixture, dataset, filters, since, until);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ obsCount });
        expect(noticeOf(result)).toBe(notice);
        expect(contentText(result as never)).toContain(notice);
        expect(requested().searchParams.get('sinceTimePeriod')).toBe(since);
        expect(requested().searchParams.get('untilTimePeriod')).toBe(until);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    }

    for (const [label, fixture, dataset, filters, since, until] of [
      ['a year on annual data', 'nama-10-gdp-de-2022', 'nama_10_gdp', NAMA, '2022', '2022'],
      [
        'a month starting a semester',
        'nrg-pc-204-de-2022-01-to-2023',
        'nrg_pc_204',
        NRG,
        '2022-01',
        '2023',
      ],
      [
        'a period past the reported coverage',
        'nama-10-gdp-de-2024-to-2031-06',
        'nama_10_gdp',
        NAMA,
        '2024',
        '2031-06',
      ],
    ] as const) {
      it(`stays silent for ${label}`, async () => {
        const result = await query(fixture, dataset, filters, since, until);
        expect(result.isError).not.toBe(true);
        expect(noticeOf(result)).toBeUndefined();
        expect(contentText(result as never)).not.toContain('falls inside');
      });
    }

    it('quotes the literal as the caller sent it, trimmed', async () => {
      const result = await query(
        'nama-10-gdp-de-2022-06-to-2024',
        'nama_10_gdp',
        NAMA,
        ' 2022-Q02 ',
        '2024',
      );
      expect(requested().searchParams.get('sinceTimePeriod')).toBe('2022-Q2');
      expect(noticeOf(result)).toBe(inside('2022-Q02', 'annual', '2022'));
    });

    it('asks for both bounds when both fall inside the one period', async () => {
      const result = await query(
        'comext/ds-045409-de-fr-2023-06-to-2023-12',
        'DS-045409',
        DS,
        '2023-06',
        '2023-08',
      );
      expect(noticeOf(result)).toBe(
        'since_period "2023-06" and until_period "2023-08" fall inside annual period 2023, which Eurostat excludes: it keeps only periods wholly inside the range. since_period "2023" and until_period "2023" together include that period if this slice has it.',
      );
    });

    it('collects the notice with the others rather than replacing them', async () => {
      const result = await query(
        'nama-10-gdp-de-2022-06-to-2024',
        'nama_10_gdp',
        { ...NAMA, geo: ['DE', 'QQ'] },
        '2022-06',
        '2024',
      );
      expect(noticeOf(result)).toContain(inside('2022-06', 'annual', '2022'));
      expect(noticeOf(result)).toContain('geo=[QQ]');
    });
  });

  describe('a time dimension that comes back empty', () => {
    const noWhole = (dataset: string, span: string | undefined, label: string) =>
      `No observations matched. The requested period range ${span ? `overlaps ${span} but ` : ''}holds no whole ${label} period of "${dataset}": Eurostat keeps only periods wholly inside the range.`;

    for (const [label, since, until, bounds] of [
      [
        'each bound alone selects one (step 2)',
        '2022-06',
        '2023-06',
        'since_period "2022" or until_period "2023"',
      ],
      ['the since bound selects one', '2020-06', '2020', 'since_period "2020"'],
      ['the last covered period', '2025-06', '2031', 'since_period "2025"'],
      ['the first covered period', '1974-06', '1975-06', 'until_period "1975"'],
      [
        'neither alone selects one',
        '2022-06',
        '2022-06',
        'since_period "2022" and until_period "2022"',
      ],
      ['a since bound with no until', '2025-06', undefined, 'since_period "2025"'],
      ['an until bound with no since', undefined, '1975-06', 'until_period "1975"'],
    ] as const) {
      it(`holds no whole period: ${label}`, async () => {
        const result = await query('nama-10-gdp-de-no-period', 'nama_10_gdp', NAMA, since, until);
        const failure = failureOf(result);
        expect(failure.reason).toBe('no_results');
        expect(failure.message).toBe(noWhole('nama_10_gdp', '1975 – 2025', 'annual'));
        expect(failure.hint).toBe(`Set ${bounds} to select a whole period.`);
        const text = contentText(result as never);
        expect(text).toContain(failure.message);
        expect(text).toContain(failure.hint);
      });
    }

    it('names the finest frequency on a dataset that reports no coverage', async () => {
      const failure = failureOf(
        await query(
          'comext/ds-045409-de-fr-no-period',
          'DS-045409',
          DS,
          '2023-06-10',
          '2023-06-20',
        ),
      );
      expect(failure.message).toBe(noWhole('DS-045409', undefined, 'monthly'));
      expect(failure.hint).toBe(
        'Set since_period "2023-06" and until_period "2023-06" to select a whole period.',
      );
    });

    for (const [since, until] of [
      ['2030', '2031'],
      ['1960', '1970'],
    ] as const) {
      it(`keeps the outside-coverage message for ${since} to ${until}`, async () => {
        const failure = failureOf(
          await query('nama-10-gdp-de-no-period', 'nama_10_gdp', NAMA, since, until),
        );
        expect(failure.message).toBe(
          'No observations matched. The requested period range selects no period of "nama_10_gdp", whose data runs 1975 – 2025.',
        );
        expect(failure.hint).toBe('Set since_period/until_period inside 1975 – 2025.');
      });
    }

    for (const [label, fixture, dataset, filters, since, until, span] of [
      [
        'a weekend',
        'ert-bil-eur-d-usd-no-period',
        'ert_bil_eur_d',
        USD,
        '2022-06-18',
        '2022-06-19',
        '1974-07-01 – 2026-10-31',
      ],
      [
        'a survey gap',
        'earn-ses-annual-de-2020',
        'earn_ses_annual',
        { geo: ['DE'] },
        '2020',
        '2020',
        '2002 – 2022',
      ],
      [
        'a survey gap wholly inside a range whose bounds both fall inside a period',
        'earn-ses-annual-de-2020',
        'earn_ses_annual',
        { geo: ['DE'] },
        '2019-06',
        '2021-06',
        '2002 – 2022',
      ],
      [
        'a dataset reporting no coverage',
        'comext/ds-045409-de-fr-no-period',
        'DS-045409',
        DS,
        '2031',
        '2032',
        undefined,
      ],
    ] as const) {
      it(`holds no published period: ${label}`, async () => {
        const result = await query(fixture, dataset, filters, since, until);
        const failure = failureOf(result);
        expect(failure.reason).toBe('no_results');
        expect(failure.message).toBe(
          `No observations matched. The requested period range ${span ? `overlaps ${span} but ` : ''}holds no published period of "${dataset}".`,
        );
        expect(failure.hint).toBe(
          `List the periods "${dataset}" publishes with eurostat_get_dimension_values, dimension "time", then set since_period/until_period on one of them.`,
        );
        expect(`${failure.message} ${failure.hint}`).not.toMatch(/(since|until)_period "/);
        expect(contentText(result as never)).toContain(failure.hint);
      });
    }

    it('keeps an unmatched filter value beside the period diagnosis', async () => {
      const body = envelope('nama-10-gdp-de-no-period') as {
        dimension: { geo: { category: { index: Record<string, number> } } };
      };
      body.dimension.geo.category.index = {};
      fetchMock.mockImplementation(noStructure).mockImplementationOnce(async () => jsonReply(body));
      const failure = failureOf(
        await runToolContract(eurostatQueryDataset, {
          dataset_code: 'nama_10_gdp',
          filters: { ...NAMA, geo: ['QQ'] },
          since_period: '2022-06',
          until_period: '2023-06',
        }),
      );
      expect(failure.message).toContain('geo=[QQ]');
      expect(failure.message).toContain('holds no whole annual period');
      expect(failure.hint).toContain('eurostat_get_dimension_values');
      expect(failure.hint).toContain('since_period "2022"');
    });

    it('leaves the bare NO_RESULTS answer with its generic message and hint', async () => {
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
      const failure = failureOf(
        await runToolContract(eurostatQueryDataset, {
          dataset_code: 'nama_10_gdp',
          filters: NAMA,
          since_period: '2022-06',
          until_period: '2023-06',
        }),
      );
      expect(failure.reason).toBe('no_results');
      expect(failure.hint).toContain('an unmatched value and an out-of-coverage range');
    });
  });

  describe('a one-day range', () => {
    for (const [since, until] of [
      ['2022-06-15', '2022-06-15'],
      ['2022-D166', '2022-D166'],
      ['2022-06-15', '2022-D166'],
    ] as const) {
      it(`returns the one observation for ${since} to ${until} (#88 step 1)`, async () => {
        const result = await query(
          'ert-bil-eur-d-usd-2022-06-15',
          'ert_bil_eur_d',
          USD,
          since,
          until,
        );
        expect(requested().searchParams.get('time')).toBe('2022-06-15');
        expect(requested().searchParams.has('sinceTimePeriod')).toBe(false);
        expect(requested().searchParams.has('untilTimePeriod')).toBe(false);
        expect(result.structuredContent).toMatchObject({
          obsCount: 1,
          timeRange: { start: '2022-06-15', end: '2022-06-15' },
        });
        expect(noticeOf(result)).toBeUndefined();
      });
    }

    it('echoes the bounds as the caller set them', async () => {
      const result = await query(
        'ert-bil-eur-d-usd-2022-06-15',
        'ert_bil_eur_d',
        USD,
        '2022-D166',
        '2022-06-15',
      );
      expect(result.structuredContent).toMatchObject({
        appliedFilters: { sincePeriod: '2022-D166', untilPeriod: '2022-06-15', filters: USD },
      });
    });

    it('sends one day of annual data as time and names both bounds (#88 step 3)', async () => {
      const result = await query(
        'nama-10-gdp-de-no-period',
        'nama_10_gdp',
        NAMA,
        '2022-06-15',
        '2022-06-15',
      );
      expect(requested().searchParams.get('time')).toBe('2022-06-15');
      const failure = failureOf(result);
      expect(failure.reason).toBe('no_results');
      expect(failure.hint).toBe(
        'Set since_period "2022" and until_period "2022" to select a whole period.',
      );
    });

    for (const day of ['2022-06-18', '2022-06-19']) {
      it(`takes the no-published-period diagnosis for ${day}, a day with no rate`, async () => {
        const failure = failureOf(
          await query('ert-bil-eur-d-usd-no-period', 'ert_bil_eur_d', USD, day, day),
        );
        expect(failure.reason).toBe('no_results');
        expect(failure.message).toContain('holds no published period');
      });
    }

    it('leaves two consecutive days as the bounds (#88 step 4)', async () => {
      await query('ert-bil-eur-d-usd-2022-06-15', 'ert_bil_eur_d', USD, '2022-06-15', '2022-06-16');
      expect(requested().searchParams.get('sinceTimePeriod')).toBe('2022-06-15');
      expect(requested().searchParams.get('untilTimePeriod')).toBe('2022-06-16');
      expect(requested().searchParams.has('time')).toBe(false);
    });
  });

  describe('the descriptions', () => {
    const since = eurostatQueryDataset.input.shape.since_period.description ?? '';
    const until = eurostatQueryDataset.input.shape.until_period.description ?? '';

    it('state the wholly-inside rule', () => {
      expect(since).toContain('Eurostat keeps only periods wholly inside the range');
      expect(until).toContain('falls inside a period');
    });

    it('state how a one-day range is sent', () => {
      expect(since).toMatch(/same day is sent as that one date/);
    });

    it('claim no mapping and offer no range that holds nothing as a working example', () => {
      for (const description of [since, until]) {
        expect(description).not.toMatch(/mapped onto/);
        expect(description).not.toMatch(/"2020-06" to "2020"/);
        expect(description).not.toMatch(/works on annual data/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// geo_level behind a bare NO_RESULTS (#85). The real service over captured replies:
// the reply's shape decides the path, so a fake that served any shape would prove
// nothing. The deadline itself is tabled in narrowing-advice.test.ts.
// ---------------------------------------------------------------------------

describe('eurostatQueryDataset — geo_level behind a bare NO_RESULTS (#85)', () => {
  const BARE = envelope('no-results-reply');
  const URB = { indic_ur: ['DE1001V'] };
  const NAMA = { unit: ['CP_MEUR'], na_item: ['B1GQ'] };
  const DS = {
    partner: ['FR'],
    product: ['TOTAL'],
    flow: ['1'],
    indicators: ['VALUE_IN_EUROS'],
    freq: ['A'],
  };
  const DROP_FOR_GEO_CODES =
    'Drop geo_level. If the other filters and the period range match anything, the same query then returns the "geo" codes this slice carries, and they work in filters.geo.';

  let fetchMock: ReturnType<typeof vi.fn>;

  const structure = (name: string) => async () =>
    new Response(readFileSync(new URL(`../fixtures/${name}.xml`, import.meta.url), 'utf8'));

  /** The Statistics API answers `reply`; the structure endpoint answers `onStructure`. */
  const serve = (
    reply: object,
    onStructure: (input: unknown, init?: RequestInit) => Promise<Response> = unmockedFetch,
  ) =>
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      new URL(String(input)).pathname.includes('/sdmx/2.1/datastructure/')
        ? onStructure(input, init)
        : jsonReply(reply),
    );

  const structureReads = () =>
    fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.includes('/sdmx/2.1/datastructure/'),
    ).length;

  const errorOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { error: { code: number; data: Record<string, unknown> } }).error;
  const hintOf = (result: { structuredContent?: unknown }) =>
    (errorOf(result).data.recovery as { hint: string }).hint;

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

  it.each([
    {
      name: 'urb_cpop1, keyed on cities',
      input: {
        dataset_code: 'urb_cpop1',
        filters: URB,
        last_n_periods: 1,
        geo_level: 'nuts2' as const,
      },
      fixture: 'urb-cpop1-datastructure',
      level: 'nuts2',
      listed: 'freq, indic_ur, cities',
    },
    {
      name: 'DS-045409, keyed on reporter and partner',
      input: {
        dataset_code: 'DS-045409',
        filters: DS,
        since_period: '2024',
        until_period: '2024',
        geo_level: 'country' as const,
      },
      fixture: 'comext/ds-045409-datastructure',
      level: 'country',
      listed: 'freq, reporter, partner, product, flow, indicators',
    },
  ])('lists the dimensions of $name and routes to their codes', async (row) => {
    serve(BARE, structure(row.fixture));
    const result = await runToolContract(eurostatQueryDataset, row.input);

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
    const message = `No observations matched. geo_level "${row.level}" likely selects no code for this query. "${row.input.dataset_code}" has no "geo" dimension; its dimensions are ${row.listed}.`;
    const hint = `Drop geo_level. To select geography, filter whichever of ${row.listed} holds it, with codes from eurostat_get_dimension_values.`;
    expect(hintOf(result)).toBe(hint);
    const text = contentText(result as never);
    expect(text).toContain(message);
    expect(text).toContain(`Recovery: ${hint}`);
    expect(structureReads()).toBe(1);
  });

  it.each([
    ['last_n_periods', { last_n_periods: 1 }],
    ['a range inside coverage', { since_period: '2022', until_period: '2023' }],
    ['a range that holds no whole period', { since_period: '2022-06', until_period: '2023-06' }],
    ['a range past coverage', { since_period: '2030', until_period: '2031' }],
  ])('says to drop geo_level on a dataset with geo, over %s', async (_name, periods) => {
    serve(BARE, structure('nama-10-gdp-datastructure'));
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      filters: NAMA,
      geo_level: 'nuts3',
      ...periods,
    });

    expect(errorOf(result)).toMatchObject({ data: { reason: 'no_results' } });
    expect(hintOf(result)).toBe(DROP_FOR_GEO_CODES);
    const text = contentText(result as never);
    expect(text).toContain(
      'No observations matched. geo_level "nuts3" likely selects no code for this query.',
    );
    expect(text).toContain(`Recovery: ${DROP_FOR_GEO_CODES}`);
    expect(text).not.toContain('freq, unit, na_item');
    expect(text).not.toContain('eurostat_get_dimension_values');
    expect(structureReads()).toBe(1);
  });

  it('lets the envelope diagnosis stand alone, with no geo_level sentence and no structure read', async () => {
    serve(envelope('nama-10-gdp-country-level-2022-06-to-2023-06'));
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      filters: NAMA,
      geo_level: 'country',
      since_period: '2022-06',
      until_period: '2023-06',
    });

    expect(errorOf(result)).toMatchObject({ data: { reason: 'no_results' } });
    expect(hintOf(result)).toBe(
      'Set since_period "2022" or until_period "2023" to select a whole period.',
    );
    const text = contentText(result as never);
    expect(text).toContain('holds no whole annual period of "nama_10_gdp"');
    expect(text).not.toContain('geo_level');
    expect(structureReads()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still returns what a level selects on a dataset without geo, with no structure read', async () => {
    serve(envelope('urb-cpop1-de1001v-country-last1'));
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'urb_cpop1',
      filters: URB,
      last_n_periods: 1,
      geo_level: 'country',
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      obsCount: 5,
      dimensionsUsed: ['freq', 'indic_ur', 'cities', 'time'],
    });
    expect(structureReads()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('when the structure read does not answer', () => {
    const SENTENCE =
      'No observations matched. geo_level "nuts2" likely selects no code for this query.';
    const DROP = 'Drop geo_level and send the query again.';
    const input = {
      dataset_code: 'urb_cpop1',
      filters: URB,
      last_n_periods: 1,
      geo_level: 'nuts2' as const,
    };
    /** A request that never answers: it settles only when its signal aborts. */
    const hang = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });

    beforeEach(() => {
      vi.useFakeTimers();
      // Far past the deadline on both, so neither default stall timeout can end a read for it.
      vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
        ...serverConfig.getServerConfig(),
        requestTimeoutMs: 600_000,
        metadataTimeoutMs: 600_000,
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** The sentence stays and the case stays unclaimed: no list, no "has no geo", no route. */
    const expectSentenceAlone = (result: Awaited<ReturnType<typeof runToolContract>>) => {
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_results' },
      });
      expect(hintOf(result)).toBe(DROP);
      const text = contentText(result as never);
      expect(text).toContain(SENTENCE);
      expect(text).toContain(`Recovery: ${DROP}`);
      expect(text).not.toContain('freq, indic_ur, cities');
      expect(text).not.toContain('"geo"');
      expect(text).not.toContain('eurostat_get_dimension_values');
    };

    it('keeps the sentence when the read fails, after its 3 attempts', async () => {
      serve(BARE, async () => new Response('Service Unavailable', { status: 503 }));
      const pending = runToolContract(eurostatQueryDataset, input);
      await vi.advanceTimersByTimeAsync(5_000);
      expectSentenceAlone(await pending);
      expect(structureReads()).toBe(3);
    });

    it('keeps the sentence when the read hangs, at 5 s', async () => {
      serve(BARE, hang);
      let settled = false;
      const pending = runToolContract(eurostatQueryDataset, input).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expectSentenceAlone(await pending);
      expect(structureReads()).toBe(1);
    });

    it('reaches the caller as a cancellation when the call is cancelled during the read', async () => {
      serve(BARE, hang);
      const controller = new AbortController();
      /**
       * The handler, not runToolContract: the contract runner reports anything thrown after
       * the abort as RequestCancelled, so only the handler's own throw shows what the
       * catch did with it.
       */
      const outcome = Promise.resolve(
        eurostatQueryDataset.handler(
          eurostatQueryDataset.input.parse(input),
          createMockContext({ signal: controller.signal, errors: eurostatQueryDataset.errors }),
        ),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(structureReads()).toBe(1);
    });

    it('holds a too-large refusal to the same deadline, keeping the refusal', async () => {
      serve({ warning: { status: 413, label: 'ASYNCHRONOUS_RESPONSE' } }, hang);
      let settled = false;
      const pending = runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        filters: NAMA,
      }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const result = await pending;
      expect(errorOf(result)).toMatchObject({ data: { reason: 'async_response' } });
      expect(hintOf(result)).toBe(
        'Query matched too many observations for "nama_10_gdp". Add dimension filters — eurostat_get_dataset_info lists the dimensions of "nama_10_gdp" — or a narrower since_period/until_period range.',
      );
      expect(structureReads()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// A query that outlasts the Statistics API deadline (#98) — the real service with
// fetch stubbed per route and the clock faked, so the 30 s deadline and the 5 s
// structure read run as in production.
// ---------------------------------------------------------------------------

describe('eurostatQueryDataset — a query that outlasts the Statistics API deadline (#98)', () => {
  const STEP_2 = {
    dataset_code: 'DS-045409',
    filters: { freq: ['M'], flow: ['2'], product: ['2204'], indicators: ['VALUE_IN_EUROS'] },
    since_period: '2025-01',
  };
  const REPEAT =
    'Eurostat goes on preparing the extraction after the request is dropped and caches it, so repeat this call in a minute or two.';
  const STEP_2_ROUTE =
    'The bulk endpoint serves the same slice: call eurostat_download_dataset with dataset_code "DS-045409", the same filters and since_period "2025-01".';
  const STEP_2_NARROW =
    'Filter on reporter, partner — the dimensions of "DS-045409" this request left unfiltered — or narrow since_period/until_period.';
  const GENERIC_NARROW = (code: string) =>
    `Add dimension filters — eurostat_get_dataset_info lists the dimensions of "${code}" — or a narrower since_period/until_period range.`;

  let fetchMock: ReturnType<typeof vi.fn>;
  const isStructure = (input: unknown) =>
    new URL(String(input)).pathname.includes('/sdmx/2.1/datastructure/');
  const structureReads = () => fetchMock.mock.calls.filter(([input]) => isStructure(input)).length;
  const fixtureXml = (name: string) => async () =>
    new Response(readFileSync(new URL(`../fixtures/${name}.xml`, import.meta.url), 'utf8'));

  /** A request that never answers: it settles only when its signal aborts. */
  const silent = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  /** A 200 whose headers arrive at once and whose body never ends until the signal aborts. */
  const stalledBody = async (_input: unknown, init?: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"version":"2.0"'));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );

  /** The Statistics API answers with `onQuery`; the structure endpoint with `onStructure`. */
  const serve = (
    onQuery: (input: unknown, init?: RequestInit) => Promise<Response>,
    onStructure: (input: unknown, init?: RequestInit) => Promise<Response>,
  ) =>
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      isStructure(input) ? onStructure(input, init) : onQuery(input, init),
    );

  const errorOf = (result: { structuredContent?: unknown }) =>
    (
      result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      }
    ).error;
  const hintOf = (result: { structuredContent?: unknown }) =>
    (errorOf(result).data.recovery as { hint: string }).hint;

  /** Run the call past the 30 s deadline and the 5 s hint read. */
  const settled = async (input: Record<string, unknown>) => {
    const pending = runToolContract(eurostatQueryDataset, input as never);
    await vi.advanceTimersByTimeAsync(40_000);
    return pending;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
    // Presence alone decides the route; nothing is staged on an error.
    setCanvas({} as DataCanvas);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setCanvas(undefined);
  });

  it('declares retry_deadline_exceeded as a Timeout', () => {
    expect(
      eurostatQueryDataset.errors?.find(({ reason }) => reason === 'retry_deadline_exceeded'),
    ).toMatchObject({ code: JsonRpcErrorCode.Timeout });
  });

  it('fails the step-2 query with the repeat, the download route and its open dimensions, on both surfaces', async () => {
    serve(silent, fixtureXml('comext/ds-045409-datastructure'));
    const result = await settled(STEP_2);

    const error = errorOf(result);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message:
        'Eurostat\'s Statistics API did not complete a query of dataset "DS-045409" within its 30,000 ms deadline (1 attempt).',
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 30_000, retryAttempts: 1 },
    });
    // The fake clock stops the silent request at the deadline, so the elapsed time is the deadline.
    expect(error.data.elapsedMs).toBe(30_000);
    expect(error.message).not.toContain('fetchJsonStat');
    expect(hintOf(result)).toBe(`${REPEAT} ${STEP_2_ROUTE} ${STEP_2_NARROW}`);
    const text = contentText(result as never);
    expect(text).toContain('within its 30,000 ms deadline');
    expect(text).not.toContain('fetchJsonStat');
    expect(text).toContain(`Recovery: ${REPEAT}`);
    expect(text).toContain('call eurostat_download_dataset with dataset_code "`DS-045409`"');
    expect(text).toContain('since_period "`2025-01`"');
    expect(text).toContain('Filter on reporter, partner');
    expect(text).toContain('reason retry_deadline_exceeded');
    expect(structureReads()).toBe(1);
  });

  it('drops the repeat when the headers arrived and the body was still streaming', async () => {
    serve(stalledBody, fixtureXml('comext/ds-045409-datastructure'));
    const result = await settled(STEP_2);
    expect(errorOf(result).data.reason).toBe('retry_deadline_exceeded');
    expect(hintOf(result)).toBe(`${STEP_2_ROUTE} ${STEP_2_NARROW}`);
    expect(contentText(result as never)).not.toContain('minute');
  });

  it('offers no download route without a dataframe canvas', async () => {
    setCanvas(undefined);
    serve(silent, fixtureXml('comext/ds-045409-datastructure'));
    const result = await settled(STEP_2);
    expect(hintOf(result)).toBe(`${REPEAT} ${STEP_2_NARROW}`);
    expect(contentText(result as never)).not.toContain('eurostat_download_dataset');
  });

  it.each([
    [
      1,
      'since_period set to the latest period eurostat_get_dimension_values lists for dimension "time"',
    ],
    [
      6,
      'since_period set to the earliest of the last 6 periods eurostat_get_dimension_values lists for dimension "time"',
    ],
  ])('turns last_n_periods %i into a since_period to look up', async (lastN, period) => {
    serve(silent, fixtureXml('comext/ds-045409-datastructure'));
    const { since_period: _since, ...rest } = STEP_2;
    const result = await settled({ ...rest, last_n_periods: lastN });
    expect(hintOf(result)).toBe(
      `${REPEAT} The bulk endpoint serves the same slice: call eurostat_download_dataset with dataset_code "DS-045409", the same filters and ${period}. ${STEP_2_NARROW}`,
    );
  });

  it('turns geo_level into the filters.geo codes of that level on a dataset with geo', async () => {
    serve(silent, fixtureXml('nama-10-gdp-datastructure'));
    const result = await settled({
      dataset_code: 'nama_10_gdp',
      filters: { unit: ['CP_MEUR'], na_item: ['B1GQ'] },
      geo_level: 'nuts2',
      since_period: '2020',
    });
    expect(hintOf(result)).toBe(
      `${REPEAT} The bulk endpoint serves the same slice: call eurostat_download_dataset with dataset_code "nama_10_gdp", the same filters, filters.geo set to the codes eurostat_get_dimension_values lists for dimension "geo" at geo_level "nuts2" and since_period "2020". Filter on freq — the dimensions of "nama_10_gdp" this request left unfiltered — or narrow since_period/until_period.`,
    );
  });

  it('offers no route for geo_level on a dataset without a geo dimension', async () => {
    serve(silent, fixtureXml('comext/ds-045409-datastructure'));
    const result = await settled({ ...STEP_2, geo_level: 'country' });
    expect(hintOf(result)).toBe(
      `${REPEAT} Filter on reporter, partner — the dimensions of "DS-045409" this request left unfiltered — or narrow since_period/until_period.`,
    );
  });

  it('moves filters.time to since_period and until_period', async () => {
    serve(silent, fixtureXml('nama-10-gdp-datastructure'));
    const result = await settled({
      dataset_code: 'nama_10_gdp',
      filters: { unit: ['CP_MEUR'], geo: ['DE'], time: ['2023', '2021', '2022'] },
    });
    expect(hintOf(result)).toBe(
      `${REPEAT} The bulk endpoint serves the same slice: call eurostat_download_dataset with dataset_code "nama_10_gdp", the same filters and since_period "2021" and until_period "2023" in place of filters.time. Filter on freq, na_item — the dimensions of "nama_10_gdp" this request left unfiltered — or narrow since_period/until_period.`,
    );
    const text = contentText(result as never);
    expect(text).toContain('since_period "`2021`" and until_period "`2023`"');
  });

  it('keeps the generic narrowing sentence when the structure read fails, and settles inside 35 s', async () => {
    serve(silent, async () => new Response('Service Unavailable', { status: 503 }));
    let settledAt: number | undefined;
    const pending = runToolContract(eurostatQueryDataset, STEP_2).finally(() => {
      settledAt = Date.now();
    });
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await pending;
    expect(hintOf(result)).toBe(`${REPEAT} ${STEP_2_ROUTE} ${GENERIC_NARROW('DS-045409')}`);
    expect((settledAt ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThanOrEqual(35_000);
  });

  it('settles at the request deadline plus the 5 s hint read when both hang, under the 60 s client default', async () => {
    serve(silent, silent);
    let settled = false;
    const pending = runToolContract(eurostatQueryDataset, STEP_2).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const result = await pending;
    expect(errorOf(result).data.reason).toBe('retry_deadline_exceeded');
    expect(hintOf(result)).toBe(`${REPEAT} ${STEP_2_ROUTE} ${GENERIC_NARROW('DS-045409')}`);
    expect(structureReads()).toBe(1);
  });

  it.each([
    ['during the query', 10_000],
    ['during the hint read', 32_000],
  ])('reaches the caller as a cancellation when cancelled %s', async (_when, at) => {
    serve(silent, silent);
    const controller = new AbortController();
    /**
     * The handler, not runToolContract: the contract runner reports anything thrown after
     * the abort as RequestCancelled, so only the handler's own throw shows what the
     * catch did with it.
     */
    const outcome = Promise.resolve(
      eurostatQueryDataset.handler(
        eurostatQueryDataset.input.parse(STEP_2),
        createMockContext({ signal: controller.signal, errors: eurostatQueryDataset.errors }),
      ),
    ).then(
      () => undefined,
      (error: unknown) => error as { code?: number; data?: { reason?: string } },
    );
    await vi.advanceTimersByTimeAsync(at);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await outcome;
    expect(error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error?.data?.reason).not.toBe('retry_deadline_exceeded');
  });
});

// ---------------------------------------------------------------------------
// Periods a series lacks (#90) — the real service on recorded replies, staged on a
// real canvas.
// ---------------------------------------------------------------------------

describe('eurostatQueryDataset — periods a series lacks (#90)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  /** The issue's step 1: Germany carries 1991–1995 of the 21 years, France all of them. */
  const STEP1 = {
    dataset_code: 'nama_10_gdp',
    filters: { geo: ['DE', 'FR'], unit: ['CP_MEUR'], na_item: ['B1GQ'] },
    since_period: '1975',
    until_period: '1995',
    stage: true,
    preview_limit: 2,
  };

  const ctx = () => createMockContext({ errors: eurostatQueryDataset.errors, tenantId: 'default' });
  const serve = (name: string) =>
    fetchMock.mockImplementation(async () => jsonReply(envelope(name)));
  const structured = (result: { structuredContent?: unknown }) =>
    result.structuredContent as Record<string, unknown> & {
      canvasId: string;
      notice?: string;
      tableName: string;
    };

  beforeAll(async () => {
    ({ canvas, teardown } = withRealCanvas());
    await canvas.acquire(undefined, ctx());
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
  });

  it('characterizes the step-1 query: 26 observations staged, none missing, the preview sentence unchanged', async () => {
    serve('nama-10-gdp-de-fr-1975-to-1995');
    const result = await runToolContract(eurostatQueryDataset, STEP1);
    expect(result.isError).not.toBe(true);
    const out = structured(result);
    expect(out).toMatchObject({
      obsCount: 26,
      missingObsCount: 0,
      stagedRowCount: 26,
      truncated: false,
      timeRange: { start: '1975', end: '1995' },
    });
    expect(out.observations).toHaveLength(2);
    expect(out.notice).toContain(
      `preview_limit=2 returns the first 2 of 26 matched rows inline; it does not reduce the match. All 26 matched rows are staged as table \`${out.tableName}\` on canvas \`${out.canvasId}\`. Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query. Use dimension filters (freq, unit, na_item, geo) or a period range when the match itself should be smaller.`,
    );
    expect(contentText(result)).toContain(out.notice as string);
    expect(contentText(result)).toContain(
      '**Observations:** 26 (0 missing) | **Period:** 1975 – 1995',
    );
    const staged = await (await canvas.acquire(out.canvasId, ctx())).query(
      `SELECT count(*)::INTEGER AS n, count(obs_value)::INTEGER AS valued FROM ${out.tableName}`,
    );
    expect(staged.rows).toEqual([{ n: 26, valued: 26 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** The absent-cell sentence, for `cells` in `affected` of `total` series. */
  const absentSentence = (cells: string, affected: number, total: number) =>
    `${cells} in ${affected} of ${total} series: periods a series lacks at a frequency it carries (no value, no flag). They are not observations: obsCount, missingObsCount, the rows and any staged table leave them out, so a per-period total across series covers only the series present.`;

  it('returns absentCellCount 16 on both surfaces, naming 16 absent cells in 1 of 2 series', async () => {
    serve('nama-10-gdp-de-fr-1975-to-1995');
    const result = await runToolContract(eurostatQueryDataset, STEP1);
    expect(result.isError).not.toBe(true);
    const out = structured(result);
    expect(Object.keys(out).sort()).toEqual(
      [
        'absentCellCount',
        'appliedFilters',
        'canvasId',
        'datasetCode',
        'datasetLabel',
        'dimensionsUsed',
        'missingObsCount',
        'notice',
        'obsCount',
        'observations',
        'stagedRowCount',
        'tableName',
        'timeRange',
        'truncated',
      ].sort(),
    );
    expect(out).toMatchObject({ absentCellCount: 16, obsCount: 26, stagedRowCount: 26 });
    expect(out.notice).toContain(absentSentence('16 absent cells', 1, 2));
    const text = contentText(result);
    expect(text).toContain(
      '**Observations:** 26 (0 missing) | **Period:** 1975 – 1995 | **Absent cells:** 16',
    );
    expect(text).toContain(out.notice as string);
    // The staged table holds Germany's five observations and no row for the years it lacks.
    const staged = await (await canvas.acquire(out.canvasId, ctx())).query(
      `SELECT count(*)::INTEGER AS n FROM ${out.tableName} WHERE geo = 'DE'`,
    );
    expect(staged.rows).toEqual([{ n: 5 }]);
  });

  for (const [label, input] of [
    [
      'last_n_periods',
      { ...STEP1, since_period: undefined, until_period: undefined, last_n_periods: 21 },
    ],
    ['no staging and a 500-row preview', { ...STEP1, stage: false, preview_limit: 500 }],
    ['a one-row preview', { ...STEP1, preview_limit: 1 }],
  ] as const) {
    it(`gives the same count with ${label}`, async () => {
      serve('nama-10-gdp-de-fr-1975-to-1995');
      const result = await runToolContract(eurostatQueryDataset, input as never);
      const out = structured(result);
      expect(out).toMatchObject({ absentCellCount: 16, obsCount: 26, missingObsCount: 0 });
      expect(out.notice).toContain(absentSentence('16 absent cells', 1, 2));
      expect(contentText(result)).toContain('**Absent cells:** 16');
    });
  }

  it('reports 0 and adds no sentence for the recorded annual-beside-monthly Comext pair', async () => {
    serve('comext/ds-045409-de-fr-2023-06-to-2024');
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'DS-045409',
      filters: {
        reporter: ['DE'],
        partner: ['FR'],
        product: ['TOTAL'],
        flow: ['1'],
        indicators: ['VALUE_IN_EUROS'],
      },
      since_period: '2023-06',
      until_period: '2024',
      preview_limit: 500,
    });
    const out = structured(result);
    expect(out).toMatchObject({ absentCellCount: 0, obsCount: 20, missingObsCount: 0 });
    expect(out.notice).not.toMatch(/absent cell/);
    expect(contentText(result)).toContain('| **Absent cells:** 0');
  });

  it('writes one absent cell in the singular, beside the last-N and trailing-period sentences', async () => {
    // DE has 2024–2026; FR has 2024 and 2026 and lacks 2025, inside the span. No series has 2027.
    fetchMock.mockImplementation(async () =>
      jsonReply({
        label: 'Test dataset',
        id: ['geo', 'time'],
        size: [2, 4],
        dimension: {
          geo: { label: 'geo', category: { index: { DE: 0, FR: 1 } } },
          time: { label: 'time', category: { index: { 2024: 0, 2025: 1, 2026: 2, 2027: 3 } } },
        },
        value: { '0': 1, '1': 2, '2': 3, '4': 4, '6': 5 },
      }),
    );
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      last_n_periods: 4,
    });
    const out = structured(result);
    expect(out).toMatchObject({ absentCellCount: 1, obsCount: 5 });
    expect(out.notice).toContain(
      '1 selected period (2027) carries no populated cells anywhere in this match. last_n_periods counts dataset time positions, not periods with populated cells for this slice; preview_limit does not select periods. Set last_n_periods to 5 for the 4 periods ending at 2026, or set a since_period/until_period range ending at 2026, the latest period with a cell in this match; until_period alone selects every period up to it.',
    );
    expect(out.notice).toContain(
      "2027 carries no cell in any series, after the latest period with one (2026). absentCellCount leaves such periods out: it counts only periods from a frequency's first to its latest period with a cell.",
    );
    expect(out.notice).toContain(absentSentence('1 absent cell', 1, 2));
    expect(contentText(result)).toContain(out.notice as string);
  });

  it('leaves a trailing selected period out of absentCellCount and names it instead', async () => {
    serve('une-rt-m-geo-de-lower-last3');
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'une_rt_m',
      filters: DE_UNEMPLOYMENT,
      last_n_periods: 3,
    });
    const out = structured(result);
    expect(out).toMatchObject({ absentCellCount: 0, obsCount: 2 });
    expect(out.notice).toContain('1 selected period (2026-08) carries no populated cells');
    expect(out.notice).toContain(
      'Set last_n_periods to 4 for the 3 periods ending at 2026-07, or set a since_period/until_period range ending at 2026-07, the latest period with a cell',
    );
    expect(out.notice).toContain(
      '2026-08 carries no cell in any series, after the latest period with one (2026-07).',
    );
    expect(out.notice).not.toMatch(/absent cell/);
    expect(contentText(result)).toContain('**Absent cells:** 0');
    expect(contentText(result)).toContain(out.notice as string);
  });

  it('renders absentCellCount in format() whatever its value', () => {
    for (const absentCellCount of [0, 1, 13_389]) {
      const text = (
        eurostatQueryDataset.format!({ ...mockQueryResult, absentCellCount }) as Array<{
          text?: string;
        }>
      )
        .map((block) => block.text ?? '')
        .join('');
      expect(text).toContain(
        `**Observations:** 3 (1 missing) | **Period:** 2023 – 2023 | **Absent cells:** ${absentCellCount}`,
      );
    }
  });
});

/** Every recorded reply here is a live capture of the filters and periods its test sends. */
describe('eurostatQueryDataset — values and periods with no cell (#96, #97)', () => {
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

  const serve = (name: string) =>
    fetchMock.mockImplementation(async () => jsonReply(envelope(name)));
  const run = async (name: string, input: Record<string, unknown>) => {
    serve(name);
    const result = await runToolContract(eurostatQueryDataset, input as never);
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const out = result.structuredContent as Record<string, unknown> & { notice?: string };
    return { out, notice: out.notice ?? '', text: contentText(result) };
  };
  const UNIT = { unit: ['PPS_HAB_EU27_2020'] };
  const WINE_TO_US = {
    partner: ['US'],
    product: ['2204'],
    flow: ['2'],
    indicators: ['VALUE_IN_EUROS'],
  };

  describe('values with no cell (#96)', () => {
    it('names them on both surfaces (step 1)', async () => {
      const { out, notice, text } = await run('nama-10r-2gdp-de11-no02-ch01-last1', {
        dataset_code: 'nama_10r_2gdp',
        filters: { ...UNIT, geo: ['DE11', 'NO02', 'CH01'] },
        last_n_periods: 1,
      });
      expect(out).toMatchObject({
        emptyValues: { geo: ['NO02', 'CH01'] },
        obsCount: 1,
        absentCellCount: 0,
      });
      expect(out).not.toHaveProperty('unmatchedValues');
      expect(notice).toBe(
        '2 values the query selects exist in the dataset but have no cell in this match, so they contribute no rows: geo=[NO02, CH01]. A value can still carry data in other periods or beside other filter values.',
      );
      expect(text).toContain(
        '**Values with no cell:** geo=[NO02, CH01] — in the dataset but with no value or flag in this match, so the rows cover only the other values',
      );
      expect(text).toContain(notice);
    });

    it('lists 24 in the notice and every one in the field and in content[] (step 3)', async () => {
      const { out, notice, text } = await run('nama-10r-2gdp-nuts2-last1', {
        dataset_code: 'nama_10r_2gdp',
        filters: UNIT,
        geo_level: 'nuts2',
        last_n_periods: 1,
      });
      const geo = (out.emptyValues as { geo: string[] }).geo;
      expect(out.obsCount).toBe(276);
      expect(geo).toHaveLength(33);
      expect(notice).toContain(
        `33 values the query selects exist in the dataset but have no cell in this match, so they contribute no rows: geo=[${geo.slice(0, 24).join(', ')}] (9 more omitted; emptyValues lists all 33).`,
      );
      expect(notice).not.toContain(geo[24] as string);
      expect(text).toContain(`**Values with no cell:** geo=[${geo.join(', ')}]`);
    });

    it('names an unmatched and an empty value apart, each in its own sentence and line', async () => {
      const { out, notice, text } = await run('nama-10r-2gdp-de11-xx99-ch01-last1', {
        dataset_code: 'nama_10r_2gdp',
        filters: { ...UNIT, geo: ['DE11', 'XX99', 'CH01'] },
        last_n_periods: 1,
      });
      expect(out).toMatchObject({
        unmatchedValues: { geo: ['XX99'] },
        emptyValues: { geo: ['CH01'] },
      });
      expect(notice).toContain(
        'These filter values matched nothing and contribute no rows: geo=[XX99].',
      );
      expect(notice).toContain(
        '1 value the query selects exists in the dataset but has no cell in this match, so it contributes no rows: geo=[CH01].',
      );
      expect(text).toContain('**Unmatched filter values:** geo=[XX99]');
      expect(text).toContain('**Values with no cell:** geo=[CH01]');
      expect(text).toContain(notice);
    });

    it('discloses an empty value and trailing periods together', async () => {
      // NO02 publishes 2020–2021 and CH01 nothing; no series has 2022–2024.
      const { out, notice, text } = await run('nama-10r-2gdp-no02-ch01-since-2020', {
        dataset_code: 'nama_10r_2gdp',
        filters: { ...UNIT, geo: ['NO02', 'CH01'] },
        since_period: '2020',
      });
      expect(out).toMatchObject({
        emptyValues: { geo: ['CH01'] },
        absentCellCount: 0,
        obsCount: 2,
      });
      expect(notice).toContain(
        '2022 – 2024 carry no cell in any series, after the latest period with one (2021).',
      );
      expect(notice).toContain('geo=[CH01]');
      expect(notice).not.toMatch(/absent cell|last_n_periods/);
      expect(text).toContain(notice);
    });

    it('omits the field and its line when every selected value has a cell', async () => {
      const { out, text } = await run('nama-10-gdp-de-fr-1975-to-1995', {
        dataset_code: 'nama_10_gdp',
        filters: { geo: ['DE', 'FR'], unit: ['CP_MEUR'], na_item: ['B1GQ'] },
        since_period: '1975',
        until_period: '1995',
      });
      expect(out).not.toHaveProperty('emptyValues');
      expect(text).not.toContain('Values with no cell');
    });

    it('lists the first 24 values across dimensions, and says nothing is omitted at exactly 24', async () => {
      const codes = (prefix: string, n: number) =>
        Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
      const noticeFor = async (emptyValues: Record<string, string[]>) => {
        vi.mocked(getEurostatDataService).mockReturnValue({
          queryDataset: vi.fn().mockResolvedValue({ ...mockQueryResult, emptyValues }),
        } as never);
        const result = await runToolContract(eurostatQueryDataset, { dataset_code: 'nama_10_gdp' });
        return {
          notice: (result.structuredContent as { notice: string }).notice,
          text: contentText(result),
        };
      };

      // 20 + 5 values: the notice runs out of room four values into the second dimension.
      const over = await noticeFor({ unit: codes('U', 20), geo: codes('G', 5) });
      expect(over.notice).toContain(
        `25 values the query selects exist in the dataset but have no cell in this match, so they contribute no rows: unit=[${codes('U', 20).join(', ')}]; geo=[G00, G01, G02, G03] (1 more omitted; emptyValues lists all 25).`,
      );
      expect(over.text).toContain(
        `**Values with no cell:** unit=[${codes('U', 20).join(', ')}]; geo=[${codes('G', 5).join(', ')}]`,
      );

      const exactly = await noticeFor({ geo: codes('G', 24) });
      expect(exactly.notice).toContain(`geo=[${codes('G', 24).join(', ')}].`);
      expect(exactly.notice).not.toContain('omitted');
    });

    it('advertises emptyValues as an optional output field', () => {
      const parsed = eurostatQueryDataset.output.parse({
        ...mockQueryResult,
        emptyValues: { geo: ['CH01'] },
      });
      expect(parsed.emptyValues).toEqual({ geo: ['CH01'] });
      expect(eurostatQueryDataset.output.parse(mockQueryResult)).not.toHaveProperty('emptyValues');
    });
  });

  describe("periods outside a frequency's span (#97)", () => {
    it('leaves the padded months out of absentCellCount and names them (step 1)', async () => {
      const { out, notice, text } = await run(
        'comext/ds-045409-m-de-fr-it-es-us-2204-since-2026-01',
        {
          dataset_code: 'DS-045409',
          filters: { freq: ['M'], reporter: ['DE', 'FR', 'IT', 'ES'], ...WINE_TO_US },
          since_period: '2026-01',
        },
      );
      expect(out).toMatchObject({ absentCellCount: 0, obsCount: 32 });
      expect(notice).toContain(
        "2026-09 – 2026-12 carry no cell in any series, after the latest period with one (2026-08). absentCellCount leaves such periods out: it counts only periods from a frequency's first to its latest period with a cell.",
      );
      expect(notice).not.toMatch(/absent cells? in/);
      expect(text).toContain('**Absent cells:** 0');
      expect(text).toContain(notice);
    });

    it('names leading years and says the slice starts later, with no advice to raise N (step 3)', async () => {
      const { out, notice } = await run('nama-10-pc-me-rs-last30', {
        dataset_code: 'nama_10_pc',
        filters: { geo: ['ME', 'RS'], unit: ['CP_PPS_EU27_2020_HAB'], na_item: ['B1GQ'] },
        last_n_periods: 30,
      });
      expect(out).toMatchObject({ absentCellCount: 6, obsCount: 46 });
      expect(notice).toContain(
        '4 selected periods (1996, 1997, 1998, 1999) carry no populated cells anywhere in this match. last_n_periods counts dataset time positions, not periods with populated cells for this slice; preview_limit does not select periods. This slice starts later than the selection, so a larger last_n_periods only reaches earlier periods.',
      );
      expect(notice).toContain(
        '1996 – 1999 carry no cell in any series, before the first period with one (2000).',
      );
      expect(notice).toContain('6 absent cells in 1 of 2 series');
      expect(notice).not.toMatch(/Increase last_n_periods|Set last_n_periods to/);
    });

    it('advises the N that ends at the latest month with a cell, or a range ending there, for trailing months', async () => {
      const { out, notice } = await run('comext/ds-045409-m-de-us-2204-last6', {
        dataset_code: 'DS-045409',
        filters: { freq: ['M'], reporter: ['DE'], ...WINE_TO_US },
        last_n_periods: 6,
      });
      expect(out).toMatchObject({ absentCellCount: 0, obsCount: 2 });
      expect(notice).toContain(
        '4 selected periods (2026-09, 2026-10, 2026-11, 2026-12) carry no populated cells',
      );
      // 6 + the 4 empty trailing months: the ten latest positions end with 2026-03 – 2026-08.
      expect(notice).toContain(
        'Set last_n_periods to 10 for the 6 periods ending at 2026-08, or set a since_period/until_period range ending at 2026-08, the latest period with a cell in this match; until_period alone selects every period up to it.',
      );
      expect(notice).toContain('2026-09 – 2026-12 carry no cell in any series');
    });

    it('names both ends of a last-N window, with no advice to raise N', async () => {
      const { out, notice } = await run('nama-10r-2gdp-no02-last30', {
        dataset_code: 'nama_10r_2gdp',
        filters: { ...UNIT, geo: ['NO02'] },
        last_n_periods: 30,
      });
      expect(out.absentCellCount).toBe(0);
      expect(notice).toContain(
        '2000 – 2007 carry no cell in any series, before the first period with one (2008); 2022 – 2024 carry no cell in any series, after the latest period with one (2021).',
      );
      expect(notice).toContain('This slice starts later than the selection');
      expect(notice).not.toMatch(/Increase last_n_periods|Set last_n_periods to/);
    });

    it('names each frequency of a mixed slice apart', async () => {
      const { out, notice } = await run('comext/ds-045409-de-fr-us-2204-since-2025-01', {
        dataset_code: 'DS-045409',
        filters: { reporter: ['DE', 'FR'], ...WINE_TO_US },
        since_period: '2025-01',
      });
      expect(out.absentCellCount).toBe(0);
      expect(notice).toContain(
        '2026-09 – 2026-12 carry no cell in any series, after the latest period with one (2026-08); 2026 carries no cell in any series, after the latest period with one (2025).',
      );
    });

    it('names a frequency with no cell in the window, and still advises a larger N', async () => {
      // A last-N window over a mixed slice: monthly cells through 2026-08, no annual cell.
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: vi.fn().mockResolvedValue({
          ...mockQueryResult,
          unpopulatedPeriods: ['2026-09', '2026-10', '2026-11', '2026-12', '2026'],
          outsideSpans: [
            {
              frequency: 'M',
              kind: 'edges',
              first: '2026-07',
              last: '2026-08',
              before: [],
              after: ['2026-09', '2026-10', '2026-11', '2026-12'],
            },
            { frequency: 'A', kind: 'empty', periods: ['2026'] },
          ],
          latestWithCell: '2026-08',
        }),
      } as never);
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'DS-045409',
        last_n_periods: 7,
      });
      const { notice } = result.structuredContent as { notice: string };
      expect(notice).toContain(
        '2026-09 – 2026-12 carry no cell in any series, after the latest period with one (2026-08); 2026 carries no cell in any series, the only period of its frequency in this match.',
      );
      // Two frequencies share the window's positions, so no exact N is given.
      expect(notice).toContain(
        'Increase last_n_periods, or set a since_period/until_period range ending at 2026-08, the latest period with a cell in this match; until_period alone selects every period up to it.',
      );
      expect(contentText(result)).toContain(notice);
    });

    it('gives no advice for an empty period inside the span, and counts it as absent', async () => {
      // DE and FR both have 2024 and 2026 and lack 2025.
      fetchMock.mockImplementation(async () =>
        jsonReply({
          label: 'Test dataset',
          id: ['geo', 'time'],
          size: [2, 3],
          dimension: {
            geo: { label: 'geo', category: { index: { DE: 0, FR: 1 } } },
            time: { label: 'time', category: { index: { 2024: 0, 2025: 1, 2026: 2 } } },
          },
          value: { '0': 1, '2': 2, '3': 3, '5': 4 },
        }),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        last_n_periods: 3,
      });
      const { notice } = result.structuredContent as { notice: string };
      expect(result.structuredContent).toMatchObject({ absentCellCount: 2 });
      expect(notice).toContain(
        '1 selected period (2025) carries no populated cells anywhere in this match. last_n_periods counts dataset time positions, not periods with populated cells for this slice; preview_limit does not select periods. 2 absent cells in 2 of 2 series',
      );
      expect(notice).not.toMatch(/Increase last_n_periods|starts later|no cell in any series/);
    });

    it('gives no advice when one empty period follows the span and another lies inside it', async () => {
      // DE and FR both have 2024 and 2026, lack 2025, and have no 2027 cell.
      fetchMock.mockImplementation(async () =>
        jsonReply({
          label: 'Test dataset',
          id: ['geo', 'time'],
          size: [2, 4],
          dimension: {
            geo: { label: 'geo', category: { index: { DE: 0, FR: 1 } } },
            time: {
              label: 'time',
              category: { index: { 2024: 0, 2025: 1, 2026: 2, 2027: 3 } },
            },
          },
          value: { '0': 1, '2': 2, '4': 3, '6': 4 },
        }),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'nama_10_gdp',
        last_n_periods: 4,
      });
      const { notice } = result.structuredContent as { notice: string };
      expect(result.structuredContent).toMatchObject({ absentCellCount: 2 });
      expect(notice).toContain(
        '2 selected periods (2025, 2027) carry no populated cells anywhere in this match.',
      );
      expect(notice).toContain(
        '2027 carries no cell in any series, after the latest period with one (2026).',
      );
      expect(notice).not.toMatch(/Increase last_n_periods|starts later/);
      expect(contentText(result)).toContain(notice);
    });
  });
});

describe('eurostatQueryDataset — filter text in authored Markdown', () => {
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

  // A link, strong emphasis, and a second line that opens a list item, as a caller sends them.
  const LIVE = ['a](http://x)', '**b**', 'c\n- d'];
  // The same three values escaped, so a CommonMark parse reads each back as sent.
  const ESCAPED = 'a\\](http://x), \\*\\*b\\*\\*, c\\\n\\- d';

  it('escapes unmatched values in the notice, the format() line and the filters trailer', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
    );
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'une_rt_m',
      filters: { ...DE_UNEMPLOYMENT, geo: ['DE', ...LIVE] },
      since_period: '2024-01',
    });
    expect(result.isError).not.toBe(true);
    const out = result.structuredContent as {
      notice: string;
      unmatchedValues: Record<string, string[]>;
      appliedFilters: { filters: Record<string, string[]> };
    };
    expect(out.unmatchedValues).toEqual({ geo: LIVE });
    expect(out.appliedFilters.filters.geo).toEqual(['DE', ...LIVE]);
    expect(out.notice).toContain(
      `These filter values matched nothing and contribute no rows: geo=[${ESCAPED}]. Check the valid codes for geo with eurostat_get_dimension_values.`,
    );
    const text = contentText(result);
    expect(text).toContain(
      `**Unmatched filter values:** geo=[${ESCAPED}] — these matched nothing, so the rows cover only the other values`,
    );
    // The notice's second line is quoted on its own; its dash stays text, not a list item.
    expect(text).toContain('> \\- d]. Check the valid codes for geo');
    expect(text).toContain(
      `- **Filters:** geo=[DE, ${ESCAPED}]; unit=[PC_ACT]; s_adj=[SA]; age=[TOTAL]; sex=[T]`,
    );
  });

  it('escapes values with no cell, and a filter key, in both notice sentences and both format() lines', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      queryDataset: vi.fn().mockResolvedValue({
        ...mockQueryResult,
        appliedFilters: { geo: ['DE', ...LIVE], _k_: ['v'] },
        unmatchedValues: { _k_: ['v'] },
        emptyValues: { geo: LIVE },
      }),
    } as never);
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      filters: { geo: ['DE', ...LIVE], _k_: ['v'] },
    });
    expect(result.isError).not.toBe(true);
    const out = result.structuredContent as {
      notice: string;
      emptyValues: Record<string, string[]>;
      unmatchedValues: Record<string, string[]>;
    };
    expect(out.emptyValues).toEqual({ geo: LIVE });
    expect(out.unmatchedValues).toEqual({ _k_: ['v'] });
    expect(out.notice).toContain(
      'These filter values matched nothing and contribute no rows: \\_k\\_=[v]. Check the valid codes for \\_k\\_ with eurostat_get_dimension_values.',
    );
    expect(out.notice).toContain(
      `3 values the query selects exist in the dataset but have no cell in this match, so they contribute no rows: geo=[${ESCAPED}]. A value can still carry data in other periods or beside other filter values.`,
    );
    const text = contentText(result);
    expect(text).toContain('**Unmatched filter values:** \\_k\\_=[v] — these matched nothing');
    expect(text).toContain(
      `**Values with no cell:** geo=[${ESCAPED}] — in the dataset but with no value or flag in this match`,
    );
    expect(text).toContain(`- **Filters:** geo=[DE, ${ESCAPED}]; \\_k\\_=[v]`);
  });
});

describe('eurostatQueryDataset — a staged canvas ID in the notice', () => {
  // Underscores at both ends: in running text, Markdown reads the ID as emphasis.
  const ID = '_abcdefgh_';
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ canvas, teardown } = withRealCanvas());
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await teardown();
  });

  /** A real canvas answering every acquire under `id`, which the registry would never mint. */
  const underId = async (id: string): Promise<DataCanvas> => {
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId: 'default' }));
    const renamed = new Proxy(instance, {
      get: (target, key) => {
        if (key === 'canvasId') return id;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { acquire: async () => renamed } as never;
  };

  for (const [label, previewLimit] of [
    ['beside an inline prefix', 2],
    ['with every row inline', 100],
  ] as const) {
    it(`renders the canvas ID and table name as code spans ${label}`, async () => {
      setCanvas(await underId(ID));
      fetchMock.mockImplementationOnce(async () =>
        jsonReply(envelope('une-rt-m-geo-de-xx-since-2024-01')),
      );
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'une_rt_m',
        filters: DE_UNEMPLOYMENT,
        since_period: '2024-01',
        preview_limit: previewLimit,
        stage: true,
        canvas_id: ID,
      });
      expect(result.isError).not.toBe(true);
      const out = result.structuredContent as {
        canvasId: string;
        notice: string;
        tableName: string;
      };
      expect(out.canvasId).toBe(ID);
      const staged = `All 31 matched rows are staged as table \`${out.tableName}\` on canvas \`${ID}\`. Call eurostat_dataframe_describe`;
      expect(out.notice).toContain(staged);
      expect(contentText(result)).toContain(staged);
      expect(contentText(result)).not.toContain(`"${ID}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// Filter keys and values the dataset does not have (#104), and "+" in a value (#100) —
// the real service with fetch routed per endpoint, over replies recorded live. The reads
// themselves (deadline, failure, cancellation, cache) are tabled in narrowing-advice.test.ts;
// these prove the tool reaches them on each side of each branch.
// ---------------------------------------------------------------------------

describe('eurostatQueryDataset — naming the dimensions and codes a filter missed (#104, #100)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  type Route = 'contentconstraint' | 'dataflow' | 'datastructure' | 'statistics';
  const routeOf = (input: unknown): Route =>
    (new URL(String(input)).pathname.match(/\/sdmx\/2\.1\/([a-z]+)\//)?.[1] as Route) ??
    'statistics';
  const recorded = (name: string) => async () =>
    new Response(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
  /** The Statistics API answers `body`; a structure route answers from `structures`, else 404. */
  const serve = (
    body: object,
    status: number,
    structures: Partial<Record<Route, (input: unknown, init?: RequestInit) => Promise<Response>>>,
  ) =>
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const route = routeOf(input);
      if (route === 'statistics') return jsonReply(body, status);
      return structures[route]?.(input, init) ?? new Response('<fault/>', { status: 404 });
    });
  const reads = (route: Route) =>
    fetchMock.mock.calls.filter(([input]) => routeOf(input) === route).length;
  const errorOf = (result: { structuredContent?: unknown }) =>
    (
      result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      }
    ).error;
  const hintOf = (result: { structuredContent?: unknown }) =>
    (errorOf(result).data.recovery as { hint: string }).hint;

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

  describe('filter keys ilc_li02 has no dimension for', () => {
    const REJECTED = envelope('ilc-li02-fr-indic-il-incgrp-150');
    const STALE = { geo: ['FR'], indic_il: ['LI_R_MD60'], incgrp: ['TOTAL'] };
    const ORDER = ['freq', 'statinfo', 'unit', 'rskpovth', 'sex', 'age', 'geo'];
    const MESSAGE =
      'Filter names "indic_il", "incgrp", which are not dimensions of this dataset. Filterable dimensions, in key order: freq, statinfo, unit, rskpovth, sex, age, geo.';
    const RENAME = 'Rename each filter key the error names to one of the dimensions it lists.';

    it('names both in one error with the key order, on both surfaces', async () => {
      serve(REJECTED, 400, { datastructure: recorded('ilc-li02-datastructure.xml') });
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'ilc_li02',
        filters: STALE,
      });
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: MESSAGE,
        data: {
          reason: 'invalid_dimension',
          unknownDimensions: ['indic_il', 'incgrp'],
          dimensionOrder: ORDER,
          recovery: { hint: RENAME },
        },
      });
      const text = contentText(result as never);
      expect(text).toContain(
        'Filterable dimensions, in key order: `freq`, `statinfo`, `unit`, `rskpovth`, `sex`, `age`, `geo`.',
      );
      expect(text).toContain(`Recovery: ${RENAME}`);
      expect(reads('statistics')).toBe(1);
      expect(reads('datastructure')).toBe(1);
    });

    it('lists no time key when filters.time sits beside them', async () => {
      serve(REJECTED, 400, { datastructure: recorded('ilc-li02-datastructure.xml') });
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'ilc_li02',
        filters: { ...STALE, time: ['2020'] },
      });
      expect(errorOf(result)).toMatchObject({
        message: MESSAGE,
        data: { unknownDimensions: ['indic_il', 'incgrp'] },
      });
    });

    it.each([
      ['the structure cannot be read', STALE, {}],
      [
        'the structure lists every filter key',
        { geo: ['FR'], statinfo: ['X'] },
        { datastructure: recorded('ilc-li02-datastructure.xml') },
      ],
    ])("keeps Eurostat's one-key error when %s", async (_name, filters, structures) => {
      serve(REJECTED, 400, structures);
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'ilc_li02',
        filters,
      });
      const error = errorOf(result);
      expect(error.data.reason).toBe('invalid_dimension');
      expect(error.message).toContain('Dimension "INDIC_IL" is not defined');
      expect(error.data).not.toHaveProperty('unknownDimensions');
      expect(hintOf(result)).toBe(
        'Use eurostat_get_dataset_info to see valid dimension codes for "ilc_li02".',
      );
      expect(reads('datastructure')).toBe(1);
    });
  });

  describe('filter values hlth_cd_apr has no code for', () => {
    const VALUES = {
      dataflow: recorded('dimension-values/hlth-cd-apr-dataflow.xml'),
      contentconstraint: recorded('dimension-values/hlth-cd-apr-constraint.xml'),
    };

    it('lists the three mortalit codes with their labels on both surfaces', async () => {
      serve(envelope('hlth-cd-apr-fi-prev'), 200, VALUES);
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'hlth_cd_apr',
        filters: { geo: ['FI'], mortalit: ['PREV'] },
      });
      const listed =
        '"mortalit" has 3 codes: TOTAL (Total), PRVT (Preventable mortality), TRT (Treatable mortality).';
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message:
          'No observations matched. These filter values match nothing in "hlth_cd_apr": mortalit=[PREV].',
        data: {
          reason: 'no_results',
          unmatchedValues: { mortalit: ['PREV'] },
          validValues: {
            mortalit: {
              totalCount: 3,
              values: [
                { code: 'TOTAL', label: 'Total' },
                { code: 'PRVT', label: 'Preventable mortality' },
                { code: 'TRT', label: 'Treatable mortality' },
              ],
            },
          },
          recovery: { hint: listed },
        },
      });
      expect(contentText(result as never)).toContain(
        'Recovery: "mortalit" has 3 codes: `TOTAL` (Total), `PRVT` (Preventable mortality), `TRT` (Treatable mortality).',
      );
    });

    it.each([
      [
        'XX',
        'hlth-cd-apr-xx-prvt',
        'Find the code for "XX" with eurostat_get_dimension_values, dimension "geo" and filter "XX", adding geo_level for a code below country level.',
      ],
      [
        'F.I',
        'hlth-cd-apr-f-dot-i-prvt',
        'No Eurostat code contains ".", and "F.I" without its dots may not be a code of "hlth_cd_apr" either. Find the code with eurostat_get_dimension_values, dimension "geo" and filter "FI".',
      ],
    ])(
      'gives geo, above 25 codes, its total over every level and no codes, for %s',
      async (value, fixture, next) => {
        serve(envelope(fixture), 200, VALUES);
        const result = await runToolContract(eurostatQueryDataset, {
          dataset_code: 'hlth_cd_apr',
          filters: { geo: [value], mortalit: ['PRVT'] },
        });
        const hint = `"geo" has 38 codes, too many to list here. ${next}`;
        expect(errorOf(result).data).toMatchObject({
          unmatchedValues: { geo: [value] },
          validValues: { geo: { totalCount: 38 } },
        });
        expect(hintOf(result)).toBe(hint);
        const text = contentText(result as never);
        // The key and the value are sent back to eurostat_get_dimension_values: code spans.
        expect(text).toContain('Recovery: "`geo`" has 38 codes, too many to list here.');
        expect(text).toContain(`"\`${value}\`"`);
        expect(text).not.toContain('EU27');
      },
    );

    it('keeps the generic pointer when the values cannot be read', async () => {
      serve(envelope('hlth-cd-apr-fi-prev'), 200, {});
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: 'hlth_cd_apr',
        filters: { geo: ['FI'], mortalit: ['PREV'] },
      });
      expect(errorOf(result).data).not.toHaveProperty('validValues');
      expect(hintOf(result)).toBe(
        'Check the valid codes for mortalit with eurostat_get_dimension_values.',
      );
      expect(reads('dataflow')).toBe(1);
    });

    describe('when the values read does not answer', () => {
      /** A request that never answers: it settles only when its signal aborts. */
      const hang = (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      const input = { dataset_code: 'hlth_cd_apr', filters: { geo: ['FI'], mortalit: ['PREV'] } };

      beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
          ...serverConfig.getServerConfig(),
          requestTimeoutMs: 600_000,
          metadataTimeoutMs: 600_000,
        });
        serve(envelope('hlth-cd-apr-fi-prev'), 200, { dataflow: hang, contentconstraint: hang });
      });
      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      it('keeps the generic pointer at 5 s', async () => {
        let settled = false;
        const pending = runToolContract(eurostatQueryDataset, input).finally(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        const result = await pending;
        expect(errorOf(result).data).toMatchObject({ reason: 'no_results' });
        expect(errorOf(result).data).not.toHaveProperty('validValues');
        expect(hintOf(result)).toBe(
          'Check the valid codes for mortalit with eurostat_get_dimension_values.',
        );
      });

      it('reaches the caller as a cancellation when the call is cancelled during the read', async () => {
        const controller = new AbortController();
        // The handler, not runToolContract, which reports anything thrown after an abort as cancelled.
        const outcome = Promise.resolve(
          eurostatQueryDataset.handler(
            eurostatQueryDataset.input.parse(input),
            createMockContext({ signal: controller.signal, errors: eurostatQueryDataset.errors }),
          ),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(1_000);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(await outcome).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      });
    });
  });

  it('reads "DE+FR" as DE and FR, and echoes them as two values (#100)', async () => {
    serve(envelope('nama-10-gdp-de-fr-since-2024'), 200, {});
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'nama_10_gdp',
      filters: { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE+FR'] },
      since_period: '2024',
    });
    expect(result.isError).not.toBe(true);
    const out = result.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({
      obsCount: 4,
      appliedFilters: { filters: { geo: ['DE', 'FR'] } },
    });
    expect(out).not.toHaveProperty('unmatchedValues');
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.getAll('geo')).toEqual([
      'DE',
      'FR',
    ]);
  });
});
