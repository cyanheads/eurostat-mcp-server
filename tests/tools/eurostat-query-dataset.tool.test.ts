/**
 * @fileoverview Tests for the eurostat_query_dataset tool.
 * @module tests/tools/eurostat-query-dataset.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
      data: { reason: 'not_found' },
    });
  });

  it('throws no_results when the filter combination matches nothing', async () => {
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
      data: { reason: 'no_results' },
    });
  });

  it('throws async_response when query is too large', async () => {
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
      data: { reason: 'async_response' },
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

  it('formats truncation note when observations exceed 200', () => {
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
    expect(text).toContain('5 more observations not shown');
  });
});
