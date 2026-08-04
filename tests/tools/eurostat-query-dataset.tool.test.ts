/**
 * @fileoverview Tests for the eurostat_query_dataset tool.
 * @module tests/tools/eurostat-query-dataset.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatQueryDataset } from '@/mcp-server/tools/definitions/eurostat-query-dataset.tool.js';

vi.mock('@/services/eurostat-data/eurostat-data-service.js', () => ({
  getEurostatDataService: vi.fn(),
}));

import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

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
    const enrichment = getEnrichment(ctx);
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

    const enrichment = getEnrichment(ctx);
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
