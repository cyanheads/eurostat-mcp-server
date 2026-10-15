/**
 * @fileoverview Tests for the eurostat_browse_themes tool.
 * @module tests/tools/eurostat-browse-themes.tool.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatBrowseThemes } from '@/mcp-server/tools/definitions/eurostat-browse-themes.tool.js';

// Only the accessor is replaced, so a test can hand the tool the real service class.
vi.mock('@/services/eurostat-catalogue/eurostat-catalogue-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/eurostat-catalogue/eurostat-catalogue-service.js')
  >()),
  getEurostatCatalogueService: vi.fn(),
}));

import {
  EurostatCatalogueService,
  getEurostatCatalogueService,
} from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';

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

/** The partial-catalogue disclosures (#63), read through the production result. */
describe('eurostatBrowseThemes — disclosing a partial catalogue', () => {
  const serve = (browsed: Record<string, unknown>) =>
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi.fn().mockResolvedValue(browsed),
    } as never);
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  const LOADED_AT = '2026-10-14T23:35:00.000Z';

  it('keeps a healthy browse free of disclosure fields (characterization)', async () => {
    serve({ items: mockChildItems, parentPath: ['Economy and finance'] });
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'econ' });
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual([
      'itemCount',
      'items',
      'nextStep',
      'parentPath',
      'themeCode',
    ]);
  });

  it('discloses an unmerged Comext list on both surfaces, outside the domain fields', async () => {
    serve({ items: mockChildItems, parentPath: ['International trade'], comextListMissing: true });
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'ext_go' });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.comextListMissing).toBe(true);
    expect(structured.items).toEqual(mockChildItems);
    expect(structured.itemCount).toBe(2);
    const notice = structured.notice as string;
    expect(notice).toContain('Comext dataflow list could not be loaded');
    expect(notice).toContain('retried about once a minute');
    expect(notice).toContain('eurostat_get_dataset_info reads a DS-* code directly');
    expect(textOf(result)).toContain(notice);
  });

  it('discloses a stale catalogue with its load time, in one notice beside the Comext sentence', async () => {
    serve({
      items: mockRootItems,
      parentPath: [],
      comextListMissing: true,
      catalogueLoadedAt: LOADED_AT,
    });
    const result = await runToolContract(eurostatBrowseThemes, {});
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.catalogueLoadedAt).toBe(LOADED_AT);
    expect(structured.notice).toMatch(/could not be loaded.*could not be refreshed/s);
    expect(structured.notice).toContain(LOADED_AT);
    expect(textOf(result)).toContain(structured.notice as string);
  });

  it('points at the Comext merge, not the root themes, for a Comext code missing from the catalogue', async () => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi
        .fn()
        .mockRejectedValue(
          new McpError(
            JsonRpcErrorCode.NotFound,
            'Theme "prom" comes from the Comext dataflow list, which could not be loaded, so it is not in the catalogue right now.',
            { reason: 'not_found', themeCode: 'prom', comextListMissing: true },
          ),
        ),
    } as never);
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'prom' });
    const error = (
      result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason: string; recovery: { hint: string } };
        };
      }
    ).error;
    expect(error).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
    expect(error.data.recovery.hint).toBe(
      'The Comext dataflow list merge is retried about once a minute: browse "prom" again after that. eurostat_get_dataset_info reads a DS-* code directly.',
    );
    expect(textOf(result)).toContain('comes from the Comext dataflow list');
    expect(textOf(result)).toContain(`Recovery: ${error.data.recovery.hint}`);
  });

  const STALE = `The catalogue could not be refreshed, so this lookup ran against the copy loaded at ${LOADED_AT}; folders Eurostat added since then are not in it.`;
  const notFoundFrom = (data: Record<string, unknown>) =>
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      browse: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Theme not found.', {
          reason: 'not_found',
          ...data,
        }),
      ),
    } as never);
  const hintOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { error: { data: { recovery: { hint: string } } } }).error.data
      .recovery.hint;

  it('discloses a stale catalogue on not_found, ahead of the root-themes route', async () => {
    notFoundFrom({ themeCode: 'trd', catalogueLoadedAt: LOADED_AT });
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'trd' });
    expect(hintOf(result)).toBe(
      `${STALE} Call eurostat_browse_themes without theme_code to see valid root themes, then navigate from there.`,
    );
    expect(textOf(result)).toContain(STALE);
  });

  it('follows the Comext disclosure with the stale one on a Comext not_found', async () => {
    notFoundFrom({ themeCode: 'prom', comextListMissing: true, catalogueLoadedAt: LOADED_AT });
    const hint = hintOf(await runToolContract(eurostatBrowseThemes, { theme_code: 'prom' }));
    expect(hint).toMatch(/^The Comext dataflow list merge is retried about once a minute/);
    expect(hint.endsWith(STALE)).toBe(true);
  });
});

/**
 * not_found from the real catalogue service over the recorded 2026-10-14 TOC excerpt
 * (#63): fresh, then past the TTL with a refresh that fails, so the expired copy answers.
 */
describe('eurostatBrowseThemes — not_found from the real catalogue service', () => {
  const excerpt = readFileSync(
    new URL('../fixtures/toc-2026-10-14-excerpt.tsv', import.meta.url),
    'utf8',
  );
  const hintOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (
      result.structuredContent as {
        error: { data: { reason: string; recovery: { hint: string } } };
      }
    ).error.data;
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => ('text' in block ? block.text : '')).join('\n');

  /** A service holding the excerpt, loaded `ageMs` ago, whose refresh fails; `merged` false leaves Comext unmerged. */
  function serveCatalogue(ageMs: number, merged = true): string {
    const service = new EurostatCatalogueService({} as never, {} as never);
    const internals = service as unknown as {
      buildCache(entries: unknown, flows: unknown[] | undefined, loadedAt: Date): unknown;
      cache: unknown;
      fetchAndParseToc(): Promise<unknown>;
      parseToc(text: string): unknown;
    };
    const loadedAt = new Date(Date.now() - ageMs);
    internals.cache = internals.buildCache(
      internals.parseToc(excerpt),
      merged ? [] : undefined,
      loadedAt,
    );
    vi.spyOn(internals, 'fetchAndParseToc').mockRejectedValue(new Error('Eurostat unreachable'));
    vi.mocked(getEurostatCatalogueService).mockReturnValue(service);
    return loadedAt.toISOString();
  }
  const EXPIRED = 13 * 60 * 60 * 1000;
  const stale = (loadedAt: string) =>
    `The catalogue could not be refreshed, so this lookup ran against the copy loaded at ${loadedAt}; folders Eurostat added since then are not in it.`;

  it('keeps the root-themes hint alone for a catalogue inside its TTL (characterization)', async () => {
    serveCatalogue(0);
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'zz_missing' });
    expect(hintOf(result)).toMatchObject({
      reason: 'not_found',
      recovery: {
        hint: 'Call eurostat_browse_themes without theme_code to see valid root themes, then navigate from there.',
      },
    });
  });

  it('discloses the expired copy a failed refresh holds in service, on both surfaces', async () => {
    const loadedAt = serveCatalogue(EXPIRED);
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'zz_missing' });
    expect(result.isError).toBe(true);
    expect(hintOf(result)).toMatchObject({
      reason: 'not_found',
      recovery: {
        hint: `${stale(loadedAt)} Call eurostat_browse_themes without theme_code to see valid root themes, then navigate from there.`,
      },
    });
    expect(textOf(result)).toContain(stale(loadedAt));
  });

  it('discloses it after the Comext sentence for a Comext folder while the list is unmerged', async () => {
    const loadedAt = serveCatalogue(EXPIRED, false);
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'prom' });
    expect(hintOf(result).recovery.hint).toBe(
      `The Comext dataflow list merge is retried about once a minute: browse "prom" again after that. eurostat_get_dataset_info reads a DS-* code directly. ${stale(loadedAt)}`,
    );
  });
});

/** A cold start against a catalogue host that is down: no copy to fall back on (#71). */
describe('eurostatBrowseThemes — an unavailable catalogue host on a cold start (#71)', () => {
  /** Browse through a fresh real service over a stubbed `fetch`, past the TOC's retry backoff. */
  async function browseColdStart(fetchImpl: () => Promise<Response>) {
    vi.mocked(getEurostatCatalogueService).mockReturnValue(
      new EurostatCatalogueService({} as never, {} as never),
    );
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    try {
      const pending = runToolContract(eurostatBrowseThemes, {});
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      const error = (
        result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
      ).error;
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      return { error, text };
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }

  it('fails a TOC answering 503 on every attempt as a retryable upstream_fault on both surfaces', async () => {
    const { error, text } = await browseColdStart(
      async () => new Response('Service Unavailable', { status: 503, statusText: 'Unavailable' }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toContain('HTTP 503');
    expect(hint).toMatch(/retry in a few minutes/i);
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('reason upstream_fault · retryable');
  });

  it('fails an unreachable host the same way', async () => {
    const { error, text } = await browseColdStart(async () => {
      throw new TypeError('fetch failed');
    });
    expect(error.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
    expect((error.data.recovery as { hint: string }).hint).toContain('could not be reached');
    expect(text).toContain('reason upstream_fault · retryable');
  });
});
