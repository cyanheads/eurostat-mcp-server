/**
 * @fileoverview Tests for the eurostat-dataset resource.
 * @module tests/resources/eurostat-dataset.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatDatasetResource } from '@/mcp-server/resources/definitions/eurostat-dataset.resource.js';

vi.mock('@/services/eurostat-data/eurostat-data-service.js', () => ({
  getEurostatDataService: vi.fn(),
}));

import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

const mockMeta = {
  code: 'nama_10_gdp',
  label: 'GDP and main components',
  dimensions: [
    {
      code: 'unit',
      label: 'Unit of measure',
      valuesCount: 12,
      sampleValues: [{ code: 'CP_MEUR', label: 'Current prices, million euro' }],
    },
  ],
  timeRange: { start: '1975', end: '2024' },
  obsCount: 1_100_000,
  lastUpdated: '2026-05-01T00:00:00Z',
  metadataUrl: 'https://ec.europa.eu/eurostat/cache/metadata/en/nama_10_gdp_esms.htm',
};

const resourceParams = eurostatDatasetResource.params;
if (!resourceParams) throw new Error('eurostatDatasetResource must declare params');

describe('eurostatDatasetResource', () => {
  beforeEach(() => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(mockMeta),
    } as never);
  });

  it('returns metadata for a valid dataset_code', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    expect(result).toMatchObject({
      code: 'nama_10_gdp',
      label: 'GDP and main components',
      obsCount: 1_100_000,
    });
  });

  it('delegates to the data service with correct dataset code', async () => {
    const mockGetInfo = vi.fn().mockResolvedValue(mockMeta);
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: mockGetInfo,
    } as never);
    const ctx = createMockContext({ tenantId: 'test' });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    await eurostatDatasetResource.handler(params, ctx);
    expect(mockGetInfo).toHaveBeenCalledWith('nama_10_gdp', ctx);
  });

  it('propagates service errors to the caller', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockRejectedValue(new Error('Dataset not found')),
    } as never);
    const ctx = createMockContext({ tenantId: 'test' });
    const params = resourceParams.parse({ dataset_code: 'nonexistent_xyz' });
    await expect(eurostatDatasetResource.handler(params, ctx)).rejects.toThrow('Dataset not found');
  });

  it('carries the real time period count through to the caller', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue({
        ...mockMeta,
        dimensions: [
          ...mockMeta.dimensions,
          {
            code: 'time',
            label: 'Time',
            valuesCount: 51,
            sampleValues: [{ code: '1975', label: '1975' }],
          },
        ],
      }),
    } as never);
    const ctx = createMockContext({ tenantId: 'test' });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    expect(result.dimensions.find((d) => d.code === 'time')?.valuesCount).toBe(51);
  });

  it('advertises the annotation-derived fields as optional in the output schema', () => {
    const parsed = eurostatDatasetResource.output!.parse({
      code: 'xyz',
      label: 'Sparse dataset',
      dimensions: [],
      timeRange: {},
    });
    expect(parsed.obsCount).toBeUndefined();
    expect(parsed.lastUpdated).toBeUndefined();
    expect(parsed.timeRange).toEqual({});
  });

  it('omits annotation-derived fields absent from the upstream metadata', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue({
        code: 'xyz',
        label: 'Sparse dataset',
        dimensions: [],
        timeRange: {},
      }),
    } as never);
    const ctx = createMockContext({ tenantId: 'test' });
    const params = resourceParams.parse({ dataset_code: 'xyz' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    // Absent upstream annotations must not surface as 0 / '' — the resource schema declares
    // these optional so a consumer can tell "unknown" from "zero".
    expect(result.obsCount).toBeUndefined();
    expect(result.lastUpdated).toBeUndefined();
    expect(result.timeRange.start).toBeUndefined();
    expect(result.timeRange.end).toBeUndefined();
  });

  it('advertises a dimension value set as optional in the output schema (#34)', () => {
    // Declared independently of the tool's schema — both must accept the same payload, or
    // the resource is the surface that cannot represent an unmeasured period count.
    const parsed = eurostatDatasetResource.output!.parse({
      code: 'nama_10_gdp',
      label: 'GDP',
      dimensions: [{ code: 'time', label: 'Time' }],
      timeRange: {},
    });
    expect(parsed.dimensions[0]?.valuesCount).toBeUndefined();
    expect(parsed.dimensions[0]?.sampleValues).toBeUndefined();
  });

  it('carries an unmeasured time period count through as omitted, not as one (#34)', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue({
        ...mockMeta,
        dimensions: [...mockMeta.dimensions, { code: 'time', label: 'Time' }],
      }),
    } as never);
    const ctx = createMockContext({ tenantId: 'test' });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    const time = result.dimensions.find((d) => d.code === 'time');
    expect(time?.valuesCount).toBeUndefined();
    expect(time?.valuesCount).not.toBe(1);
    // Everything the first metadata request carried is still here.
    expect(result.obsCount).toBe(1_100_000);
    expect(result.dimensions.find((d) => d.code === 'unit')?.valuesCount).toBe(12);
  });

  it('handles sparse metadata without metadataUrl', async () => {
    const sparseMeta = { ...mockMeta, metadataUrl: undefined };
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(sparseMeta),
    } as never);
    const ctx = createMockContext({ tenantId: 'test' });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    expect(result.metadataUrl).toBeUndefined();
    expect(result.code).toBe('nama_10_gdp');
  });
});
