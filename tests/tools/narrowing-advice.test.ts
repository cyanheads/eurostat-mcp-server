/**
 * @fileoverview Tests for the structure read behind a recovery hint — a failed read
 * degrades the hint, a cancelled call does not, and one deadline bounds the read across
 * every attempt and backoff.
 * @module tests/tools/narrowing-advice.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as serverConfig from '@/config/server-config.js';
import {
  dimensionsToNarrow,
  dimensionValuesForHint,
  dottedValueAdvice,
  unmatchedValuesAdvice,
} from '@/mcp-server/tools/narrowing-advice.js';
import type { SdmxDatasetMetadata } from '@/services/eurostat-data/sdmx-metadata.js';

// Only the accessor is replaced, so a test can hand the helper the real service class.
vi.mock('@/services/eurostat-data/eurostat-data-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/eurostat-data/eurostat-data-service.js')>()),
  getEurostatDataService: vi.fn(),
}));

import {
  EurostatDataService,
  getEurostatDataService,
} from '@/services/eurostat-data/eurostat-data-service.js';

const failingRead = (err: Error) =>
  vi
    .mocked(getEurostatDataService)
    .mockReturnValue({ getDimensionOrder: vi.fn().mockRejectedValue(err) } as never);

describe('dimensionsToNarrow', () => {
  it('reuses a dimension order the request already read', async () => {
    const getDimensionOrder = vi.fn();
    vi.mocked(getEurostatDataService).mockReturnValue({ getDimensionOrder } as never);
    await expect(dimensionsToNarrow('nama_10_gdp', ['geo'], createMockContext())).resolves.toEqual([
      'geo',
    ]);
    expect(getDimensionOrder).not.toHaveBeenCalled();
  });

  it('leaves the hint generic when the structure read fails', async () => {
    failingRead(new Error('structure unavailable'));
    await expect(
      dimensionsToNarrow('nama_10_gdp', [], createMockContext()),
    ).resolves.toBeUndefined();
  });

  it('rethrows when the call was cancelled, so the cancellation is not masked', async () => {
    const abort = new Error('aborted');
    failingRead(abort);
    const controller = new AbortController();
    controller.abort();
    await expect(
      dimensionsToNarrow('nama_10_gdp', [], createMockContext({ signal: controller.signal })),
    ).rejects.toBe(abort);
  });
});

/**
 * The real service with only fetch faked, because the retry ladder and its deadline are
 * what is under test. Every path the helper serves goes through this one read, so the
 * tools' own tests prove only that they reach it.
 */
describe('dimensionsToNarrow — one deadline across the read (#85)', () => {
  const unavailable = () => new Response('Service Unavailable', { status: 503 });
  /** A request that never answers: it settles only when its signal aborts. */
  const hang = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  const track = <T>(read: Promise<T>) => {
    let settled = false;
    const outcome = read.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    return { outcome, settled: () => settled };
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Far past the deadline on both, so neither default stall timeout can end a read for it.
    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      ...serverConfig.getServerConfig(),
      requestTimeoutMs: 600_000,
      metadataTimeoutMs: 600_000,
    });
    fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
      throw new Error(`Unmocked fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the dimensions a captured structure definition lists, on one attempt', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          readFileSync(
            new URL('../fixtures/nama-10-gdp-datastructure.xml', import.meta.url),
            'utf8',
          ),
        ),
    );
    await expect(dimensionsToNarrow('nama_10_gdp', [], createMockContext())).resolves.toEqual([
      'freq',
      'unit',
      'na_item',
      'geo',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      '/eurostat/api/dissemination/sdmx/2.1/datastructure/ESTAT/nama_10_gdp',
    );
  });

  it('gives up on a read that never answers at 5 s, on its one attempt', async () => {
    fetchMock.mockImplementation(hang);
    const read = track(dimensionsToNarrow('nama_10_gdp', [], createMockContext()));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toEqual({ value: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts a retry against the same 5 s, so a stalled second attempt ends at 5 s, not 6 s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchMock.mockImplementationOnce(async () => unavailable()).mockImplementation(hang);
    const read = track(dimensionsToNarrow('nama_10_gdp', [], createMockContext()));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read.settled()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toEqual({ value: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the low end', 0],
    ['the middle', 0.5],
    ['the high end', 0.999],
  ])(
    'fails over a read answering 503 after 3 attempts at %s of the jitter',
    async (_name, random) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      fetchMock.mockImplementation(async () => unavailable());
      const read = track(dimensionsToNarrow('nama_10_gdp', [], createMockContext()));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(read.settled()).toBe(true);
      await expect(read.outcome).resolves.toEqual({ value: undefined });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    ['a 404', () => new Response('<fault/>', { status: 404 })],
    ['a body that is not XML', () => new Response('<<<', { status: 200 })],
  ])('fails over %s on its one attempt', async (_name, reply) => {
    fetchMock.mockImplementation(async () => reply());
    const read = track(dimensionsToNarrow('nama_10_gdp', [], createMockContext()));
    await vi.advanceTimersByTimeAsync(0);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toEqual({ value: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows a cancellation during an attempt as a cancellation, with no further attempt', async () => {
    fetchMock.mockImplementation(hang);
    const controller = new AbortController();
    const read = track(
      dimensionsToNarrow('nama_10_gdp', [], createMockContext({ signal: controller.signal })),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read.settled()).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows a cancellation during a backoff, with no further attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchMock.mockImplementation(async () => unavailable());
    const controller = new AbortController();
    const reason = new DOMException('caller went away', 'AbortError');
    const read = track(
      dimensionsToNarrow('nama_10_gdp', [], createMockContext({ signal: controller.signal })),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(read.settled()).toBe(false);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toEqual({ error: reason });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('dottedValueAdvice (#100)', () => {
  it('gives a Comext digit-and-dot value its stripped form as the code to write', () => {
    expect(dottedValueAdvice('DS-045409', [{ dimension: 'product', value: '2204.21' }])).toEqual({
      hint: 'No Eurostat code contains ".". Write "220421" for "2204.21" in filters.product.',
      literals: ['220421', '2204.21', 'product'],
    });
    expect(
      dottedValueAdvice('ds-059341', [{ dimension: 'product', value: '01.02.03' }]).hint,
    ).toContain('"010203"');
  });

  it('points a value outside that shape at the value search on its stripped form', () => {
    const advice = dottedValueAdvice('prc_hicp_manr', [{ dimension: 'coicop', value: '01.1.1' }]);
    expect(advice.hint).toBe(
      'No Eurostat code contains ".", and "01.1.1" without its dots may not be a code of "prc_hicp_manr" either. Find the code with eurostat_get_dimension_values, dimension "coicop" and filter "0111".',
    );
    expect(advice.literals).toEqual(['01.1.1', '0111', 'coicop']);
    // A Comext value that is not digits and dots gets the search too.
    expect(
      dottedValueAdvice('DS-045409', [{ dimension: 'product', value: '2204.A1' }]).hint,
    ).toContain('filter "2204A1"');
    expect(
      dottedValueAdvice('DS-045409', [{ dimension: 'product', value: '2204.' }]).hint,
    ).toContain('filter "2204"');
  });

  it('states the opening sentence once when several values are named', () => {
    expect(
      dottedValueAdvice('DS-045409', [
        { dimension: 'product', value: '2204.21' },
        { dimension: 'product', value: '2204.22' },
      ]),
    ).toEqual({
      hint: 'No Eurostat code contains ".". Write "220421" for "2204.21" in filters.product. Write "220422" for "2204.22" in filters.product.',
      literals: ['220421', '2204.21', 'product', '220422', '2204.22', 'product'],
    });
    expect(
      dottedValueAdvice('prc_hicp_manr', [
        { dimension: 'coicop', value: '01.1.1' },
        { dimension: 'geo', value: '..' },
      ]).hint,
    ).toBe(
      'No Eurostat code contains ".", and "01.1.1" without its dots may not be a code of "prc_hicp_manr" either. Find the code with eurostat_get_dimension_values, dimension "coicop" and filter "0111". List the codes of "geo" with eurostat_get_dimension_values.',
    );
  });

  it('names no filter when nothing is left once the dots are removed', () => {
    expect(dottedValueAdvice('nama_10_gdp', [{ dimension: 'geo', value: '..' }])).toEqual({
      hint: 'No Eurostat code contains ".". List the codes of "geo" with eurostat_get_dimension_values.',
      literals: ['geo'],
    });
  });
});

/**
 * The real service with only fetch faked, serving the `hlth_cd_apr` dataflow and content
 * constraint recorded live, because the shared metadata load and its cache are part of
 * what is under test.
 */
describe('dimensionValuesForHint (#104)', () => {
  const recorded = (name: string) =>
    readFileSync(
      new URL(`../fixtures/dimension-values/hlth-cd-apr-${name}.xml`, import.meta.url),
      'utf8',
    );
  const routeOf = (input: unknown) =>
    new URL(String(input)).pathname.includes('/contentconstraint/') ? 'constraint' : 'dataflow';
  const dataflowReads = () =>
    fetchMock.mock.calls.filter(([input]) => routeOf(input) === 'dataflow').length;
  /** A request that never answers: it settles only when its signal aborts. */
  const hang = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      ...serverConfig.getServerConfig(),
      requestTimeoutMs: 600_000,
      metadataTimeoutMs: 600_000,
    });
    fetchMock = vi.fn(async (input: unknown) => new Response(recorded(routeOf(input))));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the value lists the recorded structures carry', async () => {
    const metadata = await dimensionValuesForHint('hlth_cd_apr', createMockContext());
    expect(metadata?.valuesByDimension.mortalit?.map(({ code }) => code)).toEqual([
      'TOTAL',
      'PRVT',
      'TRT',
    ]);
    expect(metadata?.valuesByDimension.geo).toHaveLength(38);
  });

  it('gives up at 5 s, and the load it left running fills the cache for the next read', async () => {
    fetchMock.mockImplementation(
      (input: unknown) =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(recorded(routeOf(input)))), 8_000);
        }),
    );
    let settled = false;
    const first = dimensionValuesForHint('hlth_cd_apr', createMockContext()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(3_000);
    const second = await dimensionValuesForHint('hlth_cd_apr', createMockContext());
    expect(second?.valuesByDimension.mortalit).toHaveLength(3);
    expect(dataflowReads()).toBe(1);
  });

  it('returns nothing for a read that fails, without waiting for the timer', async () => {
    fetchMock.mockImplementation(async () => new Response('<fault/>', { status: 404 }));
    let settled = false;
    const read = dimensionValuesForHint('hlth_cd_apr', createMockContext()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(read).resolves.toBeUndefined();
  });

  it('rethrows a cancellation during the read as a cancellation', async () => {
    fetchMock.mockImplementation(hang);
    const controller = new AbortController();
    const read = dimensionValuesForHint(
      'hlth_cd_apr',
      createMockContext({ signal: controller.signal }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await read).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });
});

describe('unmatchedValuesAdvice (#104)', () => {
  const codes = (count: number, prefix = 'C') =>
    Array.from({ length: count }, (_, i) => ({ code: `${prefix}${i}`, label: `Label ${i}` }));
  const metadataOf = (
    lists: Record<string, Array<{ code: string; label: string }>>,
  ): SdmxDatasetMetadata => ({
    geoLevelsByCode: {},
    meta: {
      code: 'ds',
      label: 'ds',
      timeRange: {},
      dimensions: Object.keys(lists).map((code) => ({ code, label: code })),
    },
    valuesByDimension: lists,
  });
  const MORTALIT = [
    { code: 'TOTAL', label: 'Total' },
    { code: 'PRVT', label: 'Preventable mortality' },
    { code: 'TRT', label: 'Treatable mortality' },
  ];

  it('lists every code and label of a dimension holding at most 25', () => {
    expect(
      unmatchedValuesAdvice(
        'hlth_cd_apr',
        { mortalit: ['PREV'] },
        metadataOf({ mortalit: MORTALIT }),
      ),
    ).toEqual({
      sentences: [
        '"mortalit" has 3 codes: TOTAL (Total), PRVT (Preventable mortality), TRT (Treatable mortality).',
      ],
      literals: ['TOTAL', 'PRVT', 'TRT'],
      unresolved: [],
      validValues: { mortalit: { totalCount: 3, values: MORTALIT } },
    });
    const one = unmatchedValuesAdvice('ds', { freq: ['Q'] }, metadataOf({ freq: codes(1) }));
    expect(one.sentences).toEqual(['"freq" has 1 code: C0 (Label 0).']);
  });

  it('lists 25 codes, and above 25 gives only the total and a value search', () => {
    expect(
      unmatchedValuesAdvice('ds', { unit: ['X'] }, metadataOf({ unit: codes(25) })).validValues.unit
        ?.values,
    ).toHaveLength(25);

    const above = unmatchedValuesAdvice('ds', { unit: ['X'] }, metadataOf({ unit: codes(26) }));
    expect(above).toEqual({
      sentences: [
        '"unit" has 26 codes, too many to list here.',
        'Find the code for "X" with eurostat_get_dimension_values, dimension "unit" and filter "X".',
      ],
      literals: ['X', 'unit'],
      unresolved: [],
      validValues: { unit: { totalCount: 26 } },
    });
    expect(above.sentences.join(' ')).not.toContain('C0');
  });

  it('counts every geo level, matches the key in any case, and points below-country codes at geo_level', () => {
    const geo = [...codes(30, 'DE'), ...codes(1_200, 'DE1')];
    const advice = unmatchedValuesAdvice('ds', { GEO: ['XX', 'YY'] }, metadataOf({ geo }));
    expect(advice.validValues).toEqual({ GEO: { totalCount: 1_230 } });
    expect(advice.sentences).toEqual([
      '"GEO" has 1,230 codes, too many to list here.',
      'Find the code for "XX" with eurostat_get_dimension_values, dimension "GEO" and filter "XX", adding geo_level for a code below country level.',
      'Find the code for "YY" with eurostat_get_dimension_values, dimension "GEO" and filter "YY", adding geo_level for a code below country level.',
    ]);
  });

  it('gives a dotted value in a long list the dotted-value advice instead of the search', () => {
    const advice = unmatchedValuesAdvice(
      'DS-045409',
      { product: ['2204.21', '9999'] },
      metadataOf({ product: codes(30) }),
    );
    expect(advice.sentences).toEqual([
      '"product" has 30 codes, too many to list here.',
      'No Eurostat code contains ".". Write "220421" for "2204.21" in filters.product.',
      'Find the code for "9999" with eurostat_get_dimension_values, dimension "product" and filter "9999".',
    ]);
    expect(advice.literals).toEqual(['9999', 'product', '220421', '2204.21']);
  });

  it('leaves a dimension it has no values for unresolved, beside one it lists', () => {
    expect(
      unmatchedValuesAdvice(
        'ds',
        { mortalit: ['PREV'], nope: ['A'], empty: ['B'] },
        metadataOf({ mortalit: MORTALIT, empty: [] }),
      ),
    ).toMatchObject({
      unresolved: ['nope', 'empty'],
      validValues: { mortalit: { totalCount: 3 } },
    });
  });
});
