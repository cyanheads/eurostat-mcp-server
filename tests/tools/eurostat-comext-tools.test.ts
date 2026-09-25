/**
 * @fileoverview The tool surface against the Comext host (#46, #45), end to end:
 * real services behind every tool, global fetch stubbed per host, results read
 * through both structuredContent and content[], and a real DuckDB canvas wherever
 * something is staged.
 * @module tests/tools/eurostat-comext-tools.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatDatasetResource } from '@/mcp-server/resources/definitions/eurostat-dataset.resource.js';
import { eurostatBrowseThemes } from '@/mcp-server/tools/definitions/eurostat-browse-themes.tool.js';
import { eurostatDataframeDescribe } from '@/mcp-server/tools/definitions/eurostat-dataframe-describe.tool.js';
import { eurostatDownloadDataset } from '@/mcp-server/tools/definitions/eurostat-download-dataset.tool.js';
import { eurostatGetDatasetInfo } from '@/mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { eurostatGetDimensionValues } from '@/mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { eurostatQueryDataset } from '@/mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { eurostatSearchDatasets } from '@/mcp-server/tools/definitions/eurostat-search-datasets.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initEurostatBulkService } from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import { initEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';
import { initEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import {
  SDMX_CONSTRAINT_XML,
  SDMX_DATAFLOW_XML,
  sdmxDataStructureXml,
} from '../fixtures/eurostat-sdmx-metadata.js';
import {
  COMEXT_FULL_EXTRACTION_FAULT,
  comextFixture,
  constraintWithProducts,
  json,
  type RoutedRequest,
  routeOf,
  tsv,
  xml,
} from '../helpers/comext-fixtures.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

// ---------------------------------------------------------------------------
// Upstream stand-in: each host serves its own codes and 404s the other's
// ---------------------------------------------------------------------------

const TOC = [
  '"title"\t"code"\t"type"\t"last update of data"\t"last table structure change"\t"data start"\t"data end"\t"values"',
  '"Database by themes"\t"data"\t"folder"\t""\t""\t""\t""',
  '"    International trade"\t"external"\t"folder"\t""\t""\t""\t""',
  '"        International trade in goods"\t"ext_go"\t"folder"\t""\t""\t""\t""',
  '"            EU trade since 1999 by SITC"\t"ext_st_eu27_2020sitc"\t"dataset"\t"15.09.2026"\t""\t"2002"\t"2026-07"\t104232',
  '"    Industry, trade and services"\t"icts"\t"folder"\t""\t""\t""\t""',
].join('\n');

/** Main-host key dimensions served for every main-host structure definition. */
const MIGR_DIMENSIONS = ['freq', 'unit', 'citizen', 'sex', 'age', 'geo'];

interface Upstream {
  /** Main-host constraint override: `unit` then lists this many codes. */
  mainUnitCount?: number;
  /** Comext constraint override: `product` then lists this many codes. */
  productCount?: number;
  /** Statistics API bodies by upper-cased code, with an optional HTTP status. */
  statistics: Record<string, { body: string; status?: number }>;
  /** TSV bodies by upper-cased code, with an optional HTTP status. */
  tsv: Record<string, { body: string; status?: number }>;
}

let upstream: Upstream;
let fetchMock: ReturnType<typeof vi.fn>;
const requests = (): RoutedRequest[] => fetchMock.mock.calls.map(([input]) => routeOf(input));

function respond(input: unknown): Response {
  const request = routeOf(input);
  if (request.route === 'toc') return new Response(TOC);
  if (request.route === 'dataflow-list') return xml(comextFixture('comext-dataflows.xml'));

  const code = request.code.toUpperCase();
  const isDs = code.startsWith('DS-');
  if (isDs !== (request.host === 'comext') || code === 'DS-999999') {
    if (request.route === 'statistics')
      return json(comextFixture('ds-999999-statistics.json'), 404);
    if (request.route === 'data') return xml(comextFixture('ds-999999-data.xml'), 404);
    return xml(comextFixture('ds-999999-dataflow.xml'), 404);
  }
  if (request.route === 'statistics' || request.route === 'data') {
    const reply = (request.route === 'statistics' ? upstream.statistics : upstream.tsv)[code];
    if (!reply) throw new Error(`No ${request.route} body arranged for ${code}`);
    return request.route === 'statistics'
      ? json(reply.body, reply.status)
      : reply.status
        ? xml(reply.body, reply.status)
        : tsv(reply.body);
  }
  if (isDs) {
    if (request.route === 'dataflow') return xml(comextFixture('ds-045409-dataflow.xml'));
    if (request.route === 'datastructure') return xml(comextFixture('ds-045409-datastructure.xml'));
    return xml(
      upstream.productCount === undefined
        ? comextFixture('ds-045409-constraint.xml')
        : constraintWithProducts(upstream.productCount),
    );
  }
  if (request.route === 'dataflow') {
    return xml(SDMX_DATAFLOW_XML.replaceAll('EARN_SES_ANNUAL', code));
  }
  if (request.route === 'datastructure') {
    return xml(sdmxDataStructureXml(MIGR_DIMENSIONS.map((id, i) => ({ id, position: i + 1 }))));
  }
  if (upstream.mainUnitCount === undefined) return xml(SDMX_CONSTRAINT_XML);
  const units = Array.from(
    { length: upstream.mainUnitCount },
    (_, i) => `<c:Value>U${i}</c:Value>`,
  );
  return xml(
    SDMX_CONSTRAINT_XML.replace(
      /<c:KeyValue id="unit">.*?<\/c:KeyValue>/s,
      `<c:KeyValue id="unit">${units.join('')}</c:KeyValue>`,
    ),
  );
}

beforeEach(() => {
  upstream = { statistics: {}, tsv: {} };
  fetchMock = vi.fn(async (input: unknown) => respond(input));
  vi.stubGlobal('fetch', fetchMock);
  // Fresh services per test, so no metadata or catalogue cache leaks between cases.
  initEurostatDataService({} as never, {} as never);
  initEurostatBulkService({} as never, {} as never);
  initEurostatCatalogueService({} as never, {} as never);
  setCanvas(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCanvas(undefined);
});

type Result = Awaited<ReturnType<typeof runToolContract>>;
const text = (result: Result): string =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
const structured = <T = Record<string, unknown>>(result: Result): T =>
  result.structuredContent as T;
const errorData = (result: Result) =>
  structured<{ error: { code: number; message: string; data: Record<string, unknown> } }>(result)
    .error;
const hintOf = (result: Result): string =>
  ((errorData(result).data.recovery as { hint?: string } | undefined)?.hint ?? '') as string;

// ---------------------------------------------------------------------------

describe('eurostat_query_dataset on DS-* codes (#46)', () => {
  const EXAMPLE = {
    reporter: ['EU27_2020'],
    partner: ['US'],
    product: ['TOTAL'],
    flow: ['1'],
    indicators: ['VALUE_IN_EUROS'],
  };

  for (const code of ['DS-045409', 'ds-045409']) {
    it(`returns the issue's two monthly observations for "${code}"`, async () => {
      upstream.statistics['DS-045409'] = {
        body: comextFixture('ds-045409-eu27-us-total-2024-01-02.json'),
      };
      const result = await runToolContract(eurostatQueryDataset, {
        dataset_code: code,
        filters: EXAMPLE,
        since_period: '2024-01',
        until_period: '2024-02',
      });
      expect(result.isError).not.toBe(true);
      expect(structured(result)).toMatchObject({ obsCount: 2, missingObsCount: 0 });
      expect(requests().map((r) => r.host)).toEqual(['comext']);
      expect(text(result)).toContain('EU trade since 1988 by HS2-4-6 and CN8');
      expect(text(result)).toContain('time=2024-02');
      expect(text(result)).toContain('28417786122');
    });
  }

  it('returns PRODCOM ":C" as confStatus C and "KG" as valueText on both surfaces', async () => {
    upstream.statistics['DS-059358'] = { body: comextFixture('ds-059358-de-2022.json') };
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'DS-059358',
      filters: { reporter: ['DE'], product: ['20143430'] },
      since_period: '2022',
      until_period: '2022',
      preview_limit: 500,
    });
    expect(result.isError).not.toBe(true);
    type Obs = {
      confStatus?: { code: string };
      dimensions: Record<string, { code: string }>;
      value: number | null;
      valueText?: string;
    };
    const observations = structured<{ observations: Obs[] }>(result).observations;
    const at = (product: string, indicator: string) =>
      observations.find(
        (o) =>
          o.dimensions.product?.code === product && o.dimensions.indicators?.code === indicator,
      );
    expect(at('20143430', 'QNTUNIT')).toMatchObject({ value: null, valueText: 'KG' });
    expect(at('20143430', 'PVALFLAG')).toMatchObject({ value: null, confStatus: { code: 'C' } });
    expect(at('20143430', 'EXPVAL')).toMatchObject({ value: 32868973 });
    expect(text(result)).toMatch(
      /indicators=QNTUNIT \(Quantity unit\) \| time=2022 \(2022\) → N\/A \[valueText "KG"\]/,
    );
    expect(text(result)).toMatch(/indicators=PVALFLAG .*→ N\/A \[CONF_STATUS C: confidential\]/);
  });

  it("names the Comext dataset's own unfiltered dimensions when Eurostat refuses the query as too large", async () => {
    upstream.statistics['DS-045409'] = {
      body: comextFixture('ds-045409-extraction-too-big.json'),
      status: 413,
    };
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'DS-045409',
      filters: { reporter: ['DE'], flow: ['1'], indicators: ['VALUE_IN_EUROS'] },
      last_n_periods: 1,
    });
    expect(errorData(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'async_response' },
    });
    expect(errorData(result).message).toContain('estimated 10305182 rows');
    expect(hintOf(result)).toContain('Filter on freq, partner, product');
    expect(hintOf(result)).not.toMatch(/\bgeo\b|na_item/);
    expect(text(result)).toContain('not retryable');
    expect(requests().map((r) => `${r.host}:${r.route}`)).toEqual([
      'comext:statistics',
      'comext:datastructure',
    ]);
  });

  it('names a main-host dataset’s own dimensions too, counting geo_level as filtering geo', async () => {
    upstream.statistics.MIGR_ASYRESCRA = {
      body: '{ "error": [{"status": 413,"id": 413,"label": "EXTRACTION_TOO_BIG: The requested extraction is too big, estimated 43032576 rows, max authorised is 5000000, please change your filters to reduce the extraction size"}]}',
      status: 413,
    };
    const result = await runToolContract(eurostatQueryDataset, {
      dataset_code: 'migr_asyrescra',
      filters: { unit: ['PER'] },
      geo_level: 'country',
    });
    expect(errorData(result).data).toMatchObject({ reason: 'async_response' });
    expect(hintOf(result)).toContain('Filter on freq, citizen, sex, age');
    expect(hintOf(result)).not.toContain('geo');
  });

  describe('staging a DS-* match past 5,000 observations', () => {
    let canvas: DataCanvas;
    let teardown: () => Promise<void>;
    beforeAll(() => {
      ({ canvas, teardown } = withRealCanvas());
    });
    afterAll(async () => {
      await teardown();
    });

    it('stages a text value in obs_value_text rather than failing the DOUBLE column', async () => {
      setCanvas(canvas);
      const products = Array.from({ length: 5_001 }, (_, i) => `P${i}`);
      const value: Record<string, number | string> = { 0: 'KG', 1: ':C' };
      for (let i = 2; i < products.length; i++) value[i] = i;
      upstream.statistics['DS-059358'] = {
        body: JSON.stringify({
          version: '2.0',
          class: 'dataset',
          label: 'Sold production, exports and imports',
          id: ['freq', 'product', 'time'],
          size: [1, products.length, 1],
          dimension: {
            freq: { category: { index: { A: 0 } } },
            product: { category: { index: Object.fromEntries(products.map((p, i) => [p, i])) } },
            time: { category: { index: { '2022': 0 } } },
          },
          value,
        }),
      };
      const result = await runToolContract(eurostatQueryDataset, { dataset_code: 'DS-059358' });
      expect(result.isError).not.toBe(true);
      const { canvasId, tableName, stagedRowCount } = structured<{
        canvasId: string;
        stagedRowCount: number;
        tableName: string;
      }>(result);
      expect(stagedRowCount).toBe(5_001);
      const instance = await canvas.acquire(canvasId, createMockContext({ tenantId: 'default' }));
      const [table] = await instance.describe({ tableName });
      expect(table?.columns.map((c) => c.name)).toContain('obs_value_text');
      const rows = await instance.query(
        `SELECT obs_value_text, conf_status, count(*) AS n FROM ${tableName} WHERE obs_value IS NULL GROUP BY 1, 2 ORDER BY 1`,
      );
      expect(rows.rows).toEqual([
        { obs_value_text: 'KG', conf_status: null, n: '1' },
        { obs_value_text: null, conf_status: 'C', n: '1' },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------

describe('eurostat_download_dataset on DS-* codes and fault 413 (#46)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });

  it('stages a filtered DS-045409 download, keyed by the structure the Comext host serves', async () => {
    setCanvas(canvas);
    upstream.tsv['DS-045409'] = { body: comextFixture('ds-045409-de-us-m-2026-06-07.tsv') };
    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'DS-045409',
      filters: {
        reporter: ['DE'],
        partner: ['US'],
        flow: ['1'],
        indicators: ['VALUE_IN_EUROS'],
        freq: ['M'],
      },
      since_period: '2026-06',
      until_period: '2026-07',
    });
    expect(result.isError).not.toBe(true);
    expect(structured(result)).toMatchObject({ rowCount: 6, stagedRowCount: 6 });
    const data = requests().find((r) => r.route === 'data');
    expect(requests().map((r) => `${r.host}:${r.route}`)).toEqual([
      'comext:datastructure',
      'comext:data',
    ]);
    expect(decodeURIComponent(data?.url.pathname ?? '')).toMatch(
      /\/DS-045409\/M\.DE\.US\.\.1\.VALUE_IN_EUROS$/,
    );
    expect(text(result)).toContain('stagedRowCount 6');
  });

  it('stages PRODCOM ":C" in conf_status and "KG" in obs_value_text', async () => {
    setCanvas(canvas);
    upstream.tsv['DS-059358'] = { body: comextFixture('ds-059358-de-2022.tsv') };
    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'DS-059358',
      filters: { reporter: ['DE'], product: ['20143430'] },
      since_period: '2022',
      until_period: '2022',
      preview_limit: 500,
    });
    expect(result.isError).not.toBe(true);
    const { canvasId, tableName, observations } = structured<{
      canvasId: string;
      observations: Array<Record<string, unknown>>;
      tableName: string;
    }>(result);
    expect(observations.find((r) => r.indicators === 'QNTUNIT')).toMatchObject({
      obs_value: null,
      obs_value_text: 'KG',
    });
    expect(text(result)).toContain(
      'indicators=QNTUNIT | time=2022 | obs_value=NULL | obs_value_text=KG',
    );
    const instance = await canvas.acquire(canvasId, createMockContext({ tenantId: 'default' }));
    const counts = await instance.query(
      `SELECT count(*) FILTER (WHERE obs_value_text = 'KG') AS kg, count(*) FILTER (WHERE conf_status = 'C') AS c, count(*) FILTER (WHERE obs_value IS NOT NULL) AS numbers FROM ${tableName}`,
    );
    // The recorded body: 27 ":C" cells, 6 "KG" cells and 25 numbers across six products.
    expect(counts.rows).toEqual([{ kg: '6', c: '27', numbers: '25' }]);
  });

  it('fails an unfiltered DS-059328 as non-retryable extraction_too_big naming its dimensions', async () => {
    upstream.tsv['DS-059328'] = { body: COMEXT_FULL_EXTRACTION_FAULT, status: 413 };
    const result = await runToolContract(eurostatDownloadDataset, { dataset_code: 'DS-059328' });
    expect(errorData(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'extraction_too_big' },
    });
    expect(errorData(result).message).toContain('Full extraction of COMEXT datasets is forbidden');
    expect(hintOf(result)).toContain(
      'Filter on freq, reporter, partner, product, flow, indicators',
    );
    expect(hintOf(result)).not.toMatch(/retry in a few minutes/i);
    expect(text(result)).toContain('not retryable');
  });

  it('fails a main-host fault 413 the same way, never as a retryable upstream_fault', async () => {
    upstream.tsv.MIGR_ASYRESCRA = { body: comextFixture('ds-045409-fault-413.xml'), status: 413 };
    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'migr_asyrescra',
    });
    expect(errorData(result).data).toMatchObject({ reason: 'extraction_too_big' });
    expect(hintOf(result)).toContain('Filter on freq, unit, citizen, sex, age, geo');
    expect(hintOf(result)).not.toMatch(/retry in a few minutes/i);
    expect(text(result)).not.toMatch(/Retry in a few minutes/);
    expect(text(result)).toContain('not retryable');
  });

  it('names only the dimensions a filtered request left open', async () => {
    upstream.tsv['DS-045409'] = { body: comextFixture('ds-045409-fault-413.xml'), status: 413 };
    const result = await runToolContract(eurostatDownloadDataset, {
      dataset_code: 'DS-045409',
      filters: { reporter: ['DE'], FLOW: ['1'], indicators: ['VALUE_IN_EUROS'] },
    });
    expect(errorData(result).data).toMatchObject({ reason: 'extraction_too_big' });
    expect(hintOf(result)).toContain('Filter on freq, partner, product —');
    // The structure definition was read once, for the key, and reused for the hint.
    expect(requests().filter((r) => r.route === 'datastructure')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('DS-999999 is not_found on every tool (#46)', () => {
  const cases: Array<[string, () => Promise<Result>]> = [
    [
      'eurostat_query_dataset',
      () => runToolContract(eurostatQueryDataset, { dataset_code: 'DS-999999' }),
    ],
    [
      'eurostat_download_dataset (unfiltered)',
      () => runToolContract(eurostatDownloadDataset, { dataset_code: 'DS-999999' }),
    ],
    [
      'eurostat_download_dataset (filtered)',
      () =>
        runToolContract(eurostatDownloadDataset, {
          dataset_code: 'DS-999999',
          filters: { reporter: ['DE'] },
        }),
    ],
    [
      'eurostat_get_dataset_info',
      () => runToolContract(eurostatGetDatasetInfo, { dataset_code: 'DS-999999' }),
    ],
    [
      'eurostat_get_dimension_values',
      () =>
        runToolContract(eurostatGetDimensionValues, {
          dataset_code: 'DS-999999',
          dimension: 'product',
        }),
    ],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const result = await call();
      expect(errorData(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found' },
      });
      expect(requests().every((r) => r.host === 'comext')).toBe(true);
    });
  }

  it('eurostat://dataset/{dataset_code}', async () => {
    await expect(
      eurostatDatasetResource.handler(
        { dataset_code: 'DS-999999' },
        createMockContext({ tenantId: 'default' }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });
});

// ---------------------------------------------------------------------------

describe('eurostat_get_dataset_info on DS-045409 (#46)', () => {
  it('returns 7 dimensions and reads timeRange and obsCount as unreported', async () => {
    upstream.productCount = 37_069;
    const result = await runToolContract(eurostatGetDatasetInfo, { dataset_code: 'DS-045409' });
    const meta = structured<{ dimensions: Array<{ code: string; valuesCount?: number }> }>(result);
    expect(meta.dimensions).toHaveLength(7);
    expect(meta.dimensions.find((d) => d.code === 'product')?.valuesCount).toBe(37_069);
    expect(structured(result)).not.toHaveProperty('obsCount');
    expect(structured(result)).toMatchObject({ timeRange: {} });
    expect(text(result)).toContain('**Period:** not reported by Eurostat');
    expect(text(result)).toContain('**Observations:** not reported by Eurostat');
    expect(text(result)).toContain('37059 more — use eurostat_get_dimension_values');
  });
});

// ---------------------------------------------------------------------------

describe('eurostat_get_dimension_values inline cap (#46)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });

  const product = (extra: Record<string, unknown> = {}) =>
    runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'DS-045409',
      dimension: 'product',
      ...extra,
    });

  it('returns the first 2,000 of 37,069 inline and discloses the cut without a canvas', async () => {
    upstream.productCount = 37_069;
    const result = await product();
    const body = structured<{ totalCount: number; values: Array<{ code: string }> }>(result);
    expect(body.values).toHaveLength(2_000);
    expect(body.values[0]?.code).toBe('P000000');
    expect(body.values.at(-1)?.code).toBe('P001999');
    expect(structured(result)).toMatchObject({
      totalCount: 37_069,
      truncated: true,
      shown: 2_000,
      cap: 2_000,
    });
    expect(structured<{ notice: string }>(result).notice).toContain(
      'This deployment runs without a dataframe canvas, so the other 35,069 cannot be listed',
    );
    expect(text(result)).toContain('**Total values:** 37069 — the first 2000 are listed below');
    expect(text(result)).toContain('The first 2,000 of 37,069 "product" values of "DS-045409"');
    expect(text(result)).not.toContain('P002000');
  });

  it('points at canvas_id when a canvas is configured but none was passed', async () => {
    setCanvas(canvas);
    upstream.productCount = 37_069;
    const result = await product();
    expect(structured(result)).not.toHaveProperty('tableName');
    expect(structured<{ notice: string }>(result).notice).toContain(
      'call again with canvas_id set to the canvasId of a eurostat_query_dataset or eurostat_download_dataset response',
    );
  });

  it('stages every value past the cap when canvas_id is passed', async () => {
    setCanvas(canvas);
    upstream.productCount = 37_069;
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId: 'default' }));
    const result = await product({ canvas_id: instance.canvasId });
    const body = structured<{
      stagedRowCount: number;
      tableName: string;
      values: unknown[];
    }>(result);
    expect(body.values).toHaveLength(2_000);
    expect(body.stagedRowCount).toBe(37_069);
    const counted = await instance.query(
      `SELECT count(*) AS n, max(code) AS last FROM ${body.tableName}`,
    );
    expect(counted.rows).toEqual([{ n: '37069', last: 'P037068' }]);
    expect(structured<{ notice: string }>(result).notice).toContain(
      `All 37,069 are staged as table "${body.tableName}"`,
    );
    expect(text(result)).toContain(`All 37,069 are staged as table "${body.tableName}"`);
  });

  it('returns exactly 2,000 values whole, with no truncation fields', async () => {
    upstream.productCount = 2_000;
    const result = await product();
    expect(structured<{ values: unknown[] }>(result).values).toHaveLength(2_000);
    for (const key of ['truncated', 'shown', 'cap', 'notice']) {
      expect(structured(result)).not.toHaveProperty(key);
    }
    expect(text(result)).not.toContain('listed below');
  });

  it('cuts 2,001 values to 2,000', async () => {
    upstream.productCount = 2_001;
    const result = await product();
    expect(structured(result)).toMatchObject({ totalCount: 2_001, truncated: true, shown: 2_000 });
  });

  it('leaves a short dimension unchanged', async () => {
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'DS-045409',
      dimension: 'freq',
    });
    expect(structured(result)).toEqual({
      dimensionCode: 'freq',
      dimensionLabel: 'Frequency',
      values: [
        { code: 'A', label: 'Annual' },
        { code: 'M', label: 'Monthly' },
      ],
      totalCount: 2,
    });
  });

  it('applies the same cap on the main host', async () => {
    upstream.mainUnitCount = 2_500;
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: 'unit',
    });
    expect(structured<{ values: unknown[] }>(result).values).toHaveLength(2_000);
    expect(structured(result)).toMatchObject({ totalCount: 2_500, truncated: true });
  });
});

// ---------------------------------------------------------------------------

describe('search and browse over both sources (#46, #45)', () => {
  it('finds the trade collections searching "comext"', async () => {
    const result = await runToolContract(eurostatSearchDatasets, { query: 'comext' });
    const codes = structured<{ datasets: Array<{ code: string }> }>(result).datasets.map(
      (d) => d.code,
    );
    expect(codes).toHaveLength(7);
    expect(codes.every((code) => code.startsWith('DS-'))).toBe(true);
    expect(text(result)).toContain('**Code:** DS-045409 | **Type:** dataset');
    expect(text(result)).toContain('**Last updated:** 15.09.2026');
  });

  for (const code of ['DS-056120', 'DS-999999']) {
    it(`tells the caller ${code} is not disseminated rather than to broaden the search`, async () => {
      const result = await runToolContract(eurostatSearchDatasets, { query: code });
      expect(errorData(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_match' },
      });
      expect(errorData(result).message).toContain(
        `${code} is on neither the Eurostat dissemination catalogue nor the Comext dataflow list`,
      );
      expect(hintOf(result)).toContain(`Broadening will not find ${code}`);
      expect(hintOf(result)).not.toMatch(/broader term/);
      expect(text(result)).toContain('does not disseminate it');
    });
  }

  it('keeps the broaden-the-search hint for an ordinary no-match', async () => {
    const result = await runToolContract(eurostatSearchDatasets, { query: 'zebra crossings' });
    expect(hintOf(result)).toContain('Try a broader term');
  });

  it('checks a code directly when the Comext list could not be loaded', async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      routeOf(input).route === 'dataflow-list'
        ? new Response('down', { status: 503 })
        : respond(input),
    );
    const result = await runToolContract(eurostatSearchDatasets, { query: 'DS-045409' });
    expect(errorData(result).message).toBe('No datasets matched "DS-045409".');
    expect(hintOf(result)).toContain('Call eurostat_get_dataset_info with the code');
  });

  it('lists ext_go_detail when browsing ext_go', async () => {
    const result = await runToolContract(eurostatBrowseThemes, { theme_code: 'ext_go' });
    const codes = structured<{ items: Array<{ code: string }> }>(result).items.map((i) => i.code);
    expect(codes).toEqual(['ext_st_eu27_2020sitc', 'ext_go_detail']);
    expect(text(result)).toContain('**International trade in goods - detailed data (Comext)**');
  });

  it('names both sources and the unreachable legacy collections in both descriptions', () => {
    for (const description of [
      eurostatSearchDatasets.description,
      eurostatBrowseThemes.description,
    ]) {
      expect(description).toContain('dissemination table of contents');
      expect(description).toMatch(/Comext host/);
      expect(description).toContain('DS-056120');
    }
  });
});

// ---------------------------------------------------------------------------

describe('eurostat_dataframe_describe on an empty canvas', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });

  it('names every tool that stages a table', async () => {
    setCanvas(canvas);
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId: 'default' }));
    const result = await runToolContract(eurostatDataframeDescribe, {
      canvas_id: instance.canvasId,
    });
    const notice = structured<{ notice: string }>(result).notice;
    for (const tool of [
      'eurostat_query_dataset',
      'eurostat_download_dataset',
      'eurostat_get_dimension_values',
    ]) {
      expect(notice).toContain(tool);
      expect(text(result)).toContain(tool);
    }
  });
});
