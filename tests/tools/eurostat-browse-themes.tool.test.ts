/**
 * @fileoverview Tests for the eurostat_browse_themes tool.
 * @module tests/tools/eurostat-browse-themes.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatBrowseThemes } from '@/mcp-server/tools/definitions/eurostat-browse-themes.tool.js';

vi.mock('@/services/eurostat-catalogue/eurostat-catalogue-service.js', () => ({
  getEurostatCatalogueService: vi.fn(),
}));

import { getEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';

const mockRootItems = [
  {
    code: 'econ',
    label: 'Economy and finance',
    type: 'folder' as const,
    hasChildren: true,
  },
  {
    code: 'pop',
    label: 'Population and social conditions',
    type: 'folder' as const,
    hasChildren: true,
  },
];

const mockChildItems = [
  {
    code: 'nama',
    label: 'National accounts',
    type: 'folder' as const,
    hasChildren: true,
  },
  {
    code: 'nama_10_gdp',
    label: 'GDP and main components',
    type: 'dataset' as const,
    hasChildren: false,
    dataStart: '1975',
    dataEnd: '2024',
    obsCount: 1_100_000,
  },
];

describe('eurostatBrowseThemes', () => {
  beforeEach(() => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi.fn().mockResolvedValue({ items: mockRootItems, parentPath: [] }),
    } as never);
  });

  it('returns root themes when no theme_code provided', async () => {
    const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
    const input = eurostatBrowseThemes.input.parse({});
    const result = await eurostatBrowseThemes.handler(input, ctx);
    expect(result.items).toHaveLength(2);
    expect(result.parentPath).toEqual([]);
    expect(result.items[0]?.code).toBe('econ');
  });

  it('returns children and parentPath when theme_code provided', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi.fn().mockResolvedValue({
        items: mockChildItems,
        parentPath: ['Economy and finance'],
      }),
    } as never);
    const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
    const input = eurostatBrowseThemes.input.parse({ theme_code: 'econ' });
    const result = await eurostatBrowseThemes.handler(input, ctx);
    expect(result.items).toHaveLength(2);
    expect(result.parentPath).toEqual(['Economy and finance']);
    expect(result.items[1]?.code).toBe('nama_10_gdp');
  });

  it('throws not_found for an unknown theme_code', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not found'), { data: { reason: 'not_found' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
    const input = eurostatBrowseThemes.input.parse({ theme_code: 'nonexistent_xyz' });
    await expect(eurostatBrowseThemes.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('trims whitespace from theme_code', async () => {
    const mockBrowse = vi.fn().mockResolvedValue({ items: mockRootItems, parentPath: [] });
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: mockBrowse,
    } as never);
    const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
    const input = eurostatBrowseThemes.input.parse({ theme_code: '  econ  ' });
    await eurostatBrowseThemes.handler(input, ctx);
    // verify the service was called with the trimmed code
    expect(mockBrowse).toHaveBeenCalledWith('econ', ctx);
  });

  it('formats root listing without path header', () => {
    const result = { items: mockRootItems, parentPath: [] };
    const blocks = eurostatBrowseThemes.format!(result);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('econ');
    expect(text).toContain('Economy and finance');
    expect(text).toContain('2 items');
    expect(text).not.toContain('**Path:**');
  });

  it('formats child listing with breadcrumb path', () => {
    const result = { items: mockChildItems, parentPath: ['Economy and finance'] };
    const blocks = eurostatBrowseThemes.format!(result);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('**Path:**');
    expect(text).toContain('Economy and finance');
    expect(text).toContain('nama_10_gdp');
    expect(text).toContain('1975');
    expect(text).toContain('1,100,000');
  });

  it('formats sparse items without optional fields', () => {
    const sparseResult = {
      items: [{ code: 'xyz', label: 'Test folder', type: 'folder' as const, hasChildren: false }],
      parentPath: [],
    };
    const blocks = eurostatBrowseThemes.format!(sparseResult);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('xyz');
    expect(text).toContain('Test folder');
    expect(text).not.toContain('Period:');
  });
});
