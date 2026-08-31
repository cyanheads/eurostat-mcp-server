/**
 * @fileoverview Tests for the eurostat_browse_themes tool.
 * @module tests/tools/eurostat-browse-themes.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('advertises an open-world annotation for its live catalogue dependency (#29)', () => {
    expect(eurostatBrowseThemes.annotations?.openWorldHint).toBe(true);
    expect(eurostatBrowseThemes.annotations?.readOnlyHint).toBe(true);
  });

  it('returns root themes when no theme_code provided', async () => {
    const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
    const input = eurostatBrowseThemes.input.parse({});
    const result = await eurostatBrowseThemes.handler(input, ctx);
    expect(result.items).toHaveLength(2);
    expect(result.parentPath).toEqual([]);
    expect(result.items[0]?.code).toBe('econ');
    // Folder-only listing → drill-into-sub-themes hint (#13, folder branch).
    expect(result.nextStep).toContain('sub-themes');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.itemCount).toBe(2);
    expect(enrichment.themeCode).toBeUndefined();
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
    // Listing contains a queryable dataset → inspect-dimensions hint (#13, dataset branch).
    expect(result.nextStep).toContain('eurostat_get_dataset_info');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.itemCount).toBe(2);
    expect(enrichment.themeCode).toBe('econ');
  });

  it('omits nextStep for an empty folder (#13, empty branch)', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi.fn().mockResolvedValue({ items: [], parentPath: ['Economy and finance'] }),
    } as never);
    const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
    const input = eurostatBrowseThemes.input.parse({ theme_code: 'empty_folder' });
    const result = await eurostatBrowseThemes.handler(input, ctx);
    expect(result.items).toHaveLength(0);
    expect(result.nextStep).toBeUndefined();
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
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('eurostat_browse_themes') },
      },
    });
  });

  it('keeps root navigation aligned across structuredContent and content[]', async () => {
    const result = await runToolContract(eurostatBrowseThemes, {});

    expect(result.structuredContent).toMatchObject({
      items: mockRootItems,
      parentPath: [],
      nextStep: expect.stringContaining('sub-themes'),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('econ');
    expect(text).toContain('pop');
    expect(text).toContain('sub-themes');
  });

  it('treats an empty theme_code as root navigation on both response paths', async () => {
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: '   ' });

    expect(result.structuredContent).toMatchObject({ items: mockRootItems, parentPath: [] });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('econ');
    expect(text).not.toContain('**Path:**');
  });

  it('keeps folder navigation aligned across structuredContent and content[]', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi.fn().mockResolvedValue({
        items: mockChildItems,
        parentPath: ['Economy and finance'],
      }),
    } as never);

    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'econ' });

    expect(result.structuredContent).toMatchObject({
      items: mockChildItems,
      parentPath: ['Economy and finance'],
      nextStep: expect.stringContaining('eurostat_get_dataset_info'),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('Economy and finance');
    expect(text).toContain('nama_10_gdp');
    expect(text).toContain('eurostat_get_dataset_info');
  });

  it('preserves not_found and root recovery on both error response paths', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Theme "nonexistent_xyz" not found.', {
          reason: 'not_found',
          themeCode: 'nonexistent_xyz',
        }),
      ),
    } as never);

    const result = await runToolContract(eurostatBrowseThemes, {
      theme_code: 'nonexistent_xyz',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'not_found',
          recovery: { hint: expect.stringContaining('without theme_code') },
        },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('nonexistent_xyz');
    expect(text).toContain('eurostat_browse_themes without theme_code');
  });

  it.each([
    ['dataset', 'nama_10_gdp'],
    ['table', 'nama_10_gdp_t'],
  ] as const)(
    'preserves not_a_folder recovery for a known %s code on both error response paths',
    async (entryType, themeCode) => {
      vi.mocked(getEurostatCatalogueService).mockReturnValue({
        browse: vi
          .fn()
          .mockRejectedValue(
            new McpError(
              JsonRpcErrorCode.ValidationError,
              `Theme code "${themeCode}" identifies a ${entryType}, not a folder.`,
              { reason: 'not_a_folder', themeCode, entryType },
            ),
          ),
      } as never);

      const result = await runToolContract(eurostatBrowseThemes, { theme_code: themeCode });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining(entryType),
          data: {
            reason: 'not_a_folder',
            themeCode,
            entryType,
            recovery: {
              hint: expect.stringMatching(/eurostat_get_dataset_info.*eurostat_query_dataset/i),
            },
          },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain(themeCode);
      expect(text).toContain(entryType);
      expect(text).toMatch(/eurostat_get_dataset_info.*eurostat_query_dataset/is);
    },
  );

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

  it('renders both hasChildren states explicitly (has children / no children)', () => {
    const result = {
      items: [
        { code: 'econ', label: 'Economy', type: 'folder' as const, hasChildren: true },
        { code: 'ds1', label: 'A dataset', type: 'dataset' as const, hasChildren: false },
      ],
      parentPath: [],
    };
    const blocks = eurostatBrowseThemes.format!(result);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    // The false state was previously silent — now both boolean states render.
    expect(text).toContain('(has children)');
    expect(text).toContain('(no children)');
  });

  it('passes the other placements of an ambiguous code through to the caller (#32)', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi.fn().mockResolvedValue({
        items: mockChildItems,
        parentPath: ['Database by themes', 'Health and safety'],
        otherPlacements: [['Cross cutting topics', 'Health and safety']],
      }),
    } as never);
    const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
    const input = eurostatBrowseThemes.input.parse({ theme_code: 'hsw_ac' });
    const result = await eurostatBrowseThemes.handler(input, ctx);
    expect(result.otherPlacements).toEqual([['Cross cutting topics', 'Health and safety']]);
  });

  it('advertises otherPlacements as an optional output field (#32)', () => {
    // The wire contract: unambiguous codes — the overwhelming majority — must validate
    // without it, and an ambiguous one must be able to carry its breadcrumbs.
    expect(
      eurostatBrowseThemes.output.parse({ items: [], parentPath: [] }).otherPlacements,
    ).toBeUndefined();
    expect(
      eurostatBrowseThemes.output.parse({
        items: [],
        parentPath: ['Database by themes'],
        otherPlacements: [['Cross cutting topics']],
      }).otherPlacements,
    ).toEqual([['Cross cutting topics']]);
  });

  it('omits otherPlacements when the code has one placement (#32)', async () => {
    const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
    const input = eurostatBrowseThemes.input.parse({ theme_code: 'econ' });
    const result = await eurostatBrowseThemes.handler(input, ctx);
    expect(result.otherPlacements).toBeUndefined();
  });

  it('names the branches it did not take on the content[] surface (#32)', () => {
    const blocks = eurostatBrowseThemes.format!({
      items: mockChildItems,
      parentPath: ['Database by themes', 'Health and safety'],
      otherPlacements: [['Cross cutting topics', 'Health and safety']],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Also filed under');
    expect(text).toContain('Cross cutting topics › Health and safety');
    expect(text).toContain('1 other branch');
  });

  it('says nothing about placements for an unambiguous code (#32)', () => {
    const blocks = eurostatBrowseThemes.format!({ items: mockRootItems, parentPath: [] });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toContain('Also filed under');
  });

  it('renders the nextStep hint when present', () => {
    const result = {
      items: mockRootItems,
      parentPath: [],
      nextStep: 'Pass a folder code back to theme_code to drill into sub-themes.',
    };
    const blocks = eurostatBrowseThemes.format!(result);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Next step');
    expect(text).toContain('sub-themes');
  });
});
