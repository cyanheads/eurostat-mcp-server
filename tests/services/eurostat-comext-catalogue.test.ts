/**
 * @fileoverview EurostatCatalogueService merging the Comext dataflow list into the
 * TOC (#46, #45): search and browse over DS-* collections, lastUpdated in the TOC's
 * form, failure isolation with a retried merge, undisseminated DS-* codes, and
 * cross-call stability. Global fetch is stubbed against the recorded Comext list.
 * @module tests/services/eurostat-comext-catalogue.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';
import { comextFixture, routeOf, xml } from '../helpers/comext-fixtures.js';

function tocLine(title: string, code: string, type: 'folder' | 'dataset', extra: string[] = []) {
  return [`"${title}"`, `"${code}"`, `"${type}"`, ...extra].join('\t');
}

/** The TOC branches the Comext collections file under, as the live TOC nests them. */
const TOC = [
  '"title"\t"code"\t"type"\t"last update of data"\t"last table structure change"\t"data start"\t"data end"\t"values"',
  tocLine('Database by themes', 'data', 'folder', ['""', '""', '""', '""']),
  tocLine('    International trade', 'external', 'folder', ['""', '""', '""', '""']),
  tocLine('        International trade in goods', 'ext_go', 'folder', ['""', '""', '""', '""']),
  tocLine('            International trade in goods - aggregated data', 'ext_go_agg', 'folder', [
    '""',
    '""',
    '""',
    '""',
  ]),
  tocLine('                EU trade since 1999 by SITC', 'ext_st_eu27_2020sitc', 'dataset', [
    '"15.09.2026"',
    '""',
    '"2002"',
    '"2026-07"',
    '104232',
  ]),
  tocLine('    Industry, trade and services', 'icts', 'folder', ['""', '""', '""', '""']),
  tocLine('        Short-term business statistics', 'sts', 'folder', ['""', '""', '""', '""']),
  tocLine('            Production in industry - monthly data', 'sts_inpr_m', 'dataset', [
    '"01.08.2026"',
    '""',
    '"1953-01"',
    '"2026-06"',
    '999',
  ]),
].join('\n');

const COMEXT_LIST = comextFixture('comext-dataflows.xml');
const TRADE_CODES = [
  'DS-059329',
  'DS-059334',
  'DS-059331',
  'DS-059328',
  'DS-059341',
  'DS-045409',
  'DS-059366',
];
const PRODCOM_CODES = ['DS-059358', 'DS-059359', 'DS-059367', 'DS-059368'];

let fetchMock: ReturnType<typeof vi.fn>;
let comextReply: () => Response;

beforeEach(() => {
  comextReply = () => xml(COMEXT_LIST);
  fetchMock = vi.fn(async (input: unknown) => {
    const request = routeOf(input);
    if (request.route === 'toc' && request.host === 'main') return new Response(TOC);
    if (request.route === 'dataflow-list' && request.host === 'comext') return comextReply();
    throw new Error(`Unexpected request: ${request.url.href}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const service = () => new EurostatCatalogueService({} as never, {} as never);
const ctx = () => createMockContext();
const routes = () => fetchMock.mock.calls.map(([input]) => routeOf(input).route);

describe('EurostatCatalogueService — Comext dataflows in search (#46)', () => {
  it('finds the seven trade collections searching "comext"', async () => {
    const { datasets } = await service().search('comext', 100, undefined, ctx());
    expect(datasets.map((d) => d.code).sort()).toEqual([...TRADE_CODES].sort());
    for (const d of datasets) {
      expect(d.themePath).toEqual([
        'Database by themes',
        'International trade',
        'International trade in goods',
        'International trade in goods - detailed data (Comext)',
      ]);
    }
  });

  it('finds the four PRODCOM collections searching "prodcom"', async () => {
    const { datasets } = await service().search('prodcom', 100, undefined, ctx());
    expect(datasets.map((d) => d.code).sort()).toEqual([...PRODCOM_CODES].sort());
  });

  it('finds the CN8 collection searching "CN8"', async () => {
    const { datasets } = await service().search('CN8', 100, undefined, ctx());
    expect(datasets.map((d) => d.code)).toEqual(['DS-045409']);
    expect(datasets[0]?.label).toBe('EU trade since 1988 by HS2-4-6 and CN8');
  });

  it('finds a collection by its DS-* code in any case', async () => {
    const { datasets } = await service().search('ds-045409', 10, undefined, ctx());
    expect(datasets.map((d) => d.code)).toEqual(['DS-045409']);
  });

  it('reports lastUpdated as dd.mm.yyyy and leaves out coverage and counts', async () => {
    const { datasets } = await service().search('DS-059358', 10, undefined, ctx());
    expect(datasets).toEqual([
      {
        code: 'DS-059358',
        label: 'Sold production, exports and imports',
        type: 'dataset',
        lastUpdated: '16.09.2026',
        themePath: [
          'Database by themes',
          'Industry, trade and services',
          'Statistics on the production of manufactured goods (PRODCOM)',
        ],
      },
    ]);
  });

  it('collapses the double space in an upstream title', async () => {
    const { datasets } = await service().search('DS-059331', 10, undefined, ctx());
    expect(datasets[0]?.label).toBe(
      'International trade of EU and non-EU countries since 2002 by SITC',
    );
  });

  it('keeps TOC datasets ahead of merged ones', async () => {
    const { datasets } = await service().search('trade', 100, undefined, ctx());
    const codes = datasets.map((d) => d.code);
    expect(codes.slice(0, 2)).toEqual(['ext_st_eu27_2020sitc', 'sts_inpr_m']);
    expect(codes.slice(2).every((code) => code.startsWith('DS-'))).toBe(true);
    expect(codes).toHaveLength(2 + TRADE_CODES.length + PRODCOM_CODES.length);
  });
});

describe('EurostatCatalogueService — Comext folders in browse (#46)', () => {
  it('lists ext_go_detail under ext_go, after its TOC children', async () => {
    const { items } = await service().browse('ext_go', ctx());
    expect(items.map((i) => i.code)).toEqual(['ext_go_agg', 'ext_go_detail']);
    expect(items[1]).toEqual({
      code: 'ext_go_detail',
      label: 'International trade in goods - detailed data (Comext)',
      type: 'folder',
      hasChildren: true,
    });
  });

  it('lists prom under icts', async () => {
    const { items } = await service().browse('icts', ctx());
    expect(items.map((i) => i.code)).toEqual(['sts', 'prom']);
  });

  it('lists the collections inside each folder with no coverage or counts', async () => {
    const svc = service();
    const trade = await svc.browse('ext_go_detail', ctx());
    expect(trade.items.map((i) => i.code).sort()).toEqual([...TRADE_CODES].sort());
    expect(trade.parentPath).toEqual([
      'Database by themes',
      'International trade',
      'International trade in goods',
      'International trade in goods - detailed data (Comext)',
    ]);
    const prodcom = await svc.browse('prom', ctx());
    expect(prodcom.items.map((i) => i.code).sort()).toEqual([...PRODCOM_CODES].sort());
    for (const item of [...trade.items, ...prodcom.items]) {
      expect(Object.keys(item).sort()).toEqual(['code', 'hasChildren', 'label', 'type']);
    }
  });

  it('files a collection whose metadata page names no known folder under the first root', async () => {
    comextReply = () => xml(COMEXT_LIST.replace('prom_esms.htm', 'something_new_esms.htm'));
    const svc = service();
    const root = await svc.browse(undefined, ctx());
    expect(root.items.map((i) => i.code)).toContain('comext');
    const other = await svc.browse('comext', ctx());
    expect(other.items.map((i) => i.code)).toEqual(['DS-059358']);
  });
});

describe('EurostatCatalogueService — Comext failure isolation (#46)', () => {
  it('answers from the TOC and logs when the Comext list fails, then merges on retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    comextReply = () => new Response('upstream down', { status: 503 });
    const svc = service();
    const first = ctx();
    const warning = vi.spyOn(first.log, 'warning');

    const during = await svc.search('trade', 100, undefined, first);
    expect(during.datasets.map((d) => d.code)).toEqual(['ext_st_eu27_2020sitc', 'sts_inpr_m']);
    expect((await svc.browse('ext_go', ctx())).items.map((i) => i.code)).toEqual(['ext_go_agg']);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Comext dataflow list unavailable'),
      expect.objectContaining({ retryAfterMs: 60_000 }),
    );

    // Inside the cooldown the failed list is not retried.
    const callsDuringOutage = fetchMock.mock.calls.length;
    await svc.search('comext', 100, undefined, ctx());
    expect(fetchMock.mock.calls.length).toBe(callsDuringOutage);

    comextReply = () => xml(COMEXT_LIST);
    vi.setSystemTime(Date.now() + 61_000);
    const after = await svc.search('comext', 100, undefined, ctx());
    expect(after.datasets).toHaveLength(7);
    // The TOC was fetched once; only the Comext list was retried.
    expect(routes().filter((r) => r === 'toc')).toHaveLength(1);
    expect(routes().filter((r) => r === 'dataflow-list')).toHaveLength(2);
  });

  it('treats a list naming no dataflows as a failure, not an empty host', async () => {
    comextReply = () =>
      xml('<?xml version="1.0"?><m:Structure xmlns:m="x"><m:Structures/></m:Structure>');
    const svc = service();
    const result = await svc.search('DS-045409', 10, undefined, ctx());
    expect(result.datasets).toEqual([]);
    expect(result.comextListMissing).toBe(true);
  });

  it('answers from the TOC when the Comext list is not XML', async () => {
    comextReply = () => new Response('<html><body>maintenance</body></html', { status: 200 });
    const result = await service().search('production', 10, undefined, ctx());
    expect(result.datasets.map((d) => d.code)).toEqual(['sts_inpr_m']);
  });
});

describe('EurostatCatalogueService — the merge retry across concurrent callers', () => {
  it('sends one Comext list request for every caller arriving once the cooldown has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    comextReply = () => new Response('down', { status: 503 });
    const svc = service();
    await svc.search('trade', 100, undefined, ctx());
    comextReply = () => xml(COMEXT_LIST);
    vi.setSystemTime(Date.now() + 61_000);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc.search('comext', 100, undefined, ctx())),
    );
    expect(results.every((r) => r.datasets.length === 7)).toBe(true);
    expect(routes().filter((r) => r === 'dataflow-list')).toHaveLength(2);
  });

  it('keeps a cursor paged before the merge valid after it, with no match repeated or skipped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    comextReply = () => new Response('down', { status: 503 });
    const svc = service();
    const first = await svc.search('trade', 1, undefined, ctx());
    expect(first.datasets.map((d) => d.code)).toEqual(['ext_st_eu27_2020sitc']);
    expect(first.totalMatches).toBe(2);

    comextReply = () => xml(COMEXT_LIST);
    vi.setSystemTime(Date.now() + 61_000);
    const codes = first.datasets.map((d) => d.code);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await svc.search('trade', 1, cursor, ctx());
      codes.push(...page.datasets.map((d) => d.code));
      cursor = page.nextCursor;
    }
    const merged = await svc.search('trade', 100, undefined, ctx());
    expect(codes).toEqual(merged.datasets.map((d) => d.code));
    expect(new Set(codes).size).toBe(2 + TRADE_CODES.length + PRODCOM_CODES.length);
  });
});

describe('EurostatCatalogueService — caller cancellation around the shared loads', () => {
  /** Hold requests on `route` until released, rejecting early when their own signal aborts. */
  function gateRoute(route: 'dataflow-list' | 'toc'): {
    release: () => void;
    started: Promise<void>;
  } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const answer = fetchMock.getMockImplementation() as (input: unknown) => Promise<Response>;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (routeOf(input).route === route) {
        markStarted();
        const signal = init?.signal;
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          void gate.then(resolve);
        });
      }
      return answer(input);
    });
    return { release, started };
  }

  it('fails only the cancelled caller of a cold catalogue load', async () => {
    const svc = service();
    const { release, started } = gateRoute('toc');
    const cancelled = new AbortController();
    const first = svc.search(
      'comext',
      100,
      undefined,
      createMockContext({ signal: cancelled.signal }),
    );
    const second = svc.search('comext', 100, undefined, ctx());
    await started;
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    release();
    expect((await second).datasets).toHaveLength(7);
    expect(routes().filter((r) => r === 'toc')).toHaveLength(1);
  });

  it('lets a cancelled caller of the merge retry neither fail nor postpone the merge for others', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    comextReply = () => new Response('down', { status: 503 });
    const svc = service();
    await svc.search('trade', 100, undefined, ctx());
    comextReply = () => xml(COMEXT_LIST);
    vi.setSystemTime(Date.now() + 61_000);

    const { release, started } = gateRoute('dataflow-list');
    const cancelled = new AbortController();
    const first = svc.search(
      'comext',
      100,
      undefined,
      createMockContext({ signal: cancelled.signal }),
    );
    const second = svc.search('comext', 100, undefined, ctx());
    await started;
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    release();
    expect((await second).datasets).toHaveLength(7);
    expect((await svc.search('prodcom', 100, undefined, ctx())).datasets).toHaveLength(4);
    expect(routes().filter((r) => r === 'dataflow-list')).toHaveLength(2);
  });
});

describe('EurostatCatalogueService — undisseminated DS-* codes (#45)', () => {
  it('names a DS-* code on neither list', async () => {
    const result = await service().search('DS-056120', 10, undefined, ctx());
    expect(result).toEqual({ datasets: [], totalMatches: 0, undisseminatedCodes: ['DS-056120'] });
  });

  it('names only the absent codes when the query names several', async () => {
    const result = await service().search('ds-045409 DS-999999 imports', 10, undefined, ctx());
    expect(result.undisseminatedCodes).toEqual(['DS-999999']);
  });

  it('names nothing for a no-match query without a DS-* code', async () => {
    const result = await service().search('zebra crossings', 10, undefined, ctx());
    expect(result).toEqual({ datasets: [], totalMatches: 0 });
  });

  it('flags that the Comext list is missing rather than calling a code undisseminated', async () => {
    comextReply = () => new Response('down', { status: 503 });
    const result = await service().search('DS-045409', 10, undefined, ctx());
    expect(result).toMatchObject({
      datasets: [],
      undisseminatedCodes: ['DS-045409'],
      comextListMissing: true,
    });
  });
});

describe('EurostatCatalogueService — cross-call stability of the merged catalogue', () => {
  it('answers the same on a fresh service and after priming calls on both sources', async () => {
    const run = async (svc: EurostatCatalogueService) => ({
      comext: await svc.search('comext', 100, undefined, ctx()),
      prodcom: await svc.browse('prom', ctx()),
      trade: await svc.browse('ext_go', ctx()),
    });
    const fresh = await run(service());

    const primed = service();
    await primed.search('prodcom', 3, undefined, ctx());
    await primed.search('DS-056120', 10, undefined, ctx());
    await primed.search('production industry', 10, undefined, ctx());
    await primed.browse('icts', ctx());
    const touched = await primed.browse('ext_go_detail', ctx());
    touched.items.length = 0;
    const found = await primed.search('comext', 100, undefined, ctx());
    found.datasets.length = 0;

    expect(await run(primed)).toEqual(fresh);
  });
});
