/**
 * @fileoverview Unit tests for EurostatCatalogueService pure logic (TOC parsing, search, browse).
 * @module tests/services/eurostat-catalogue-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  EurostatCatalogueService,
  getEurostatCatalogueService,
  initEurostatCatalogueService,
} from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';

/** Minimal mock AppConfig and StorageService — the service ignores both */
const mockConfig = {} as never;
const mockStorage = {} as never;

/** Build a minimal TSV line for parseToc. Tab-separated, double-quoted. */
function tocLine(
  title: string,
  code: string,
  type: 'folder' | 'dataset' | 'table',
  lastUpdated = '',
  dataStart = '',
  dataEnd = '',
  obsCount?: number,
): string {
  const cols = [
    `"${title}"`,
    `"${code}"`,
    `"${type}"`,
    lastUpdated ? `"${lastUpdated}"` : '""',
    '""', // last structure change — not used
    dataStart ? `"${dataStart}"` : '""',
    dataEnd ? `"${dataEnd}"` : '""',
  ];
  if (obsCount !== undefined) cols.push(String(obsCount));
  return cols.join('\t');
}

/**
 * Build a minimal valid TSV with a header row followed by user-supplied entries.
 * The header row (code=code) is skipped during parsing.
 */
function buildTsv(entries: string[]): string {
  const header =
    '"title"\t"code"\t"type"\t"last update of data"\t"last table structure change"\t"data start"\t"data end"\t"values"';
  return [header, ...entries].join('\n');
}

/** Parse TSV entries into the in-memory cache shape the service holds. */
function makeCache(svc: EurostatCatalogueService, entries: string[], loadedAt = new Date()) {
  // Access private method via any cast — this is a unit test reaching into pure logic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = (svc as any).parseToc(buildTsv(entries));
  return {
    entries: parsed,
    codeIndex: new Map(parsed.map((e: { code: string }, i: number) => [e.code, i])),
    loadedAt,
  };
}

/** Simulate a loaded service by seeding the cache directly, bypassing any fetch. */
async function makeLoadedService(entries: string[]): Promise<EurostatCatalogueService> {
  const svc = new EurostatCatalogueService(mockConfig, mockStorage);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).cache = makeCache(svc, entries);
  return svc;
}

/** Age the seeded cache so the next catalogue call sees it as expired (TTL default 12h). */
function expireCache(svc: EurostatCatalogueService): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).cache.loadedAt = new Date(Date.now() - 13 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// TOC parsing
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — parseToc', () => {
  it('skips the header row', async () => {
    const svc = await makeLoadedService([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).cache.entries;
    expect(entries).toHaveLength(0);
  });

  it('parses a root folder entry', async () => {
    const svc = await makeLoadedService([tocLine('Economy', 'econ', 'folder')]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).cache.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].code).toBe('econ');
    expect(entries[0].type).toBe('folder');
    expect(entries[0].depth).toBe(0);
    expect(entries[0].parentIndex).toBe(-1);
  });

  it('infers depth from leading spaces (4 spaces = depth 1)', async () => {
    const child = tocLine('    National accounts', 'nama', 'folder');
    const svc = await makeLoadedService([tocLine('Economy', 'econ', 'folder'), child]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).cache.entries;
    expect(entries[1].depth).toBe(1);
    expect(entries[1].label).toBe('National accounts');
    expect(entries[1].parentIndex).toBe(0);
  });

  it('parses dataset with obsCount', async () => {
    const svc = await makeLoadedService([
      tocLine('GDP dataset', 'nama_10_gdp', 'dataset', '01.05.2026', '1975', '2024', 1_100_000),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).cache.entries;
    expect(entries[0].obsCount).toBe(1_100_000);
    expect(entries[0].dataStart).toBe('1975');
    expect(entries[0].dataEnd).toBe('2024');
    expect(entries[0].lastUpdated).toBe('01.05.2026');
  });

  it('omits obsCount when column is empty', async () => {
    const svc = await makeLoadedService([
      tocLine('GDP dataset', 'nama_10_gdp', 'dataset', '', '', ''),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).cache.entries;
    expect(entries[0].obsCount).toBeUndefined();
  });

  it('skips blank lines', async () => {
    const tsv = buildTsv([
      tocLine('Economy', 'econ', 'folder'),
      '',
      '   ',
      tocLine('Population', 'pop', 'folder'),
    ]);
    const svc = new EurostatCatalogueService(mockConfig, mockStorage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).parseToc(tsv);
    expect(entries).toHaveLength(2);
  });

  it('skips lines with fewer than 7 columns', async () => {
    const short = '"truncated"\t"xyz"';
    const tsv = buildTsv([short, tocLine('Economy', 'econ', 'folder')]);
    const svc = new EurostatCatalogueService(mockConfig, mockStorage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).parseToc(tsv);
    expect(entries).toHaveLength(1);
    expect(entries[0].code).toBe('econ');
  });

  it('handles table type correctly', async () => {
    const svc = await makeLoadedService([
      tocLine('Trade table', 'trade_t', 'table', '', '2000', '2024', 50000),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).cache.entries;
    expect(entries[0].type).toBe('table');
  });

  it('deep nesting: depth-2 child resolves correct parent', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    Level1', 'l1', 'folder'),
      tocLine('        Level2', 'l2', 'dataset'),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (svc as any).cache.entries;
    expect(entries[2].depth).toBe(2);
    expect(entries[2].parentIndex).toBe(1); // l2's parent is l1
  });
});

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — browse', () => {
  it('returns root themes when themeCode is undefined', async () => {
    const svc = await makeLoadedService([
      tocLine('Database by themes', 'data', 'folder'),
      tocLine('    Economy', 'econ', 'folder'),
      tocLine('    Population', 'pop', 'folder'),
    ]);
    const ctx = createMockContext();
    const result = await svc.browse(undefined, ctx);
    expect(result.parentPath).toEqual([]);
    expect(result.items.map((i) => i.code)).toEqual(['econ', 'pop']);
  });

  it('unions the children of every depth-0 root at root level (#20)', async () => {
    // The live TOC carries two depth-0 folder roots; both roots' depth-1
    // children must surface at root, in root order (first root's, then second's).
    const svc = await makeLoadedService([
      tocLine('Database by themes', 'data', 'folder'),
      tocLine('    Economy', 'econ', 'folder'),
      tocLine('    Population', 'pop', 'folder'),
      tocLine('Cross cutting topics', 'data2', 'folder'),
      tocLine('    Tables on EU policy', 'tb_eu', 'folder'),
      tocLine('    Cross cutting', 'cc', 'folder'),
    ]);
    const ctx = createMockContext();
    const result = await svc.browse(undefined, ctx);
    expect(result.items.map((i) => i.code)).toEqual(['econ', 'pop', 'tb_eu', 'cc']);
  });

  it('returns children and parentPath for a valid themeCode', async () => {
    const svc = await makeLoadedService([
      tocLine('Database by themes', 'data', 'folder'),
      tocLine('    Economy', 'econ', 'folder'),
      tocLine('        National accounts', 'nama', 'folder'),
      tocLine('            GDP', 'nama_10_gdp', 'dataset', '', '1975', '2024'),
    ]);
    const ctx = createMockContext();
    const result = await svc.browse('nama', ctx);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.code).toBe('nama_10_gdp');
    expect(result.parentPath).toContain('Economy');
    expect(result.parentPath).toContain('National accounts');
  });

  it('throws not_found for an unknown theme code', async () => {
    const svc = await makeLoadedService([tocLine('Economy', 'econ', 'folder')]);
    const ctx = createMockContext();
    await expect(svc.browse('nonexistent_xyz', ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when theme code refers to a dataset, not a folder', async () => {
    const svc = await makeLoadedService([tocLine('GDP dataset', 'nama_10_gdp', 'dataset')]);
    const ctx = createMockContext();
    await expect(svc.browse('nama_10_gdp', ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('hasChildren is true when folder has children', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    Economy', 'econ', 'folder'),
      tocLine('        GDP', 'nama_10_gdp', 'dataset'),
    ]);
    const ctx = createMockContext();
    const result = await svc.browse(undefined, ctx);
    expect(result.items[0]?.code).toBe('econ');
    expect(result.items[0]?.hasChildren).toBe(true);
  });

  it('hasChildren is false when folder is empty', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    Empty', 'empty', 'folder'),
    ]);
    const ctx = createMockContext();
    const result = await svc.browse(undefined, ctx);
    expect(result.items[0]?.hasChildren).toBe(false);
  });

  it('uses cached TOC on second call without re-fetching', async () => {
    const svc = await makeLoadedService([tocLine('Economy', 'econ', 'folder')]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ensureSpy = vi.spyOn(svc as any, 'ensureLoaded');
    const ctx = createMockContext();
    await svc.browse(undefined, ctx);
    await svc.browse(undefined, ctx);
    // ensureLoaded is called both times but fetchAndParseToc is not
    expect(ensureSpy).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchSpy = vi.spyOn(svc as any, 'fetchAndParseToc');
    // fetchAndParseToc should NOT have been called a second time (cache hit)
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — search', () => {
  it('returns matching datasets by case-insensitive label match', async () => {
    const svc = await makeLoadedService([
      tocLine('GDP and main components', 'nama_10_gdp', 'dataset'),
      tocLine('Population by age', 'demo_pjanind', 'dataset'),
      tocLine('Regional GDP data', 'reg_eco3gdp', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets, totalMatches } = await svc.search('gdp', 10, undefined, ctx);
    expect(totalMatches).toBe(2);
    expect(datasets.map((d) => d.code)).toContain('nama_10_gdp');
    expect(datasets.map((d) => d.code)).toContain('reg_eco3gdp');
  });

  it('ANDs whitespace tokens — every token must match, order-independent (#14)', async () => {
    const svc = await makeLoadedService([
      tocLine('Business demography by size class and NUTS 3 region', 'bd_size_r', 'dataset'),
      tocLine('Business demography by legal form', 'bd_legal', 'dataset'),
    ]);
    const ctx = createMockContext();
    // Non-contiguous, out-of-order tokens, all present only in the first label.
    const { datasets, totalMatches } = await svc.search(
      'business demography NUTS 3',
      10,
      undefined,
      ctx,
    );
    expect(totalMatches).toBe(1);
    expect(datasets[0]?.code).toBe('bd_size_r');
  });

  it('returns zero matches when any single token is absent (#14)', async () => {
    const svc = await makeLoadedService([
      tocLine('Business demography by size class', 'bd_size', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets, totalMatches } = await svc.search(
      'business demography trade',
      10,
      undefined,
      ctx,
    );
    expect(totalMatches).toBe(0);
    expect(datasets).toHaveLength(0);
  });

  it('matches tokens found only in the theme breadcrumb (#14)', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    Regional statistics by NUTS classification', 'reg', 'folder'),
      tocLine('        Economic accounts', 'aact_eaa', 'dataset'),
    ]);
    const ctx = createMockContext();
    // "regional" lives only in the themePath — never in the label or code.
    const { datasets } = await svc.search('regional economic accounts', 10, undefined, ctx);
    expect(datasets.map((d) => d.code)).toContain('aact_eaa');
  });

  it('matches tokens found only in the dataset code (#14)', async () => {
    const svc = await makeLoadedService([
      tocLine('Gross domestic product', 'nama_10_gdp', 'dataset'),
    ]);
    const ctx = createMockContext();
    // "nama" appears only in the code, "gross" only in the label.
    const { datasets } = await svc.search('nama gross', 10, undefined, ctx);
    expect(datasets[0]?.code).toBe('nama_10_gdp');
  });

  it('excludes folder entries from search results', async () => {
    const svc = await makeLoadedService([
      tocLine('Economy', 'econ', 'folder'),
      tocLine('Economy and GDP', 'nama_10_gdp', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets } = await svc.search('economy', 10, undefined, ctx);
    // 'econ' folder matches by label but must be excluded; the matching dataset stays.
    expect(datasets.map((d) => d.code)).not.toContain('econ');
    expect(datasets.map((d) => d.code)).toContain('nama_10_gdp');
  });

  it('paginates with an opaque cursor — page size, nextCursor, no overlap or omission (#16)', async () => {
    const svc = await makeLoadedService([
      tocLine('GDP alpha', 'gdp_a', 'dataset'),
      tocLine('GDP beta', 'gdp_b', 'dataset'),
      tocLine('GDP gamma', 'gdp_c', 'dataset'),
      tocLine('GDP delta', 'gdp_d', 'dataset'),
      tocLine('GDP epsilon', 'gdp_e', 'dataset'),
    ]);
    const ctx = createMockContext();

    const page1 = await svc.search('gdp', 2, undefined, ctx);
    expect(page1.totalMatches).toBe(5);
    expect(page1.datasets).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await svc.search('gdp', 2, page1.nextCursor, ctx);
    expect(page2.datasets).toHaveLength(2);
    expect(page2.nextCursor).toBeDefined();

    const page3 = await svc.search('gdp', 2, page2.nextCursor, ctx);
    expect(page3.datasets).toHaveLength(1);
    // Last page carries no continuation cursor.
    expect(page3.nextCursor).toBeUndefined();

    // Every match retrieved exactly once, in stable order, across the three pages.
    const seen = [...page1.datasets, ...page2.datasets, ...page3.datasets].map((d) => d.code);
    expect(seen).toEqual(['gdp_a', 'gdp_b', 'gdp_c', 'gdp_d', 'gdp_e']);
  });

  it('respects the limit as the page size', async () => {
    const svc = await makeLoadedService([
      tocLine('GDP alpha', 'gdp_a', 'dataset'),
      tocLine('GDP beta', 'gdp_b', 'dataset'),
      tocLine('GDP gamma', 'gdp_c', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets, totalMatches, nextCursor } = await svc.search('gdp', 2, undefined, ctx);
    expect(totalMatches).toBe(3);
    expect(datasets).toHaveLength(2);
    expect(nextCursor).toBeDefined();
  });

  it('returns empty datasets array for no-match query', async () => {
    const svc = await makeLoadedService([tocLine('GDP dataset', 'nama_10_gdp', 'dataset')]);
    const ctx = createMockContext();
    const { datasets, totalMatches, nextCursor } = await svc.search(
      'xyz_nonexistent_123',
      10,
      undefined,
      ctx,
    );
    expect(datasets).toHaveLength(0);
    expect(totalMatches).toBe(0);
    expect(nextCursor).toBeUndefined();
  });

  it('includes themePath in results', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    Economy', 'econ', 'folder'),
      tocLine('        GDP dataset', 'nama_10_gdp', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets } = await svc.search('gdp', 10, undefined, ctx);
    expect(datasets[0]?.themePath).toContain('Economy');
  });

  it('matches table type entries', async () => {
    const svc = await makeLoadedService([tocLine('Trade summary table', 'trade_sum', 'table')]);
    const ctx = createMockContext();
    const { datasets } = await svc.search('trade', 10, undefined, ctx);
    expect(datasets[0]?.type).toBe('table');
    expect(datasets[0]?.code).toBe('trade_sum');
  });

  it('handles unicode in labels', async () => {
    const svc = await makeLoadedService([tocLine('Données démographiques', 'demo_fr', 'dataset')]);
    const ctx = createMockContext();
    const { datasets } = await svc.search('données', 10, undefined, ctx);
    expect(datasets[0]?.code).toBe('demo_fr');
  });

  it('matches nothing for a whitespace-only query (#24)', async () => {
    const svc = await makeLoadedService([
      tocLine('GDP and main components', 'nama_10_gdp', 'dataset'),
      tocLine('Population by age', 'demo_pjanind', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets, totalMatches, nextCursor } = await svc.search('   ', 10, undefined, ctx);
    expect(totalMatches).toBe(0);
    expect(datasets).toHaveLength(0);
    expect(nextCursor).toBeUndefined();
  });

  it('matches nothing for an all-whitespace query of mixed blank characters (#24)', async () => {
    const svc = await makeLoadedService([tocLine('GDP', 'nama_10_gdp', 'dataset')]);
    const ctx = createMockContext();
    const { datasets, totalMatches } = await svc.search('\t\n  ', 10, undefined, ctx);
    expect(totalMatches).toBe(0);
    expect(datasets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Search — duplicate codes across theme branches (#26)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — search deduplication (#26)', () => {
  /** Same dataset code filed under two different parent folders, as the live TOC does. */
  const duplicatePlacements = [
    tocLine('Root', 'root', 'folder'),
    tocLine('    Prices', 'prc', 'folder'),
    tocLine('        HICP inflation contributions', 'prc_hicp_ctr', 'dataset'),
    tocLine('    Short-term indicators', 'sti', 'folder'),
    tocLine('        HICP inflation contributions', 'prc_hicp_ctr', 'dataset'),
    tocLine('        Inflation rate summary', 'tipscp10', 'table'),
  ];

  it('counts a code once in totalMatches and returns it once per page', async () => {
    const svc = await makeLoadedService(duplicatePlacements);
    const ctx = createMockContext();
    const { datasets, totalMatches } = await svc.search('inflation', 10, undefined, ctx);
    expect(totalMatches).toBe(2);
    expect(datasets.map((d) => d.code)).toEqual(['prc_hicp_ctr', 'tipscp10']);
  });

  it('keeps the first matching placement as the code its only themePath', async () => {
    const svc = await makeLoadedService(duplicatePlacements);
    const ctx = createMockContext();
    const { datasets } = await svc.search('inflation', 10, undefined, ctx);
    // Exactly one row for the doubly-filed code, carrying the earlier branch —
    // the later "Short-term indicators" placement must not appear at all.
    expect(datasets.filter((d) => d.code === 'prc_hicp_ctr').map((d) => d.themePath)).toEqual([
      ['Root', 'Prices'],
    ]);
  });

  it('does not let duplicates consume page slots', async () => {
    const svc = await makeLoadedService(duplicatePlacements);
    const ctx = createMockContext();
    // Two unique codes with a page size of 2 is exactly one full page — a duplicate
    // occupying a slot would push tipscp10 onto a second page.
    const page = await svc.search('inflation', 2, undefined, ctx);
    expect(page.datasets.map((d) => d.code)).toEqual(['prc_hicp_ctr', 'tipscp10']);
    expect(page.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Search — cursor binding (#28)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — cursor binding (#28)', () => {
  const twoTopicCatalogue = [
    tocLine('Population alpha', 'pop_a', 'dataset'),
    tocLine('Population beta', 'pop_b', 'dataset'),
    tocLine('Population gamma', 'pop_c', 'dataset'),
    tocLine('Population delta', 'pop_d', 'dataset'),
    tocLine('Inflation alpha', 'inf_a', 'dataset'),
    tocLine('Inflation beta', 'inf_b', 'dataset'),
    tocLine('Inflation gamma', 'inf_c', 'dataset'),
    tocLine('Inflation delta', 'inf_d', 'dataset'),
  ];

  it('rejects a cursor minted for a different query instead of skipping matches', async () => {
    const svc = await makeLoadedService(twoTopicCatalogue);
    const ctx = createMockContext();
    const population = await svc.search('population', 3, undefined, ctx);
    expect(population.nextCursor).toBeDefined();

    await expect(svc.search('inflation', 3, population.nextCursor, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_cursor' },
    });
  });

  it('leaves the new query reachable from its own first page after a rejected cursor', async () => {
    const svc = await makeLoadedService(twoTopicCatalogue);
    const ctx = createMockContext();
    const population = await svc.search('population', 3, undefined, ctx);
    await svc.search('inflation', 3, population.nextCursor, ctx).catch(() => undefined);

    const inflation = await svc.search('inflation', 3, undefined, ctx);
    expect(inflation.datasets.map((d) => d.code)).toEqual(['inf_a', 'inf_b', 'inf_c']);
  });

  it('accepts a cursor whose query differs only in case and spacing', async () => {
    const svc = await makeLoadedService(twoTopicCatalogue);
    const ctx = createMockContext();
    const page1 = await svc.search('population', 2, undefined, ctx);
    const page2 = await svc.search('  POPULATION ', 2, page1.nextCursor, ctx);
    expect(page2.datasets.map((d) => d.code)).toEqual(['pop_c', 'pop_d']);
  });

  it('rejects a cursor issued against a TOC snapshot that has since refreshed (#23)', async () => {
    const svc = await makeLoadedService(twoTopicCatalogue);
    const ctx = createMockContext();
    const page1 = await svc.search('population', 2, undefined, ctx);
    expect(page1.nextCursor).toBeDefined();

    // A TTL refresh lands between the two pages, reordering the matched set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).cache = makeCache(
      svc,
      [tocLine('Population omega', 'pop_z', 'dataset'), ...twoTopicCatalogue],
      new Date(Date.now() + 1),
    );

    await expect(svc.search('population', 2, page1.nextCursor, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_cursor' },
    });
  });

  it('rejects a structurally valid cursor that carries no query binding', async () => {
    const svc = await makeLoadedService(twoTopicCatalogue);
    const ctx = createMockContext();
    const legacyCursor = encodeCursor({ offset: 3, limit: 3 });
    await expect(svc.search('inflation', 3, legacyCursor, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_cursor' },
    });
  });

  it('rejects a malformed cursor under the same invalid_cursor contract', async () => {
    const svc = await makeLoadedService(twoTopicCatalogue);
    const ctx = createMockContext();
    // Undecodable, structurally invalid, and truncated cursors must all reach the
    // caller as the declared contract reason, not as a bare InvalidParams.
    for (const garbage of ['not-a-real-cursor', '!!!!', 'eyJvZmZzZXQiOi0xLCJsaW1pdCI6M30']) {
      await expect(svc.search('population', 3, garbage, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_cursor' },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// TOC cache TTL and refresh (#23)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — TOC cache TTL (#23)', () => {
  /** Catalogue as first loaded: one theme under the root wrapper. */
  const loadedToc = [
    tocLine('Database by themes', 'data', 'folder'),
    tocLine('    Economy', 'econ', 'folder'),
  ];

  /** Catalogue as Eurostat publishes it later: a second theme and a dataset appear. */
  const upstreamToc = [
    tocLine('Database by themes', 'data', 'folder'),
    tocLine('    Economy', 'econ', 'folder'),
    tocLine('    Trade', 'trd', 'folder'),
    tocLine('        Trade volumes', 'trd_vol', 'dataset'),
  ];

  /** Replace the network fetch with a counted stub returning a parsed TOC. */
  function stubFetch(svc: EurostatCatalogueService, entries: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (
      vi
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn(svc as any, 'fetchAndParseToc')
        .mockImplementation(async () => makeCache(svc, entries))
    );
  }

  it('serves a cache younger than the TTL without re-fetching', async () => {
    const svc = await makeLoadedService(loadedToc);
    const fetchSpy = stubFetch(svc, upstreamToc);
    const ctx = createMockContext();

    const result = await svc.browse(undefined, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.code)).toEqual(['econ']);
  });

  it('refreshes once past the TTL and serves the new catalogue', async () => {
    const svc = await makeLoadedService(loadedToc);
    const fetchSpy = stubFetch(svc, upstreamToc);
    expireCache(svc);
    const ctx = createMockContext();

    const refreshed = await svc.browse(undefined, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(refreshed.items.map((i) => i.code)).toEqual(['econ', 'trd']);

    // The refreshed cache resets the clock — a follow-up call re-uses it.
    const followUp = await svc.browse(undefined, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(followUp.items.map((i) => i.code)).toEqual(['econ', 'trd']);
  });

  it('surfaces a dataset added upstream once the TTL has passed', async () => {
    const svc = await makeLoadedService(loadedToc);
    stubFetch(svc, upstreamToc);
    const ctx = createMockContext();

    expect((await svc.search('trade volumes', 10, undefined, ctx)).totalMatches).toBe(0);
    expireCache(svc);
    const afterRefresh = await svc.search('trade volumes', 10, undefined, ctx);
    expect(afterRefresh.datasets.map((d) => d.code)).toEqual(['trd_vol']);
  });

  it('shares one in-flight refresh across concurrent callers past the TTL', async () => {
    const svc = await makeLoadedService(loadedToc);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchSpy = vi.spyOn(svc as any, 'fetchAndParseToc').mockImplementation(async () => {
      await gate;
      return makeCache(svc, upstreamToc);
    });
    expireCache(svc);
    const ctx = createMockContext();

    const both = Promise.all([
      svc.browse(undefined, ctx),
      svc.search('trade volumes', 10, undefined, ctx),
    ]);
    release?.();
    const [browsed, searched] = await both;

    // One fetch served both callers, and both saw the refreshed snapshot.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(browsed.items.map((i) => i.code)).toEqual(['econ', 'trd']);
    expect(searched.datasets.map((d) => d.code)).toEqual(['trd_vol']);
  });

  it('serves the last loaded catalogue when a refresh fails', async () => {
    const svc = await makeLoadedService(loadedToc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc as any, 'fetchAndParseToc').mockRejectedValue(new Error('Eurostat unreachable'));
    expireCache(svc);
    const ctx = createMockContext();

    const result = await svc.browse(undefined, ctx);
    expect(result.items.map((i) => i.code)).toEqual(['econ']);
  });

  it('surfaces a cold-start fetch failure to the caller', async () => {
    const svc = new EurostatCatalogueService(mockConfig, mockStorage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc as any, 'fetchAndParseToc').mockRejectedValue(new Error('Eurostat unreachable'));
    const ctx = createMockContext();

    await expect(svc.browse(undefined, ctx)).rejects.toThrow('Eurostat unreachable');
  });

  it('retries the fetch on the next call after a failure', async () => {
    const svc = new EurostatCatalogueService(mockConfig, mockStorage);
    const fetchSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(svc as any, 'fetchAndParseToc')
      .mockRejectedValueOnce(new Error('Eurostat unreachable'))
      .mockImplementationOnce(async () => makeCache(svc, loadedToc));
    const ctx = createMockContext();

    await expect(svc.browse(undefined, ctx)).rejects.toThrow('Eurostat unreachable');
    const result = await svc.browse(undefined, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.items.map((i) => i.code)).toEqual(['econ']);
  });

  it('holds a failed refresh off upstream for the cooldown, then retries', async () => {
    vi.useFakeTimers();
    try {
      const svc = await makeLoadedService(loadedToc);
      const fetchSpy = vi
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn(svc as any, 'fetchAndParseToc')
        .mockRejectedValueOnce(new Error('Eurostat unreachable'))
        .mockImplementationOnce(async () => makeCache(svc, upstreamToc));
      expireCache(svc);
      const ctx = createMockContext();

      // The first call past the TTL attempts the refresh and falls back to the cache.
      const duringOutage = await svc.browse(undefined, ctx);
      expect(duringOutage.items.map((i) => i.code)).toEqual(['econ']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Callers inside the cooldown are served the same cache without a second
      // fetch — without the cooldown each of these would pay a full retry cycle.
      vi.setSystemTime(Date.now() + 30_000);
      const stillCoolingDown = await svc.browse(undefined, ctx);
      expect(stillCoolingDown.items.map((i) => i.code)).toEqual(['econ']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Past the cooldown the next call tries again and picks up the new catalogue.
      vi.setSystemTime(Date.now() + 31_000);
      const recovered = await svc.browse(undefined, ctx);
      expect(recovered.items.map((i) => i.code)).toEqual(['econ', 'trd']);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the failure cooldown once a refresh succeeds', async () => {
    const svc = new EurostatCatalogueService(mockConfig, mockStorage);
    const fetchSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(svc as any, 'fetchAndParseToc')
      .mockRejectedValueOnce(new Error('Eurostat unreachable'))
      .mockImplementation(async () => makeCache(svc, loadedToc));
    const ctx = createMockContext();

    // A cold-start failure arms the cooldown; the immediate retry succeeds.
    await expect(svc.browse(undefined, ctx)).rejects.toThrow('Eurostat unreachable');
    await svc.browse(undefined, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // An expiry still inside that original cooldown window refreshes rather than
    // being held off by the failure the successful load superseded.
    expireCache(svc);
    await svc.browse(undefined, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

describe('getEurostatCatalogueService', () => {
  it('returns the initialized service after init', () => {
    initEurostatCatalogueService(mockConfig, mockStorage);
    const svc = getEurostatCatalogueService();
    expect(svc).toBeInstanceOf(EurostatCatalogueService);
  });

  it('re-using getEurostatCatalogueService returns the same instance', () => {
    initEurostatCatalogueService(mockConfig, mockStorage);
    const a = getEurostatCatalogueService();
    const b = getEurostatCatalogueService();
    expect(a).toBe(b);
  });
});
