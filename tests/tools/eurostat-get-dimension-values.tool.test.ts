/**
 * @fileoverview Tests for the eurostat_get_dimension_values tool.
 * @module tests/tools/eurostat-get-dimension-values.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatGetDimensionValues } from '@/mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';

vi.mock('@/services/eurostat-data/eurostat-data-service.js', () => ({
  getEurostatDataService: vi.fn(),
}));

import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

const mockUnitResult = {
  dimensionCode: 'unit',
  dimensionLabel: 'Unit of measure',
  values: [
    { code: 'CP_MEUR', label: 'Current prices, million euro' },
    { code: 'CLV10_MEUR', label: 'Chain linked volumes (2010), million euro' },
    { code: 'PPS_EU27_2020', label: 'Purchasing power standard (EU27_2020)' },
  ],
  totalCount: 3,
};

const mockGeoResult = {
  dimensionCode: 'geo',
  dimensionLabel: 'Geopolitical entity (reporting)',
  geoLevel: 'country' as const,
  values: [
    { code: 'DE', label: 'Germany' },
    { code: 'FR', label: 'France' },
    { code: 'IT', label: 'Italy' },
  ],
  totalCount: 3,
};

describe('eurostatGetDimensionValues', () => {
  beforeEach(() => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue(mockUnitResult),
    } as never);
  });

  it('returns dimension values for valid inputs', async () => {
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'unit',
    });
    const result = await eurostatGetDimensionValues.handler(input, ctx);
    expect(result.dimensionCode).toBe('unit');
    expect(result.values).toHaveLength(3);
    expect(result.totalCount).toBe(3);
    expect(result.values[0]?.code).toBe('CP_MEUR');
  });

  it('passes geo_level to service when provided', async () => {
    const mockGetDimValues = vi.fn().mockResolvedValue(mockGeoResult);
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: mockGetDimValues,
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'geo',
      geo_level: 'country',
    });
    await eurostatGetDimensionValues.handler(input, ctx);
    expect(mockGetDimValues).toHaveBeenCalledWith('nama_10_gdp', 'geo', 'country', ctx);
  });

  it('passes undefined geo_level when not provided', async () => {
    const mockGetDimValues = vi.fn().mockResolvedValue(mockUnitResult);
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: mockGetDimValues,
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'unit',
    });
    await eurostatGetDimensionValues.handler(input, ctx);
    expect(mockGetDimValues).toHaveBeenCalledWith('nama_10_gdp', 'unit', undefined, ctx);
  });

  it('throws not_found for invalid dataset or dimension code', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not found'), { data: { reason: 'not_found' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nonexistent_xyz',
      dimension: 'unit',
    });
    await expect(eurostatGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found', recovery: { hint: expect.stringContaining('nonexistent_xyz') } },
    });
  });

  it('surfaces async_response with a dimension-contextual recovery hint', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('async response'), { data: { reason: 'async_response' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'time',
    });
    await expect(eurostatGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'async_response',
        recovery: { hint: expect.stringContaining('nama_10_gdp') },
      },
    });
  });

  it('surfaces conflicting_params when geo_level is sent with a non-geo dimension', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockRejectedValue(
        Object.assign(new Error('geo_level does not apply to "unit"'), {
          data: { reason: 'conflicting_params' },
        }),
      ),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'unit',
      geo_level: 'nuts3',
    });
    // Previously this succeeded with geo_level silently ignored; the caller now hears about it.
    await expect(eurostatGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'conflicting_params',
        recovery: { hint: expect.stringContaining('unit') },
      },
    });
  });

  it('surfaces a level-specific no_results contract for an empty geo level (#38)', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockRejectedValue(
        Object.assign(new Error('No country values'), {
          data: { reason: 'no_results', geoLevel: 'country' },
        }),
      ),
    } as never);
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'tgs00010',
      dimension: 'geo',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_results',
          recovery: { hint: expect.stringContaining('country') },
        },
      },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('Recovery:') }),
    );
  });

  it('carries the effective geo level through structuredContent and content', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue(mockGeoResult),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'earn_ses_annual',
      dimension: 'geo',
    });
    const result = await eurostatGetDimensionValues.handler(input, ctx);
    expect(eurostatGetDimensionValues.output.parse(result).geoLevel).toBe('country');
    const text = eurostatGetDimensionValues.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('country');
  });

  it('formats output with all values', () => {
    const blocks = eurostatGetDimensionValues.format!(mockUnitResult);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('unit');
    expect(text).toContain('Unit of measure');
    expect(text).toContain('3');
    expect(text).toContain('CP_MEUR');
    expect(text).toContain('Current prices, million euro');
  });

  it('formats geo dimension values correctly', () => {
    const blocks = eurostatGetDimensionValues.format!(mockGeoResult);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('geo');
    expect(text).toContain('DE');
    expect(text).toContain('Germany');
    expect(text).toContain('FR');
  });
});
