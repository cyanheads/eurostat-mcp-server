/**
 * @fileoverview Tests for the eurostat_search_datasets tool.
 * @module tests/tools/eurostat-search-datasets.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatSearchDatasets } from '@/mcp-server/tools/definitions/eurostat-search-datasets.tool.js';

// Mock the catalogue service
vi.mock('@/services/eurostat-catalogue/eurostat-catalogue-service.js', () => ({
  getEurostatCatalogueService: vi.fn(),
}));

import { getEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';

const mockDatasets = [
  {
    code: 'nama_10_gdp',
    label: 'GDP and main components',
    type: 'dataset' as const,
    dataStart: '1975',
    dataEnd: '2024',
    lastUpdated: '01.05.2026',
    obsCount: 1_100_000,
    themePath: ['Economy and finance', 'National accounts'],
  },
  {
    code: 'nama_10_a10',
    label: 'National accounts by industry',
    type: 'dataset' as const,
    themePath: ['Economy and finance', 'National accounts'],
  },
];

describe('eurostatSearchDatasets', () => {
  beforeEach(() => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      search: vi.fn().mockResolvedValue({ datasets: mockDatasets, totalMatches: 2 }),
    } as never);
  });

  it('returns matching datasets', async () => {
    const ctx = createMockContext({ errors: eurostatSearchDatasets.errors });
    const input = eurostatSearchDatasets.input.parse({ query: 'GDP' });
    const result = await eurostatSearchDatasets.handler(input, ctx);
    expect(result.datasets).toHaveLength(2);
    expect(result.datasets[0]?.code).toBe('nama_10_gdp');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalMatches).toBe(2);
    expect(enrichment.query).toBe('GDP');
  });

  it('throws no_match when no datasets found', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      search: vi.fn().mockResolvedValue({ datasets: [], totalMatches: 0 }),
    } as never);
    const ctx = createMockContext({ errors: eurostatSearchDatasets.errors });
    const input = eurostatSearchDatasets.input.parse({ query: 'nonexistent_xyz_123' });
    await expect(eurostatSearchDatasets.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_match' },
    });
  });

  it('applies default limit of 20', () => {
    const input = eurostatSearchDatasets.input.parse({ query: 'GDP' });
    expect(input.limit).toBe(20);
  });

  it('formats output with all relevant fields', () => {
    const result = {
      datasets: mockDatasets,
    };
    const blocks = eurostatSearchDatasets.format!(result);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Showing 2 results');
    expect(text).toContain('nama_10_gdp');
    expect(text).toContain('GDP and main components');
    expect(text).toContain('Economy and finance');
    expect(text).toContain('1975');
  });

  it('formats output without optional fields', () => {
    const sparseResult = {
      datasets: [{ code: 'abc', label: 'Test dataset', type: 'table' as const, themePath: [] }],
    };
    const blocks = eurostatSearchDatasets.format!(sparseResult);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('abc');
    expect(text).toContain('Test dataset');
  });
});
