/**
 * @fileoverview Unit tests for EurostatDataService pure logic (JSON-stat decoding,
 * error classification, metadata extraction, query param building).
 * @module tests/services/eurostat-data-service.test
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('defaults obsCount to 0 when annotation is absent', () => {
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
    expect(meta.obsCount).toBe(0);
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
