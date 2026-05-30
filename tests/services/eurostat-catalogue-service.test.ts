/**
 * @fileoverview Unit tests for EurostatCatalogueService pure logic (TOC parsing, search, browse).
 * @module tests/services/eurostat-catalogue-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

/** Simulate a loaded service by monkey-patching fetchAndParseToc. */
async function makeLoadedService(entries: string[]): Promise<EurostatCatalogueService> {
  const svc = new EurostatCatalogueService(mockConfig, mockStorage);
  const tsv = buildTsv(entries);
  // Access private method via any cast — this is a unit test reaching into pure logic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = (svc as any).parseToc(tsv);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).cache = {
    entries: parsed,
    codeIndex: new Map(parsed.map((e: { code: string }, i: number) => [e.code, i])),
    loadedAt: new Date(),
  };
  return svc;
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
    const { datasets, totalMatches } = await svc.search('gdp', 10, ctx);
    expect(totalMatches).toBe(2);
    expect(datasets.map((d) => d.code)).toContain('nama_10_gdp');
    expect(datasets.map((d) => d.code)).toContain('reg_eco3gdp');
  });

  it('excludes folder entries from search results', async () => {
    const svc = await makeLoadedService([
      tocLine('Economy folder', 'econ', 'folder'),
      tocLine('GDP dataset', 'nama_10_gdp', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets } = await svc.search('economy', 10, ctx);
    // 'econ' folder matches by label but must be excluded
    expect(datasets.map((d) => d.code)).not.toContain('econ');
  });

  it('respects the limit parameter', async () => {
    const svc = await makeLoadedService([
      tocLine('GDP alpha', 'gdp_a', 'dataset'),
      tocLine('GDP beta', 'gdp_b', 'dataset'),
      tocLine('GDP gamma', 'gdp_c', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets, totalMatches } = await svc.search('gdp', 2, ctx);
    expect(totalMatches).toBe(3);
    expect(datasets).toHaveLength(2);
  });

  it('returns empty datasets array for no-match query', async () => {
    const svc = await makeLoadedService([tocLine('GDP dataset', 'nama_10_gdp', 'dataset')]);
    const ctx = createMockContext();
    const { datasets, totalMatches } = await svc.search('xyz_nonexistent_123', 10, ctx);
    expect(datasets).toHaveLength(0);
    expect(totalMatches).toBe(0);
  });

  it('includes themePath in results', async () => {
    const svc = await makeLoadedService([
      tocLine('Root', 'root', 'folder'),
      tocLine('    Economy', 'econ', 'folder'),
      tocLine('        GDP dataset', 'nama_10_gdp', 'dataset'),
    ]);
    const ctx = createMockContext();
    const { datasets } = await svc.search('gdp', 10, ctx);
    expect(datasets[0]?.themePath).toContain('Economy');
  });

  it('matches table type entries', async () => {
    const svc = await makeLoadedService([tocLine('Trade summary table', 'trade_sum', 'table')]);
    const ctx = createMockContext();
    const { datasets } = await svc.search('trade', 10, ctx);
    expect(datasets[0]?.type).toBe('table');
    expect(datasets[0]?.code).toBe('trade_sum');
  });

  it('handles unicode in labels', async () => {
    const svc = await makeLoadedService([tocLine('Données démographiques', 'demo_fr', 'dataset')]);
    const ctx = createMockContext();
    const { datasets } = await svc.search('données', 10, ctx);
    expect(datasets[0]?.code).toBe('demo_fr');
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
