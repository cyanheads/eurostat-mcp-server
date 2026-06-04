/**
 * @fileoverview Tests for the eurostat_get_dataset_info tool.
 * @module tests/tools/eurostat-get-dataset-info.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatGetDatasetInfo } from '@/mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';

vi.mock('@/services/eurostat-data/eurostat-data-service.js', () => ({
  getEurostatDataService: vi.fn(),
}));

import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

const mockMeta = {
  code: 'nama_10_gdp',
  label: 'GDP and main components (output, expenditure and income)',
  dimensions: [
    {
      code: 'unit',
      label: 'Unit of measure',
      valuesCount: 12,
      sampleValues: [
        { code: 'CP_MEUR', label: 'Current prices, million euro' },
        { code: 'CLV10_MEUR', label: 'Chain linked volumes (2010), million euro' },
      ],
    },
    {
      code: 'na_item',
      label: 'National accounts indicator (ESA 2010)',
      valuesCount: 25,
      sampleValues: [{ code: 'B1GQ', label: 'Gross domestic product at market prices' }],
    },
    {
      code: 'geo',
      label: 'Geopolitical entity (reporting)',
      valuesCount: 41,
      sampleValues: [
        { code: 'DE', label: 'Germany' },
        { code: 'FR', label: 'France' },
      ],
    },
  ],
  timeRange: { start: '1975', end: '2024' },
  obsCount: 1_100_000,
  lastUpdated: '2026-05-01T00:00:00Z',
  metadataUrl: 'https://ec.europa.eu/eurostat/cache/metadata/en/nama_10_gdp_esms.htm',
};

describe('eurostatGetDatasetInfo', () => {
  beforeEach(() => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(mockMeta),
    } as never);
  });

  it('returns dataset metadata for a valid code', async () => {
    const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
    const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatGetDatasetInfo.handler(input, ctx);
    expect(result.code).toBe('nama_10_gdp');
    expect(result.dimensions).toHaveLength(3);
    expect(result.obsCount).toBe(1_100_000);
    expect(result.timeRange.start).toBe('1975');
  });

  it('throws not_found for an unknown dataset code', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not found'), { data: { reason: 'not_found' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
    const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'nonexistent_xyz' });
    await expect(eurostatGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found', recovery: { hint: expect.stringContaining('nonexistent_xyz') } },
    });
  });

  it('throws async_response with recovery hint for oversized metadata call', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('async response'), { data: { reason: 'async_response' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
    const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'nama_10_gdp' });
    await expect(eurostatGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'async_response', recovery: { hint: expect.stringContaining('retry') } },
    });
  });

  it('formats output with all required fields', () => {
    const blocks = eurostatGetDatasetInfo.format!(mockMeta);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nama_10_gdp');
    expect(text).toContain('GDP and main components');
    expect(text).toContain('1975');
    expect(text).toContain('2024');
    expect(text).toContain('1,100,000');
    expect(text).toContain('unit');
    expect(text).toContain('CP_MEUR');
    expect(text).toContain('esms.htm');
  });

  it('formats sparse metadata without metadataUrl', () => {
    const sparseMeta = {
      ...mockMeta,
      metadataUrl: undefined,
      dimensions: [
        {
          code: 'geo',
          label: 'Geopolitical entity',
          valuesCount: 2,
          sampleValues: [{ code: 'DE', label: 'Germany' }],
        },
      ],
    };
    const blocks = eurostatGetDatasetInfo.format!(sparseMeta);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nama_10_gdp');
    expect(text).not.toContain('Metadata:');
  });

  it('formats hint when dimension has more values than sample', () => {
    const blocks = eurostatGetDatasetInfo.format!(mockMeta);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    // unit has 12 values but only 2 samples shown — expect "more" hint
    expect(text).toContain('more');
    expect(text).toContain('eurostat_get_dimension_values');
  });
});
