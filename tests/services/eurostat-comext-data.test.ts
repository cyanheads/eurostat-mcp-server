/**
 * @fileoverview EurostatDataService against the Comext host (#46): routing of DS-*
 * codes, the per-dataset metadata cache and its cross-call isolation, PRODCOM's
 * text-valued cells, and the wording of a too-large refusal. Global fetch is
 * stubbed, so the real fetchWithTimeout, retry, classification and parse all run.
 * @module tests/services/eurostat-comext-data.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import { SDMX_CONSTRAINT_XML, SDMX_DATAFLOW_XML } from '../fixtures/eurostat-sdmx-metadata.js';
import {
  COMEXT_HOST,
  comextFixture,
  constraintWithProducts,
  json,
  type RoutedRequest,
  routeOf,
  xml,
} from '../helpers/comext-fixtures.js';

const ctx = () => createMockContext();
const service = () => new EurostatDataService({} as never, {} as never);

/**
 * Answer as the two hosts do: the Comext host serves DS-045409's structure and the
 * main host its own datasets, and each answers the other's codes with fault 100 —
 * so a request routed to the wrong host fails instead of passing silently.
 */
function hostsResponse(
  input: unknown,
  { productCount, statistics }: { productCount?: number; statistics?: Record<string, string> } = {},
): Response {
  const request = routeOf(input);
  const isDs = /^ds-/i.test(request.code);
  const onRightHost = isDs === (request.host === 'comext');
  if (request.route === 'statistics') {
    const body = statistics?.[request.code.toUpperCase()];
    if (onRightHost && body) return json(body);
    return json(comextFixture('ds-999999-statistics.json'), 404);
  }
  if (!onRightHost || (isDs && request.code.toUpperCase() !== 'DS-045409')) {
    return xml(comextFixture('ds-999999-dataflow.xml'), 404);
  }
  if (isDs) {
    if (request.route === 'dataflow') return xml(comextFixture('ds-045409-dataflow.xml'));
    if (request.route === 'contentconstraint') {
      return xml(
        productCount === undefined
          ? comextFixture('ds-045409-constraint.xml')
          : constraintWithProducts(productCount),
      );
    }
    if (request.route === 'datastructure') return xml(comextFixture('ds-045409-datastructure.xml'));
  } else {
    if (request.route === 'dataflow') {
      return xml(SDMX_DATAFLOW_XML.replaceAll('EARN_SES_ANNUAL', request.code.toUpperCase()));
    }
    if (request.route === 'contentconstraint') return xml(SDMX_CONSTRAINT_XML);
  }
  throw new Error(`Unexpected request: ${request.url.href}`);
}

let fetchMock: ReturnType<typeof vi.fn>;
const requests = (): RoutedRequest[] => fetchMock.mock.calls.map(([input]) => routeOf(input));
const dataflowReads = (code: string) =>
  requests().filter((r) => r.route === 'dataflow' && r.code.toLowerCase() === code.toLowerCase());

beforeEach(() => {
  fetchMock = vi.fn(async (input: unknown) => hostsResponse(input));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('EurostatDataService — DS-* routing to the Comext host (#46)', () => {
  const EXAMPLE = {
    reporter: ['EU27_2020'],
    partner: ['US'],
    product: ['TOTAL'],
    flow: ['1'],
    indicators: ['VALUE_IN_EUROS'],
  };
  const statistics = {
    'DS-045409': comextFixture('ds-045409-eu27-us-total-2024-01-02.json'),
  };

  for (const code of ['DS-045409', 'ds-045409', 'Ds-045409']) {
    it(`queries "${code}" on the Comext host and returns the two monthly observations`, async () => {
      fetchMock.mockImplementation(async (input: unknown) => hostsResponse(input, { statistics }));
      const result = await service().queryDataset(
        code,
        EXAMPLE,
        undefined,
        '2024-01',
        '2024-02',
        undefined,
        'EN',
        50,
        ctx(),
      );
      expect(requests().map((r) => r.host)).toEqual(['comext']);
      expect(requests()[0]?.url.href.startsWith(`${COMEXT_HOST}/statistics/1.0/data/`)).toBe(true);
      expect(result.obsCount).toBe(2);
      expect(result.observations.map((o) => o.dimensions.time?.code)).toEqual([
        '2024-01',
        '2024-02',
      ]);
      expect(result.observations.every((o) => o.dimensions.freq?.code === 'M')).toBe(true);
    });
  }

  it('keeps a main-host code on the main host for every route', async () => {
    const svc = service();
    await svc.getDatasetInfo('earn_ses_annual', ctx());
    expect(requests().every((r) => r.host === 'main')).toBe(true);
    expect(requests()).toHaveLength(2);
  });

  it('reads the dataset info of DS-045409 from the Comext host: 7 dimensions, no coverage', async () => {
    const meta = await service().getDatasetInfo('DS-045409', ctx());
    expect(requests().every((r) => r.host === 'comext')).toBe(true);
    expect(meta.dimensions.map((d) => d.code)).toEqual([
      'freq',
      'reporter',
      'partner',
      'product',
      'flow',
      'indicators',
      'time',
    ]);
    expect(meta.timeRange).toEqual({});
    expect(meta.obsCount).toBeUndefined();
    expect(meta.lastUpdated).toBe('2026-09-15T11:00:00+0200');
  });

  it('reads the dimension order of DS-045409 from its structure definition on the Comext host', async () => {
    const order = await service().getDimensionOrder('ds-045409', ctx());
    expect(order).toEqual(['freq', 'reporter', 'partner', 'product', 'flow', 'indicators']);
    expect(requests()).toMatchObject([{ host: 'comext', route: 'datastructure' }]);
  });

  it('reports DS-999999 as not_found on every route, having asked the Comext host', async () => {
    const svc = service();
    const notFound = { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } };
    await expect(svc.getDatasetInfo('DS-999999', ctx())).rejects.toMatchObject(notFound);
    await expect(
      svc.getDimensionValues('DS-999999', 'product', undefined, ctx()),
    ).rejects.toMatchObject(notFound);
    await expect(svc.getDimensionOrder('DS-999999', ctx())).rejects.toMatchObject(notFound);
    await expect(
      svc.queryDataset('DS-999999', {}, undefined, undefined, undefined, 1, 'EN', 50, ctx()),
    ).rejects.toMatchObject(notFound);
    expect(requests().every((r) => r.host === 'comext')).toBe(true);
  });
});

describe('EurostatDataService — per-dataset metadata cache (#46)', () => {
  it('makes no second dataflow request for the same DS-* code within the cache lifetime', async () => {
    const svc = service();
    await svc.getDatasetInfo('DS-045409', ctx());
    await svc.getDimensionValues('DS-045409', 'product', undefined, ctx());
    await svc.getDatasetInfo('DS-045409', ctx());
    expect(dataflowReads('DS-045409')).toHaveLength(1);
  });

  it('caches a main-host dataset the same way', async () => {
    const svc = service();
    await svc.getDatasetInfo('earn_ses_annual', ctx());
    await svc.getDimensionValues('earn_ses_annual', 'geo', 'nuts2', ctx());
    expect(dataflowReads('earn_ses_annual')).toHaveLength(1);
    expect(requests().filter((r) => r.route === 'contentconstraint')).toHaveLength(1);
  });

  it('shares one entry across spellings, echoing each caller its own spelling', async () => {
    const svc = service();
    const upper = await svc.getDatasetInfo('DS-045409', ctx());
    const lower = await svc.getDatasetInfo('ds-045409', ctx());
    expect(dataflowReads('DS-045409')).toHaveLength(1);
    expect(upper.code).toBe('DS-045409');
    expect(lower.code).toBe('ds-045409');
    expect({ ...lower, code: 'DS-045409' }).toEqual(upper);
  });

  it('shares one download between concurrent first calls', async () => {
    const svc = service();
    await Promise.all([
      svc.getDatasetInfo('DS-045409', ctx()),
      svc.getDimensionValues('DS-045409', 'reporter', undefined, ctx()),
    ]);
    expect(dataflowReads('DS-045409')).toHaveLength(1);
  });

  it('downloads the structure again once the hour has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const svc = service();
    await svc.getDatasetInfo('DS-045409', ctx());
    vi.setSystemTime(Date.now() + 59 * 60_000);
    await svc.getDatasetInfo('DS-045409', ctx());
    expect(dataflowReads('DS-045409')).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await svc.getDatasetInfo('DS-045409', ctx());
    expect(dataflowReads('DS-045409')).toHaveLength(2);
  });

  it('does not cache a failed load', async () => {
    const svc = service();
    fetchMock.mockImplementationOnce(async () => xml(comextFixture('ds-999999-dataflow.xml'), 404));
    await expect(svc.getDatasetInfo('DS-045409', ctx())).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
    const meta = await svc.getDatasetInfo('DS-045409', ctx());
    expect(meta.dimensions).toHaveLength(7);
    expect(dataflowReads('DS-045409')).toHaveLength(2);
  });

  it('bounds the cache by size rather than count: forty small datasets stay cached together', async () => {
    const svc = service();
    const codes = Array.from({ length: 40 }, (_, i) => `set_${String(i).padStart(2, '0')}`);
    for (const code of codes) await svc.getDatasetInfo(code, ctx());
    for (const code of codes) await svc.getDatasetInfo(code, ctx());
    expect(codes.every((code) => dataflowReads(code).length === 1)).toBe(true);
  });

  describe('the byte budget', () => {
    /** The cache's budget on the estimated size of the values it holds: 64 MiB. */
    const BUDGET = 64 * 1024 * 1024;
    /**
     * A main-host dataset whose `unit` dimension lists enough 1,000-character codes to
     * make up `share` of the budget. With no codelist entry, each label falls back to its
     * code, so a value is ~2,000 characters held.
     */
    const sized = (share: number) => {
      const code = 'U'.repeat(996);
      const count = Math.round((share * BUDGET) / 4_000);
      const units = Array.from(
        { length: count },
        (_, i) => `<c:Value>${code}${String(i).padStart(4, '0')}</c:Value>`,
      ).join('');
      return SDMX_CONSTRAINT_XML.replace(
        /<c:KeyValue id="unit">.*?<\/c:KeyValue>/s,
        `<c:KeyValue id="unit">${units}</c:KeyValue>`,
      );
    };
    const shares: Record<string, number> = { big_a: 0.4, big_b: 0.4, big_c: 0.4, huge: 1.2 };

    beforeEach(() => {
      fetchMock.mockImplementation(async (input: unknown) => {
        const request = routeOf(input);
        const share = shares[request.code];
        if (share !== undefined && request.route === 'contentconstraint') return xml(sized(share));
        return hostsResponse(input);
      });
    });

    it('evicts the least recently used dataset once the held values pass the budget', async () => {
      const svc = service();
      await svc.getDatasetInfo('big_a', ctx());
      await svc.getDatasetInfo('big_b', ctx());
      // Touch big_a, so big_b becomes the least recently used.
      await svc.getDatasetInfo('big_a', ctx());
      await svc.getDatasetInfo('big_c', ctx());
      await svc.getDatasetInfo('big_a', ctx());
      await svc.getDatasetInfo('big_c', ctx());
      expect(dataflowReads('big_a')).toHaveLength(1);
      expect(dataflowReads('big_c')).toHaveLength(1);
      await svc.getDatasetInfo('big_b', ctx());
      expect(dataflowReads('big_b')).toHaveLength(2);
    });

    it('answers every caller of a dataset larger than the whole budget, without keeping it', async () => {
      const svc = service();
      await svc.getDatasetInfo('set_small', ctx());
      const [first, second] = await Promise.all([
        svc.getDimensionValues('huge', 'unit', undefined, ctx()),
        svc.getDimensionValues('huge', 'unit', undefined, ctx()),
      ]);
      expect(first.totalCount).toBe(second.totalCount);
      expect(first.totalCount).toBeGreaterThan(20_000);
      expect(dataflowReads('huge')).toHaveLength(1);
      await svc.getDatasetInfo('huge', ctx());
      expect(dataflowReads('huge')).toHaveLength(2);
      // Declining the oversized entry evicts nothing else.
      await svc.getDatasetInfo('set_small', ctx());
      expect(dataflowReads('set_small')).toHaveLength(1);
    });
  });

  it('lets no caller edit a cached entry', async () => {
    const svc = service();
    const info = await svc.getDatasetInfo('DS-045409', ctx());
    info.label = 'edited';
    info.dimensions.pop();
    const values = await svc.getDimensionValues('DS-045409', 'product', undefined, ctx());
    values.values.pop();
    values.values.push({ code: 'X', label: 'X' });
    expect(() => {
      (values.values[0] as { label: string }).label = 'edited';
    }).toThrow(TypeError);

    const again = await svc.getDatasetInfo('DS-045409', ctx());
    const valuesAgain = await svc.getDimensionValues('DS-045409', 'product', undefined, ctx());
    expect(again.label).toBe('EU trade since 1988 by HS2-4-6 and CN8');
    expect(again.dimensions).toHaveLength(7);
    expect(valuesAgain.values.map((v) => v.code)).toEqual(['01', '0101', '01012100', 'TOTAL']);
    expect(valuesAgain.values[0]?.label).toBe('LIVE ANIMALS');
  });

  it('answers the same on a fresh service and after priming with other datasets on both hosts', async () => {
    const run = async (svc: EurostatDataService) => ({
      info: await svc.getDatasetInfo('DS-045409', ctx()),
      product: await svc.getDimensionValues('DS-045409', 'product', undefined, ctx()),
      geo: await svc.getDimensionValues('earn_ses_annual', 'geo', 'nuts1', ctx()),
    });
    const fresh = await run(service());

    const primed = service();
    await primed.getDatasetInfo('earn_ses_annual', ctx());
    await primed.getDimensionValues('ds-045409', 'reporter', undefined, ctx());
    await primed.getDimensionValues('earn_ses_annual', 'geo', undefined, ctx());
    await primed.getDatasetInfo('other_dataset', ctx());
    await expect(primed.getDatasetInfo('DS-999999', ctx())).rejects.toThrow();
    const touched = await primed.getDatasetInfo('ds-045409', ctx());
    touched.dimensions.length = 0;

    expect(await run(primed)).toEqual(fresh);
  });
});

describe('EurostatDataService — caller cancellation around the shared metadata load', () => {
  /**
   * Hold every structure request until `release()`, rejecting early when the request's
   * own signal aborts — as a real fetch does — so a test can cancel one caller while
   * the shared download is still in flight.
   */
  function gateFetch(): { release: () => void; started: Promise<void> } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      markStarted();
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        void gate.then(resolve);
      });
      return hostsResponse(input);
    });
    return { release, started };
  }

  it('fails only the caller that cancelled, never a concurrent caller of the same dataset', async () => {
    const svc = service();
    const { release, started } = gateFetch();
    const cancelled = new AbortController();
    const first = svc.getDatasetInfo('DS-045409', createMockContext({ signal: cancelled.signal }));
    const second = svc.getDatasetInfo('DS-045409', ctx());
    await started;
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    release();
    const meta = await second;
    expect(meta.dimensions).toHaveLength(7);
    expect(dataflowReads('DS-045409')).toHaveLength(1);
  });

  it('keeps the load a cancelled sole caller started, so the next caller reuses it', async () => {
    const svc = service();
    const { release, started } = gateFetch();
    const cancelled = new AbortController();
    const first = svc.getDimensionValues(
      'DS-045409',
      'product',
      undefined,
      createMockContext({ signal: cancelled.signal }),
    );
    await started;
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    release();
    const values = await svc.getDimensionValues('DS-045409', 'product', undefined, ctx());
    expect(values.totalCount).toBe(4);
    expect(dataflowReads('DS-045409')).toHaveLength(1);
  });

  it('rejects at once a caller whose signal was already aborted, without starting a download', async () => {
    const svc = service();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      svc.getDatasetInfo('DS-045409', createMockContext({ signal: cancelled.signal })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('EurostatDataService — PRODCOM text values (#46)', () => {
  const statistics = { 'DS-059358': comextFixture('ds-059358-de-2022.json') };
  const query = () =>
    service().queryDataset(
      'DS-059358',
      { reporter: ['DE'], product: ['20143430'] },
      undefined,
      '2022',
      '2022',
      undefined,
      'EN',
      500,
      ctx(),
    );

  beforeEach(() => {
    fetchMock.mockImplementation(async (input: unknown) => hostsResponse(input, { statistics }));
  });

  const find = (
    observations: Awaited<ReturnType<typeof query>>['observations'],
    product: string,
    indicator: string,
  ) =>
    observations.find(
      (o) => o.dimensions.product?.code === product && o.dimensions.indicators?.code === indicator,
    );

  it('decodes a text cell in any JSON-stat body, whichever host served it', () => {
    const body = JSON.parse(statistics['DS-059358']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decoded = (service() as any).decodeObservations(body, 500) as Array<{
      value: unknown;
      valueText?: string;
      confStatus?: { code: string };
    }>;
    expect(decoded.every((o) => o.value === null || typeof o.value === 'number')).toBe(true);
    expect(decoded.filter((o) => o.valueText === 'KG')).toHaveLength(6);
    expect(decoded.filter((o) => o.confStatus?.code === 'C').length).toBeGreaterThan(0);
  });

  it('decodes ":C" to a null value with confStatus C', async () => {
    const { observations } = await query();
    expect(find(observations, '20143430', 'PVALFLAG')).toMatchObject({
      value: null,
      confStatus: { code: 'C', label: 'confidential' },
    });
    expect(find(observations, '20143430', 'PVALFLAG')).not.toHaveProperty('valueText');
  });

  it('keeps "KG" verbatim in valueText with a null value', async () => {
    const { observations } = await query();
    const unit = find(observations, '20143430', 'QNTUNIT');
    expect(unit).toMatchObject({ value: null, valueText: 'KG' });
    expect(unit).not.toHaveProperty('confStatus');
  });

  it('leaves the numeric indicators beside them numeric', async () => {
    const { observations } = await query();
    expect(find(observations, '20143430', 'EXPVAL')).toMatchObject({ value: 32868973 });
    expect(find(observations, '20143430', 'EXPVAL')).not.toHaveProperty('valueText');
  });

  it('counts every text cell as carrying no numeric value', async () => {
    const result = await query();
    const textCells = Object.values(
      JSON.parse(statistics['DS-059358']).value as Record<string, unknown>,
    ).filter((v) => typeof v === 'string').length;
    expect(result.obsCount).toBe(result.observations.length);
    expect(result.missingObsCount).toBe(textCells);
    expect(result.observations.filter((o) => o.value === null)).toHaveLength(textCells);
  });

  it('stages the text in obs_value_text and never a string in obs_value', async () => {
    const result = await query();
    const rows = [...result.rows()];
    expect(rows.every((r) => r.obs_value === null || typeof r.obs_value === 'number')).toBe(true);
    expect(rows.filter((r) => r.obs_value_text === 'KG')).toHaveLength(6);
    expect(rows.filter((r) => r.conf_status === 'C').length).toBeGreaterThan(0);
  });
});

describe('EurostatDataService — too-large refusals (#46)', () => {
  it('carries Eurostat EXTRACTION_TOO_BIG label and row estimate in the non-retryable async_response', async () => {
    fetchMock.mockImplementation(async () =>
      json(comextFixture('ds-045409-extraction-too-big.json'), 413),
    );
    const failure = await service()
      .queryDataset(
        'DS-045409',
        { reporter: ['DE'], flow: ['1'], indicators: ['VALUE_IN_EUROS'] },
        undefined,
        undefined,
        undefined,
        1,
        'EN',
        50,
        ctx(),
      )
      .catch((error: unknown) => error as McpError);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'async_response', retryable: false },
    });
    expect((failure as McpError).message).toContain('EXTRACTION_TOO_BIG');
    expect((failure as McpError).message).toContain('estimated 10305182 rows');
    expect((failure as McpError).message).not.toMatch(/geo, unit, na_item/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('EurostatDataService — a Comext value list longer than any inline bound', () => {
  it('returns all 37,069 product codes from the service, whatever the tool shows inline', async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      hostsResponse(input, { productCount: 37_069 }),
    );
    const result = await service().getDimensionValues('DS-045409', 'product', undefined, ctx());
    expect(result.totalCount).toBe(37_069);
    expect(result.values).toHaveLength(37_069);
  });
});
