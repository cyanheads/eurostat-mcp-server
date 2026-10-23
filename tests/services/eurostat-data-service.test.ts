/**
 * @fileoverview Unit tests for EurostatDataService pure logic (JSON-stat decoding,
 * error classification, metadata extraction, query param building).
 * @module tests/services/eurostat-data-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCell } from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import {
  EurostatDataService,
  findUnmatchedValues,
  getEurostatDataService,
  initEurostatDataService,
  observationRowSchema,
  splitStatus,
  toObservationRow,
} from '@/services/eurostat-data/eurostat-data-service.js';
import {
  type JsonStatResponse,
  OBS_CAP,
  type Observation,
  type ObservationRow,
} from '@/services/eurostat-data/types.js';
import {
  EARN_SES_ANNUAL_DIMENSIONS,
  SDMX_CONSTRAINT_WITHOUT_COUNTRIES_XML,
  SDMX_CONSTRAINT_XML,
  SDMX_DATAFLOW_XML,
  sdmxDataStructureXml,
} from '../fixtures/eurostat-sdmx-metadata.js';

/** Minimal mock AppConfig and StorageService — service ignores both */
const mockConfig = {} as never;
const mockStorage = {} as never;

/** Build a tiny but valid 2-dim (geo × time) JSON-stat response for decoding tests. */
function buildJsonStat(
  geos: Array<{ code: string; label: string }>,
  times: Array<{ code: string; label: string }>,
  values: Record<number, number | null>,
  status?: Record<string, string>,
  statusLabels?: Record<string, string>,
): JsonStatResponse {
  const geoIndex: Record<string, number> = {};
  const geoLabel: Record<string, string> = {};
  geos.forEach(({ code, label }, i) => {
    geoIndex[code] = i;
    geoLabel[code] = label;
  });

  const timeIndex: Record<string, number> = {};
  const timeLabel: Record<string, string> = {};
  times.forEach(({ code, label }, i) => {
    timeIndex[code] = i;
    timeLabel[code] = label;
  });

  const valMap: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(values)) {
    valMap[String(k)] = v;
  }

  const resp: JsonStatResponse = {
    id: ['geo', 'time'],
    size: [geos.length, times.length],
    dimension: {
      geo: { label: 'Geography', category: { index: geoIndex, label: geoLabel } },
      time: { label: 'Time', category: { index: timeIndex, label: timeLabel } },
    },
    value: valMap,
    label: 'Test Dataset',
  };
  if (status) resp.status = status;
  if (statusLabels) {
    resp.extension = { status: { label: statusLabels } };
  }
  return resp;
}

// ---------------------------------------------------------------------------
// decodeObservations (via private method — tested through public API shape)
// ---------------------------------------------------------------------------

describe('EurostatDataService — decodeObservations', () => {
  let svc: EurostatDataService;

  beforeEach(() => {
    svc = new EurostatDataService(mockConfig, mockStorage);
  });

  it('decodes a 2-dim response with two observations', () => {
    const data = buildJsonStat(
      [{ code: 'DE', label: 'Germany' }],
      [
        { code: '2023', label: '2023' },
        { code: '2024', label: '2024' },
      ],
      { 0: 3_867_000, 1: 4_000_000 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, OBS_CAP);
    expect(obs).toHaveLength(2);
    expect(obs[0].dimensions.geo.code).toBe('DE');
    expect(obs[0].dimensions.time.code).toBe('2023');
    expect(obs[0].value).toBe(3_867_000);
    expect(obs[1].dimensions.time.code).toBe('2024');
    expect(obs[1].value).toBe(4_000_000);
  });

  it('treats null values as missing observations', () => {
    const data = buildJsonStat(
      [{ code: 'IT', label: 'Italy' }],
      [{ code: '2023', label: '2023' }],
      { 0: null },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, OBS_CAP);
    expect(obs[0].value).toBeNull();
  });

  it('attaches status codes with labels when present', () => {
    const data = buildJsonStat(
      [{ code: 'FR', label: 'France' }],
      [{ code: '2023', label: '2023' }],
      { 0: 2_785_000 },
      { '0': 'p' },
      { p: 'provisional' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, OBS_CAP);
    expect(obs[0].status?.code).toBe('p');
    expect(obs[0].status?.label).toBe('provisional');
  });

  it('falls back to status code as label when no label mapping exists', () => {
    const data = buildJsonStat(
      [{ code: 'FR', label: 'France' }],
      [{ code: '2023', label: '2023' }],
      { 0: 100 },
      { '0': 'x' },
      // no statusLabels entry for 'x'
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, OBS_CAP);
    expect(obs[0].status?.code).toBe('x');
    expect(obs[0].status?.label).toBe('x'); // label falls back to code
  });

  it('skips cells not present in value or status maps', () => {
    const data = buildJsonStat(
      [
        { code: 'DE', label: 'Germany' },
        { code: 'FR', label: 'France' },
      ],
      [{ code: '2023', label: '2023' }],
      // only index 0 present, index 1 (FR/2023) omitted
      { 0: 500 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, OBS_CAP);
    expect(obs).toHaveLength(1);
    expect(obs[0].dimensions.geo.code).toBe('DE');
  });

  it('returns empty array when data has no id/size/dimension', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations({}, OBS_CAP);
    expect(obs).toHaveLength(0);
  });

  it('splits a confidentiality marker out of the status instead of leaving it in the flag (#35)', () => {
    // Live `sts_inpr_m` shape: JSON-stat has no CONF_STATUS field and folds the code into
    // the observation status behind a `|`. `|C` is not an OBS_FLAG — the published codelist
    // has 42 codes and none starts with a pipe.
    const data = buildJsonStat(
      [{ code: 'IE', label: 'Ireland' }],
      [{ code: '2023-01', label: '2023-01' }],
      {},
      { '0': '|C' },
      { '|C': '|confidential' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, OBS_CAP);
    expect(obs[0].status).toBeUndefined();
    expect(obs[0].confStatus).toEqual({ code: 'C', label: 'confidential' });
    expect(obs[0].value).toBeNull();
  });

  it('carries an observation flag and a confidentiality marker side by side (#35)', () => {
    const data = buildJsonStat(
      [{ code: 'IE', label: 'Ireland' }],
      [{ code: '2023-01', label: '2023-01' }],
      { 0: 88.1 },
      { '0': 'p|C' },
      { 'p|C': 'provisional|confidential' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, OBS_CAP);
    expect(obs[0].status).toEqual({ code: 'p', label: 'provisional' });
    expect(obs[0].confStatus).toEqual({ code: 'C', label: 'confidential' });
  });

  it('leaves both markers absent for an unflagged observation (#35)', () => {
    const data = buildJsonStat(
      [{ code: 'DE', label: 'Germany' }],
      [{ code: '2023', label: '2023' }],
      { 0: 4_000_000 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, OBS_CAP);
    expect(obs[0]).not.toHaveProperty('status');
    expect(obs[0]).not.toHaveProperty('confStatus');
  });

  it('stops at the limit instead of building every cell first (#27)', () => {
    const data = buildJsonStat(
      [{ code: 'DE', label: 'Germany' }],
      Array.from({ length: 10 }, (_, i) => ({ code: String(2000 + i), label: String(2000 + i) })),
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, i * 100])),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, 3);
    expect(obs).toHaveLength(3);
    // The kept rows are the lowest linear indexes — an order the decoder walks itself, so
    // the same response always yields the same rows regardless of upstream key order.
    expect(
      obs.map((o: { dimensions: { time: { code: string } } }) => o.dimensions.time.code),
    ).toEqual(['2000', '2001', '2002']);
  });
});

// ---------------------------------------------------------------------------
// splitStatus — OBS_FLAG vs CONF_STATUS (#35)
// ---------------------------------------------------------------------------

describe('splitStatus', () => {
  it('reads a bare status as an observation flag and nothing else', () => {
    expect(splitStatus('p', { p: 'provisional' })).toEqual({
      flag: { code: 'p', label: 'provisional' },
    });
  });

  it('reads a pipe-prefixed status as a confidentiality code and nothing else', () => {
    expect(splitStatus('|C', { '|C': '|confidential' })).toEqual({
      confStatus: { code: 'C', label: 'confidential' },
    });
  });

  it('splits a status carrying both halves', () => {
    expect(splitStatus('p|C', { 'p|C': 'provisional|confidential' })).toEqual({
      flag: { code: 'p', label: 'provisional' },
      confStatus: { code: 'C', label: 'confidential' },
    });
  });

  it('keeps the localized label Eurostat sends for the observation flag', () => {
    // Under lang=DE Eurostat translates the OBS_FLAG half and leaves the other in English.
    expect(splitStatus('p|C', { 'p|C': 'vorläufig|confidential' })).toEqual({
      flag: { code: 'p', label: 'vorläufig' },
      confStatus: { code: 'C', label: 'confidential' },
    });
  });

  it('falls back to the published codelists when the response labels neither half', () => {
    expect(splitStatus('p|C', {})).toEqual({
      flag: { code: 'p', label: 'provisional' },
      confStatus: { code: 'C', label: 'confidential' },
    });
    expect(splitStatus('|N', {})).toEqual({
      confStatus: { code: 'N', label: 'not for publication' },
    });
  });

  it('falls back to the bare code for a half neither the response nor the codelist knows', () => {
    expect(splitStatus('zz|Q', {})).toEqual({
      flag: { code: 'zz', label: 'zz' },
      confStatus: { code: 'Q', label: 'Q' },
    });
  });

  it('yields neither half for an empty status', () => {
    expect(splitStatus('', {})).toEqual({});
  });
});

describe('query and bulk stagers agree on a confidential observation (#35)', () => {
  /**
   * `sts_inpr_m` IE 2023-01 reaches the two services in different wire formats — `: @C` in
   * SDMX TSV, status `|C` labelled `|confidential` in JSON-stat — and SDMX-CSV renders the
   * same observation as `,,C` across `OBS_VALUE,OBS_FLAG,CONF_STATUS`. Both stagers are
   * asserted against those literal expectations rather than against each other, so this
   * fails if either drifts.
   */
  it('writes the same measure columns for the same cell', () => {
    const svc = new EurostatDataService(mockConfig, mockStorage);
    const data = buildJsonStat(
      [{ code: 'IE', label: 'Ireland' }],
      [{ code: '2023-01', label: '2023-01' }],
      {},
      { '0': '|C' },
      { '|C': '|confidential' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [obs] = (svc as any).decodeObservations(data, OBS_CAP);
    const queryRow = toObservationRow(obs, ['geo', 'time']);
    expect(queryRow).toMatchObject({
      obs_value: null,
      obs_flag: null,
      obs_flag_label: null,
      conf_status: 'C',
      conf_status_label: 'confidential',
    });

    const cell = parseCell(': @C');
    expect(cell).toEqual({ value: null, flag: null, conf: 'C' });
  });
});

// ---------------------------------------------------------------------------
// scanCells — totals counted without decoding (#27)
// ---------------------------------------------------------------------------

describe('EurostatDataService — scanCells', () => {
  let svc: EurostatDataService;

  beforeEach(() => {
    svc = new EurostatDataService(mockConfig, mockStorage);
  });

  it('counts every populated cell, including status-only ones, and the periods they span', () => {
    const data = buildJsonStat(
      [
        { code: 'DE', label: 'Germany' },
        { code: 'FR', label: 'France' },
      ],
      [
        { code: '2022', label: '2022' },
        { code: '2023', label: '2023' },
        { code: '2024', label: '2024' },
      ],
      // DE: 2022 present, 2023 null, 2024 absent. FR: 2023 present.
      { 0: 10, 1: null, 4: 20 },
      // FR/2024 carries a status flag but no value — decodable, and missing.
      { '5': 'n' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scan = (svc as any).scanCells(data);
    expect(scan.obsCount).toBe(4);
    expect(scan.missingObsCount).toBe(2);
    expect(scan.timeCodes).toEqual(['2022', '2023', '2024']);
  });

  it('agrees with an uncapped decode over the same response', () => {
    const data = buildJsonStat(
      [
        { code: 'DE', label: 'Germany' },
        { code: 'FR', label: 'France' },
      ],
      [
        { code: '2023', label: '2023' },
        { code: '2024', label: '2024' },
      ],
      { 0: 1, 1: null, 3: 4 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scan = (svc as any).scanCells(data);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations(data, Number.POSITIVE_INFINITY);
    expect(scan.obsCount).toBe(obs.length);
    expect(scan.missingObsCount).toBe(
      obs.filter((o: { value: number | null }) => o.value === null).length,
    );
  });
});

// ---------------------------------------------------------------------------
// checkResponseErrors
// ---------------------------------------------------------------------------

describe('EurostatDataService — checkResponseErrors', () => {
  let svc: EurostatDataService;

  beforeEach(() => {
    svc = new EurostatDataService(mockConfig, mockStorage);
  });

  it('throws async_response on warning status 413', () => {
    const data: JsonStatResponse = { warning: { status: 413, label: 'Too large' } };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com'),
    ).toThrow();
  });

  /** The error `checkResponseErrors` throws for `data`; fails the test when it throws nothing. */
  const thrownFor = (data: JsonStatResponse): McpError => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com');
    } catch (err) {
      return err as McpError;
    }
    return expect.unreachable('expected checkResponseErrors to throw');
  };

  it('async_response error carries reason in data', () => {
    const data: JsonStatResponse = { warning: { status: 413, label: 'Too large' } };
    expect(thrownFor(data).data).toMatchObject({ reason: 'async_response' });
  });

  it('throws not_found on error id 100 (dataset not found)', () => {
    const data: JsonStatResponse = {
      error: [{ status: 404, id: 100, label: 'Dataset not found' }],
    };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com'),
    ).toThrow();
  });

  it('classifies HTTP-200 error id 100 as no_results rather than a missing dataset (#37)', () => {
    const data: JsonStatResponse = {
      error: [{ status: 200, id: 100, label: 'NO_RESULTS' }],
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com');
      throw new Error('Expected checkResponseErrors to throw');
    } catch (err) {
      expect((err as McpError).data).toMatchObject({ reason: 'no_results' });
      expect((err as Error).message).not.toContain('Dataset not found');
    }
  });

  it('classifies an error-array status 413 as non-retryable async_response (#44)', () => {
    const data: JsonStatResponse = {
      error: [{ status: 413, id: 413, label: 'ASYNCHRONOUS_RESPONSE' }],
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com');
      throw new Error('Expected checkResponseErrors to throw');
    } catch (err) {
      expect((err as McpError).data).toMatchObject({
        reason: 'async_response',
        retryable: false,
      });
    }
  });

  it('throws invalid_dimension on error id 150', () => {
    const data: JsonStatResponse = {
      error: [{ status: 400, id: 150, label: 'Invalid dimension' }],
    };
    expect(thrownFor(data).data).toMatchObject({ reason: 'invalid_dimension' });
  });

  it('throws conflicting_params on 400 without id 150', () => {
    const data: JsonStatResponse = {
      error: [{ status: 400, id: 999, label: 'Bad request' }],
    };
    expect(thrownFor(data).data).toMatchObject({ reason: 'conflicting_params' });
  });

  it('throws serviceUnavailable for non-400/404 API errors', () => {
    const data: JsonStatResponse = {
      error: [{ status: 500, id: 0, label: 'Internal error' }],
    };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com'),
    ).toThrow();
  });

  /**
   * Every message that quotes Eurostat's label ends it with one full stop, whether the
   * label brings its own or not. Live labels do both: the time-selection refusal ends
   * "…Please choose one or the other." while id 150's ends "…is not defined".
   */
  describe('quotes the upstream label with a single closing period', () => {
    const sites: Array<[string | undefined, { status: number; id: number }, string]> = [
      ['not_found', { status: 404, id: 100 }, 'ERR_NOT_FOUND_4: XYZ is not available'],
      [
        'invalid_dimension',
        { status: 400, id: 150 },
        'INVALID_QUERY_DIMENSION: Dimension "PRECISION" is not defined',
      ],
      [
        'conflicting_params',
        { status: 400, id: 400 },
        "'TIME' parameter, 'TIME_PERIOD' parameter, 'lastTimePeriod' parameter and 'sinceTimePeriod' parameter cannot be set at the same time. Please choose one or the other",
      ],
      ['invalid_period', { status: 400, id: 400 }, "Invalid value for 'sinceTimePeriod' parameter"],
      [
        'invalid_period',
        { status: 400, id: 140 },
        'TIME_PERIOD_FILTER_SPEC_INVALID: Impossible to apply time dimension filtering',
      ],
      ['conflicting_params', { status: 400, id: 400 }, "Invalid value for 'lang' parameter"],
      [undefined, { status: 500, id: 0 }, 'Internal error'],
    ];

    for (const [reason, shape, stem] of sites) {
      for (const [ending, label] of [
        ['ending in a period', `${stem}.`],
        ['ending without one', stem],
      ] as const) {
        it(`HTTP ${shape.status} id ${shape.id} → ${reason ?? 'unclassified'}, label ${ending}`, () => {
          const err = thrownFor({ error: [{ ...shape, label }] });
          if (reason) expect(err.data).toMatchObject({ reason });
          expect(err.message).toContain(`${stem}.`);
          expect(err.message).not.toContain(`${stem}..`);
          expect(err.message).not.toMatch(/\.\./);
        });
      }
    }
  });

  it('does not throw when data has no errors or warnings', () => {
    const data: JsonStatResponse = { label: 'OK', id: ['geo'], size: [1], value: {} };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com'),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// queryDataset — conflicting param validation (pure logic, no HTTP)
// ---------------------------------------------------------------------------

describe('EurostatDataService — queryDataset param validation', () => {
  it('throws conflicting_params when geo filter and geo_level are both provided', async () => {
    const svc = new EurostatDataService(mockConfig, mockStorage);
    const ctx = createMockContext();
    await expect(
      svc.queryDataset(
        'nama_10_gdp',
        { geo: ['DE'] },
        'country',
        undefined,
        undefined,
        undefined,
        'EN',
        50,
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'conflicting_params' } });
  });

  it('throws conflicting_params when lastN and sinceP are both provided', async () => {
    const svc = new EurostatDataService(mockConfig, mockStorage);
    const ctx = createMockContext();
    await expect(
      svc.queryDataset('nama_10_gdp', {}, undefined, '2020', undefined, 5, 'EN', 50, ctx),
    ).rejects.toMatchObject({ data: { reason: 'conflicting_params' } });
  });

  it('throws conflicting_params when lastN and untilP are both provided', async () => {
    const svc = new EurostatDataService(mockConfig, mockStorage);
    const ctx = createMockContext();
    await expect(
      svc.queryDataset('nama_10_gdp', {}, undefined, undefined, '2024', 3, 'EN', 50, ctx),
    ).rejects.toMatchObject({ data: { reason: 'conflicting_params' } });
  });
});

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

describe('getEurostatDataService', () => {
  it('returns the initialized service after init', () => {
    initEurostatDataService(mockConfig, mockStorage);
    const svc = getEurostatDataService();
    expect(svc).toBeInstanceOf(EurostatDataService);
  });

  it('re-using getEurostatDataService returns the same instance', () => {
    initEurostatDataService(mockConfig, mockStorage);
    const a = getEurostatDataService();
    const b = getEurostatDataService();
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// getDimensionValues — param building (fetch-stubbed, exercises the real HTTP path)
// ---------------------------------------------------------------------------

/** Default fetch stub: a request no test arranged fails loudly instead of returning undefined. */
async function unmockedFetch(input: unknown): Promise<Response> {
  throw new Error(`Unmocked fetch: ${String(input)}`);
}
/** A 200 JSON-stat Response. */
function okResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
/** A non-2xx Response carrying a raw Eurostat error body (as fetchWithTimeout would receive it). */
function errorResponse(status: number, body: string): Response {
  return new Response(body, { status, statusText: status === 404 ? 'Not Found' : 'Bad Request' });
}
/** A 200 SDMX-XML Response. */
function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/vnd.sdmx.structure+xml;version=2.1' },
  });
}
/** Build a minimal JSON-stat body enumerating each dimension → its ordered codes. */
function jsonStat(dims: Record<string, string[]>): JsonStatResponse {
  const id = Object.keys(dims);
  return {
    id,
    size: id.map((d) => dims[d]?.length ?? 0),
    label: 'Test Dataset',
    dimension: Object.fromEntries(
      id.map((d) => [
        d,
        {
          label: d,
          category: {
            index: Object.fromEntries((dims[d] ?? []).map((c, i) => [c, i])),
            label: Object.fromEntries((dims[d] ?? []).map((c) => [c, c])),
          },
        },
      ]),
    ),
    value: {},
  };
}

function sdmxMetadataResponse(input: string | URL, constraintXml = SDMX_CONSTRAINT_XML): Response {
  const url = new URL(String(input));
  const datasetCode = url.pathname.split('/').at(-2)?.toUpperCase() ?? 'EARN_SES_ANNUAL';
  if (url.pathname.includes('/sdmx/2.1/dataflow/')) {
    return xmlResponse(SDMX_DATAFLOW_XML.replaceAll('EARN_SES_ANNUAL', datasetCode));
  }
  if (url.pathname.includes('/sdmx/2.1/contentconstraint/')) return xmlResponse(constraintXml);
  throw new Error(`Unexpected metadata URL: ${url}`);
}

describe('EurostatDataService — dataset-scoped SDMX metadata (#44)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi
      .fn()
      .mockImplementation(async (input: string | URL) => sdmxMetadataResponse(input));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const svc = () => new EurostatDataService(mockConfig, mockStorage);

  it('builds DatasetMeta from the dataflow descendants plus content constraint', async () => {
    const meta = await svc().getDatasetInfo('earn_ses_annual', createMockContext());

    expect(meta.label).toBe('Structure of earnings survey: annual earnings');
    expect(meta.dimensions.map(({ code }) => code)).toEqual(['freq', 'unit', 'geo', 'time']);
    expect(
      meta.dimensions.find(({ code }) => code === 'time')?.sampleValues?.map(({ code }) => code),
    ).toEqual(['2002', '2006', '2010', '2014', '2018', '2022']);
    expect(meta.obsCount).toBe(6_160_543);
    expect(meta.timeRange).toEqual({ start: '2002', end: '2022' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    const dataflow = urls.find(({ pathname }) => pathname.includes('/dataflow/'));
    const constraint = urls.find(({ pathname }) => pathname.includes('/contentconstraint/'));
    expect(dataflow?.pathname).toContain('/sdmx/2.1/dataflow/ESTAT/earn_ses_annual/1.0');
    expect(dataflow?.searchParams.get('references')).toBe('descendants');
    expect(dataflow?.searchParams.get('detail')).toBe('referencepartial');
    expect(constraint?.pathname).toContain('/sdmx/2.1/contentconstraint/ESTAT/earn_ses_annual/1.0');
  });

  it('returns every constrained time value without an observation query', async () => {
    const result = await svc().getDimensionValues(
      'earn_ses_annual',
      'time',
      undefined,
      createMockContext(),
    );
    expect(result.values.map(({ code }) => code)).toEqual([
      '2002',
      '2006',
      '2010',
      '2014',
      '2018',
      '2022',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('/statistics/'))).toBe(
      true,
    );
  });

  it('keeps country as the omitted geo_level default and exposes the effective level (#38)', async () => {
    const result = await svc().getDimensionValues(
      'earn_ses_annual',
      'geo',
      undefined,
      createMockContext(),
    );
    expect(result.geoLevel).toBe('country');
    expect(result.values).toEqual([
      { code: 'DE', label: 'Germany' },
      { code: 'FR', label: 'France' },
    ]);
  });

  it('filters an explicit geo hierarchy level and reports it', async () => {
    const result = await svc().getDimensionValues(
      'earn_ses_annual',
      'geo',
      'nuts2',
      createMockContext(),
    );
    expect(result.geoLevel).toBe('nuts2');
    expect(result.values).toEqual([{ code: 'DE11', label: 'Stuttgart' }]);
  });

  it('returns the full constrained value set for a non-geo dimension', async () => {
    const result = await svc().getDimensionValues(
      'earn_ses_annual',
      'unit',
      undefined,
      createMockContext(),
    );
    expect(result.geoLevel).toBeUndefined();
    expect(result.totalCount).toBe(11);
    expect(result.values.at(-1)).toEqual({ code: 'U11', label: 'Unit 11' });
  });

  it('rejects geo_level paired with a non-geo dimension before requesting metadata', async () => {
    await expect(
      svc().getDimensionValues('earn_ses_annual', 'unit', 'nuts3', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'conflicting_params' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an empty default geo level as no_results, not a missing dataset (#38)', async () => {
    fetchMock.mockImplementation(async (input: string | URL) =>
      sdmxMetadataResponse(input, SDMX_CONSTRAINT_WITHOUT_COUNTRIES_XML),
    );
    await expect(
      svc().getDimensionValues('tgs00010', 'geo', undefined, createMockContext()),
    ).rejects.toMatchObject({
      data: { reason: 'no_results', geoLevel: 'country' },
      message: expect.not.stringContaining('Dataset not found'),
    });
  });

  it('preserves unknown datasets as not_found', async () => {
    fetchMock.mockImplementation(async () =>
      errorResponse(404, '<mes:ErrorMessage>Not found</mes:ErrorMessage>'),
    );
    await expect(
      svc().getDatasetInfo('nonexistent_xyz', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });
});

describe('EurostatDataService — getDimensionValues param building', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const svc = () => new EurostatDataService(mockConfig, mockStorage);

  it('geo without geo_level applies the documented country default', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => sdmxMetadataResponse(input));
    const res = await svc().getDimensionValues(
      'earn_ses_annual',
      'geo',
      undefined,
      createMockContext(),
    );
    expect(res.geoLevel).toBe('country');
    expect(res.values.map(({ code }) => code)).toEqual(['DE', 'FR']);
  });

  it('geo with an explicit geo_level uses that value', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => sdmxMetadataResponse(input));
    const result = await svc().getDimensionValues(
      'earn_ses_annual',
      'geo',
      'aggregate',
      createMockContext(),
    );
    expect(result.geoLevel).toBe('aggregate');
    expect(result.values.map(({ code }) => code)).toEqual(['EU27_2020', 'EA20']);
  });

  it('a non-time categorical dimension uses its full content-constraint set', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => sdmxMetadataResponse(input));
    const res = await svc().getDimensionValues(
      'earn_ses_annual',
      'unit',
      undefined,
      createMockContext(),
    );
    expect(res.totalCount).toBe(11);
    expect(res.geoLevel).toBeUndefined();
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('/statistics/'))).toBe(
      true,
    );
  });

  it('time enumerates the full constraint rather than an observation slice', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => sdmxMetadataResponse(input));
    const res = await svc().getDimensionValues(
      'earn_ses_annual',
      'time',
      undefined,
      createMockContext(),
    );
    expect(res.totalCount).toBe(6);
    expect(res.values[0]?.code).toBe('2002');
    expect(res.values.at(-1)?.code).toBe('2022');
  });

  it('rejects geo_level paired with a non-geo dimension instead of ignoring it', async () => {
    fetchMock.mockResolvedValue(okResponse(jsonStat({ unit: ['CP_MEUR'] })));
    await expect(
      svc().getDimensionValues('nama_10_gdp', 'unit', 'nuts3', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'conflicting_params' } });
    // Rejected before any request — the parameter had no effect on the query it was sent with.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces malformed structure metadata as a non-retryable upstream fault', async () => {
    fetchMock.mockImplementation(async () => xmlResponse('<m:Structure/>'));
    await expect(
      svc().getDimensionValues('nama_10_gdp', 'unit', undefined, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'upstream_fault', retryable: false } });
  });
});

// ---------------------------------------------------------------------------
// getDatasetInfo — public metadata contract over the two SDMX structure requests
// ---------------------------------------------------------------------------

describe('EurostatDataService — getDatasetInfo time coverage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const svc = () => new EurostatDataService(mockConfig, mockStorage);
  it('reports the dataset-wide period count from the content constraint', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => sdmxMetadataResponse(input));

    const meta = await svc().getDatasetInfo('earn_ses_annual', createMockContext());

    const time = meta.dimensions.find((d) => d.code === 'time');
    expect(time?.valuesCount).toBe(6);
    expect(time?.sampleValues?.[0]?.code).toBe('2002');
    expect(meta.dimensions.find((d) => d.code === 'geo')?.valuesCount).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves annotation-backed fields in the public DatasetMeta contract', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => sdmxMetadataResponse(input));
    const meta = await svc().getDatasetInfo('earn_ses_annual', createMockContext());
    expect(meta.label).toBe('Structure of earnings survey: annual earnings');
    expect(meta.obsCount).toBe(6_160_543);
    expect(meta.timeRange).toEqual({ start: '2002', end: '2022' });
    expect(meta.lastUpdated).toBe('2026-02-09T23:00:00+0100');
    expect(meta.metadataUrl).toBe('https://example.test/earn_ses_esms.htm');
  });

  it('still fails when the primary metadata source reports an unknown dataset', async () => {
    fetchMock.mockImplementation(async () => errorResponse(404, 'not found'));
    await expect(
      svc().getDatasetInfo('nonexistent_xyz', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });
});

// ---------------------------------------------------------------------------
// getDimensionOrder — the positional key order a filtered bulk download needs
// ---------------------------------------------------------------------------

/** The Statistics API's HTTP-413 refusal of an extraction, as Eurostat sends it. */
const EXTRACTION_TOO_BIG =
  '{ "error": [{"status": 413,"id": 413,"label": "EXTRACTION_TOO_BIG: The requested extraction is too big, estimated 5821200 rows, max authorised is 5000000, please change your filters to reduce the extraction size"}]}';

/** The SOAP fault the structure endpoint returns for a code it does not know. */
const DSD_NOT_FOUND =
  '<?xml version="1.0" encoding="UTF-8"?><S:Fault xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>100</faultcode><faultstring>ERR_NOT_FOUND_4: NONEXISTENT_XYZ (DATA_STRUCTURE:ESTAT,*) is not available for dissemination.</faultstring></S:Fault>';

describe('EurostatDataService — getDimensionOrder (#57)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const svc = () => new EurostatDataService(mockConfig, mockStorage);
  const requested = () => fetchMock.mock.calls.map(([input]) => new URL(String(input)));

  /**
   * Answers both sources a dimension order can be read from — the Statistics API's
   * one-period slice and the SDMX structure definition — with the same order, so
   * the assertion pins what the method returns rather than where it reads it.
   */
  const bothSources =
    (statistics: () => Response) =>
    async (input: string | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.includes('/sdmx/2.1/datastructure/')) {
        return xmlResponse(sdmxDataStructureXml());
      }
      if (url.pathname.includes('/statistics/1.0/data/')) return statistics();
      throw new Error(`Unexpected URL: ${url}`);
    };

  it('returns the key dimensions in key order, time excluded', async () => {
    fetchMock.mockImplementation(
      bothSources(() =>
        okResponse(
          jsonStat(
            Object.fromEntries([
              ...EARN_SES_ANNUAL_DIMENSIONS.map((dim) => [dim, ['X']]),
              ['time', ['2022']],
            ]),
          ),
        ),
      ),
    );
    await expect(svc().getDimensionOrder('earn_ses_annual', createMockContext())).resolves.toEqual(
      EARN_SES_ANNUAL_DIMENSIONS,
    );
  });

  it('resolves when the unfiltered latest-period slice exceeds the extraction limit', async () => {
    fetchMock.mockImplementation(bothSources(() => errorResponse(413, EXTRACTION_TOO_BIG)));
    await expect(svc().getDimensionOrder('earn_ses_annual', createMockContext())).resolves.toEqual(
      EARN_SES_ANNUAL_DIMENSIONS,
    );
  });

  it('reads the latest structure definition and never requests observations', async () => {
    fetchMock.mockImplementation(bothSources(() => errorResponse(413, EXTRACTION_TOO_BIG)));
    await svc().getDimensionOrder('earn_ses_annual', createMockContext());

    const urls = requested();
    expect(urls.some(({ pathname }) => pathname.includes('/statistics/'))).toBe(false);
    expect(urls).toHaveLength(1);
    // Unversioned: a pinned `/1.0` answers with the dataset's first structure, not its current one.
    expect(urls[0]?.pathname).toMatch(/\/sdmx\/2\.1\/datastructure\/ESTAT\/earn_ses_annual$/);
    expect(urls[0]?.search).toBe('');
  });

  it('orders by the position attribute rather than document order', async () => {
    fetchMock.mockImplementation(async () =>
      xmlResponse(
        sdmxDataStructureXml([
          { id: 'geo', position: 4 },
          { id: 'freq', position: 1 },
          { id: 'na_item', position: 3 },
          { id: 'unit', position: 2 },
        ]),
      ),
    );
    await expect(svc().getDimensionOrder('nama_10_gdp', createMockContext())).resolves.toEqual([
      'freq',
      'unit',
      'na_item',
      'geo',
    ]);
  });

  it('reports an unknown dataset as not_found', async () => {
    fetchMock.mockImplementation(async () => errorResponse(404, DSD_NOT_FOUND));
    await expect(
      svc().getDimensionOrder('nonexistent_xyz', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });

  it('reports a structure definition with no dimension list as a non-retryable upstream fault', async () => {
    fetchMock.mockImplementation(async () => xmlResponse('<m:Structure/>'));
    await expect(
      svc().getDimensionOrder('earn_ses_annual', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'upstream_fault', retryable: false } });
  });

  it('reports a structure definition with only a time dimension as an upstream fault', async () => {
    fetchMock.mockImplementation(async () => xmlResponse(sdmxDataStructureXml([])));
    await expect(
      svc().getDimensionOrder('earn_ses_annual', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'upstream_fault' } });
  });
});

// ---------------------------------------------------------------------------
// An unavailable structure endpoint — every caller of the SDMX structure fetch
// ---------------------------------------------------------------------------

describe('EurostatDataService — an unavailable SDMX structure endpoint', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const svc = () => new EurostatDataService(mockConfig, mockStorage);
  const unavailable = () =>
    new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });

  /**
   * Settle `run` past the retry backoff without waiting it out. Four attempts back off
   * 1 s, 2 s and 4 s, each up to 25% longer with jitter, so 60 s clears every schedule.
   */
  async function settle<T>(run: Promise<T>): Promise<T | McpError> {
    const outcome = run.then(
      (value) => value,
      (error: unknown) => error as McpError,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    return outcome;
  }

  it('fails the dimension-order read as a retryable upstream_fault once every attempt answered 503', async () => {
    fetchMock.mockImplementation(async () => unavailable());
    const err = (await settle(
      svc().getDimensionOrder('DS-045409', createMockContext()),
    )) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'upstream_fault',
      retryable: true,
      status: 503,
      datasetCode: 'DS-045409',
    });
    expect(err.message).toContain('"DS-045409"');
    expect(err.message).toContain('HTTP 503');
    // The retry loop ran to exhaustion before the failure was classified.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('fails the dataset metadata load the same way, after retrying both structure reads', async () => {
    fetchMock.mockImplementation(async () => unavailable());
    const err = (await settle(svc().getDatasetInfo('DS-045409', createMockContext()))) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_fault', retryable: true, status: 503 });
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths.filter((p) => p.includes('/dataflow/'))).toHaveLength(4);
    expect(paths.filter((p) => p.includes('/contentconstraint/'))).toHaveLength(4);
  });

  it('fails the dimension-values metadata load the same way', async () => {
    fetchMock.mockImplementation(async () => unavailable());
    const err = (await settle(
      svc().getDimensionValues('nama_10_gdp', 'geo', undefined, createMockContext()),
    )) as McpError;
    expect(err.data).toMatchObject({ reason: 'upstream_fault', retryable: true, status: 503 });
  });

  it('classifies a network failure that outlasts the retries as a retryable upstream_fault', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const err = (await settle(
      svc().getDimensionOrder('nama_10_gdp', createMockContext()),
    )) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
    expect(err.message).toContain('could not be reached');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('still answers when the endpoint recovers inside the retry budget', async () => {
    fetchMock
      .mockImplementationOnce(async () => unavailable())
      .mockImplementationOnce(async () => unavailable())
      .mockImplementation(async () => xmlResponse(sdmxDataStructureXml()));
    await expect(
      settle(svc().getDimensionOrder('earn_ses_annual', createMockContext())),
    ).resolves.toEqual(EARN_SES_ANNUAL_DIMENSIONS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('leaves a 404 as not_found, on one attempt', async () => {
    fetchMock.mockImplementation(async () => errorResponse(404, DSD_NOT_FOUND));
    const err = (await settle(
      svc().getDimensionOrder('nonexistent_xyz', createMockContext()),
    )) as McpError;
    expect(err.data).toMatchObject({ reason: 'not_found' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a cancelled read as a cancellation, not an upstream fault', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      return unavailable();
    });
    const err = (await settle(
      svc().getDimensionOrder('nama_10_gdp', createMockContext({ signal: controller.signal })),
    )) as McpError;
    expect((err.data as { reason?: string } | undefined)?.reason).not.toBe('upstream_fault');
  });
});

// ---------------------------------------------------------------------------
// queryDataset — filter normalization (fetch-stubbed)
// ---------------------------------------------------------------------------

describe('EurostatDataService — queryDataset filter normalization', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A response with one decodable observation, so queryDataset does not throw no_results. */
  const oneObservation = () => ({
    ...jsonStat({ geo: ['DE'], time: ['2024'] }),
    value: { '0': 4_000_000 },
  });
  const svc = () => new EurostatDataService(mockConfig, mockStorage);
  const paramsOf = (callIndex: number): URLSearchParams =>
    new URL(String(fetchMock.mock.calls[callIndex]?.[0])).searchParams;

  it('drops zero-length filter arrays from both the request and the applied set', async () => {
    fetchMock.mockResolvedValue(okResponse(oneObservation()));
    const res = await svc().queryDataset(
      'nama_10_gdp',
      { unit: ['CP_MEUR'], geo: [] },
      undefined,
      undefined,
      undefined,
      1,
      'EN',
      50,
      createMockContext(),
    );
    const p = paramsOf(0);
    expect(p.getAll('unit')).toEqual(['CP_MEUR']);
    expect(p.has('geo')).toBe(false);
    // The caller is told what was sent, not what was asked for.
    expect(res.appliedFilters).toEqual({ unit: ['CP_MEUR'] });
  });

  it('does not treat an empty geo array as conflicting with geo_level', async () => {
    fetchMock.mockResolvedValue(okResponse(oneObservation()));
    const res = await svc().queryDataset(
      'nama_10_gdp',
      { geo: [] },
      'country',
      undefined,
      undefined,
      1,
      'EN',
      50,
      createMockContext(),
    );
    // geo: [] places no restriction, so it cannot conflict with geo_level.
    expect(paramsOf(0).get('geoLevel')).toBe('country');
    expect(paramsOf(0).has('geo')).toBe(false);
    expect(res.appliedFilters).toEqual({});
  });

  const query = (filters: Record<string, string[]>, lastN?: number) =>
    svc().queryDataset(
      'nama_10_gdp',
      filters,
      undefined,
      undefined,
      undefined,
      lastN,
      'EN',
      50,
      createMockContext(),
    );

  it('sends a non-blank value exactly as given, padding included', async () => {
    fetchMock.mockResolvedValue(okResponse(oneObservation()));
    const res = await query({ geo: [' DE'] });
    expect(paramsOf(0).getAll('geo')).toEqual([' DE']);
    expect(res.appliedFilters).toEqual({ geo: [' DE'] });
  });

  for (const key of ['time', 'TIME', 'time_period', 'Time_Period']) {
    it(`sends a ${key} filter as a time-dimension filter when no period input is set`, async () => {
      fetchMock.mockResolvedValue(okResponse(oneObservation()));
      const res = await query({ unit: ['CP_MEUR'], [key]: ['2020'] });
      expect(paramsOf(0).getAll(key)).toEqual(['2020']);
      expect(paramsOf(0).has('lastTimePeriod')).toBe(false);
      expect(res.appliedFilters).toEqual({ unit: ['CP_MEUR'], [key]: ['2020'] });
    });
  }

  it('leaves an unknown non-control filter key for Eurostat to judge', async () => {
    fetchMock.mockResolvedValue(okResponse(oneObservation()));
    await query({ precision: ['1'] }, 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(paramsOf(0).getAll('precision')).toEqual(['1']);
  });

  it('drops blank and whitespace-only values, and a dimension left with none (#61)', async () => {
    fetchMock.mockResolvedValue(okResponse(oneObservation()));
    const res = await query({ unit: ['', 'CP_MEUR', '  '], geo: ['', '  '], na_item: [' \t'] }, 1);
    const p = paramsOf(0);
    expect(p.getAll('unit')).toEqual(['CP_MEUR']);
    expect(p.has('geo')).toBe(false);
    expect(p.has('na_item')).toBe(false);
    expect(res.appliedFilters).toEqual({ unit: ['CP_MEUR'] });
  });

  it('does not treat a blank-only geo array as conflicting with geo_level (#61)', async () => {
    fetchMock.mockResolvedValue(okResponse(oneObservation()));
    const res = await svc().queryDataset(
      'nama_10_gdp',
      { geo: ['', '  '] },
      'country',
      undefined,
      undefined,
      1,
      'EN',
      50,
      createMockContext(),
    );
    expect(paramsOf(0).get('geoLevel')).toBe('country');
    expect(paramsOf(0).has('geo')).toBe(false);
    expect(res.appliedFilters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// queryDataset — filter keys that name a Statistics API control (#62)
// ---------------------------------------------------------------------------

describe('EurostatDataService — queryDataset rejects control-named filter keys (#62)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const query = (filters: Record<string, string[]>) =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'nama_10_gdp',
      filters,
      undefined,
      undefined,
      undefined,
      1,
      'EN',
      50,
      createMockContext(),
    );

  const DEDICATED = ['lang', 'geo_level', 'since_period', 'until_period', 'last_n_periods'];

  for (const [key, input] of [
    ['lang', 'lang'],
    ['LANG', 'lang'],
    ['Lang', 'lang'],
    ['geoLevel', 'geo_level'],
    ['GEOLEVEL', 'geo_level'],
    ['sinceTimePeriod', 'since_period'],
    ['SINCETIMEPERIOD', 'since_period'],
    ['untilTimePeriod', 'until_period'],
    ['UntilTimePeriod', 'until_period'],
    ['lastTimePeriod', 'last_n_periods'],
    ['LASTTIMEPERIOD', 'last_n_periods'],
    ['lasttimeperiod', 'last_n_periods'],
  ] as const) {
    it(`rejects filters.${key} as invalid_dimension naming ${input}, before any request`, async () => {
      const err = (await query({ unit: ['CP_MEUR'], [key]: ['3'] }).catch((e) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'invalid_dimension' });
      expect(err.message).toContain(`"${key}"`);
      // Whole hint: `lang` names both the key and its input, so a substring check for the
      // input passes on a hint that never says which input to set.
      expect((err.data as { recovery: { hint: string } }).recovery.hint).toBe(
        `Remove "${key}" from filters and set ${input} instead.`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  for (const key of ['format', 'FORMAT']) {
    it(`rejects filters.${key} as invalid_dimension naming no dedicated input`, async () => {
      const err = (await query({ [key]: ['JSON'] }).catch((e) => e)) as McpError;
      expect(err.data).toMatchObject({ reason: 'invalid_dimension' });
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toContain(`"${key}"`);
      for (const input of DEDICATED) expect(hint).not.toMatch(new RegExp(`\\b${input}\\b`));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('names every control key in one rejection', async () => {
    const err = (await query({ lang: ['FR'], GEOLEVEL: ['nuts1'] }).catch((e) => e)) as McpError;
    expect((err.data as { recovery: { hint: string } }).recovery.hint).toBe(
      'Remove "lang", "GEOLEVEL" from filters and set lang for "lang", geo_level for "GEOLEVEL" instead.',
    );
  });

  it('treats a control key carrying only blank values as unset, not as a rejection', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ...jsonStat({ geo: ['DE'], time: ['2024'] }), value: { '0': 1 } }),
    );
    const res = await query({ geo: ['DE'], lang: [''], LASTTIMEPERIOD: [] });
    const p = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(p.getAll('lang')).toEqual(['EN']);
    expect(p.has('LASTTIMEPERIOD')).toBe(false);
    expect(res.appliedFilters).toEqual({ geo: ['DE'] });
  });
});

// ---------------------------------------------------------------------------
// queryDataset — a time filter beside a period input (#70)
// ---------------------------------------------------------------------------

describe('EurostatDataService — queryDataset time filter vs period inputs (#70)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const query = (
    filters: Record<string, string[]>,
    sinceP: string | undefined,
    untilP: string | undefined,
    lastN: number | undefined,
  ) =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'nama_10_gdp',
      filters,
      undefined,
      sinceP,
      untilP,
      lastN,
      'EN',
      50,
      createMockContext(),
    );

  for (const key of ['time', 'TIME', 'time_period', 'Time_Period']) {
    for (const [input, sinceP, untilP, lastN] of [
      ['since_period', '2020', undefined, undefined],
      ['until_period', undefined, '2022', undefined],
      ['last_n_periods', undefined, undefined, 1],
    ] as const) {
      it(`rejects filters.${key} with ${input} as conflicting_params before any request`, async () => {
        const err = (await query({ geo: ['DE'], [key]: ['2020'] }, sinceP, untilP, lastN).catch(
          (e) => e,
        )) as McpError;
        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.data).toMatchObject({ reason: 'conflicting_params' });
        const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
        expect(hint).toContain(`filters.${key}`);
        expect(hint).toContain(input);
        expect(hint).not.toContain('geo_level');
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }
  }

  it('names both bounds when since_period and until_period are set', async () => {
    const err = (await query({ time: ['2020'] }, '2019', '2021', undefined).catch(
      (e) => e,
    )) as McpError;
    const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
    expect(hint).toContain('since_period');
    expect(hint).toContain('until_period');
  });

  it('treats a blank-only time filter as unset beside last_n_periods', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ...jsonStat({ geo: ['DE'], time: ['2024'] }), value: { '0': 1 } }),
    );
    await query({ geo: ['DE'], time: ['  '] }, undefined, undefined, 1);
    const p = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(p.get('lastTimePeriod')).toBe('1');
    expect(p.has('time')).toBe(false);
  });

  it('keeps the period-input rule and its own hint for since_period with last_n_periods', async () => {
    const err = (await query({}, '2020', undefined, 5).catch((e) => e)) as McpError;
    expect(err.data).toMatchObject({ reason: 'conflicting_params' });
    const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
    expect(hint).toMatch(/since_period.*last_n_periods/);
    expect(hint).not.toContain('filters.');
    expect(hint).not.toContain('geo_level');
  });

  it('gives the geo rule a hint naming only geo and geo_level', async () => {
    const err = (await new EurostatDataService(mockConfig, mockStorage)
      .queryDataset(
        'nama_10_gdp',
        { geo: ['DE'] },
        'country',
        undefined,
        undefined,
        1,
        'EN',
        50,
        createMockContext(),
      )
      .catch((e) => e)) as McpError;
    const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
    expect(hint).toMatch(/filters\.geo.*geo_level/);
    expect(hint).not.toMatch(/period/);
  });
});

// ---------------------------------------------------------------------------
// queryDataset — time coverage (fetch-stubbed)
// ---------------------------------------------------------------------------

describe('EurostatDataService — queryDataset time coverage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const periodAnnotations = {
    annotation: [
      { type: 'OBS_PERIOD_OVERALL_OLDEST', title: '1975' },
      { type: 'OBS_PERIOD_OVERALL_LATEST', title: '2025' },
    ],
  };
  const query = () =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'xyz',
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      'EN',
      50,
      createMockContext(),
    );

  it('omits both bounds when neither the observations nor the annotations report a period', async () => {
    // No time dimension to derive a period from and no dataset-wide annotations to fall back
    // to. Both bounds previously became '', indistinguishable from a known-empty period.
    fetchMock.mockResolvedValue(okResponse({ ...jsonStat({ geo: ['DE'] }), value: { '0': 42 } }));
    const res = await query();
    expect(res.timeRange).toEqual({});
  });

  it('carries one bound when only the other annotation is present', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        ...jsonStat({ geo: ['DE'] }),
        value: { '0': 42 },
        extension: { annotation: [{ type: 'OBS_PERIOD_OVERALL_LATEST', title: '2025' }] },
      }),
    );
    const res = await query();
    expect(res.timeRange).toEqual({ end: '2025' });
  });

  it('falls back to the dataset-wide annotations when the result carries no time dimension', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        ...jsonStat({ geo: ['DE'] }),
        value: { '0': 42 },
        extension: periodAnnotations,
      }),
    );
    const res = await query();
    expect(res.timeRange).toEqual({ start: '1975', end: '2025' });
  });

  it('reports the returned observations period rather than the dataset-wide annotations', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        ...jsonStat({ geo: ['DE'], time: ['2023', '2024'] }),
        value: { '0': 1, '1': 2 },
        extension: periodAnnotations,
      }),
    );
    const res = await query();
    expect(res.timeRange).toEqual({ start: '2023', end: '2024' });
  });

  it('bounds the period by code, not by the order the time dimension declares its values', async () => {
    // The time category lists 2024 at position 0 and 2010 at the last position. Reading the
    // first and last position occupied would report 2024 – 2010: a start after its own end.
    fetchMock.mockResolvedValue(
      okResponse({
        ...jsonStat({ geo: ['DE'], time: ['2024', '1999', '2010'] }),
        value: { '0': 1, '1': 2, '2': 3 },
        extension: periodAnnotations,
      }),
    );
    const res = await query();
    expect(res.timeRange).toEqual({ start: '1999', end: '2024' });
  });
});

// ---------------------------------------------------------------------------
// queryDataset — row cap applied while decoding (#27)
// ---------------------------------------------------------------------------

describe('EurostatDataService — queryDataset row cap (#27)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PERIODS = Array.from({ length: 60 }, (_, i) => String(2000 + i));
  const GEOS = Array.from({ length: 100 }, (_, i) => `G${i}`);

  /**
   * 6,000 populated cells — 1,000 past the cap. Dimension order is time-major, so the
   * linear index the decoder walks reaches the last 10 periods only after the cap: any
   * total derived from the decoded rows loses them.
   */
  const oversized = () => {
    const value: Record<string, number | null> = {};
    for (let i = 0; i < PERIODS.length * GEOS.length; i++) value[String(i)] = i;
    value['10'] = null; // inside the cap
    value['5500'] = null; // past it, in period 2055
    return { ...jsonStat({ time: PERIODS, geo: GEOS }), value };
  };

  const query = () =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'nama_10_gdp',
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      'EN',
      OBS_CAP,
      createMockContext(),
    );

  it('returns at most the cap in observations', async () => {
    fetchMock.mockResolvedValue(okResponse(oversized()));
    const res = await query();
    expect(res.observations).toHaveLength(OBS_CAP);
    expect(OBS_CAP).toBeLessThan(6000);
  });

  it('reports the full match in obsCount, not the number of rows it returned', async () => {
    fetchMock.mockResolvedValue(okResponse(oversized()));
    const res = await query();
    expect(res.obsCount).toBe(6000);
    expect(res.obsCount).not.toBe(res.observations.length);
  });

  it('counts missing observations past the cap', async () => {
    fetchMock.mockResolvedValue(okResponse(oversized()));
    const res = await query();
    // One null inside the cap, one past it — a count taken from the returned rows sees one.
    expect(res.missingObsCount).toBe(2);
  });

  it('reports the period span of the whole match, not of the rows it returned', async () => {
    fetchMock.mockResolvedValue(okResponse(oversized()));
    const res = await query();
    expect(res.timeRange).toEqual({ start: '2000', end: '2059' });
    // The returned rows stop well short of that end — the span is not derived from them.
    const lastRow = res.observations.at(-1);
    expect(lastRow?.dimensions.time?.code).toBe('2049');
  });

  it('leaves a result under the cap whole', async () => {
    const small = {
      ...jsonStat({ time: ['2023', '2024'], geo: ['DE'] }),
      value: { '0': 1, '1': 2 },
    };
    fetchMock.mockResolvedValue(okResponse(small));
    const res = await query();
    expect(res.observations).toHaveLength(2);
    expect(res.obsCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// queryDataset — the dataframe row source (#8)
// ---------------------------------------------------------------------------

describe('EurostatDataService — dataframe row source (#8)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const PERIODS = Array.from({ length: 60 }, (_, i) => String(2000 + i));
  const GEOS = Array.from({ length: 100 }, (_, i) => `G${i}`);

  /** 6,000 populated cells — 1,000 past OBS_CAP — with one flagged and one missing cell. */
  const oversized = () => {
    const value: Record<string, number | null> = {};
    for (let i = 0; i < PERIODS.length * GEOS.length; i++) value[String(i)] = i;
    value['10'] = null;
    return {
      ...jsonStat({ time: PERIODS, geo: GEOS }),
      value,
      status: { '3': 'p' },
      extension: { status: { label: { p: 'provisional' } } },
    };
  };

  const query = () =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'nama_10_gdp',
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      'EN',
      OBS_CAP,
      createMockContext(),
    );

  it('flattens each dimension into a code column and a label column', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        ...jsonStat({ geo: ['DE'], time: ['2023'] }),
        value: { '0': 4_000_000 },
        status: { '0': 'p' },
        extension: { status: { label: { p: 'provisional' } } },
      }),
    );
    const res = await query();
    const rows = [...res.rows()];
    expect(rows).toEqual([
      {
        geo: 'DE',
        geo_label: 'DE',
        time: '2023',
        time_label: '2023',
        obs_value: 4_000_000,
        obs_flag: 'p',
        obs_flag_label: 'provisional',
        conf_status: null,
        conf_status_label: null,
      },
    ]);
    // Every column is a scalar — a nested {code,label} object cannot be a dataframe column.
    for (const cell of Object.values(rows[0] ?? {})) {
      expect(typeof cell === 'object' && cell !== null).toBe(false);
    }
  });

  it('carries a missing value and an absent flag as nulls, not as omitted keys', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ...jsonStat({ geo: ['IT'], time: ['2023'] }), value: { '0': null } }),
    );
    const [row] = [...(await query()).rows()];
    expect(row).toMatchObject({ obs_value: null, obs_flag: null, obs_flag_label: null });
    // Declared columns must be present on every row, or the canvas appender sees a ragged table.
    expect(Object.keys(row ?? {})).toEqual(
      observationRowSchema(['geo', 'time']).map((c) => c.name),
    );
  });

  it('fills a dimension the observation does not carry with nulls, not a missing column', () => {
    // Every row must present the full declared column set. A row short of a column makes the
    // table ragged, and the value that lands in the gap is whatever the appender puts there.
    const row = toObservationRow(
      { dimensions: { geo: { code: 'DE', label: 'Germany' } }, value: 7 },
      ['geo', 'time'],
    );
    expect(row).toEqual({
      geo: 'DE',
      geo_label: 'Germany',
      time: null,
      time_label: null,
      obs_value: 7,
      obs_flag: null,
      obs_flag_label: null,
      conf_status: null,
      conf_status_label: null,
    });
  });

  it('reaches every matched cell, including the ones past the inline cap', async () => {
    fetchMock.mockResolvedValue(okResponse(oversized()));
    const res = await query();
    let count = 0;
    let last: ObservationRow | undefined;
    for (const row of res.rows()) {
      count++;
      last = row;
    }
    expect(res.observations).toHaveLength(OBS_CAP);
    expect(count).toBe(res.obsCount);
    expect(count).toBe(6000);
    // The period the capped observation list never reaches.
    expect(last?.time).toBe('2059');
  });

  it('yields rows the inline observations agree with, cell for cell', async () => {
    // The preview and the staged table are the same walk, so the capped observation list is a
    // prefix of the row source. A row source derived separately could drift from it silently.
    fetchMock.mockResolvedValue(okResponse(oversized()));
    const res = await query();
    const iter = res.rows();
    for (const obs of res.observations) {
      const row = iter.next().value as ObservationRow;
      expect(row).toEqual(toObservationRow(obs, res.dimensionsUsed));
    }
    // …and there is more past the prefix.
    expect(iter.next().done).toBe(false);
  });

  it('decodes on demand rather than building the whole match up front', async () => {
    /**
     * Instrumentation, not a stub: the spy delegates to the real generator and only counts
     * what it yields. A `rows()` that materialized its source — `[...this.iterate…]` — would
     * drive the count to the full 6,000 before the caller pulled its first row, which is the
     * million-object allocation the inline cap exists to avoid.
     */
    const proto = EurostatDataService.prototype as unknown as {
      iterateObservations(data: JsonStatResponse): Generator<Observation>;
    };
    const real = proto.iterateObservations;
    let yielded = 0;
    vi.spyOn(proto, 'iterateObservations').mockImplementation(function* (
      this: typeof proto,
      data: JsonStatResponse,
    ) {
      for (const obs of real.call(this, data)) {
        yielded++;
        yield obs;
      }
    });

    fetchMock.mockResolvedValue(okResponse(oversized()));
    const res = await query();

    // The capped decode is itself demand-driven: it stops at the cap, not at cell 6,000.
    expect(yielded).toBe(OBS_CAP);

    const before = yielded;
    const iter = res.rows();
    iter.next();
    iter.next();
    iter.next();
    expect(yielded - before).toBe(3);
    iter.return(undefined);
  });
});

// ---------------------------------------------------------------------------
// queryDataset — the no-results guard (#36)
// ---------------------------------------------------------------------------

/**
 * Verbatim Statistics API responses for `sts_inpr_m` filtered to indic_bt=PRD, nace_r2=B,
 * s_adj=CA, unit=I21, geo=IE: one over 2023-01…2023-06, where Eurostat withholds every
 * cell, and one over 1975-01…1975-06, which predates this series (it starts 1980-01).
 * They differ in exactly the way the guard has to tell apart — the confidential slice
 * sends six `status` entries against an empty `value`, the empty one carries no `status`
 * key at all — and both are captured rather than written by hand, because the `value: {}`
 * that makes this bug possible is the detail a hand-built body would not think to include.
 */
const fixture = (name: string): JsonStatResponse =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as JsonStatResponse;

describe('EurostatDataService — no-results guard (#36)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const query = () =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'sts_inpr_m',
      { indic_bt: ['PRD'], nace_r2: ['B'], s_adj: ['CA'], unit: ['I21'], geo: ['IE'] },
      undefined,
      '2023-01',
      '2023-06',
      undefined,
      'EN',
      50,
      createMockContext(),
    );

  it('returns the observations of a slice whose every cell is confidential', async () => {
    fetchMock.mockResolvedValue(okResponse(fixture('sts-inpr-m-ie-confidential')));
    const res = await query();

    expect(res.obsCount).toBe(6);
    expect(res.missingObsCount).toBe(6);
    expect(res.observations).toHaveLength(6);
    expect(res.timeRange).toEqual({ start: '2023-01', end: '2023-06' });
    for (const obs of res.observations) {
      expect(obs.value).toBeNull();
      expect(obs.confStatus).toEqual({ code: 'C', label: 'confidential' });
      expect(obs.status).toBeUndefined();
      expect(obs.dimensions.geo).toEqual({ code: 'IE', label: 'Ireland' });
    }
    expect(res.observations.map((o) => o.dimensions.time?.code)).toEqual([
      '2023-01',
      '2023-02',
      '2023-03',
      '2023-04',
      '2023-05',
      '2023-06',
    ]);
  });

  it('stages the same six cells as dataframe rows', async () => {
    fetchMock.mockResolvedValue(okResponse(fixture('sts-inpr-m-ie-confidential')));
    const rows = [...(await query()).rows()];
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      geo: 'IE',
      time: '2023-01',
      obs_value: null,
      obs_flag: null,
      conf_status: 'C',
      conf_status_label: 'confidential',
    });
  });

  it('still rejects a slice that matched no cell at all', async () => {
    // The 1975 range predates this series: Eurostat answers 200 with no error, an empty
    // `value` and no `status` map. Nothing was withheld here — there is nothing to return.
    fetchMock.mockResolvedValue(okResponse(fixture('sts-inpr-m-ie-empty')));
    await expect(
      new EurostatDataService(mockConfig, mockStorage).queryDataset(
        'sts_inpr_m',
        { indic_bt: ['PRD'], nace_r2: ['B'], s_adj: ['CA'], unit: ['I21'], geo: ['IE'] },
        undefined,
        '1975-01',
        '1975-06',
        undefined,
        'EN',
        50,
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results', datasetCode: 'sts_inpr_m' },
    });
  });
});

// ---------------------------------------------------------------------------
// fetchJson — live error classification (fetch-stubbed, exercises the catch-block choke point)
// ---------------------------------------------------------------------------

describe('EurostatDataService — fetchJson error classification', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const query = (dataset: string, filters: Record<string, string[]>) =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      dataset,
      filters,
      undefined,
      undefined,
      undefined,
      1,
      'EN',
      50,
      createMockContext(),
    );

  it('maps a live HTTP 400 (Eurostat id 150) to invalid_dimension with the ValidationError code', async () => {
    // The full live path: fetchWithTimeout throws a FetchHttpError McpError for the 400 BEFORE
    // the body is parsed — the fix re-parses the captured body and classifies it.
    fetchMock.mockResolvedValue(
      errorResponse(
        400,
        '{ "error": [{"status": 400,"id": 150,"label": "INVALID_QUERY_DIMENSION: Dimension \\"ZZZZ\\" is not defined"}]}',
      ),
    );
    await expect(query('nama_10_gdp', { zzzz: ['x'] })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_dimension' },
    });
    // ValidationError is non-transient — no retry storm.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a live HTTP 404 (Eurostat id 100) to not_found via the same choke point', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(
        404,
        '{ "error": [{"status": 404,"id": 100,"label": "ERR_NOT_FOUND_4: XYZ is not available for dissemination."}]}',
      ),
    );
    await expect(query('XYZ', {})).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('maps HTTP-200 id 100 to no_results without claiming the dataset is absent (#37)', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ error: [{ status: 200, id: 100, label: 'NO_RESULTS' }] }),
    );
    await expect(query('nama_10_gdp', { geo: ['ZZ'] })).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
      message: expect.not.stringContaining('Dataset not found'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes a live HTTP 413 error array before retry and makes one attempt (#44)', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(
        413,
        '{ "error": [{"status": 413,"id": 413,"label": "ASYNCHRONOUS_RESPONSE"}]}',
      ),
    );
    await expect(query('nama_10_gdp', {})).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'async_response', retryable: false },
      message: expect.not.stringContaining('failed after 4 attempts'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows the raw HTTP error when a truncated error body is not valid JSON', async () => {
    // Bodies over the 500-byte cap arrive truncated and fail JSON.parse — must degrade, not crash.
    fetchMock.mockResolvedValue(errorResponse(400, `${'x'.repeat(600)}…`));
    await expect(query('nama_10_gdp', { zzzz: ['x'] })).rejects.toMatchObject({
      data: { errorSource: 'FetchHttpError' },
    });
  });
});

// ---------------------------------------------------------------------------
// An unavailable Statistics API — the observation fetch behind queryDataset (#71)
// ---------------------------------------------------------------------------

describe('EurostatDataService — an unavailable Statistics API (#71)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const query = (ctx = createMockContext()) =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'nama_10_gdp',
      { geo: ['DE'] },
      undefined,
      undefined,
      undefined,
      1,
      'EN',
      50,
      ctx,
    );
  const answering = (status: number, body: string, statusText = 'Service Unavailable') =>
    new Response(body, { status, statusText });

  /** Settle past the 1 s / 2 s / 4 s backoff (plus jitter) without waiting it out. */
  async function settle<T>(run: Promise<T>): Promise<T | McpError> {
    const outcome = run.then(
      (value) => value,
      (error: unknown) => error as McpError,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    return outcome;
  }

  it('fails as a retryable upstream_fault once every attempt answered a plain-text 503', async () => {
    fetchMock.mockImplementation(async () => answering(503, 'Service Unavailable'));
    const err = (await settle(query())) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'upstream_fault',
      retryable: true,
      status: 503,
      datasetCode: 'nama_10_gdp',
    });
    expect(err.message).toContain('Statistics API');
    expect(err.message).toContain('HTTP 503');
    expect(err.message).toContain('"nama_10_gdp"');
    expect(err.message).toContain('failed after 4 attempts');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['an HTML 502 page', 502, '<!DOCTYPE html><html><body>Bad Gateway</body></html>'],
    ['a 504 gateway timeout', 504, 'Gateway Timeout'],
    [
      'a 500 whose JSON error body names no failure this server models',
      500,
      '{"error":[{"status":500,"id":0,"label":"Internal error"}]}',
    ],
  ])('classifies %s on every attempt the same way', async (_label, status, body) => {
    fetchMock.mockImplementation(async () => answering(status, body, 'Upstream Error'));
    const err = (await settle(query())) as McpError;
    expect(err.data).toMatchObject({ reason: 'upstream_fault', retryable: true, status });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('classifies a host that cannot be reached on any attempt as a retryable upstream_fault', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const err = (await settle(query())) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
    expect(err.message).toContain('could not be reached');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('marks a 501 not retryable, on one attempt', async () => {
    fetchMock.mockImplementation(async () => answering(501, 'Not Implemented', 'Not Implemented'));
    const err = (await settle(query())) as McpError;
    expect(err.data).toMatchObject({ reason: 'upstream_fault', retryable: false, status: 501 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers when the API recovers inside the retry budget', async () => {
    fetchMock
      .mockImplementationOnce(async () => answering(503, 'Service Unavailable'))
      .mockImplementationOnce(async () => answering(503, 'Service Unavailable'))
      .mockImplementation(async () =>
        okResponse(
          buildJsonStat([{ code: 'DE', label: 'Germany' }], [{ code: '2024', label: '2024' }], {
            0: 4305.3,
          }),
        ),
      );
    const result = (await settle(query())) as Awaited<ReturnType<typeof query>>;
    expect(result.obsCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps a modeled refusal on a 5xx body as that refusal, on one attempt', async () => {
    // A body naming a failure this server models wins over the HTTP status it arrived on.
    fetchMock.mockImplementation(async () =>
      answering(
        500,
        '{"error":[{"status":400,"id":150,"label":"INVALID_QUERY_DIMENSION: Dimension \\"ZZZZ\\" is not defined"}]}',
      ),
    );
    const err = (await settle(query())) as McpError;
    expect(err.data).toMatchObject({ reason: 'invalid_dimension' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves an HTML page answered on HTTP 200 reasonless, after the retries (characterization)', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('<!DOCTYPE html><html><body>Maintenance</body></html>', { status: 200 }),
    );
    const err = (await settle(query())) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('returned HTML instead of JSON');
    expect((err.data as { reason?: string; retryable?: boolean } | undefined)?.reason).toBe(
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('leaves a cancelled query that saw a 503 as the caller’s outcome, not an outage (characterization)', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      return answering(503, 'Service Unavailable');
    });
    const err = (await settle(query(createMockContext({ signal: controller.signal })))) as McpError;
    expect((err.data as { reason?: string } | undefined)?.reason).not.toBe('upstream_fault');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Period rejections — Eurostat's own refusals of a period literal (#47)
// ---------------------------------------------------------------------------

describe('EurostatDataService — operation deadlines (#72)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const routes = ['statistics', 'structure'] as const;
  const read = (route: (typeof routes)[number], signal?: AbortSignal) => {
    const service = new EurostatDataService(mockConfig, mockStorage);
    const ctx = createMockContext(signal ? { signal } : {});
    return route === 'statistics'
      ? service.queryDataset('nama_10_gdp', {}, undefined, undefined, undefined, 1, 'EN', 50, ctx)
      : service.getDimensionOrder('earn_ses_annual', ctx);
  };
  const success = (route: (typeof routes)[number]) =>
    route === 'statistics'
      ? Response.json(
          buildJsonStat([{ code: 'DE', label: 'Germany' }], [{ code: '2024', label: '2024' }], {
            0: 42,
          }),
        )
      : new Response(sdmxDataStructureXml());

  it.each(routes)('expires during the initial %s request without retrying', async (route) => {
    vi.useFakeTimers();
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init);
        requests.push(request);
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          }),
        );
      }),
    );
    const outcome = read(route).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await outcome).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 30_000 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  it.each(routes.flatMap((route) => [false, true].map((retryAfter) => ({ route, retryAfter }))))(
    'expires during $route backoff (Retry-After=$retryAfter)',
    async ({ route, retryAfter }) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const fetchMock = vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, retryAfter ? 28_000 : 29_000));
        return new Response('Unavailable', {
          status: retryAfter ? 429 : 503,
          headers: retryAfter ? { 'Retry-After': '2' } : {},
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const outcome = read(route).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await outcome).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(routes)('rescues a %s 429 before the shared deadline', async (route) => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Limited', { status: 429, headers: { 'Retry-After': '1' } }),
      )
      .mockImplementationOnce(async () => success(route));
    vi.stubGlobal('fetch', fetchMock);
    const outcome = read(route);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await outcome).toMatchObject(
      route === 'structure' ? EARN_SES_ANNUAL_DIMENSIONS : { obsCount: 1 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a cancelled metadata waiter leave while the detached 120-second dataflow load expires', async () => {
    vi.useFakeTimers();
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init);
        requests.push(request);
        if (request.url.includes('/contentconstraint/')) return new Response(SDMX_CONSTRAINT_XML);
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                { once: true },
              );
            },
          }),
        );
      }),
    );
    const service = new EurostatDataService(mockConfig, mockStorage);
    const controller = new AbortController();
    const cancelled = service
      .getDatasetInfo('nama_10_gdp', createMockContext({ signal: controller.signal }))
      .catch((error: unknown) => error);
    let settled = false;
    const shared = service
      .getDatasetInfo('nama_10_gdp', createMockContext())
      .catch((error: unknown) => error)
      .then((value) => {
        settled = true;
        return value;
      });
    controller.abort();
    expect(await cancelled).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);
    expect(requests.find((request) => request.url.includes('/dataflow/'))?.signal.aborted).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await shared).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 120_000 },
    });
    expect(requests).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a retry and its body by the original 30-second allowance', async () => {
    vi.useFakeTimers();
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      if (requests.length === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
        return new Response('Unavailable', { status: 503 });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            request.signal.addEventListener(
              'abort',
              () => controller.error(request.signal.reason),
              { once: true },
            );
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    let outcome: unknown;
    const run = new EurostatDataService(mockConfig, mockStorage)
      .queryDataset(
        'nama_10_gdp',
        {},
        undefined,
        undefined,
        undefined,
        1,
        'EN',
        50,
        createMockContext(),
      )
      .then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
    await vi.advanceTimersByTimeAsync(30_001);
    const atDeadline = outcome;
    await vi.advanceTimersByTimeAsync(150_000);
    await run;
    expect(atDeadline).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 30_000 },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.signal.aborted).toBe(true);
  });
});

describe("EurostatDataService — Eurostat's period rejections map to invalid_period (#47)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const query = (sinceP?: string, untilP?: string) =>
    new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'une_rt_m',
      { geo: ['DE'] },
      undefined,
      sinceP,
      untilP,
      undefined,
      'EN',
      50,
      createMockContext(),
    );

  for (const [label, body, sinceP, untilP] of [
    [
      "a 400 naming 'sinceTimePeriod'",
      '{"error":[{"status":400,"id":400,"label":"Invalid value for \'sinceTimePeriod\' parameter."}]}',
      '2020-13',
      undefined,
    ],
    [
      "a 400 naming 'untilTimePeriod'",
      '{"error":[{"status":400,"id":400,"label":"Invalid value for \'untilTimePeriod\' parameter."}]}',
      undefined,
      '2020-Q9',
    ],
    [
      'a 400 carrying error id 140',
      '{"error":[{"status":400,"id":140,"label":"TIME_PERIOD_FILTER_SPEC_INVALID: Impossible to apply time dimension filtering"}]}',
      '2020-1',
      undefined,
    ],
  ] as const) {
    it(`maps ${label} to invalid_period with the ValidationError code, in one attempt`, async () => {
      fetchMock.mockResolvedValue(errorResponse(400, body));
      await expect(query(sinceP, untilP)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_period' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it('still maps a 400 that is about something else to conflicting_params', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(
        400,
        '{"error":[{"status":400,"id":400,"label":"Invalid value for \'lang\' parameter."}]}',
      ),
    );
    await expect(query()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'conflicting_params' },
    });
  });

  for (const param of ['sinceTimePeriod', 'untilTimePeriod']) {
    it(`maps Eurostat's "cannot be set at the same time" refusal naming '${param}' to conflicting_params (#70)`, async () => {
      // Two time-dimension filters reach Eurostat untouched; its refusal names the
      // period parameters too, which is not a malformed period.
      fetchMock.mockResolvedValue(
        errorResponse(
          400,
          JSON.stringify({
            error: [
              {
                status: 400,
                id: 400,
                label: `'TIME' parameter, 'TIME_PERIOD' parameter, 'lastTimePeriod' parameter and '${param}' parameter cannot be set at the same time. Please choose one or the other.`,
              },
            ],
          }),
        ),
      );
      const err = (await new EurostatDataService(mockConfig, mockStorage)
        .queryDataset(
          'nama_10_gdp',
          { time: ['2020'], time_period: ['2021'] },
          undefined,
          undefined,
          undefined,
          undefined,
          'EN',
          50,
          createMockContext(),
        )
        .catch((e) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'conflicting_params' });
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toMatch(/one time selection/);
      expect(hint).not.toContain('geo_level');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("leaves Eurostat's geo/geoLevel refusal to the generic conflicting_params, without the time hint", async () => {
    // The same "cannot be set at the same time" wording, about geography rather than time.
    fetchMock.mockResolvedValue(
      errorResponse(
        400,
        JSON.stringify({
          error: [
            {
              status: 400,
              id: 400,
              label:
                "'geo' parameter and 'geoLevel' parameter cannot be set at the same time. Please choose one or the other.",
            },
          ],
        }),
      ),
    );
    const err = (await query().catch((e) => e)) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'conflicting_params' });
    // No service hint: the tool's generic conflicting_params recovery applies.
    expect((err.data as { recovery?: unknown }).recovery).toBeUndefined();
    expect(err.message).toContain("'geo' parameter and 'geoLevel' parameter");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps id 150 as invalid_dimension ahead of the period check', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(
        400,
        '{"error":[{"status":400,"id":150,"label":"INVALID_QUERY_DIMENSION: Dimension \\"ZZZZ\\" is not defined"}]}',
      ),
    );
    await expect(query('2020')).rejects.toMatchObject({ data: { reason: 'invalid_dimension' } });
  });
});

// ---------------------------------------------------------------------------
// Sent filter values against the reply's category index (#48, #52)
// ---------------------------------------------------------------------------

describe('findUnmatchedValues', () => {
  const reply = (index: Record<string, Record<string, number>>): JsonStatResponse => ({
    id: Object.keys(index),
    size: Object.values(index).map((codes) => Object.keys(codes).length),
    dimension: Object.fromEntries(
      Object.entries(index).map(([dim, codes]) => [dim, { category: { index: codes } }]),
    ),
  });

  it('returns nothing when every sent value is in the index', () => {
    expect(findUnmatchedValues({ geo: ['DE', 'FR'] }, reply({ geo: { DE: 0, FR: 1 } }))).toBe(
      undefined,
    );
  });

  it('names a value dropped beside a matched one, which leaves size at 1', () => {
    expect(findUnmatchedValues({ geo: ['DE', 'XX'] }, reply({ geo: { DE: 0 } }))).toEqual({
      geo: ['XX'],
    });
  });

  it('compares case-insensitively and reports values as sent', () => {
    expect(findUnmatchedValues({ geo: ['de', 'xx'] }, reply({ geo: { DE: 0 } }))).toEqual({
      geo: ['xx'],
    });
  });

  it('lists every dimension that dropped a value, in the order sent', () => {
    expect(
      findUnmatchedValues(
        { age: ['TOTAL', 'ZZZ'], geo: ['XX'], unit: ['PC_ACT'] },
        reply({ age: { TOTAL: 0 }, geo: {}, unit: { PC_ACT: 0 } }),
      ),
    ).toEqual({ age: ['ZZZ'], geo: ['XX'] });
  });

  it('reports a repeated unmatched value once', () => {
    expect(findUnmatchedValues({ geo: ['XX', 'XX'] }, reply({ geo: {} }))).toEqual({
      geo: ['XX'],
    });
  });

  it('does not guess about a filtered dimension the reply does not describe', () => {
    expect(findUnmatchedValues({ geo: ['XX'] }, reply({ unit: { PC_ACT: 0 } }))).toBeUndefined();
  });

  it('matches an upper-case filter key to its dimension and reports it under the key as sent (#54)', () => {
    expect(findUnmatchedValues({ GEO: ['DE', 'XX'] }, reply({ geo: { DE: 0 } }))).toEqual({
      GEO: ['XX'],
    });
    expect(findUnmatchedValues({ Geo: ['de'] }, reply({ geo: { DE: 0 } }))).toBeUndefined();
  });
});

describe('EurostatDataService — no_results diagnosis from the envelope (#48)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const DE = { unit: ['PC_ACT'], s_adj: ['SA'], age: ['TOTAL'], sex: ['T'] };

  const emptyMatch = async (
    name: string,
    filters: Record<string, string[]>,
    period: { lastN?: number; sinceP?: string; untilP?: string } = {},
  ): Promise<Record<string, unknown>> => {
    fetchMock.mockResolvedValueOnce(okResponse(fixture(name)));
    const err = await new EurostatDataService(mockConfig, mockStorage)
      .queryDataset(
        'une_rt_m',
        filters,
        undefined,
        period.sinceP,
        period.untilP,
        period.lastN,
        'EN',
        50,
        createMockContext(),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'no_results' } });
    return (err as McpError).data as Record<string, unknown>;
  };

  it('names the unmatched value when it is the only one sent (size 0)', async () => {
    const data = await emptyMatch('une-rt-m-geo-xx-last1', { geo: ['XX'] }, { lastN: 1 });
    expect(data.unmatchedValues).toEqual({ geo: ['XX'] });
    expect(data).not.toHaveProperty('matchedPeriods');
    expect(data).not.toHaveProperty('outsideCoverage');
  });

  it('names an unmatched value beside a matched one, plus the valueless periods', async () => {
    const data = await emptyMatch(
      'une-rt-m-geo-de-xx-last1',
      { geo: ['DE', 'XX'], ...DE },
      { lastN: 1 },
    );
    expect(data.unmatchedValues).toEqual({ geo: ['XX'] });
    expect(data.matchedPeriods).toEqual(['2026-08']);
  });

  it('lists two unmatched dimensions', async () => {
    const data = await emptyMatch(
      'une-rt-m-geo-xx-age-zzz-last1',
      { geo: ['XX'], age: ['ZZZ'] },
      { lastN: 1 },
    );
    expect(data.unmatchedValues).toEqual({ geo: ['XX'], age: ['ZZZ'] });
  });

  it('diagnoses an unmatched non-geo code the same way', async () => {
    const data = await emptyMatch(
      'une-rt-m-unit-fake-last1',
      { geo: ['DE'], unit: ['QQQ_FAKE'] },
      { lastN: 1 },
    );
    expect(data.unmatchedValues).toEqual({ unit: ['QQQ_FAKE'] });
  });

  it('does not report a lowercase valid code as unmatched', async () => {
    const data = await emptyMatch(
      'une-rt-m-geo-de-lower-last1',
      { geo: ['de'], ...DE },
      { lastN: 1 },
    );
    expect(data).not.toHaveProperty('unmatchedValues');
    expect(data.matchedPeriods).toEqual(['2026-08']);
  });

  it('reports a period range outside coverage with the dataset-wide bounds', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(fixture('nama-10-gdp-de-since-2030')));
    const err = await new EurostatDataService(mockConfig, mockStorage)
      .queryDataset(
        'nama_10_gdp',
        { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE'] },
        undefined,
        '2030',
        undefined,
        undefined,
        'EN',
        50,
        createMockContext(),
      )
      .catch((e: unknown) => e);
    expect((err as McpError).data).toMatchObject({
      reason: 'no_results',
      outsideCoverage: { oldest: '1975', latest: '2025' },
    });
    expect((err as McpError).data).not.toHaveProperty('matchedPeriods');
    expect((err as McpError).data).not.toHaveProperty('unmatchedValues');
  });

  it('lists the matched periods of a past range that carries no value for the slice', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(fixture('nama-10-gdp-de-until-1980')));
    const err = await new EurostatDataService(mockConfig, mockStorage)
      .queryDataset(
        'nama_10_gdp',
        { unit: ['CP_MEUR'], na_item: ['B1GQ'], geo: ['DE'] },
        undefined,
        undefined,
        '1980',
        undefined,
        'EN',
        50,
        createMockContext(),
      )
      .catch((e: unknown) => e);
    expect((err as McpError).data).toMatchObject({
      matchedPeriods: ['1975', '1976', '1977', '1978', '1979', '1980'],
    });
  });

  it('still returns the six observations of the all-confidential slice (#36)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(fixture('sts-inpr-m-ie-confidential')));
    const res = await new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'sts_inpr_m',
      { indic_bt: ['PRD'], nace_r2: ['B'], s_adj: ['CA'], unit: ['I21'], geo: ['IE'] },
      undefined,
      '2023-01',
      '2023-06',
      undefined,
      'EN',
      50,
      createMockContext(),
    );
    expect(res.obsCount).toBe(6);
    expect(res).not.toHaveProperty('unmatchedValues');
  });
});

describe('EurostatDataService — unmatched filter values on a successful query (#52)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(unmockedFetch);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (name: string, filters: Record<string, string[]>, sinceP: string) => {
    fetchMock.mockResolvedValueOnce(okResponse(fixture(name)));
    return new EurostatDataService(mockConfig, mockStorage).queryDataset(
      'une_rt_m',
      filters,
      undefined,
      sinceP,
      undefined,
      undefined,
      'EN',
      50,
      createMockContext(),
    );
  };

  it('returns the matched observations and names the dropped value', async () => {
    const res = await run(
      'une-rt-m-geo-de-xx-since-2024-01',
      { geo: ['DE', 'XX'], unit: ['PC_ACT'], s_adj: ['SA'], age: ['TOTAL'], sex: ['T'] },
      '2024-01',
    );
    expect(res.obsCount).toBe(31);
    expect(res.unmatchedValues).toEqual({ geo: ['XX'] });
    expect(res.appliedFilters.geo).toEqual(['DE', 'XX']);
  });

  it('lists unmatched values in two dimensions', async () => {
    const res = await run(
      'une-rt-m-geo-de-xx-age-zzz-since-2026-01',
      {
        geo: ['DE', 'XX'],
        unit: ['PC_ACT'],
        s_adj: ['SA'],
        age: ['TOTAL', 'ZZZ'],
        sex: ['T'],
      },
      '2026-01',
    );
    expect(res.obsCount).toBe(7);
    expect(res.unmatchedValues).toEqual({ geo: ['XX'], age: ['ZZZ'] });
  });

  it('omits the field when every value matched, lowercase included', async () => {
    const res = await run(
      'une-rt-m-geo-de-lower-last3',
      { geo: ['de'], unit: ['PC_ACT'], s_adj: ['SA'], age: ['TOTAL'], sex: ['T'] },
      '2026-06',
    );
    expect(res.obsCount).toBe(2);
    expect(res).not.toHaveProperty('unmatchedValues');
  });
});
