/**
 * @fileoverview EurostatBulkService against both hosts (#46): DS-* routing, PRODCOM
 * text cells in the TSV, and SOAP fault 413 classified as a non-retryable
 * extraction_too_big on every host. Global fetch is stubbed rather than
 * fetchWithTimeout, so the non-2xx capture the fault classifier reads is real.
 * @module tests/services/eurostat-comext-bulk.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bulkRowSchema,
  classifyXmlBody,
  EurostatBulkService,
} from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import type { BulkRow } from '@/services/eurostat-bulk/types.js';
import {
  COMEXT_FULL_EXTRACTION_FAULT,
  COMEXT_HOST,
  comextFixture,
  MAIN_HOST,
  routeOf,
  tsv,
  xml,
} from '../helpers/comext-fixtures.js';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (input: unknown) => {
    throw new Error(`Unmocked fetch: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const svc = () => new EurostatBulkService({} as never, {} as never);

async function drain(
  code: string,
  order: string[] = [],
  filters: Record<string, string[]> = {},
  since?: string,
  until?: string,
) {
  const dl = await svc().startDownload(code, order, filters, since, until, createMockContext());
  const rows: BulkRow[] = [];
  for await (const row of dl.rows()) rows.push(row);
  return { dl, rows };
}

/** The TSV of `DS-045409` DE→US imports, monthly, June–July 2026, as recorded (first 3 series). */
const DS_045409_TSV = comextFixture('ds-045409-de-us-m-2026-06-07.tsv');
/** PRODCOM `DS-059358`, Germany, six products, 2022: `:C` and `KG` cells beside numbers. */
const DS_059358_TSV = comextFixture('ds-059358-de-2022.tsv');
const DS_ORDER = ['freq', 'reporter', 'partner', 'product', 'flow', 'indicators'];

describe('EurostatBulkService — DS-* routing (#46)', () => {
  for (const code of ['DS-045409', 'ds-045409']) {
    it(`requests "${code}" from the Comext host with its positional key`, async () => {
      fetchMock.mockImplementation(async () => tsv(DS_045409_TSV));
      const { dl, rows } = await drain(
        code,
        DS_ORDER,
        {
          freq: ['M'],
          reporter: ['DE'],
          partner: ['US'],
          flow: ['1'],
          indicators: ['VALUE_IN_EUROS'],
        },
        '2026-06',
        '2026-07',
      );
      const request = routeOf(fetchMock.mock.calls[0]?.[0]);
      expect(request).toMatchObject({ host: 'comext', route: 'data', code });
      expect(dl.url.startsWith(`${COMEXT_HOST}/sdmx/2.1/data/${code}/`)).toBe(true);
      expect(decodeURIComponent(request.url.pathname)).toMatch(/\/M\.DE\.US\.\.1\.VALUE_IN_EUROS$/);
      expect(rows).toHaveLength(6);
      expect(rows[0]).toMatchObject({ product: '01', time: '2026-06', obs_value: 1235161 });
    });
  }

  it('keeps a main-host download on the main host', async () => {
    fetchMock.mockImplementation(async () => tsv('freq,geo\\TIME_PERIOD\t2024 \r\nA,DE\t1.0 \r\n'));
    const { dl } = await drain('nama_10_gdp');
    expect(dl.url.startsWith(`${MAIN_HOST}/sdmx/2.1/data/nama_10_gdp?`)).toBe(true);
  });
});

describe('EurostatBulkService — PRODCOM text cells (#46)', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async () => tsv(DS_059358_TSV));
  });

  it('decodes ":C" to a null value with conf_status C', async () => {
    const { rows } = await drain('DS-059358');
    expect(rows.find((r) => r.product === '20143430' && r.indicators === 'PVALFLAG')).toMatchObject(
      {
        obs_value: null,
        obs_value_text: null,
        conf_status: 'C',
        conf_status_label: 'confidential',
      },
    );
  });

  it('keeps "KG" verbatim in obs_value_text', async () => {
    const { rows } = await drain('DS-059358');
    const units = rows.filter((r) => r.indicators === 'QNTUNIT');
    expect(units).toHaveLength(6);
    for (const unit of units) {
      expect(unit).toMatchObject({ obs_value: null, obs_value_text: 'KG', conf_status: null });
    }
  });

  it('counts the text cells as missing values and keeps the numbers numeric', async () => {
    const { dl, rows } = await drain('DS-059358');
    const textCells = DS_059358_TSV.split('\n').filter((l) => /\t(:C|KG)\s*$/.test(l)).length;
    expect(dl.stats.missingCount).toBe(textCells);
    expect(rows.find((r) => r.product === '20143430' && r.indicators === 'EXPVAL')).toMatchObject({
      obs_value: 32868973,
      obs_value_text: null,
    });
  });

  it('declares obs_value_text exactly where the rows carry it', async () => {
    const { dl, rows } = await drain('DS-059358');
    expect(dl.valueText).toBe(true);
    expect(bulkRowSchema(dl.header.dimensions, dl.valueText).map((c) => c.name)).toEqual(
      Object.keys(rows[0] as BulkRow),
    );
  });

  it('keeps a main-host row free of obs_value_text', async () => {
    fetchMock.mockImplementation(async () => tsv('freq,geo\\TIME_PERIOD\t2024 \r\nA,DE\t1.0 \r\n'));
    const { dl, rows } = await drain('nama_10_gdp');
    expect(rows[0]).not.toHaveProperty('obs_value_text');
    expect(bulkRowSchema(dl.header.dimensions).map((c) => c.name)).toEqual(
      Object.keys(rows[0] as BulkRow),
    );
  });

  it('reports no text column for a main-host download', async () => {
    fetchMock.mockImplementation(async () => tsv('freq,geo\\TIME_PERIOD\t2024 \r\nA,DE\t1.0 \r\n'));
    const { dl } = await drain('nama_10_gdp');
    expect(dl.valueText).toBe(false);
  });
});

describe('EurostatBulkService — fault 413 on every host (#46)', () => {
  /** The fault as the Comext host sent it for a filtered DS-045409 slice over the row limit. */
  const EXTRACTION_TOO_BIG = comextFixture('ds-045409-fault-413.xml');

  const cases: Array<[string, string, string]> = [
    ['a main-host dataset over the 5,000,000-row limit', 'migr_asyrescra', EXTRACTION_TOO_BIG],
    ['a Comext slice over the row limit', 'DS-045409', EXTRACTION_TOO_BIG],
    ['an unfiltered Comext collection', 'DS-059328', COMEXT_FULL_EXTRACTION_FAULT],
  ];

  for (const [label, code, body] of cases) {
    it(`classifies HTTP 413 fault 413 for ${label} as non-retryable extraction_too_big`, async () => {
      fetchMock.mockImplementation(async () => xml(body, 413));
      await expect(drain(code)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'extraction_too_big', faultcode: '413', retryable: false },
        message: expect.stringContaining('EXTRACTION_TOO_BIG'),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(routeOf(fetchMock.mock.calls[0]?.[0]).host).toBe(
        /^ds-/i.test(code) ? 'comext' : 'main',
      );
    });
  }

  it('classifies the fault body alone the same way', () => {
    expect(() => classifyXmlBody(EXTRACTION_TOO_BIG, 'migr_asyrescra')).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'extraction_too_big' }) }),
    );
  });

  it('reports DS-999999 as not_found from the Comext host', async () => {
    fetchMock.mockImplementation(async () => xml(comextFixture('ds-999999-data.xml'), 404));
    await expect(drain('DS-999999')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    expect(routeOf(fetchMock.mock.calls[0]?.[0]).host).toBe('comext');
  });
});
