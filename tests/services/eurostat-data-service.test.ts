/**
 * @fileoverview Unit tests for EurostatDataService pure logic (JSON-stat decoding,
 * error classification, metadata extraction, query param building).
 * @module tests/services/eurostat-data-service.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EurostatDataService,
  getEurostatDataService,
  initEurostatDataService,
} from '@/services/eurostat-data/eurostat-data-service.js';
import type { JsonStatResponse } from '@/services/eurostat-data/types.js';

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
    const obs = (svc as any).decodeObservations(data);
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
    const obs = (svc as any).decodeObservations(data);
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
    const obs = (svc as any).decodeObservations(data);
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
    const obs = (svc as any).decodeObservations(data);
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
    const obs = (svc as any).decodeObservations(data);
    expect(obs).toHaveLength(1);
    expect(obs[0].dimensions.geo.code).toBe('DE');
  });

  it('returns empty array when data has no id/size/dimension', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obs = (svc as any).decodeObservations({});
    expect(obs).toHaveLength(0);
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

  it('async_response error carries reason in data', () => {
    const data: JsonStatResponse = { warning: { status: 413, label: 'Too large' } };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com');
    } catch (err) {
      expect((err as McpError).data).toMatchObject({ reason: 'async_response' });
    }
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

  it('throws invalid_dimension on error id 150', () => {
    const data: JsonStatResponse = {
      error: [{ status: 400, id: 150, label: 'Invalid dimension' }],
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com');
    } catch (err) {
      expect((err as McpError).data).toMatchObject({ reason: 'invalid_dimension' });
    }
  });

  it('throws conflicting_params on 400 without id 150', () => {
    const data: JsonStatResponse = {
      error: [{ status: 400, id: 999, label: 'Bad request' }],
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com');
    } catch (err) {
      expect((err as McpError).data).toMatchObject({ reason: 'conflicting_params' });
    }
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

  it('does not throw when data has no errors or warnings', () => {
    const data: JsonStatResponse = { label: 'OK', id: ['geo'], size: [1], value: {} };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).checkResponseErrors(data, 'https://example.com'),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractMetadata
// ---------------------------------------------------------------------------

describe('EurostatDataService — extractMetadata', () => {
  let svc: EurostatDataService;

  beforeEach(() => {
    svc = new EurostatDataService(mockConfig, mockStorage);
  });

  it('extracts label, timeRange, obsCount, and metadataUrl from annotations', () => {
    const data: JsonStatResponse = {
      label: 'GDP and main components',
      id: ['unit', 'geo'],
      size: [2, 3],
      dimension: {
        unit: {
          label: 'Unit',
          category: {
            index: { CP_MEUR: 0, CLV10_MEUR: 1 },
            label: { CP_MEUR: 'Current prices', CLV10_MEUR: 'Chain volumes' },
          },
        },
        geo: {
          label: 'Geography',
          category: {
            index: { DE: 0, FR: 1, IT: 2 },
            label: { DE: 'Germany', FR: 'France', IT: 'Italy' },
          },
        },
      },
      extension: {
        annotation: [
          { type: 'OBS_COUNT', title: '1100000' },
          { type: 'OBS_PERIOD_OVERALL_OLDEST', title: '1975' },
          { type: 'OBS_PERIOD_OVERALL_LATEST', title: '2024' },
          { type: 'UPDATE_DATA', date: '2026-05-01T00:00:00Z' },
          {
            type: 'ESMS_HTML',
            href: 'https://ec.europa.eu/eurostat/cache/metadata/en/nama_10_gdp_esms.htm',
          },
        ],
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(data, 'nama_10_gdp');
    expect(meta.code).toBe('nama_10_gdp');
    expect(meta.label).toBe('GDP and main components');
    expect(meta.obsCount).toBe(1_100_000);
    expect(meta.timeRange.start).toBe('1975');
    expect(meta.timeRange.end).toBe('2024');
    expect(meta.lastUpdated).toBe('2026-05-01T00:00:00Z');
    expect(meta.metadataUrl).toBe(
      'https://ec.europa.eu/eurostat/cache/metadata/en/nama_10_gdp_esms.htm',
    );
  });

  it('omits metadataUrl when ESMS_HTML annotation is absent', () => {
    const data: JsonStatResponse = {
      label: 'Dataset',
      id: ['geo'],
      size: [1],
      dimension: {
        geo: { label: 'Geo', category: { index: { DE: 0 }, label: { DE: 'Germany' } } },
      },
      extension: {
        annotation: [
          { type: 'OBS_COUNT', title: '100' },
          { type: 'OBS_PERIOD_OVERALL_OLDEST', title: '2020' },
          { type: 'OBS_PERIOD_OVERALL_LATEST', title: '2024' },
          { type: 'UPDATE_DATA', date: '2025-01-01T00:00:00Z' },
        ],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(data, 'xyz');
    expect(meta.metadataUrl).toBeUndefined();
  });

  it('omits obsCount, timeRange bounds, and lastUpdated when their annotations are absent', () => {
    const data: JsonStatResponse = {
      label: 'Dataset',
      id: ['geo'],
      size: [1],
      dimension: {
        geo: { label: 'Geo', category: { index: { DE: 0 }, label: {} } },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(data, 'xyz');
    // Previously defaulted to 0 / '' / '', which a caller could not tell apart from a real
    // zero count or a known-empty period. Absent upstream metadata is now absent here too.
    expect(meta.obsCount).toBeUndefined();
    expect(meta.timeRange.start).toBeUndefined();
    expect(meta.timeRange.end).toBeUndefined();
    expect(meta.lastUpdated).toBeUndefined();
    expect('obsCount' in meta).toBe(false);
    expect('lastUpdated' in meta).toBe(false);
  });

  it('keeps a genuinely reported zero obsCount distinct from an absent one', () => {
    const data: JsonStatResponse = {
      label: 'Dataset',
      id: ['geo'],
      size: [1],
      dimension: { geo: { label: 'Geo', category: { index: { DE: 0 }, label: {} } } },
      extension: { annotation: [{ type: 'OBS_COUNT', title: '0' }] },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(data, 'xyz');
    expect(meta.obsCount).toBe(0);
  });

  it('omits obsCount when the annotation is present but unparseable', () => {
    const data: JsonStatResponse = {
      label: 'Dataset',
      id: ['geo'],
      size: [1],
      dimension: { geo: { label: 'Geo', category: { index: { DE: 0 }, label: {} } } },
      extension: { annotation: [{ type: 'OBS_COUNT', title: 'not-a-number' }] },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(data, 'xyz');
    expect(meta.obsCount).toBeUndefined();
  });

  it('carries one period bound when only the other annotation is absent', () => {
    const data: JsonStatResponse = {
      label: 'Dataset',
      id: ['geo'],
      size: [1],
      dimension: { geo: { label: 'Geo', category: { index: { DE: 0 }, label: {} } } },
      extension: { annotation: [{ type: 'OBS_PERIOD_OVERALL_OLDEST', title: '1975' }] },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(data, 'xyz');
    expect(meta.timeRange.start).toBe('1975');
    expect(meta.timeRange.end).toBeUndefined();
  });

  it('counts time from the full-range slice instead of the one-period slice', () => {
    // The lastTimePeriod=1 response every metadata call starts from: time truncated to one value.
    const onePeriod: JsonStatResponse = {
      label: 'Dataset',
      id: ['geo', 'time'],
      size: [2, 1],
      dimension: {
        geo: { label: 'Geo', category: { index: { EU27_2020: 0, DE: 1 }, label: {} } },
        time: { label: 'Time', category: { index: { '2025': 0 }, label: { '2025': '2025' } } },
      },
    };
    const fullRange: JsonStatResponse = {
      label: 'Dataset',
      id: ['geo', 'time'],
      size: [1, 3],
      dimension: {
        geo: { label: 'Geo', category: { index: { EU27_2020: 0 }, label: {} } },
        time: {
          label: 'Time',
          category: {
            index: { '2023': 0, '2024': 1, '2025': 2 },
            label: { '2023': '2023', '2024': '2024', '2025': '2025' },
          },
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(onePeriod, 'xyz', fullRange);
    const time = meta.dimensions.find((d: { code: string }) => d.code === 'time');
    expect(time.valuesCount).toBe(3);
    expect(time.sampleValues.map((v: { code: string }) => v.code)).toEqual([
      '2023',
      '2024',
      '2025',
    ]);
    // Every other dimension still comes from the one-period slice, which carries the full codelist.
    const geo = meta.dimensions.find((d: { code: string }) => d.code === 'geo');
    expect(geo.valuesCount).toBe(2);
  });

  it('samples at most 10 values per dimension', () => {
    const manyValues: Record<string, number> = {};
    const manyLabels: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      manyValues[`V${i}`] = i;
      manyLabels[`V${i}`] = `Value ${i}`;
    }
    const data: JsonStatResponse = {
      label: 'Dataset',
      id: ['unit'],
      size: [15],
      dimension: {
        unit: { label: 'Unit', category: { index: manyValues, label: manyLabels } },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(data, 'xyz');
    expect(meta.dimensions[0].valuesCount).toBe(15);
    expect(meta.dimensions[0].sampleValues).toHaveLength(10);
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
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'conflicting_params' } });
  });

  it('throws conflicting_params when lastN and sinceP are both provided', async () => {
    const svc = new EurostatDataService(mockConfig, mockStorage);
    const ctx = createMockContext();
    await expect(
      svc.queryDataset('nama_10_gdp', {}, undefined, '2020', undefined, 5, 'EN', ctx),
    ).rejects.toMatchObject({ data: { reason: 'conflicting_params' } });
  });

  it('throws conflicting_params when lastN and untilP are both provided', async () => {
    const svc = new EurostatDataService(mockConfig, mockStorage);
    const ctx = createMockContext();
    await expect(
      svc.queryDataset('nama_10_gdp', {}, undefined, undefined, '2024', 3, 'EN', ctx),
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

describe('EurostatDataService — getDimensionValues param building', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const svc = () => new EurostatDataService(mockConfig, mockStorage);
  const paramsOf = (callIndex: number): URLSearchParams =>
    new URL(String(fetchMock.mock.calls[callIndex]?.[0])).searchParams;

  it('geo without geo_level applies the documented geoLevel=country default', async () => {
    fetchMock.mockResolvedValue(okResponse(jsonStat({ geo: ['BE', 'BG', 'CZ'] })));
    const res = await svc().getDimensionValues(
      'nama_10_gdp',
      'geo',
      undefined,
      createMockContext(),
    );
    expect(res.totalCount).toBe(3);
    const p = paramsOf(0);
    expect(p.get('geoLevel')).toBe('country');
    expect(p.get('lastTimePeriod')).toBe('1');
  });

  it('geo with an explicit geo_level uses that value', async () => {
    fetchMock.mockResolvedValue(okResponse(jsonStat({ geo: ['EU27_2020', 'EA'] })));
    await svc().getDimensionValues('nama_10_gdp', 'geo', 'aggregate', createMockContext());
    expect(paramsOf(0).get('geoLevel')).toBe('aggregate');
  });

  it('a non-time categorical dimension uses a bounded lastTimePeriod=1 slice', async () => {
    fetchMock.mockResolvedValue(okResponse(jsonStat({ unit: ['CP_MEUR', 'CLV_I20'] })));
    const res = await svc().getDimensionValues(
      'nama_10_gdp',
      'unit',
      undefined,
      createMockContext(),
    );
    expect(res.totalCount).toBe(2);
    const p = paramsOf(0);
    expect(p.get('lastTimePeriod')).toBe('1');
    expect(p.has('geoLevel')).toBe(false);
  });

  it('time enumerates the full range by pinning other dims and leaving time unfiltered', async () => {
    const probe = jsonStat({
      freq: ['A'],
      unit: ['CP_MEUR', 'CLV_I20'],
      geo: ['EU27_2020', 'DE'],
      time: ['2025'],
    });
    const fullRange = jsonStat({
      freq: ['A'],
      unit: ['CP_MEUR'],
      geo: ['EU27_2020'],
      time: ['2020', '2021', '2022', '2023', '2024', '2025'],
    });
    // The probe carries lastTimePeriod=1; the bounded query carries the pinned dims.
    fetchMock.mockImplementation(async (input: string | URL) =>
      okResponse(
        new URL(String(input)).searchParams.get('lastTimePeriod') === '1' ? probe : fullRange,
      ),
    );
    const res = await svc().getDimensionValues(
      'nama_10_gdp',
      'time',
      undefined,
      createMockContext(),
    );
    // Full period range — not just the latest slice (the bug was totalCount=1, [2025]).
    expect(res.totalCount).toBe(6);
    expect(res.values[0]?.code).toBe('2020');
    expect(res.values.at(-1)?.code).toBe('2025');
    // The bounded (second) query pins every other dim to its first value and does NOT
    // restrict time — this is what removes the lastTimePeriod=1 truncation.
    const bounded = paramsOf(1);
    expect(bounded.has('lastTimePeriod')).toBe(false);
    expect(bounded.has('time')).toBe(false);
    expect(bounded.get('freq')).toBe('A');
    expect(bounded.get('unit')).toBe('CP_MEUR');
    expect(bounded.get('geo')).toBe('EU27_2020');
  });

  it('rejects geo_level paired with a non-geo dimension instead of ignoring it', async () => {
    fetchMock.mockResolvedValue(okResponse(jsonStat({ unit: ['CP_MEUR'] })));
    await expect(
      svc().getDimensionValues('nama_10_gdp', 'unit', 'nuts3', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'conflicting_params' } });
    // Rejected before any request — the parameter had no effect on the query it was sent with.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces async_response (non-retryable) when a dimension query matches too many rows', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ warning: { status: 413, label: 'ASYNCHRONOUS_RESPONSE' } }),
    );
    await expect(
      svc().getDimensionValues('nama_10_gdp', 'unit', undefined, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'async_response', retryable: false } });
    // retryable:false fails fast — no retry storm against an oversized query.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getDatasetInfo — time coverage (fetch-stubbed, exercises the two-request path)
// ---------------------------------------------------------------------------

describe('EurostatDataService — getDatasetInfo time coverage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const svc = () => new EurostatDataService(mockConfig, mockStorage);
  const paramsOf = (callIndex: number): URLSearchParams =>
    new URL(String(fetchMock.mock.calls[callIndex]?.[0])).searchParams;

  it('reports the dataset-wide period count for time, not the one-period slice', async () => {
    const onePeriod = jsonStat({
      freq: ['A'],
      geo: ['EU27_2020', 'DE'],
      time: ['2025'],
    });
    const fullRange = jsonStat({
      freq: ['A'],
      geo: ['EU27_2020'],
      time: ['2020', '2021', '2022', '2023', '2024', '2025'],
    });
    fetchMock.mockImplementation(async (input: string | URL) =>
      okResponse(
        new URL(String(input)).searchParams.get('lastTimePeriod') === '1' ? onePeriod : fullRange,
      ),
    );

    const meta = await svc().getDatasetInfo('nama_10_gdp', createMockContext());

    // What a caller reads: the real period count, not the 1 the metadata filter produced.
    const time = meta.dimensions.find((d) => d.code === 'time');
    expect(time?.valuesCount).toBe(6);
    expect(time?.sampleValues[0]?.code).toBe('2020');
    // Other dimensions still come from the cheap one-period slice.
    expect(meta.dimensions.find((d) => d.code === 'geo')?.valuesCount).toBe(2);

    // Exactly one extra round trip, bounded by pinning every other dimension.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bounded = paramsOf(1);
    expect(bounded.has('lastTimePeriod')).toBe(false);
    expect(bounded.has('time')).toBe(false);
    expect(bounded.get('freq')).toBe('A');
    expect(bounded.get('geo')).toBe('EU27_2020');
  });

  it('makes no second request for a dataset with no time dimension', async () => {
    fetchMock.mockResolvedValue(okResponse(jsonStat({ geo: ['DE', 'FR'] })));
    const meta = await svc().getDatasetInfo('xyz', createMockContext());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meta.dimensions.map((d) => d.code)).toEqual(['geo']);
  });
});

// ---------------------------------------------------------------------------
// queryDataset — filter normalization (fetch-stubbed)
// ---------------------------------------------------------------------------

describe('EurostatDataService — queryDataset filter normalization', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
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
      createMockContext(),
    );
    // geo: [] places no restriction, so it cannot conflict with geo_level.
    expect(paramsOf(0).get('geoLevel')).toBe('country');
    expect(paramsOf(0).has('geo')).toBe(false);
    expect(res.appliedFilters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// queryDataset — time coverage (fetch-stubbed)
// ---------------------------------------------------------------------------

describe('EurostatDataService — queryDataset time coverage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
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
});

// ---------------------------------------------------------------------------
// fetchJson — live error classification (fetch-stubbed, exercises the catch-block choke point)
// ---------------------------------------------------------------------------

describe('EurostatDataService — fetchJson error classification', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
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

  it('rethrows the raw HTTP error when a truncated error body is not valid JSON', async () => {
    // Bodies over the 500-byte cap arrive truncated and fail JSON.parse — must degrade, not crash.
    fetchMock.mockResolvedValue(errorResponse(400, `${'x'.repeat(600)}…`));
    await expect(query('nama_10_gdp', { zzzz: ['x'] })).rejects.toMatchObject({
      data: { errorSource: 'FetchHttpError' },
    });
  });
});
