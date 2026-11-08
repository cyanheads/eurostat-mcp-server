/**
 * @fileoverview Unit tests for EurostatCatalogueService pure logic (TOC parsing, search, browse).
 * @module tests/services/eurostat-catalogue-service.test
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDimensionValueIndex,
  type DimensionValueIndex,
} from '@/services/eurostat-catalogue/dimension-value-index.js';
import {
  EurostatCatalogueService,
  getEurostatCatalogueService,
  initEurostatCatalogueService,
  MAX_UNMATCHED_WORD_CHECKS,
  MAX_VALUE_SEARCH_WORDS,
  searchTierOf,
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

/**
 * Parse TSV entries into the in-memory cache shape the service holds.
 *
 * Both the parse and the code index come from the service's own methods — a hand-rolled
 * index here would be a second implementation of the tie-break rule, and the seeded cache
 * would stop reflecting what a real TOC load produces.
 */
function makeCache(svc: EurostatCatalogueService, entries: string[], loadedAt = new Date()) {
  // Access private methods via any cast — this is a unit test reaching into pure logic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = (svc as any).parseToc(buildTsv(entries));
  return {
    entries: parsed,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    codeIndex: (svc as any).buildCodeIndex(parsed),
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
  it('resolves theme case after exact matches and preserves canonical nested placements', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    Economy', 'econ', 'folder'),
      tocLine('        National accounts', 'nama', 'folder'),
      tocLine('            GDP', 'gdp', 'dataset'),
      tocLine('    Other', 'other', 'folder'),
      tocLine('        National accounts elsewhere', 'nama', 'folder'),
      tocLine('    Exact uppercase', 'ECON', 'folder'),
    ]);
    const ctx = createMockContext();
    expect(await svc.browse('NAMA', ctx)).toMatchObject({
      themeCode: 'nama',
      items: [{ code: 'gdp' }],
      parentPath: ['Root', 'Economy', 'National accounts'],
      otherPlacements: [['Root', 'Other', 'National accounts elsewhere']],
    });
    expect(await svc.browse('ECON', ctx)).toMatchObject({ themeCode: 'ECON', items: [] });
    await expect(svc.browse('GDP', ctx)).rejects.toMatchObject({
      data: { reason: 'not_a_folder', themeCode: 'gdp', entryType: 'dataset' },
    });
  });
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

  it('throws not_a_folder with the dataset type when theme code refers to a dataset', async () => {
    const svc = await makeLoadedService([tocLine('GDP dataset', 'nama_10_gdp', 'dataset')]);
    const ctx = createMockContext();
    await expect(svc.browse('nama_10_gdp', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'not_a_folder', themeCode: 'nama_10_gdp', entryType: 'dataset' },
    });
  });

  it('throws not_a_folder with the table type when theme code refers to a table', async () => {
    const svc = await makeLoadedService([tocLine('GDP table', 'nama_10_gdp_t', 'table')]);
    const ctx = createMockContext();
    await expect(svc.browse('nama_10_gdp_t', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'not_a_folder', themeCode: 'nama_10_gdp_t', entryType: 'table' },
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
// Search — spacing around punctuation and the words that block a match (#69)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — punctuation spacing and blocking words (#69)', () => {
  /**
   * Verbatim lines of the 2026-10-14 TOC: every placement, with its ancestor folders, of
   * the datasets behind the issue's examples, plus labels spelling `Rev.2`, `Rev. 1.1`,
   * `2015 = 100`, `R&D`, `non-EU`, `15-64`, and `%`.
   */
  const EXCERPT = readFileSync(
    new URL('../fixtures/toc-2026-10-14-excerpt.tsv', import.meta.url),
    'utf8',
  );

  function excerptService(): EurostatCatalogueService {
    const svc = new EurostatCatalogueService(mockConfig, mockStorage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (svc as any).parseToc(EXCERPT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).cache = {
      entries: parsed,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      codeIndex: (svc as any).buildCodeIndex(parsed),
      loadedAt: new Date(),
    };
    return svc;
  }

  const codesFor = async (svc: EurostatCatalogueService, query: string) =>
    (await svc.search(query, 100, undefined, createMockContext())).datasets.map((d) => d.code);

  /** In tier order (#101): sbs_ovw_smc carries "statistics" only in its breadcrumb, so it ranks last. */
  const SBS = ['sbs_sc_ovw', 'egr_mne_n2sc', 'egr_mne_empw', 'sbs_ovw_smc'];
  const RATES_QUERY = 'unemployment rates by sex age annual data';

  it('finds the spaced "Rev. 2" form of the first example (characterization)', async () => {
    const svc = excerptService();
    expect(
      await codesFor(svc, 'Enterprise statistics by size class and NACE Rev. 2 activity'),
    ).toEqual(SBS);
  });

  it('finds sbs_sc_ovw for "Rev.2", the same datasets as its spaced form', async () => {
    const svc = excerptService();
    expect(
      await codesFor(svc, 'Enterprise statistics by size class and NACE Rev.2 activity'),
    ).toEqual(SBS);
  });

  it('matches both catalogue spellings for "NACE Rev.2", and "Rev. 1.1" for "Rev.1.1"', async () => {
    const svc = excerptService();
    const rev2 = await codesFor(svc, 'NACE Rev.2');
    expect(rev2).toContain('ei_isse_q'); // "(NACE Rev.2)"
    expect(rev2).toEqual(expect.arrayContaining(['ei_isin_m', 'sbs_sc_ovw'])); // "(NACE Rev. 2)"
    expect(await codesFor(svc, 'Rev.1.1')).toEqual(['htec_emp_reg']); // "NACE Rev. 1.1"
    expect(await codesFor(svc, '2015=100')).toEqual(['ei_isin_m']); // "(2015 = 100)"
  });

  it('keeps the sets of queries that carry their own punctuation (characterization)', async () => {
    const svc = excerptService();
    expect(await codesFor(svc, 'R&D')).toEqual(['rd_p_persreg']);
    expect(await codesFor(svc, 'non-EU')).toEqual(['migr_resshare', 'tesem090']);
    expect(await codesFor(svc, '15-64')).toEqual(['tgs00007']);
    expect(await codesFor(svc, '%')).toEqual(['ei_lmhr_m', 'migr_resshare']);
    expect(await codesFor(svc, 'nama_10_gdp')).toEqual(['nama_10_gdp']);
  });

  it('names each word whose removal alone finds matches, with that count, in query order', async () => {
    const result = await excerptService().search(RATES_QUERY, 20, undefined, createMockContext());
    expect(result.totalMatches).toBe(0);
    expect(result.wordRemovalCounts).toEqual([
      { word: 'rates', totalMatches: 7 },
      { word: 'sex', totalMatches: 3 },
      { word: 'annual', totalMatches: 4 },
    ]);
  });

  it('counts exactly what the search without that word finds, any placement included', async () => {
    const svc = excerptService();
    const ctx = createMockContext();
    const { wordRemovalCounts } = await svc.search(RATES_QUERY, 20, undefined, ctx);
    expect(wordRemovalCounts?.length).toBeGreaterThan(0);
    for (const { word, totalMatches } of wordRemovalCounts ?? []) {
      const without = RATES_QUERY.split(' ')
        .filter((w) => w !== word)
        .join(' ');
      expect((await svc.search(without, 20, undefined, ctx)).totalMatches).toBe(totalMatches);
    }
  });

  it('quotes each word as typed and names a repeated word once', async () => {
    const result = await excerptService().search(
      'Unemployment RATES rates by Sex age annual data',
      20,
      undefined,
      createMockContext(),
    );
    expect(result.wordRemovalCounts?.map((c) => c.word)).toEqual(['RATES', 'Sex', 'annual']);
  });

  it('counts in one pass over the catalogue, never one search per word', async () => {
    /**
     * Dataset k holds every query word but the k-th from the end, so matching the query
     * checks nearly every word of every dataset before it misses. Counting the removals in
     * one pass costs about one more such scan; a search per word costs one per word, 200
     * here. Compared on thread CPU against the same scan with a dataset that matches,
     * where no removal is counted.
     */
    const words = Array.from({ length: 200 }, (_, i) => `w${String(i).padStart(3, '0')}`);
    const query = words.join(' ');
    const lacking = Array.from({ length: 64 }, (_, k) =>
      tocLine(
        `    ${words.filter((_, i) => i !== words.length - 1 - k).join(' ')}`,
        `lacks_${k}`,
        'dataset',
      ),
    );
    const counting = await makeLoadedService([tocLine('Root', 'root', 'folder'), ...lacking]);
    const matching = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      ...lacking,
      tocLine(`    ${query}`, 'has_all', 'dataset'),
    ]);

    const result = await counting.search(query, 10, undefined, createMockContext());
    expect(result.totalMatches).toBe(0);
    expect(result.wordRemovalCounts).toEqual(
      words.slice(-64).map((word) => ({ word, totalMatches: 1 })),
    );

    const bestCpuMs = async (svc: EurostatCatalogueService) => {
      const ctx = createMockContext();
      await svc.search(query, 10, undefined, ctx); // builds the search text before timing
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const before = process.threadCpuUsage();
        await svc.search(query, 10, undefined, ctx);
        const { user, system } = process.threadCpuUsage(before);
        best = Math.min(best, (user + system) / 1000);
      }
      return best;
    };
    const countingMs = await bestCpuMs(counting);
    const matchingMs = await bestCpuMs(matching);
    expect(countingMs / Math.max(matchingMs, 0.05)).toBeLessThan(16);
  });

  it('names no word for a one-word query, a matching query, or one no single removal rescues', async () => {
    const svc = excerptService();
    const ctx = createMockContext();
    expect(await svc.search('zebra', 20, undefined, ctx)).toEqual({
      datasets: [],
      totalMatches: 0,
    });
    expect(
      (await svc.search('unemployment', 20, undefined, ctx)).wordRemovalCounts,
    ).toBeUndefined();
    expect(await svc.search('zebra crossings unemployment', 20, undefined, ctx)).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['zebra', 'crossings'],
    });
    expect(await svc.search('rates rates', 20, undefined, ctx)).not.toHaveProperty(
      'wordRemovalCounts',
    );
  });

  it('names the words no dataset carries, as typed, in query order, each once (#92)', async () => {
    const svc = excerptService();
    const ctx = createMockContext();
    // "tourism" files sbs_sc_ovw under the Tourism theme; neither other word is in the excerpt.
    expect(await svc.search('tourism Overnight stays overnight', 20, undefined, ctx)).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['Overnight', 'stays'],
    });
    // "tourism" and "unemployment" each match, never together, so no removal count applies.
    expect(await svc.search('tourism unemployment overnight', 20, undefined, ctx)).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['overnight'],
    });
  });

  it('flags a query none of whose words any dataset carries (#92)', async () => {
    const result = await excerptService().search(
      'overnight STAYS overnight',
      20,
      undefined,
      createMockContext(),
    );
    expect(result).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['overnight', 'STAYS'],
      allWordsUnmatched: true,
    });
  });

  it('reports a dead word beside its own removal count when the other words co-occur (#92)', async () => {
    const result = await excerptService().search(
      'Overnight overnight tourism',
      20,
      undefined,
      createMockContext(),
    );
    expect(result).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['Overnight'],
      wordRemovalCounts: [{ word: 'Overnight', totalMatches: 1 }],
    });
  });

  it('checks a word past a dataset’s second miss, so a late match keeps it off the list (#92)', async () => {
    /**
     * "delta" appears only in a dataset that already lacks two query words before it
     * ("alpha" and "gamma"), so a scan stopping at a dataset's second miss would call it dead.
     */
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    alpha beta', 'first', 'dataset'),
      tocLine('    gamma', 'second', 'dataset'),
      tocLine('    delta', 'third', 'dataset'),
    ]);
    const result = await svc.search(
      'alpha gamma delta epsilon',
      10,
      undefined,
      createMockContext(),
    );
    expect(result).toEqual({ datasets: [], totalMatches: 0, unmatchedWords: ['epsilon'] });
  });

  /** `count` distinct words, `w00` upward, none a substring of another. */
  const numberedWords = (count: number) =>
    Array.from({ length: count }, (_, i) => `w${String(i).padStart(2, '0')}`);

  it(`names the dead words of a ${MAX_UNMATCHED_WORD_CHECKS}-word query like any other (characterization)`, async () => {
    const words = numberedWords(MAX_UNMATCHED_WORD_CHECKS);
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine(`    ${words.slice(0, 15).join(' ')}`, 'first_half', 'dataset'),
      tocLine(`    ${words.slice(15, 30).join(' ')}`, 'second_half', 'dataset'),
    ]);
    expect(await svc.search(words.join(' '), 10, undefined, createMockContext())).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: words.slice(30),
      valuesNotSearched: 'too_many_words',
    });
  });

  it(`names dead words from the first ${MAX_UNMATCHED_WORD_CHECKS} distinct words, and flags a later word no text read holds`, async () => {
    const words = numberedWords(MAX_UNMATCHED_WORD_CHECKS + 2);
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine(`    ${words.slice(0, 15).join(' ')}`, 'first_half', 'dataset'),
      tocLine(`    ${words.slice(15, 30).join(' ')}`, 'second_half', 'dataset'),
      tocLine(`    ${words[MAX_UNMATCHED_WORD_CHECKS]}`, 'late_word', 'dataset'),
    ]);
    // A repeat of an early word adds no distinct word.
    const query = [...words, 'W00'].join(' ');
    expect(await svc.search(query, 10, undefined, createMockContext())).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: words.slice(30, MAX_UNMATCHED_WORD_CHECKS),
      unmatchedWordsPartial: true,
      valuesNotSearched: 'too_many_words',
    });
  });

  it(`flags no later word when a text read holds every word past the first ${MAX_UNMATCHED_WORD_CHECKS}`, async () => {
    const words = numberedWords(MAX_UNMATCHED_WORD_CHECKS + 2);
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine(`    ${words.filter((w) => w !== 'w05').join(' ')}`, 'all_but_one', 'dataset'),
    ]);
    expect(await svc.search(words.join(' '), 10, undefined, createMockContext())).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['w05'],
      wordRemovalCounts: [{ word: 'w05', totalMatches: 1 }],
      valuesNotSearched: 'too_many_words',
    });
  });

  /**
   * Thread CPU ms of the cheapest of three cold searches — the first over a snapshot, which
   * builds its search text — over a catalogue whose one dataset carries `label`.
   */
  async function coldSearchCpuMs(label: string, query: string): Promise<number> {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const svc = await makeLoadedService([
        tocLine('Root', 'root', 'folder'),
        tocLine(`    ${label}`, 'long_label', 'dataset'),
      ]);
      const ctx = createMockContext();
      const before = process.threadCpuUsage();
      await svc.search(query, 10, undefined, ctx);
      const { user, system } = process.threadCpuUsage(before);
      best = Math.min(best, (user + system) / 1000);
    }
    return best;
  }

  const SIZES = [5_000, 20_000, 80_000, 320_000];
  const shapes: Record<string, (n: number) => { label: string; query: string }> = {
    'a long run of spaces between letters': (n) => ({
      label: `a${' '.repeat(n)}b`,
      query: 'zzz yyy',
    }),
    'mixed blank characters between letters': (n) => ({
      label: `x${'   '.repeat(n / 3)}y`,
      query: 'zzz yyy',
    }),
    'repeated openers with spaces': (n) => ({
      label: `a${' ('.repeat(n / 2)}b`,
      query: 'zzz yyy',
    }),
    'a caller query of repeated openers and spaces': (n) => ({
      label: 'Short label',
      query: `${'( '.repeat(n / 2)}zzz yyy`,
    }),
    'a caller query of distinct words': (n) => ({
      label: 'Short label',
      query: Array.from({ length: n / 8 }, (_, i) => `w${i}`).join(' '),
    }),
    // The two below match, so their results are ranked by tier (#101).
    'a matching caller query of repeated words': (n) => ({
      label: 'Short label',
      query: 'label '.repeat(n / 6),
    }),
    'a matching caller query of punctuated words': (n) => ({
      label: 'NACE Rev. 2',
      query: 'rev. '.repeat(n / 5),
    }),
  };

  for (const [shape, make] of Object.entries(shapes)) {
    it(`stays linear on ${shape}`, async () => {
      await coldSearchCpuMs('warm ( up', 'warm up'); // compile the regexes before timing
      const times: number[] = [];
      for (const n of SIZES) {
        const { label, query } = make(n);
        const ms = await coldSearchCpuMs(label, query);
        // Checked per size: a quadratic search fails here rather than running for minutes.
        expect(ms).toBeLessThan(250);
        times.push(ms);
      }
      const [smallest = 0, largest = 0] = [times[0], times[times.length - 1]];
      expect(largest / Math.max(smallest, 0.05)).toBeLessThan(256);
    });
  }

  /**
   * A catalogue of 12,000 datasets, about the size of the live one, whose labels each hold
   * every word of the queries below.
   */
  const wide = makeLoadedService([
    tocLine('Root', 'root', 'folder'),
    ...Array.from({ length: 12_000 }, (_, k) =>
      tocLine(`    Entry ${k} of a wide catalogue: label §1 x§1 x y 111`, `wide_${k}`, 'dataset'),
    ),
  ]);

  /** Thread CPU ms of the cheapest of three searches for `query`, its search text already built. */
  async function wideSearchCpuMs(query: string): Promise<number> {
    const svc = await wide;
    const ctx = createMockContext();
    await svc.search('label', 10, undefined, ctx);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const before = process.threadCpuUsage();
      await svc.search(query, 10, undefined, ctx);
      const { user, system } = process.threadCpuUsage(before);
      best = Math.min(best, (user + system) / 1000);
    }
    return best;
  }

  /** Sizes doubling over 64×; shapes the fold regex works on stay below 80k characters. */
  const doublingFrom = (from: number) => Array.from({ length: 7 }, (_, k) => from * 2 ** k);
  const wideShapes: Record<string, { sizes: number[]; query: (n: number) => string }> = {
    'a query of matching words': {
      sizes: doublingFrom(1_000),
      query: (n) => 'label '.repeat(n / 6),
    },
    'line breaks after a punctuation mark': {
      sizes: doublingFrom(1_000),
      query: (n) => `${'§1 x'.repeat(n / 4)}\ny`,
    },
    'blank runs with carriage returns': {
      sizes: doublingFrom(1_000),
      query: (n) => `label${'  \r\n'.repeat(n / 4)}`,
    },
    'a long digit run': { sizes: doublingFrom(5_000), query: (n) => `label ${'1'.repeat(n)}` },
  };

  for (const [shape, { sizes, query }] of Object.entries(wideShapes)) {
    it(`matches across many datasets in time linear in the query on ${shape}`, async () => {
      await wideSearchCpuMs('warm up'); // compile the regexes before timing
      const times: number[] = [];
      for (const n of sizes) {
        const ms = await wideSearchCpuMs(query(n));
        // Checked per size: a super-linear search fails here rather than running for minutes.
        expect(ms).toBeLessThan(250);
        times.push(ms);
      }
      const [smallest = 0, largest = 0] = [times[0], times[times.length - 1]];
      expect(largest / Math.max(smallest, 0.05)).toBeLessThan(256);
    });
  }

  /** Queries no dataset of the wide catalogue matches: every one carries a word none holds. */
  const missShapes: Record<string, { sizes: number[]; query: (n: number) => string }> = {
    'distinct words': {
      sizes: doublingFrom(1_000),
      query: (n) => Array.from({ length: n / 8 }, (_, i) => `zq${i}`).join(' '),
    },
    'line breaks after a punctuation mark': {
      sizes: doublingFrom(1_000),
      query: (n) => `zq ${'§1 x'.repeat(n / 4)}\ny`,
    },
    'blank runs with carriage returns': {
      sizes: doublingFrom(1_000),
      query: (n) => `zq label${'  \r\n'.repeat(n / 4)}`,
    },
    'a long digit run': { sizes: doublingFrom(5_000), query: (n) => `zq ${'1'.repeat(n)}` },
  };

  for (const [shape, { sizes, query }] of Object.entries(missShapes)) {
    it(`answers a search that matches nothing in time linear in the query on ${shape}`, async () => {
      await wideSearchCpuMs('warm up'); // compile the regexes before timing
      const times: number[] = [];
      for (const n of sizes) {
        const ms = await wideSearchCpuMs(query(n));
        // Checked per size: a super-linear search fails here rather than running for minutes.
        expect(ms).toBeLessThan(250);
        times.push(ms);
      }
      const [smallest = 0, largest = 0] = [times[0], times[times.length - 1]];
      expect(largest / Math.max(smallest, 0.05)).toBeLessThan(256);
    });
  }
});

// ---------------------------------------------------------------------------
// Search — tier order (#101)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — tier order (#101)', () => {
  /**
   * For "employment rate", in TOC order: a label holding both words where the phrase starts
   * mid-word, a dataset that has them only in its breadcrumb, the phrase at the label's start,
   * both words apart, and the phrase after a space.
   */
  const employment = [
    tocLine('Root', 'root', 'folder'),
    tocLine('    Unemployment rate - monthly data', 'une_rt_m', 'dataset'),
    tocLine('    Employment rates', 'lfsa_emprt', 'folder'),
    tocLine('        Persons in work by sex', 'lfsa_epgais', 'dataset'),
    tocLine('    Employment rates by sex, age and citizenship (%)', 'lfsa_ergan', 'dataset'),
    tocLine('    Rate of employment growth', 'tec00109', 'dataset'),
    tocLine('    Long-term employment rate', 'lfsa_ltrt', 'dataset'),
  ];
  const TIERED = ['lfsa_ergan', 'lfsa_ltrt', 'une_rt_m', 'tec00109', 'lfsa_epgais'];

  const codesFor = async (svc: EurostatCatalogueService, query: string) =>
    (await svc.search(query, 100, undefined, createMockContext())).datasets.map((d) => d.code);

  it('puts a label phrase at a word start first, then every word in label or code, then breadcrumb-only', async () => {
    const svc = await makeLoadedService(employment);
    expect(await codesFor(svc, 'employment rate')).toEqual(TIERED);
  });

  it('counts a word found only in the code toward the second tier', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    GDP and main components', 'nama_10', 'folder'),
      tocLine('        Main aggregates', 'nama_main', 'dataset'),
      tocLine('    Main aggregates by region', 'gdp_r_main', 'dataset'),
    ]);
    // nama_main has "gdp" only in its breadcrumb; gdp_r_main has it in its code.
    expect(await codesFor(svc, 'gdp main')).toEqual(['gdp_r_main', 'nama_main']);
  });

  it('folds whitespace beside punctuation on the label and the query for the phrase', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    Rev.2 tables by NACE', 'rev_first', 'dataset'),
      tocLine('    Turnover by NACE Rev. 2 activity', 'sts_trtu', 'dataset'),
    ]);
    // Only sts_trtu holds the phrase, once "Rev. 2" folds to "Rev.2" on whichever side it is spaced.
    expect(await codesFor(svc, 'NACE Rev.2')).toEqual(['sts_trtu', 'rev_first']);
    expect(await codesFor(svc, 'NACE Rev. 2')).toEqual(['sts_trtu', 'rev_first']);
  });

  it('ranks a code by its label and code, whichever placement supplied its themePath', async () => {
    const regional = tocLine('        Regional GDP by NUTS 2 region', 'nama_10r_2gdp', 'dataset');
    const perInhabitant = [
      tocLine('    Regional statistics', 'reg', 'folder'),
      tocLine('        GDP per inhabitant', 'tgs00005', 'dataset'),
    ];
    const economyFirst = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      ...perInhabitant,
      tocLine('    Economy', 'econ', 'folder'),
      regional,
      tocLine('    Regional statistics', 'reg', 'folder'),
      regional,
    ]);
    const regionalFirst = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      ...perInhabitant,
      regional,
      tocLine('    Economy', 'econ', 'folder'),
      regional,
    ]);
    const ctx = createMockContext();
    const first = await economyFirst.search('regional gdp', 10, undefined, ctx);
    const second = await regionalFirst.search('regional gdp', 10, undefined, ctx);
    // tgs00005 comes first in TOC order but has "regional" only in its breadcrumb.
    expect(first.datasets.map((d) => [d.code, d.themePath])).toEqual([
      ['nama_10r_2gdp', ['Root', 'Economy']],
      ['tgs00005', ['Root', 'Regional statistics']],
    ]);
    expect(second.datasets.map((d) => [d.code, d.themePath])).toEqual([
      ['nama_10r_2gdp', ['Root', 'Regional statistics']],
      ['tgs00005', ['Root', 'Regional statistics']],
    ]);
  });

  it('pages each match once, in tier order, across a page boundary inside a tier', async () => {
    const svc = await makeLoadedService(employment);
    const ctx = createMockContext();
    const page1 = await svc.search('employment rate', 3, undefined, ctx);
    const page2 = await svc.search('employment rate', 3, page1.nextCursor, ctx);
    // The second tier (une_rt_m, tec00109) straddles the boundary.
    expect(page1.datasets.map((d) => d.code)).toEqual(TIERED.slice(0, 3));
    expect(page2.datasets.map((d) => d.code)).toEqual(TIERED.slice(3));
    expect([page1.totalMatches, page2.totalMatches]).toEqual([5, 5]);
    expect(page2.nextCursor).toBeUndefined();

    const codes: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.search('employment rate', 1, cursor, ctx);
      codes.push(...page.datasets.map((d) => d.code));
      cursor = page.nextCursor;
    } while (cursor);
    expect(codes).toEqual(TIERED);
  });

  it('returns no rows and no cursor for an offset past the last match', async () => {
    const svc = await makeLoadedService(employment);
    const ctx = createMockContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { entries, loadedAt } = (svc as any).cache;
    const past = encodeCursor({
      offset: 5,
      limit: 3,
      query: 'employment rate',
      generation: loadedAt.getTime(),
      entryCount: entries.length,
    });
    const page = await svc.search('employment rate', 3, past, ctx);
    expect(page.datasets).toEqual([]);
    expect(page.totalMatches).toBe(5);
    expect(page.nextCursor).toBeUndefined();
  });

  it('rejects a cursor whose walk length is missing, malformed, or past the snapshot', async () => {
    const svc = await makeLoadedService(employment);
    const ctx = createMockContext();
    const page1 = await svc.search('employment rate', 2, undefined, ctx);
    const { entryCount, ...unwalked } = JSON.parse(
      Buffer.from(page1.nextCursor ?? '', 'base64url').toString(),
    );
    expect(entryCount).toBe(employment.length);
    for (const forged of [undefined, -1, 1.5, '7', entryCount + 1]) {
      const cursor = encodeCursor({ ...unwalked, entryCount: forged });
      await expect(svc.search('employment rate', 2, cursor, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_cursor' },
      });
    }
  });

  it('applies the tiers to any word subset handed to searchTierOf', () => {
    const tierOf = searchTierOf(['employment', 'rate']);
    expect(tierOf('employment rates by sex', 'lfsa_ergan')).toBe(0);
    expect(tierOf('unemployment rate', 'une_rt_m')).toBe(1);
    expect(tierOf('persons in work', 'employment_x')).toBe(2);
    expect(searchTierOf(['RATE'])('unemployment rate', 'une_rt_m')).toBe(0);
    expect(searchTierOf(['employment'])('unemployment rate', 'une_rt_m')).toBe(1);
    expect(searchTierOf(['rate'])('persons in work', 'ratio_x')).toBe(2);
  });

  /** Thread CPU ms of the cheapest of five runs that build the tier test and rank a batch of labels. */
  function tierCpuMs(words: readonly string[]): number {
    const labels = [
      'employment rates by sex, age and citizenship (%)',
      'unemployment rate - monthly data',
      'gross domestic product (gdp) at current market prices by nuts 2 region',
      'enterprises by nace rev.2 activity (2015=100) §1 x',
    ];
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const before = process.threadCpuUsage();
      const tierOf = searchTierOf(words);
      for (let n = 0; n < 25; n++) for (const label of labels) tierOf(label, 'lfsa_ergan');
      const { user, system } = process.threadCpuUsage(before);
      best = Math.min(best, (user + system) / 1000);
    }
    return best;
  }

  /** Sizes doubling over 64×; shapes the fold regex works on stay below 80k characters. */
  const doubling = (from: number) => Array.from({ length: 7 }, (_, k) => from * 2 ** k);
  const tierShapes: Record<string, { sizes: number[]; words: (n: number) => string[] }> = {
    'line breaks after a punctuation mark': {
      sizes: doubling(1_000),
      words: (n) => [`${'§1 x'.repeat(n / 4)}\ny`],
    },
    'blank runs with carriage returns': {
      sizes: doubling(1_000),
      words: (n) => ['  \r\n'.repeat(n / 4)],
    },
    'a query of repeated openers': {
      sizes: doubling(1_000),
      words: (n) => Array.from({ length: n / 2 }, () => '('),
    },
    'a long digit run': { sizes: doubling(5_000), words: (n) => ['1'.repeat(n)] },
    'a query of distinct words': {
      sizes: doubling(5_000),
      words: (n) => Array.from({ length: n / 8 }, (_, i) => `w${i}`),
    },
  };

  for (const [shape, { sizes, words }] of Object.entries(tierShapes)) {
    it(`ranks in linear time on ${shape}`, () => {
      tierCpuMs(['warm', 'up']); // compile the regexes before timing
      const times: number[] = [];
      for (const n of sizes) {
        const ms = tierCpuMs(words(n));
        // Checked per size: a quadratic scan fails here rather than running for minutes.
        expect(ms).toBeLessThan(250);
        times.push(ms);
      }
      const [smallest = 0, largest = 0] = [times[0], times[times.length - 1]];
      expect(largest / Math.max(smallest, 0.05)).toBeLessThan(256);
    });
  }
});

// ---------------------------------------------------------------------------
// Search — matching queries keep their pages and cursors (#103)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — pages and cursors of matching searches (characterization)', () => {
  const EXCERPT = readFileSync(
    new URL('../fixtures/toc-2026-10-14-excerpt.tsv', import.meta.url),
    'utf8',
  );

  /** Every page of `query`, three rows a page, over the excerpt as loaded at a fixed time. */
  async function walk(query: string) {
    const svc = new EurostatCatalogueService(mockConfig, mockStorage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (svc as any).parseToc(EXCERPT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).cache = {
      entries: parsed,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      codeIndex: (svc as any).buildCodeIndex(parsed),
      loadedAt: new Date('2026-11-08T12:00:00Z'),
    };
    const pages: Array<{ codes: string[]; keys: string[]; nextCursor?: string }> = [];
    const totals = new Set<number>();
    let cursor: string | undefined;
    do {
      const page = await svc.search(query, 3, cursor, createMockContext());
      totals.add(page.totalMatches);
      pages.push({
        codes: page.datasets.map((d) => d.code),
        keys: Object.keys(page).sort(),
        ...(page.nextCursor && { nextCursor: page.nextCursor }),
      });
      cursor = page.nextCursor;
    } while (cursor);
    return { pages, totals: [...totals] };
  }

  const middle = ['datasets', 'nextCursor', 'totalMatches'];
  const last = ['datasets', 'totalMatches'];

  it('pages "NACE Rev.2" with the same rows and cursor', async () => {
    expect(await walk('NACE Rev.2')).toEqual({
      pages: [
        {
          codes: ['ei_isin_m', 'ei_isse_q', 'sbs_sc_ovw'],
          keys: middle,
          nextCursor:
            'eyJvZmZzZXQiOjMsImxpbWl0IjozLCJxdWVyeSI6Im5hY2UgcmV2LjIiLCJnZW5lcmF0aW9uIjoxNzk0MTM5MjAwMDAwLCJlbnRyeUNvdW50IjoxNDd9',
        },
        { codes: ['sbs_ovw_smc', 'egr_mne_n2sc', 'egr_mne_empw'], keys: last },
      ],
      totals: [6],
    });
  });

  it('pages a query that repeats one word with the same rows and cursors', async () => {
    expect(await walk('rates RATES rates')).toEqual({
      pages: [
        {
          codes: ['ei_isse_q', 'lfst_r_lfe2emprt', 'met_lfu3rt'],
          keys: middle,
          nextCursor:
            'eyJvZmZzZXQiOjMsImxpbWl0IjozLCJxdWVyeSI6InJhdGVzIHJhdGVzIHJhdGVzIiwiZ2VuZXJhdGlvbiI6MTc5NDEzOTIwMDAwMCwiZW50cnlDb3VudCI6MTQ3fQ',
        },
        {
          codes: ['urt_lfu3rt', 'enps_lfsa_urgan', 'enpe_lfsa_urgan'],
          keys: middle,
          nextCursor:
            'eyJvZmZzZXQiOjYsImxpbWl0IjozLCJxdWVyeSI6InJhdGVzIHJhdGVzIHJhdGVzIiwiZ2VuZXJhdGlvbiI6MTc5NDEzOTIwMDAwMCwiZW50cnlDb3VudCI6MTQ3fQ',
        },
        {
          codes: ['lfsa_urgaed', 'tps00066', 'lfsa_ergan'],
          keys: middle,
          nextCursor:
            'eyJvZmZzZXQiOjksImxpbWl0IjozLCJxdWVyeSI6InJhdGVzIHJhdGVzIHJhdGVzIiwiZ2VuZXJhdGlvbiI6MTc5NDEzOTIwMDAwMCwiZW50cnlDb3VudCI6MTQ3fQ',
        },
        {
          codes: ['lfsa_ergaed', 'tgs00007', 'tesem090'],
          keys: middle,
          nextCursor:
            'eyJvZmZzZXQiOjEyLCJsaW1pdCI6MywicXVlcnkiOiJyYXRlcyByYXRlcyByYXRlcyIsImdlbmVyYXRpb24iOjE3OTQxMzkyMDAwMDAsImVudHJ5Q291bnQiOjE0N30',
        },
        { codes: ['tesem080'], keys: last },
      ],
      totals: [13],
    });
  });

  it('pages a repeated word beside a spaced punctuation form with the same rows and cursor', async () => {
    expect(await walk('nace NACE Rev. 2 activity')).toEqual({
      pages: [
        {
          codes: ['htec_emp_reg', 'sbs_sc_ovw', 'sbs_ovw_smc'],
          keys: middle,
          nextCursor:
            'eyJvZmZzZXQiOjMsImxpbWl0IjozLCJxdWVyeSI6Im5hY2UgbmFjZSByZXYuIDIgYWN0aXZpdHkiLCJnZW5lcmF0aW9uIjoxNzk0MTM5MjAwMDAwLCJlbnRyeUNvdW50IjoxNDd9',
        },
        { codes: ['egr_mne_n2sc', 'egr_mne_empw'], keys: last },
      ],
      totals: [5],
    });
  });
});

// ---------------------------------------------------------------------------
// Search — dimension value labels when no catalogue text matches (#103)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — dimension value labels when no catalogue text matches (#103)', () => {
  /**
   * The issue's datasets under their TOC labels. namq_10_fcs is filed twice, first where its
   * text holds no "GDP"; reg_uk stands in for a dataset listing the Essex regions.
   */
  const TOC = [
    tocLine('Database by themes', 'data', 'folder'),
    tocLine('    Health care resources', 'hlth_res', 'folder'),
    tocLine('        Health graduates', 'hlth_rs_grd2', 'dataset'),
    tocLine('        Health personnel', 'hlth_rs_prs2', 'dataset'),
    tocLine('        Health graduates - historical data (1980-2021)', 'hlth_rs_grd', 'dataset'),
    tocLine(
      '        Health personnel (excluding nursing and caring professionals) - historical data (1980-2021)',
      'hlth_rs_prs1',
      'dataset',
    ),
    tocLine(
      '        Health personnel by NUTS 2 region - historical data (1993-2021)',
      'hlth_rs_prsrg',
      'dataset',
    ),
    tocLine('    Government finance statistics', 'gov', 'folder'),
    tocLine(
      '        Government deficit/surplus, debt and associated data',
      'gov_10dd_edpt1',
      'dataset',
    ),
    tocLine('    Household accounts', 'hh', 'folder'),
    tocLine(
      '        Household final consumption expenditure by durability - quarterly data',
      'namq_10_fcs',
      'dataset',
    ),
    tocLine('    Main GDP aggregates', 'namq_10_ma', 'folder'),
    tocLine(
      '        Household final consumption expenditure by durability - quarterly data',
      'namq_10_fcs',
      'dataset',
    ),
    tocLine('    Annual national accounts', 'nama_10', 'folder'),
    tocLine(
      '        Gross domestic product (GDP) and main components (output, expenditure and income) - annual data',
      'nama_10_gdp',
      'dataset',
    ),
    tocLine('    Prices', 'prc', 'folder'),
    tocLine(
      '        Harmonised index of consumer prices (HICP) - monthly data',
      'prc_hicp_ct',
      'dataset',
    ),
    tocLine('    Production in industry', 'sts_ind', 'folder'),
    tocLine('        Production in industry - monthly data', 'sts_inpr_m', 'dataset'),
    tocLine('    Regions', 'reg', 'folder'),
    tocLine('        Former regions of the United Kingdom', 'reg_uk', 'dataset'),
  ];

  /** Metabase rows (`dataset<TAB>dimension<TAB>code`), codes as Eurostat lists them for these datasets. */
  const METABASE = [
    'hlth_rs_grd2\tmed_spec\tDENT',
    'hlth_rs_grd2\tmed_spec\tMWS',
    'hlth_rs_grd2\tmed_spec\tPHARM',
    'hlth_rs_grd2\tunit\tNR',
    'hlth_rs_grd2\ttime\t2020',
    'hlth_rs_prs2\tmed_spec\tDENT',
    'hlth_rs_prs2\tmed_spec\tPHARM',
    'hlth_rs_prs2\tmed_spec\tPHYSIO',
    'hlth_rs_prs2\tunit\tNR',
    'hlth_rs_grd\tisco08\tOC221',
    'hlth_rs_grd\tisco08\tOC2262',
    'hlth_rs_prs1\tisco08\tOC2262',
    'hlth_rs_prs1\tisco08\tOC2264',
    'hlth_rs_prsrg\tisco08\tOC2262',
    'hlth_rs_prsrg\tisco08\tOC2264',
    'hlth_rs_prsrg\tgeo\tPL',
    'gov_10dd_edpt1\tna_item\tB1GQ',
    'gov_10dd_edpt1\tunit\tPC_GDP',
    'gov_10dd_edpt1\tgeo\tPL',
    'namq_10_fcs\tunit\tPC_GDP',
    'namq_10_fcs\tgeo\tPL',
    'nama_10_gdp\tna_item\tB1GQ',
    'nama_10_gdp\tunit\tPC_GDP',
    'nama_10_gdp\tgeo\tPL',
    'prc_hicp_ct\tcoicop18\tCP0511',
    'prc_hicp_ct\tcoicop18\tCP05311',
    'prc_hicp_ct\tcoicop18\tCP05403',
    'prc_hicp_ct\tgeo\tPL',
    'sts_inpr_m\tnace_r2\tC31',
    'sts_inpr_m\tnace_r2\tC3102',
    'sts_inpr_m\tgeo\tPL',
    'reg_uk\tgeo\tUKH3',
    'reg_uk\tgeo\tUKH33',
  ].join('\n');

  /** The English names the global codelists give those codes. */
  const CODELISTS: Record<string, Record<string, string>> = {
    MED_SPEC: {
      DENT: 'Dentists',
      MWS: 'Midwives (EU recognised qualification)',
      PHARM: 'Pharmacists',
      PHYSIO: 'Physiotherapists',
    },
    ISCO08: { OC221: 'Medical doctors', OC2262: 'Pharmacists', OC2264: 'Physiotherapists' },
    UNIT: { NR: 'Number', PC_GDP: 'Percentage of gross domestic product (GDP)' },
    NA_ITEM: { B1GQ: 'Gross domestic product at market prices' },
    GEO: { PL: 'Poland', UKH3: 'Essex (NUTS 2021)', UKH33: 'Essex CC (NUTS 2010)' },
    COICOP18: {
      CP0511: 'Furniture, furnishings and loose carpets (D)',
      CP05311: 'Major kitchen appliances (D)',
      CP05403: 'Kitchen utensils and articles (SD)',
    },
    NACE_R2: { C31: 'Manufacture of furniture', C3102: 'Manufacture of kitchen furniture' },
    // Labelled here only so that a search reading the time dimension would find "2020".
    TIME: { '2020': '2020' },
  };
  /** The codelist dump's SDMX structure message, holding {@link CODELISTS}. */
  const CODELIST_XML = `<?xml version="1.0" encoding="UTF-8"?><m:Structure><m:Structures><s:Codelists>${Object.entries(
    CODELISTS,
  )
    .map(
      ([id, codes]) =>
        `<s:Codelist id="${id}">${Object.entries(codes)
          .map(
            ([code, name]) =>
              `<s:Code id="${code}"><c:Name xml:lang="en">${name}</c:Name></s:Code>`,
          )
          .join('')}</s:Codelist>`,
    )
    .join('\n')}</s:Codelists></m:Structures></m:Structure>`;

  async function* oneChunk(text: string): AsyncGenerator<string> {
    yield text;
  }

  /** The index the loader builds from {@link METABASE} and {@link CODELIST_XML}. */
  const valueIndex = (): Promise<DimensionValueIndex> =>
    buildDimensionValueIndex(oneChunk(METABASE), oneChunk(CODELIST_XML));

  /** The catalogue over {@link TOC}, its dimension value index slot holding `slot`. */
  async function serviceWith(slot: Record<string, unknown>): Promise<EurostatCatalogueService> {
    const svc = await makeLoadedService(TOC);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).valueIndex = { failures: 0, retryAt: 0, ...slot };
    return svc;
  }
  const ready = async () => serviceWith({ index: await valueIndex() });

  const search = (svc: EurostatCatalogueService, query: string, limit = 20, cursor?: string) =>
    svc.search(query, limit, cursor, createMockContext());

  const PHARM = { dimension: 'med_spec', code: 'PHARM', label: 'Pharmacists' };
  const OC2262 = { dimension: 'isco08', code: 'OC2262', label: 'Pharmacists' };
  const PL = { dimension: 'geo', code: 'PL', label: 'Poland' };
  const PC_GDP = {
    dimension: 'unit',
    code: 'PC_GDP',
    label: 'Percentage of gross domestic product (GDP)',
  };
  const PHARMACISTS = [
    'hlth_rs_grd2',
    'hlth_rs_prs2',
    'hlth_rs_grd',
    'hlth_rs_prs1',
    'hlth_rs_prsrg',
  ];
  const invalidCursor = {
    code: JsonRpcErrorCode.InvalidParams,
    data: { reason: 'invalid_cursor' },
  };

  // No test here reaches Eurostat; one that loads an index through fetch stubs its own.
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch is not available in this suite');
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('finds hlth_rs_prs2 for "pharmacists" through med_spec=PHARM, beside every dataset with a Pharmacists value', async () => {
    const result = await search(await ready(), 'pharmacists');
    expect(result.datasets.map((d) => [d.code, d.matchedValues])).toEqual([
      ['hlth_rs_grd2', [PHARM]],
      ['hlth_rs_prs2', [PHARM]],
      ['hlth_rs_grd', [OC2262]],
      ['hlth_rs_prs1', [OC2262]],
      ['hlth_rs_prsrg', [OC2262]],
    ]);
    expect(result.datasets[1]).toEqual({
      code: 'hlth_rs_prs2',
      label: 'Health personnel',
      type: 'dataset',
      themePath: ['Database by themes', 'Health care resources'],
      matchedValues: [PHARM],
    });
    expect(result).toMatchObject({ totalMatches: 5, matchedThroughValues: true });
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('matches where a word begins a word of a label: "pharmacist" finds "Pharmacists", "sex" finds no "Essex"', async () => {
    const svc = await ready();
    expect((await search(svc, 'pharmacist')).datasets.map((d) => d.code)).toEqual(PHARMACISTS);
    expect((await search(svc, 'essex')).datasets.map((d) => [d.code, d.matchedValues])).toEqual([
      [
        'reg_uk',
        [
          { dimension: 'geo', code: 'UKH3', label: 'Essex (NUTS 2021)' },
          { dimension: 'geo', code: 'UKH33', label: 'Essex CC (NUTS 2010)' },
        ],
      ],
    ]);
    // Neither the time dimension nor a word inside a longer word is searched.
    expect(await search(svc, 'sex')).toEqual({ datasets: [], totalMatches: 0 });
    expect(await search(svc, '2020')).toEqual({ datasets: [], totalMatches: 0 });
  });

  it('lists only the values for words a row’s own text lacks, fewer such words first, then by tier', async () => {
    const result = await search(await ready(), 'GDP Poland');
    // nama_10_gdp lists PC_GDP too, but "GDP" is in its label, so only Poland came through values.
    expect(result.datasets.map((d) => [d.code, d.themePath, d.matchedValues])).toEqual([
      ['nama_10_gdp', ['Database by themes', 'Annual national accounts'], [PL]],
      ['namq_10_fcs', ['Database by themes', 'Main GDP aggregates'], [PL]],
      ['gov_10dd_edpt1', ['Database by themes', 'Government finance statistics'], [PC_GDP, PL]],
    ]);
    expect(result.totalMatches).toBe(3);
  });

  it('ranks a row where one value carries every word ahead of one whose words sit in separate values', async () => {
    const svc = await ready();
    for (const query of ['kitchen furniture', 'Kitchen kitchen FURNITURE']) {
      const result = await search(svc, query);
      expect(result.datasets.map((d) => [d.code, d.matchedValues?.map((v) => v.code)])).toEqual([
        // C3102 "Manufacture of kitchen furniture" carries both words, so it leads C31.
        ['sts_inpr_m', ['C3102', 'C31']],
        ['prc_hicp_ct', ['CP0511', 'CP05311', 'CP05403']],
      ]);
    }
  });

  it('leaves a search the catalogue text answers as it was', async () => {
    const query = 'health personnel';
    const before = await search(await makeLoadedService(TOC), query);
    expect(before.datasets.map((d) => d.code)).toEqual([
      'hlth_rs_prs2',
      'hlth_rs_prs1',
      'hlth_rs_prsrg',
    ]);
    expect(await search(await ready(), query)).toEqual(before);
  });

  it('pages rows found through values once each, in order, two to a page', async () => {
    const svc = await ready();
    const pages: string[][] = [];
    const totals = new Set<number>();
    let cursor: string | undefined;
    do {
      const page = await search(svc, 'pharmacists', 2, cursor);
      pages.push(page.datasets.map((d) => d.code));
      totals.add(page.totalMatches);
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual([PHARMACISTS.slice(0, 2), PHARMACISTS.slice(2, 4), PHARMACISTS.slice(4)]);
    expect([...totals]).toEqual([5]);
  });

  it('rejects a cursor once the index refreshes mid-walk, and one without the index binding', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await valueIndex();
    const svc = await serviceWith({ index: first });
    const page1 = await search(svc, 'pharmacists', 2);
    const { valueIndex: bound, ...unbound } = JSON.parse(
      Buffer.from(page1.nextCursor ?? '', 'base64url').toString(),
    );
    expect(bound).toBe(first.loadedAt);
    for (const forged of [
      encodeCursor(unbound),
      encodeCursor({ ...unbound, valueIndex: bound - 1 }),
    ]) {
      await expect(search(svc, 'pharmacists', 2, forged)).rejects.toMatchObject(invalidCursor);
    }
    expect((await search(svc, 'pharmacists', 2, page1.nextCursor)).datasets).toHaveLength(2);

    // A refresh lands a minute later, the catalogue unchanged.
    vi.setSystemTime(Date.now() + 60_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).valueIndex.index = await valueIndex();
    await expect(search(svc, 'pharmacists', 2, page1.nextCursor)).rejects.toMatchObject(
      invalidCursor,
    );
    const restarted = await search(svc, 'pharmacists', 2);
    expect(restarted.datasets.map((d) => d.code)).toEqual(PHARMACISTS.slice(0, 2));
    expect((await search(svc, 'pharmacists', 2, restarted.nextCursor)).datasets).toHaveLength(2);
  });

  it('returns no rows and no cursor for an offset past the last row found through values', async () => {
    const index = await valueIndex();
    const svc = await serviceWith({ index });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { entries, loadedAt } = (svc as any).cache;
    const past = encodeCursor({
      offset: 5,
      limit: 2,
      query: 'pharmacists',
      generation: loadedAt.getTime(),
      entryCount: entries.length,
      valueIndex: index.loadedAt,
    });
    expect(await search(svc, 'pharmacists', 2, past)).toEqual({
      datasets: [],
      totalMatches: 5,
      matchedThroughValues: true,
    });
  });

  it('answers a zero-match search as before, plus index_unavailable, while the index loads or after it failed', async () => {
    const before = await makeLoadedService(TOC);
    const loading = await serviceWith({ loading: new Promise(() => {}) });
    const failed = await serviceWith({ failures: 1, retryAt: Date.now() + 60_000 });
    const loaded = await ready();
    expect(await search(before, 'pharmacists zqxw')).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['pharmacists', 'zqxw'],
      allWordsUnmatched: true,
    });
    expect(await search(before, 'personnel zqxw')).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['zqxw'],
      wordRemovalCounts: [{ word: 'zqxw', totalMatches: 3 }],
    });
    for (const query of ['pharmacists zqxw', 'personnel zqxw', 'DS-056120 pharmacists', 'zqxw']) {
      const today = await search(before, query);
      expect(await search(loading, query)).toEqual({
        ...today,
        valuesNotSearched: 'index_unavailable',
      });
      expect(await search(failed, query)).toEqual({
        ...today,
        valuesNotSearched: 'index_unavailable',
      });
      // A pass over the loaded index that finds nothing leaves the result as it was.
      expect(await search(loaded, query)).toEqual(today);
    }
  });

  it(`skips the pass past ${MAX_VALUE_SEARCH_WORDS} distinct words, a repeated word counted once`, async () => {
    const svc = await ready();
    const words = ['health', 'personnel', 'database', 'by', 'themes', 'care', 'resources'];
    const atBound = [...words, 'hlth_rs_prs2', 'heal', 'pharmacists'];
    expect(atBound).toHaveLength(MAX_VALUE_SEARCH_WORDS);
    expect(
      (await search(svc, atBound.join(' '))).datasets.map((d) => [d.code, d.matchedValues]),
    ).toEqual([['hlth_rs_prs2', [PHARM]]]);
    expect((await search(svc, `${atBound.join(' ')} HEAL`)).totalMatches).toBe(1);
    expect(await search(svc, `pers ${atBound.join(' ')}`)).toEqual({
      datasets: [],
      totalMatches: 0,
      unmatchedWords: ['pharmacists'],
      wordRemovalCounts: [{ word: 'pharmacists', totalMatches: 1 }],
      valuesNotSearched: 'too_many_words',
    });
  });

  it('answers at once while an index load is in flight', async () => {
    let settle: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const svc = await serviceWith({});
    expect(await search(svc, 'pharmacists')).toEqual({
      datasets: [],
      totalMatches: 0,
      valuesNotSearched: 'index_unavailable',
    });
    // A second search shares the load rather than starting another.
    await search(svc, 'pharmacists');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    settle?.(new Response('down', { status: 503 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).valueIndex.loading;
  });

  it('retries a failed load after a minute, doubling to the TOC refresh interval, and keeps a loaded index through a failed refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let serve: 'fail' | 'index' = 'fail';
    const loads: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        const metabase = url.includes('/catalogue/metabase.txt.gz');
        if (metabase) loads.push(Date.now());
        if (serve === 'fail') return new Response('down', { status: 503 });
        return new Response(gzipSync(metabase ? METABASE : CODELIST_XML));
      }),
    );
    const svc = await serviceWith({});
    // The TOC refreshes on its own TTL meanwhile; that load is not under test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(svc as any, 'fetchAndParseToc').mockImplementation(async () => makeCache(svc, TOC));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slot = (svc as any).valueIndex;
    const call = async () => {
      await search(svc, 'pharmacists');
      await slot.loading;
    };
    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

    await call();
    expect(loads).toHaveLength(1);
    // Seconds between attempts after each failure in a row: a minute, doubling, at most 12 hours.
    const backoffS = [60, 120, 240, 480, 960, 1_920, 3_840, 7_680, 15_360, 30_720, 43_200, 43_200];
    for (const [k, seconds] of backoffS.entries()) {
      advance(seconds * 1000 - 1);
      await call();
      expect(loads).toHaveLength(k + 1);
      advance(1);
      await call();
      expect(loads).toHaveLength(k + 2);
    }
    expect(await search(svc, 'pharmacists')).toMatchObject({
      valuesNotSearched: 'index_unavailable',
    });

    // A load that succeeds resets the backoff and answers the next search.
    serve = 'index';
    advance(43_200_000);
    await call();
    const index = slot.index;
    expect(index).toBeDefined();
    expect(slot).toMatchObject({ failures: 0, retryAt: 0 });
    expect((await search(svc, 'pharmacists')).totalMatches).toBe(5);
    const afterSuccess = loads.length;

    // The index is refreshed only once it is as old as the TOC's TTL.
    serve = 'fail';
    advance(43_200_000 - 1);
    await call();
    expect(loads).toHaveLength(afterSuccess);
    advance(1);
    await call();
    expect(loads).toHaveLength(afterSuccess + 1);

    // The refresh failed: the previous index stays in service, and the backoff starts over.
    expect(slot.index).toBe(index);
    expect((await search(svc, 'pharmacists')).totalMatches).toBe(5);
    advance(59_999);
    await call();
    expect(loads).toHaveLength(afterSuccess + 1);
    advance(1);
    await call();
    expect(loads).toHaveLength(afterSuccess + 2);
  });
});

// ---------------------------------------------------------------------------
// Browse — duplicate folder codes across theme branches (#32)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — duplicate folder codes (#32)', () => {
  /**
   * The live TOC's shape: a primary tree and a cross-cutting tree that re-files a subset of
   * the same folders. Both roots carry the code `data`, and `hsw_ac` appears under each with
   * the cross-cutting copy missing one child.
   */
  const shadowedPlacements = [
    tocLine('Database by themes', 'data', 'folder'),
    tocLine('    Health and safety', 'hsw_ac', 'folder'),
    tocLine('        Accidents by activity', 'hsw_n2_01', 'dataset'),
    tocLine('        Accidents by severity', 'hsw_n2_02', 'dataset'),
    tocLine('        Accidents by age', 'hsw_n2_03', 'dataset'),
    tocLine('Cross cutting topics', 'data', 'folder'),
    tocLine('    Health and safety', 'hsw_ac', 'folder'),
    tocLine('        Accidents by activity', 'hsw_n2_01', 'dataset'),
  ];

  it('resolves a duplicated code to its first placement, not its last', async () => {
    const svc = await makeLoadedService(shadowedPlacements);
    const ctx = createMockContext();
    const result = await svc.browse('data', ctx);
    // Last-wins resolved this to "Cross cutting topics" and its single child; the primary
    // tree's branch was then unreachable by any theme_code.
    expect(result.parentPath).toEqual(['Database by themes']);
    expect(result.items.map((i) => i.code)).toEqual(['hsw_ac']);
    expect(result.otherPlacements).toEqual([['Cross cutting topics']]);
  });

  it('returns the fuller child set when placements differ', async () => {
    const svc = await makeLoadedService(shadowedPlacements);
    const ctx = createMockContext();
    const result = await svc.browse('hsw_ac', ctx);
    expect(result.items.map((i) => i.code)).toEqual(['hsw_n2_01', 'hsw_n2_02', 'hsw_n2_03']);
    expect(result.parentPath).toEqual(['Database by themes', 'Health and safety']);
  });

  it('discloses the branches it did not take', async () => {
    const svc = await makeLoadedService(shadowedPlacements);
    const ctx = createMockContext();
    const result = await svc.browse('hsw_ac', ctx);
    expect(result.otherPlacements).toEqual([['Cross cutting topics', 'Health and safety']]);
  });

  it('omits otherPlacements for a code with a single placement', async () => {
    const svc = await makeLoadedService([
      tocLine('Database by themes', 'data', 'folder'),
      tocLine('    Economy', 'econ', 'folder'),
      tocLine('        GDP', 'nama_10_gdp', 'dataset'),
    ]);
    const ctx = createMockContext();
    const result = await svc.browse('econ', ctx);
    expect(result.items.map((i) => i.code)).toEqual(['nama_10_gdp']);
    expect(result.otherPlacements).toBeUndefined();
    expect('otherPlacements' in result).toBe(false);
  });

  it('lists every extra placement when a code is filed more than twice', async () => {
    const svc = await makeLoadedService([
      tocLine('Primary', 'p', 'folder'),
      tocLine('    Shared', 'dup', 'folder'),
      tocLine('        Leaf', 'leaf_a', 'dataset'),
      tocLine('Secondary', 's', 'folder'),
      tocLine('    Shared', 'dup', 'folder'),
      tocLine('Tertiary', 't', 'folder'),
      tocLine('    Shared', 'dup', 'folder'),
    ]);
    const ctx = createMockContext();
    const result = await svc.browse('dup', ctx);
    expect(result.items.map((i) => i.code)).toEqual(['leaf_a']);
    expect(result.otherPlacements).toEqual([
      ['Secondary', 'Shared'],
      ['Tertiary', 'Shared'],
    ]);
  });

  it('ignores a dataset that happens to share the folder code', async () => {
    const svc = await makeLoadedService([
      tocLine('Primary', 'p', 'folder'),
      tocLine('    Shared', 'dup', 'folder'),
      tocLine('        Leaf', 'leaf_a', 'dataset'),
      tocLine('Secondary', 's', 'folder'),
      tocLine('    Shared', 'dup', 'dataset'),
    ]);
    const ctx = createMockContext();
    const result = await svc.browse('dup', ctx);
    expect(result.items.map((i) => i.code)).toEqual(['leaf_a']);
    // A dataset is not a branch — naming it as a placement would point the caller at a code
    // that browse cannot expand.
    expect(result.otherPlacements).toBeUndefined();
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

  it('reports no load time for a catalogue inside its TTL or freshly refreshed (characterization)', async () => {
    const svc = await makeLoadedService(loadedToc);
    stubFetch(svc, upstreamToc);
    const ctx = createMockContext();

    expect(await svc.browse(undefined, ctx)).not.toHaveProperty('catalogueLoadedAt');
    expireCache(svc);
    expect(await svc.search('trade volumes', 10, undefined, ctx)).not.toHaveProperty(
      'catalogueLoadedAt',
    );
    expect(await svc.browse('econ', ctx)).not.toHaveProperty('catalogueLoadedAt');
  });

  it('reports when the catalogue it serves was loaded while a failed refresh holds it in service (#63)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const svc = await makeLoadedService(loadedToc);
      vi
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn(svc as any, 'fetchAndParseToc')
        .mockRejectedValueOnce(new Error('Eurostat unreachable'))
        .mockRejectedValueOnce(new Error('Eurostat unreachable'))
        .mockImplementationOnce(async () => makeCache(svc, upstreamToc));
      expireCache(svc);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loadedAt = ((svc as any).cache.loadedAt as Date).toISOString();
      const ctx = createMockContext();

      // The call whose refresh failed, then calls inside the cooldown, a search and every browse.
      expect(await svc.search('economy', 10, undefined, ctx)).toMatchObject({
        catalogueLoadedAt: loadedAt,
      });
      vi.setSystemTime(Date.now() + 30_000);
      expect(await svc.browse(undefined, ctx)).toMatchObject({ catalogueLoadedAt: loadedAt });
      expect(await svc.browse('econ', ctx)).toMatchObject({ catalogueLoadedAt: loadedAt });
      expect(await svc.search('zebra', 10, undefined, ctx)).toMatchObject({
        totalMatches: 0,
        catalogueLoadedAt: loadedAt,
      });

      // The retry past the cooldown fails again: still the same copy, still disclosed.
      vi.setSystemTime(Date.now() + 31_000);
      expect(await svc.browse(undefined, ctx)).toMatchObject({ catalogueLoadedAt: loadedAt });

      // A refresh that succeeds ends the disclosure.
      vi.setSystemTime(Date.now() + 61_000);
      const recovered = await svc.browse(undefined, ctx);
      expect(recovered.items.map((i) => i.code)).toEqual(['econ', 'trd']);
      expect(recovered).not.toHaveProperty('catalogueLoadedAt');
    } finally {
      vi.useRealTimers();
    }
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
// An unavailable catalogue host on a cold start (#71)
// ---------------------------------------------------------------------------

describe('EurostatCatalogueService — an unavailable catalogue host on a cold start (#71)', () => {
  /**
   * Run `call` against a stubbed `fetch`, past the TOC's 1 s / 2 s / 4 s backoff (plus
   * jitter) without waiting it out, and return what it settled to with the fetch stub.
   */
  async function coldStart(
    respond: (url: URL) => Promise<Response>,
    call: (svc: EurostatCatalogueService) => Promise<unknown>,
  ) {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: unknown) => respond(new URL(String(input))));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const outcome = call(new EurostatCatalogueService(mockConfig, mockStorage)).then(
        (value) => value,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const tocCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/catalogue/toc/'),
      ).length;
      return {
        outcome: (await outcome) as { code?: number; data?: Record<string, unknown> },
        tocCalls,
      };
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }
  const unavailable = async () =>
    new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });

  it('fails a TOC answering 503 on every attempt as a retryable upstream_fault', async () => {
    const { outcome, tocCalls } = await coldStart(unavailable, (svc) =>
      svc.browse(undefined, createMockContext()),
    );
    expect(outcome.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(outcome.data).toMatchObject({ reason: 'upstream_fault', retryable: true, status: 503 });
    expect((outcome as unknown as Error).message).toContain('HTTP 503');
    expect(tocCalls).toBe(4);
  });

  it('fails an unreachable host the same way, for search too', async () => {
    const { outcome, tocCalls } = await coldStart(
      async () => {
        throw new TypeError('fetch failed');
      },
      (svc) => svc.search('gdp', 10, undefined, createMockContext()),
    );
    expect(outcome.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
    expect((outcome as unknown as Error).message).toContain('could not be reached');
    expect(tocCalls).toBe(4);
  });

  it('answers from the TOC alone when only the Comext dataflow list is down (characterization)', async () => {
    const { outcome } = await coldStart(
      async (url) =>
        url.pathname.includes('/catalogue/toc/')
          ? new Response(
              buildTsv([
                tocLine('Database by themes', 'data', 'folder'),
                tocLine('    GDP and main components', 'nama_10_gdp', 'dataset'),
              ]),
            )
          : unavailable(),
      (svc) => svc.search('gdp', 10, undefined, createMockContext()),
    );
    expect(outcome).toMatchObject({ totalMatches: 1, comextListMissing: true });
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
