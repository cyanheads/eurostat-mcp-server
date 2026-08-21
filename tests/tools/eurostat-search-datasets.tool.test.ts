/**
 * @fileoverview Tests for the eurostat_search_datasets tool.
 * @module tests/tools/eurostat-search-datasets.tool.test
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
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
    // nextStep is unconditional on a successful (non-throwing) search.
    expect(result.nextStep).toBeDefined();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalMatches).toBe(2);
    expect(enrichment.query).toBe('GDP');
    // No nextCursor from the service → last page, not truncated.
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.nextCursor).toBeUndefined();
  });

  it('forwards the cursor and surfaces pagination enrichment', async () => {
    const mockSearch = vi
      .fn()
      .mockResolvedValue({ datasets: mockDatasets, totalMatches: 250, nextCursor: 'CURSOR_2' });
    vi.mocked(getEurostatCatalogueService).mockReturnValue({ search: mockSearch } as never);
    const ctx = createMockContext({ errors: eurostatSearchDatasets.errors });
    const input = eurostatSearchDatasets.input.parse({ query: 'GDP', cursor: 'CURSOR_1' });
    await eurostatSearchDatasets.handler(input, ctx);
    // Cursor and limit (page size) forwarded to the service.
    expect(mockSearch).toHaveBeenCalledWith('GDP', 20, 'CURSOR_1', ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalMatches).toBe(250);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.nextCursor).toBe('CURSOR_2');
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

  it('advertises an open-world annotation for its live catalogue dependency (#29)', () => {
    expect(eurostatSearchDatasets.annotations?.openWorldHint).toBe(true);
    expect(eurostatSearchDatasets.annotations?.readOnlyHint).toBe(true);
  });

  it('rejects a whitespace-only query at parse time (#24)', () => {
    expect(() => eurostatSearchDatasets.input.parse({ query: '   ' })).toThrow();
    expect(() => eurostatSearchDatasets.input.parse({ query: '\t\n' })).toThrow();
  });

  it('keeps a query with surrounding whitespace around a real term (#24)', () => {
    expect(() => eurostatSearchDatasets.input.parse({ query: '  GDP  ' })).not.toThrow();
  });

  it('surfaces invalid_cursor when the service rejects a mismatched cursor (#28)', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      search: vi.fn().mockRejectedValue(
        Object.assign(new Error('This pagination cursor was issued for a different search'), {
          data: { reason: 'invalid_cursor' },
        }),
      ),
    } as never);
    const ctx = createMockContext({ errors: eurostatSearchDatasets.errors });
    const input = eurostatSearchDatasets.input.parse({ query: 'inflation', cursor: 'STALE' });
    const err = (await Promise.resolve(eurostatSearchDatasets.handler(input, ctx)).catch(
      (e: unknown) => e,
    )) as McpError;
    expect(err).toMatchObject({ data: { reason: 'invalid_cursor' } });
    expect((err.data as { recovery: { hint: string } }).recovery.hint).toContain(
      'without a cursor',
    );
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

  it('renders the nextStep hint when present', () => {
    const result = {
      datasets: mockDatasets,
      nextStep: 'Pass a "code" value to eurostat_get_dataset_info to inspect dimensions.',
    };
    const blocks = eurostatSearchDatasets.format!(result);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Next step');
    expect(text).toContain('eurostat_get_dataset_info');
  });
});
