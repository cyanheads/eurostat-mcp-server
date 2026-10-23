/**
 * @fileoverview Tests for the eurostat_search_datasets tool.
 * @module tests/tools/eurostat-search-datasets.tool.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatSearchDatasets } from '@/mcp-server/tools/definitions/eurostat-search-datasets.tool.js';

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
  it('accepts oversized positive limits for bounded reads', () => {
    expect(eurostatSearchDatasets.input.parse({ query: 'GDP', limit: 101 }).limit).toBe(101);
  });
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

  it('clamps the first page, composes notices, and leaves cursor calls unaccounted', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ datasets: mockDatasets, totalMatches: 2, comextListMissing: true });
    vi.mocked(getEurostatCatalogueService).mockReturnValue({ search } as never);
    const ctx = createMockContext({ errors: eurostatSearchDatasets.errors });
    const log = vi.spyOn(ctx.log, 'info');
    await eurostatSearchDatasets.handler(
      eurostatSearchDatasets.input.parse({ query: 'GDP', limit: 1000 }),
      ctx,
    );
    expect(search).toHaveBeenCalledWith('GDP', 100, undefined, ctx);
    expect(log.mock.calls.filter(([message]) => message === 'Read limit clamped')).toHaveLength(1);
    expect(getEnrichment(ctx).notice).toMatch(
      /limit requested 1000; applied 100.*were not searched/,
    );
    const result = await runToolContract(eurostatSearchDatasets, { query: 'GDP', limit: 1000 });
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('limit requested 1000; applied 100'),
    });
    expect(result.content.map((b) => ('text' in b ? b.text : '')).join('\n')).toContain(
      'limit requested 1000; applied 100',
    );
    log.mockClear();
    const cursorCtx = createMockContext({ errors: eurostatSearchDatasets.errors });
    const cursorLog = vi.spyOn(cursorCtx.log, 'info');
    await eurostatSearchDatasets.handler(
      eurostatSearchDatasets.input.parse({ query: 'GDP', limit: 1000, cursor: 'CURSOR' }),
      cursorCtx,
    );
    expect(search).toHaveBeenLastCalledWith('GDP', 1000, 'CURSOR', cursorCtx);
    expect(
      cursorLog.mock.calls.filter(([message]) => message === 'Read limit clamped'),
    ).toHaveLength(0);
    expect(getEnrichment(cursorCtx).notice).not.toContain('applied 100');
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

/**
 * The partial-catalogue disclosures (#63) and the blocking-word counts (#69), read through
 * the production result: structuredContent, content[], and the error envelope's hint.
 */
describe('eurostatSearchDatasets — disclosures and the no_match hint', () => {
  type Found = Record<string, unknown>;
  const serve = (found: Found) =>
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      search: vi.fn().mockResolvedValue(found),
    } as never);
  const run = (query: string) => runToolContract(eurostatSearchDatasets, { query });
  const textOf = (result: Awaited<ReturnType<typeof run>>) =>
    result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  const hintOf = (result: Awaited<ReturnType<typeof run>>) =>
    (result.structuredContent as { error: { data: { recovery: { hint: string } } } }).error.data
      .recovery.hint;

  const BROADER =
    'Try a broader term or use eurostat_browse_themes to explore themes without text search.';
  const COUNTS = [
    { word: 'rates', totalMatches: 7 },
    { word: 'sex', totalMatches: 3 },
    { word: 'annual', totalMatches: 4 },
  ];
  const LOADED_AT = '2026-10-14T23:35:00.000Z';

  it('keeps the healthy success free of disclosure fields (characterization)', async () => {
    serve({ datasets: mockDatasets, totalMatches: 2 });
    const result = await run('GDP');
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual([
      'datasets',
      'nextStep',
      'query',
      'totalMatches',
      'truncated',
    ]);
    expect(textOf(result)).not.toMatch(/Comext|refreshed/);
  });

  it('keeps the healthy no-match hint byte for byte (characterization)', async () => {
    serve({ datasets: [], totalMatches: 0 });
    expect(hintOf(await run('zebra crossings'))).toBe(BROADER);
  });

  it('discloses an unmerged Comext list on structuredContent and content[]', async () => {
    serve({ datasets: mockDatasets, totalMatches: 2, comextListMissing: true });
    const result = await run('GDP');
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.comextListMissing).toBe(true);
    expect(structured.totalMatches).toBe(2);
    expect(structured).not.toHaveProperty('catalogueLoadedAt');
    const notice = structured.notice as string;
    expect(notice).toContain('DS-* collections (detailed trade and PRODCOM) were not searched');
    expect(notice).toContain('retried about once a minute');
    expect(notice).toContain('eurostat_get_dataset_info reads a DS-* code directly');
    expect(textOf(result)).toContain(notice);
    expect(textOf(result)).toContain('comextListMissing');
  });

  it('discloses a catalogue a failed refresh could not replace, with its load time', async () => {
    serve({ datasets: mockDatasets, totalMatches: 2, catalogueLoadedAt: LOADED_AT });
    const result = await run('GDP');
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.catalogueLoadedAt).toBe(LOADED_AT);
    expect(structured).not.toHaveProperty('comextListMissing');
    expect(structured.notice).toContain(`could not be refreshed`);
    expect(structured.notice).toContain(LOADED_AT);
    expect(textOf(result)).toContain(structured.notice as string);
  });

  it('writes one notice carrying both sentences when both apply', async () => {
    serve({
      datasets: mockDatasets,
      totalMatches: 2,
      comextListMissing: true,
      catalogueLoadedAt: LOADED_AT,
    });
    const structured = (await run('GDP')).structuredContent as Record<string, unknown>;
    expect(structured.notice).toMatch(/were not searched.*could not be refreshed/s);
  });

  it('names each blocking word with its count instead of the broaden hint', async () => {
    serve({ datasets: [], totalMatches: 0, wordRemovalCounts: COUNTS });
    const result = await run('unemployment rates by sex age annual data');
    const hint = hintOf(result);
    expect(hint).toBe(
      'Without "rates": 7 matches. Without "sex": 3 matches. Without "annual": 4 matches. Search again without one of those words to see its matches.',
    );
    expect(textOf(result)).toContain('Without "rates": 7 matches');
  });

  it('says "1 match" for a single rescued dataset', async () => {
    serve({
      datasets: [],
      totalMatches: 0,
      wordRemovalCounts: [{ word: 'Rev.9', totalMatches: 1 }],
    });
    expect(hintOf(await run('NACE Rev.9'))).toContain('Without "Rev.9": 1 match.');
  });

  const COMEXT_UNSEARCHED =
    'The Comext dataflow list could not be loaded, so the DS-* collections (detailed trade and PRODCOM) were not searched; the merge is retried about once a minute. eurostat_get_dataset_info reads a DS-* code directly.';
  const COUNTED =
    'Without "rates": 7 matches. Without "sex": 3 matches. Without "annual": 4 matches. Search again without one of those words to see its matches.';

  it('leads with the Comext disclosure, then the counts, and drops the broaden hint', async () => {
    serve({ datasets: [], totalMatches: 0, comextListMissing: true, wordRemovalCounts: COUNTS });
    const hint = hintOf(await run('unemployment rates by sex age annual data'));
    expect(hint).toBe(`${COMEXT_UNSEARCHED} ${COUNTED}`);
  });

  it('keeps the broaden hint after the Comext disclosure when no count applies', async () => {
    serve({ datasets: [], totalMatches: 0, comextListMissing: true });
    const result = await run('prodcom');
    expect(hintOf(result)).toMatch(
      /^The Comext dataflow list could not be loaded, so the DS-\* collections \(detailed trade and PRODCOM\) were not searched;.* Try a broader term/s,
    );
    expect((result.structuredContent as { error: { message: string } }).error.message).toBe(
      'No datasets matched "prodcom".',
    );
  });

  it('names a DS-* code it could not check while the Comext list is unmerged', async () => {
    serve({
      datasets: [],
      totalMatches: 0,
      undisseminatedCodes: ['DS-045409'],
      comextListMissing: true,
    });
    const hint = hintOf(await run('DS-045409'));
    expect(hint).toContain('DS-045409 could not be checked against it');
    expect(hint).toContain('Call eurostat_get_dataset_info with the code');
    expect(hint).not.toContain('broader term');
  });

  it('follows the not-disseminated sentence with the counts when both apply', async () => {
    serve({
      datasets: [],
      totalMatches: 0,
      undisseminatedCodes: ['DS-056120'],
      wordRemovalCounts: [{ word: 'DS-056120', totalMatches: 4 }],
    });
    const hint = hintOf(await run('DS-056120 prodcom'));
    expect(hint).toMatch(
      /^Broadening will not find DS-056120: .* Without "DS-056120": 4 matches\./s,
    );
  });

  const STALE = `The catalogue could not be refreshed, so this search ran against the copy loaded at ${LOADED_AT}; datasets Eurostat added or changed since then were not searched.`;

  it('discloses a stale catalogue on no_match, ahead of the broaden hint', async () => {
    serve({ datasets: [], totalMatches: 0, catalogueLoadedAt: LOADED_AT });
    const result = await run('zebra crossings');
    expect(hintOf(result)).toBe(`${STALE} ${BROADER}`);
    expect(textOf(result)).toContain(STALE);
  });

  it('orders Comext, then staleness, then the counts, with no broaden hint', async () => {
    serve({
      datasets: [],
      totalMatches: 0,
      comextListMissing: true,
      catalogueLoadedAt: LOADED_AT,
      wordRemovalCounts: COUNTS,
    });
    const hint = hintOf(await run('unemployment rates by sex age annual data'));
    expect(hint).toBe(`${COMEXT_UNSEARCHED} ${STALE} ${COUNTED}`);
  });

  it('follows the not-disseminated sentence with the stale disclosure', async () => {
    serve({
      datasets: [],
      totalMatches: 0,
      undisseminatedCodes: ['DS-056120'],
      catalogueLoadedAt: LOADED_AT,
    });
    const hint = hintOf(await run('DS-056120'));
    expect(hint).toMatch(/^Broadening will not find DS-056120: /);
    expect(hint.endsWith(STALE)).toBe(true);
  });
});

/**
 * The stale-catalogue disclosure on a no_match (#63), raised by the real catalogue
 * service over the recorded 2026-10-14 TOC excerpt: its copy is past the TTL and
 * the refresh fails, so the expired copy answers.
 */
describe('eurostatSearchDatasets — no_match from a catalogue a failed refresh holds in service', () => {
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

  /** A service holding the excerpt loaded 13 hours ago, whose refresh fails; `merged` false leaves Comext unmerged. */
  function serveStale(merged = true): string {
    const service = new EurostatCatalogueService({} as never, {} as never);
    const internals = service as unknown as {
      buildCache(entries: unknown, flows: unknown[] | undefined, loadedAt: Date): unknown;
      cache: unknown;
      fetchAndParseToc(): Promise<unknown>;
      parseToc(text: string): unknown;
    };
    const loadedAt = new Date(Date.now() - 13 * 60 * 60 * 1000);
    internals.cache = internals.buildCache(
      internals.parseToc(excerpt),
      merged ? [] : undefined,
      loadedAt,
    );
    vi.spyOn(internals, 'fetchAndParseToc').mockRejectedValue(new Error('Eurostat unreachable'));
    vi.mocked(getEurostatCatalogueService).mockReturnValue(service);
    return loadedAt.toISOString();
  }
  const stale = (loadedAt: string) =>
    `The catalogue could not be refreshed, so this search ran against the copy loaded at ${loadedAt}; datasets Eurostat added or changed since then were not searched.`;

  it('carries the stale sentence and the broaden hint when no word blocks the match', async () => {
    const loadedAt = serveStale();
    const result = await runToolContract(eurostatSearchDatasets, { query: 'zebra crossings' });
    expect(result.isError).toBe(true);
    expect(hintOf(result)).toMatchObject({
      reason: 'no_match',
      recovery: {
        hint: `${stale(loadedAt)} Try a broader term or use eurostat_browse_themes to explore themes without text search.`,
      },
    });
    expect(textOf(result)).toContain(stale(loadedAt));
  });

  it('puts the stale sentence between the Comext disclosure and the blocking-word counts', async () => {
    const loadedAt = serveStale(false);
    const result = await runToolContract(eurostatSearchDatasets, {
      query: 'unemployment rates by sex age annual data',
    });
    const { hint } = hintOf(result).recovery;
    expect(hint).toMatch(/^The Comext dataflow list could not be loaded/);
    expect(hint).toContain(
      `were not searched; the merge is retried about once a minute. eurostat_get_dataset_info reads a DS-* code directly. ${stale(loadedAt)} Without "rates": 7 matches. Without "sex": 3 matches. Without "annual": 4 matches. Search again without one of those words to see its matches.`,
    );
    expect(hint).not.toContain('broader term');
  });
});

/** A cold start against a catalogue host that is down: no copy to fall back on (#71). */
describe('eurostatSearchDatasets — an unavailable catalogue host on a cold start (#71)', () => {
  /** Search through a fresh real service over a stubbed `fetch`, past the TOC's retry backoff. */
  async function searchColdStart(fetchImpl: () => Promise<Response>) {
    vi.mocked(getEurostatCatalogueService).mockReturnValue(
      new EurostatCatalogueService({} as never, {} as never),
    );
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    try {
      const pending = runToolContract(eurostatSearchDatasets, { query: 'gdp' });
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
    const { error, text } = await searchColdStart(
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
    const { error, text } = await searchColdStart(async () => {
      throw new TypeError('fetch failed');
    });
    expect(error.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
    expect((error.data.recovery as { hint: string }).hint).toContain('could not be reached');
    expect(text).toContain('reason upstream_fault · retryable');
  });
});
