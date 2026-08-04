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
  getEurostatDataService,
  initEurostatDataService,
  observationRowSchema,
  splitStatus,
  toObservationRow,
} from '@/services/eurostat-data/eurostat-data-service.js';
import {
  type JsonStatResponse,
  OBS_CAP,
  type ObservationRow,
} from '@/services/eurostat-data/types.js';

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

  it('omits the time value count when no full-range slice was supplied (#34)', () => {
    // The one-period slice reports a single period for `time` whatever the dataset covers.
    // With no slice to read the real range from, the count is omitted — not taken from here.
    const onePeriod: JsonStatResponse = {
      label: 'Dataset',
      id: ['geo', 'time'],
      size: [2, 1],
      dimension: {
        geo: { label: 'Geo', category: { index: { EU27_2020: 0, DE: 1 }, label: {} } },
        time: { label: 'Time', category: { index: { '2025': 0 }, label: { '2025': '2025' } } },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (svc as any).extractMetadata(onePeriod, 'xyz');
    const time = meta.dimensions.find((d: { code: string }) => d.code === 'time');
    expect(time.valuesCount).toBeUndefined();
    expect(time.sampleValues).toBeUndefined();
    expect('valuesCount' in time).toBe(false);
    // The pre-#21 defect this omission exists to avoid.
    expect(time.valuesCount).not.toBe(1);
    // The dimension is still listed, with its label, and every other dimension is intact.
    expect(time.label).toBe('Time');
    expect(meta.dimensions.find((d: { code: string }) => d.code === 'geo').valuesCount).toBe(2);
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

  it('keeps the metadata it retrieved when the time enumeration fails (#34)', async () => {
    const onePeriod = {
      ...jsonStat({ freq: ['A'], geo: ['EU27_2020', 'DE'], time: ['2025'] }),
      label: 'GDP and main components',
      extension: {
        annotation: [
          { type: 'OBS_COUNT', title: '1100000' },
          { type: 'OBS_PERIOD_OVERALL_OLDEST', title: '1975' },
          { type: 'OBS_PERIOD_OVERALL_LATEST', title: '2025' },
          { type: 'UPDATE_DATA', date: '2026-05-01T00:00:00Z' },
          { type: 'ESMS_HTML', href: 'https://example.org/nama_10_gdp_esms.htm' },
        ],
      },
    };
    // The primary slice succeeds; the pinned follow-up comes back as Eurostat's async warning.
    fetchMock.mockImplementation(async (input: string | URL) =>
      okResponse(
        new URL(String(input)).searchParams.get('lastTimePeriod') === '1'
          ? onePeriod
          : { warning: { status: 413, label: 'ASYNCHRONOUS_RESPONSE' } },
      ),
    );

    const meta = await svc().getDatasetInfo('nama_10_gdp', createMockContext());

    // Everything the first response carried survives — previously the whole call threw.
    expect(meta.label).toBe('GDP and main components');
    expect(meta.obsCount).toBe(1_100_000);
    expect(meta.timeRange).toEqual({ start: '1975', end: '2025' });
    expect(meta.lastUpdated).toBe('2026-05-01T00:00:00Z');
    expect(meta.metadataUrl).toBe('https://example.org/nama_10_gdp_esms.htm');
    expect(meta.dimensions.map((d) => d.code)).toEqual(['freq', 'geo', 'time']);
    expect(meta.dimensions.find((d) => d.code === 'geo')?.valuesCount).toBe(2);

    // Only the unmeasured dimension loses its count — and it is omitted, not reported as 1.
    const time = meta.dimensions.find((d) => d.code === 'time');
    expect(time?.valuesCount).toBeUndefined();
    expect(time?.sampleValues).toBeUndefined();
  });

  it('still fails when the primary metadata request fails (#34)', async () => {
    // The graceful path covers the secondary request only — a dataset that does not exist
    // must stay an error rather than resolve to a shell of a payload.
    fetchMock.mockResolvedValue(
      okResponse({ error: [{ status: 404, id: 100, label: 'ERR_NOT_FOUND_4' }] }),
    );
    await expect(
      svc().getDatasetInfo('nonexistent_xyz', createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
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
    fetchMock = vi.fn();
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
    fetchMock = vi.fn();
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
    const proto = EurostatDataService.prototype as unknown as Record<string, unknown>;
    const real = proto.iterateObservations as (data: JsonStatResponse) => Generator<unknown>;
    let yielded = 0;
    vi.spyOn(proto, 'iterateObservations' as never).mockImplementation(function* (
      this: EurostatDataService,
      data: JsonStatResponse,
    ) {
      for (const obs of real.call(this, data)) {
        yielded++;
        yield obs;
      }
    } as never);

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
    fetchMock = vi.fn();
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
