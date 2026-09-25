/**
 * @fileoverview Tests for the eurostat_get_dimension_values tool.
 * @module tests/tools/eurostat-get-dimension-values.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatGetDimensionValues } from '@/mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import {
  SDMX_CONSTRAINT_WITHOUT_COUNTRIES_XML,
  SDMX_CONSTRAINT_XML,
  SDMX_DATAFLOW_XML,
} from '../fixtures/eurostat-sdmx-metadata.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

// Only the accessor is replaced, so a test can hand the tool the real service class.
vi.mock('@/services/eurostat-data/eurostat-data-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/eurostat-data/eurostat-data-service.js')>()),
  getEurostatDataService: vi.fn(),
}));

import {
  EurostatDataService,
  getEurostatDataService,
} from '@/services/eurostat-data/eurostat-data-service.js';

const mockUnitResult = {
  dimensionCode: 'unit',
  dimensionLabel: 'Unit of measure',
  values: [
    { code: 'CP_MEUR', label: 'Current prices, million euro' },
    { code: 'CLV10_MEUR', label: 'Chain linked volumes (2010), million euro' },
    { code: 'PPS_EU27_2020', label: 'Purchasing power standard (EU27_2020)' },
  ],
  totalCount: 3,
};

const mockGeoResult = {
  dimensionCode: 'geo',
  dimensionLabel: 'Geopolitical entity (reporting)',
  geoLevel: 'country' as const,
  values: [
    { code: 'DE', label: 'Germany' },
    { code: 'FR', label: 'France' },
    { code: 'IT', label: 'Italy' },
  ],
  totalCount: 3,
};

describe('eurostatGetDimensionValues', () => {
  beforeEach(() => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue(mockUnitResult),
    } as never);
  });

  it('returns dimension values for valid inputs', async () => {
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'unit',
    });
    const result = await eurostatGetDimensionValues.handler(input, ctx);
    expect(result.dimensionCode).toBe('unit');
    expect(result.values).toHaveLength(3);
    expect(result.totalCount).toBe(3);
    expect(result.values[0]?.code).toBe('CP_MEUR');
  });

  it('passes geo_level to service when provided', async () => {
    const mockGetDimValues = vi.fn().mockResolvedValue(mockGeoResult);
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: mockGetDimValues,
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'geo',
      geo_level: 'country',
    });
    await eurostatGetDimensionValues.handler(input, ctx);
    expect(mockGetDimValues).toHaveBeenCalledWith('nama_10_gdp', 'geo', 'country', ctx);
  });

  it('passes undefined geo_level when not provided', async () => {
    const mockGetDimValues = vi.fn().mockResolvedValue(mockUnitResult);
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: mockGetDimValues,
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'unit',
    });
    await eurostatGetDimensionValues.handler(input, ctx);
    expect(mockGetDimValues).toHaveBeenCalledWith('nama_10_gdp', 'unit', undefined, ctx);
  });

  it('throws not_found for invalid dataset or dimension code', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not found'), { data: { reason: 'not_found' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nonexistent_xyz',
      dimension: 'unit',
    });
    await expect(eurostatGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found', recovery: { hint: expect.stringContaining('nonexistent_xyz') } },
    });
  });

  it('surfaces conflicting_params when geo_level is sent with a non-geo dimension', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockRejectedValue(
        Object.assign(new Error('geo_level does not apply to "unit"'), {
          data: { reason: 'conflicting_params' },
        }),
      ),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'nama_10_gdp',
      dimension: 'unit',
      geo_level: 'nuts3',
    });
    // Previously this succeeded with geo_level silently ignored; the caller now hears about it.
    await expect(eurostatGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'conflicting_params',
        recovery: { hint: expect.stringContaining('unit') },
      },
    });
  });

  it('surfaces a level-specific no_results contract for an empty geo level (#38)', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockRejectedValue(
        Object.assign(new Error('No country values'), {
          data: { reason: 'no_results', geoLevel: 'country' },
        }),
      ),
    } as never);
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'tgs00010',
      dimension: 'geo',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_results',
          recovery: { hint: expect.stringContaining('country') },
        },
      },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('Recovery:') }),
    );
  });

  it('carries the effective geo level through structuredContent and content', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue(mockGeoResult),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
    const input = eurostatGetDimensionValues.input.parse({
      dataset_code: 'earn_ses_annual',
      dimension: 'geo',
    });
    const result = await eurostatGetDimensionValues.handler(input, ctx);
    expect(eurostatGetDimensionValues.output.parse(result).geoLevel).toBe('country');
    const text = eurostatGetDimensionValues.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('country');
  });

  it('formats output with all values', () => {
    const blocks = eurostatGetDimensionValues.format!(mockUnitResult);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('unit');
    expect(text).toContain('Unit of measure');
    expect(text).toContain('3');
    expect(text).toContain('CP_MEUR');
    expect(text).toContain('Current prices, million euro');
  });

  it('returns exactly the dimension, its values and their count on both surfaces', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue(mockGeoResult),
    } as never);
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'nama_10_gdp',
      dimension: 'geo',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(mockGeoResult);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('`DE` — Germany');
    expect(text).not.toMatch(/staged|canvas/i);
  });

  it('formats geo dimension values correctly', () => {
    const blocks = eurostatGetDimensionValues.format!(mockGeoResult);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('geo');
    expect(text).toContain('DE');
    expect(text).toContain('Germany');
    expect(text).toContain('FR');
  });
});

// ---------------------------------------------------------------------------
// Staging the code → label list on a canvas (#50) — real canvas, real data
// service over the recorded SDMX structure, so geo_level filtering is what runs.
// ---------------------------------------------------------------------------

/** Answers the dataflow and content-constraint requests from the recorded fixtures. */
async function sdmxFixtureFetch(input: unknown): Promise<Response> {
  const url = new URL(String(input));
  const datasetCode = url.pathname.split('/').at(-2)?.toUpperCase() ?? 'EARN_SES_ANNUAL';
  if (url.pathname.includes('/sdmx/2.1/dataflow/')) {
    return new Response(SDMX_DATAFLOW_XML.replaceAll('EARN_SES_ANNUAL', datasetCode), {
      status: 200,
    });
  }
  if (url.pathname.includes('/sdmx/2.1/contentconstraint/')) {
    return new Response(SDMX_CONSTRAINT_XML, { status: 200 });
  }
  throw new Error(`Unexpected URL: ${url}`);
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((block) => block.text ?? '').join('\n');

describe('eurostatGetDimensionValues — staging on a canvas (#50)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  const ctx = () => createMockContext({ tenantId: 'default' });

  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    setCanvas(canvas);
    vi.stubGlobal('fetch', vi.fn(sdmxFixtureFetch));
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * A canvas holding a code-only bulk table, as eurostat_download_dataset stages
   * one: a geo code per row at every hierarchy level, plus a code no value list
   * carries.
   */
  async function canvasWithBulkTable(): Promise<{ canvasId: string; bulk: string }> {
    const instance = await canvas.acquire(undefined, ctx());
    const bulk = 'df_bulk0001';
    await instance.registerTable(
      bulk,
      ['EU27_2020', 'DE', 'FR', 'DE1', 'DE11', 'DE111', 'DE112'].map((geo, i) => ({
        geo,
        time: '2023',
        obs_value: 100 + i,
      })),
      {
        schema: [
          { name: 'geo', type: 'VARCHAR' },
          { name: 'time', type: 'VARCHAR' },
          { name: 'obs_value', type: 'DOUBLE' },
        ],
      },
    );
    return { canvasId: instance.canvasId, bulk };
  }

  it('without canvas_id, returns the unchanged response and never touches the canvas', async () => {
    const acquire = vi.spyOn(canvas, 'acquire');
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'geo',
      geo_level: 'nuts3',
    });
    expect(result.structuredContent).toEqual({
      dimensionCode: 'geo',
      dimensionLabel: 'Geopolitical entity (reporting)',
      geoLevel: 'nuts3',
      values: [{ code: 'DE111', label: 'Stuttgart, Stadtkreis' }],
      totalCount: 1,
    });
    expect(textOf(result)).not.toMatch(/staged|eurostat_dataframe_/i);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('stages a code/label table holding the same pairs as values', async () => {
    const { canvasId } = await canvasWithBulkTable();
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'unit',
      canvas_id: canvasId,
    });

    const structured = result.structuredContent as {
      canvasId: string;
      stagedRowCount: number;
      tableName: string;
      totalCount: number;
      values: Array<{ code: string; label: string }>;
    };
    expect(structured.canvasId).toBe(canvasId);
    expect(structured.tableName).toMatch(/^df_[0-9a-f]{8}$/);
    expect(structured.totalCount).toBe(11);
    expect(structured.stagedRowCount).toBe(structured.totalCount);

    const instance = await canvas.acquire(canvasId, ctx());
    const [table] = await instance.describe({ tableName: structured.tableName });
    expect(table?.columns.map(({ name, type }) => [name, type])).toEqual([
      ['code', 'VARCHAR'],
      ['label', 'VARCHAR'],
    ]);
    const staged = await instance.query(`SELECT code, label FROM ${structured.tableName}`);
    expect(staged.rows).toEqual(structured.values);
    // A label carrying an XML entity survives decoding and staging verbatim.
    expect(staged.rows).toContainEqual({ code: 'U01', label: 'Euro & national currency' });
  });

  it('lists the staged table through eurostat_dataframe_describe beside the bulk table', async () => {
    const { canvasId, bulk } = await canvasWithBulkTable();
    const staged = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'geo',
      geo_level: 'nuts3',
      canvas_id: canvasId,
    });
    const { tableName } = staged.structuredContent as { tableName: string };

    const { eurostatDataframeDescribe } = await import(
      '@/mcp-server/tools/definitions/eurostat-dataframe-describe.tool.js'
    );
    const described = await runToolContract(eurostatDataframeDescribe, { canvas_id: canvasId });
    const tables = (
      described.structuredContent as {
        tables: Array<{ columns: Array<{ name: string }>; name: string }>;
      }
    ).tables;
    expect(tables.map(({ name }) => name).sort()).toEqual([bulk, tableName].sort());
    expect(tables.find(({ name }) => name === tableName)?.columns.map(({ name }) => name)).toEqual([
      'code',
      'label',
    ]);
  });

  it('labels a code-only table through a join, one row per NUTS-3 code and no other level', async () => {
    const { canvasId, bulk } = await canvasWithBulkTable();
    const staged = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'geo',
      geo_level: 'nuts3',
      canvas_id: canvasId,
    });
    const { tableName } = staged.structuredContent as { tableName: string };

    const { eurostatDataframeQuery } = await import(
      '@/mcp-server/tools/definitions/eurostat-dataframe-query.tool.js'
    );
    const joined = await runToolContract(eurostatDataframeQuery, {
      canvas_id: canvasId,
      sql: `SELECT g.code, g.label, SUM(d.obs_value) AS total FROM ${bulk} d JOIN ${tableName} g ON d.geo = g.code WHERE d.time = '2023' GROUP BY 1, 2 ORDER BY 3 DESC`,
    });
    expect((joined.structuredContent as { rows: unknown[] }).rows).toEqual([
      { code: 'DE111', label: 'Stuttgart, Stadtkreis', total: 105 },
    ]);
  });

  it('stages country codes only when geo_level is omitted', async () => {
    const { canvasId } = await canvasWithBulkTable();
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'geo',
      canvas_id: canvasId,
    });
    const { tableName, stagedRowCount } = result.structuredContent as {
      stagedRowCount: number;
      tableName: string;
    };
    expect(stagedRowCount).toBe(2);
    const instance = await canvas.acquire(canvasId, ctx());
    const rows = (await instance.query(`SELECT code FROM ${tableName} ORDER BY code`)).rows;
    expect(rows).toEqual([{ code: 'DE' }, { code: 'FR' }]);
  });

  it('names the table and canvas in content[] and points at describe, then query', async () => {
    const { canvasId } = await canvasWithBulkTable();
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'unit',
      canvas_id: canvasId,
    });
    const { tableName } = result.structuredContent as { tableName: string };
    const text = textOf(result);
    expect(text).toContain(tableName);
    expect(text).toContain(canvasId);
    expect(text).toContain('stagedRowCount 11');
    expect(text).toMatch(/eurostat_dataframe_describe.*eurostat_dataframe_query/s);
  });

  it('fails an unknown canvas_id as canvas_not_found on both surfaces', async () => {
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'unit',
      canvas_id: 'Zz9Zz9Zz9Z',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', recovery: { hint: expect.any(String) } },
      },
    });
    expect(textOf(result)).toContain('Recovery:');
  });

  it('looks up only the canvas it was given, never starting one of its own', async () => {
    const acquire = vi.spyOn(canvas, 'acquire');
    await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'unit',
      canvas_id: 'Zz9Zz9Zz9Z',
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0]?.[0]).toBe('Zz9Zz9Zz9Z');
  });

  it('accepts a well-formed canvas_id and rejects a malformed one at argument validation', () => {
    expect(
      eurostatGetDimensionValues.input.parse({
        dataset_code: 'demo_r_pjangrp3',
        dimension: 'unit',
        canvas_id: 'Zz9Zz9Zz9Z',
      }),
    ).toMatchObject({ canvas_id: 'Zz9Zz9Zz9Z' });
    for (const bad of ['short', 'has spaces!', 'x'.repeat(11), '']) {
      expect(() =>
        eurostatGetDimensionValues.input.parse({
          dataset_code: 'demo_r_pjangrp3',
          dimension: 'unit',
          canvas_id: bad,
        }),
      ).toThrow();
    }
  });

  it('ignores a well-formed canvas_id on a deployment without a canvas', async () => {
    setCanvas(undefined);
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'unit',
      canvas_id: 'Zz9Zz9Zz9Z',
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.totalCount).toBe(11);
    expect(structured).not.toHaveProperty('canvasId');
    expect(structured).not.toHaveProperty('tableName');
    expect(structured).not.toHaveProperty('stagedRowCount');
    expect(textOf(result)).not.toMatch(/staged|eurostat_dataframe_/i);
  });

  it('stages every value of a long list, not an inline-sized prefix', async () => {
    const values = Array.from({ length: 1_621 }, (_, i) => ({
      code: `R${String(i).padStart(4, '0')}`,
      label: `Region ${i}`,
    }));
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue({
        dimensionCode: 'geo',
        dimensionLabel: 'Geopolitical entity (reporting)',
        geoLevel: 'nuts3',
        values,
        totalCount: values.length,
      }),
    } as never);
    const { canvasId } = await canvasWithBulkTable();

    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'geo',
      geo_level: 'nuts3',
      canvas_id: canvasId,
    });
    const { tableName, stagedRowCount } = result.structuredContent as {
      stagedRowCount: number;
      tableName: string;
    };
    expect(stagedRowCount).toBe(1_621);
    const instance = await canvas.acquire(canvasId, ctx());
    const [count] = (
      await instance.query(`SELECT CAST(COUNT(DISTINCT code) AS DOUBLE) AS n FROM ${tableName}`)
    ).rows;
    expect(count).toEqual({ n: 1_621 });
  });

  it('stages nothing for a dimension that lists no values', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue({
        dimensionCode: 'obs_status',
        dimensionLabel: 'Observation status',
        values: [],
        totalCount: 0,
      }),
    } as never);
    const { canvasId, bulk } = await canvasWithBulkTable();

    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'obs_status',
      canvas_id: canvasId,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ totalCount: 0, values: [] });
    expect(result.structuredContent).not.toHaveProperty('tableName');
    const instance = await canvas.acquire(canvasId, ctx());
    expect((await instance.describe()).map(({ name }) => name)).toEqual([bulk]);
  });
});

// ---------------------------------------------------------------------------
// The failure contract end to end: the real data service over the recorded SDMX
// structure, only fetch stubbed, so every declared reason is raised where it
// really is rather than injected by a stub.
// ---------------------------------------------------------------------------

describe('eurostatGetDimensionValues — failures raised by the real data service', () => {
  const errorOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { error: { code: number; data: Record<string, unknown> } }).error;

  /** The recorded structure pair, with one body replaced. */
  const serveStructure = (replace: { constraint?: string; dataflow?: string }) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown): Promise<Response> => {
        const { pathname } = new URL(String(input));
        if (replace.dataflow !== undefined && pathname.includes('/sdmx/2.1/dataflow/')) {
          return new Response(replace.dataflow, { status: 200 });
        }
        if (replace.constraint !== undefined && pathname.includes('/sdmx/2.1/contentconstraint/')) {
          return new Response(replace.constraint, { status: 200 });
        }
        return sdmxFixtureFetch(input);
      }),
    );

  beforeEach(() => {
    setCanvas(undefined);
    vi.stubGlobal('fetch', vi.fn(sdmxFixtureFetch));
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      'a content constraint cut off inside the geo key values',
      {
        constraint: SDMX_CONSTRAINT_XML.slice(
          0,
          SDMX_CONSTRAINT_XML.indexOf('<c:Value>DE11</c:Value>') + 12,
        ),
      },
    ],
    [
      'a dataflow cut off inside a nested codelist',
      {
        dataflow: SDMX_DATAFLOW_XML.slice(0, SDMX_DATAFLOW_XML.indexOf('<s:Code id="DE1">') + 12),
      },
    ],
    ['an empty dataflow body', { dataflow: '' }],
  ])('surfaces %s as the declared upstream_fault on both surfaces', async (_label, replace) => {
    serveStructure(replace);
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: 'geo',
      geo_level: 'nuts2',
    });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_fault',
      recovery: { hint: expect.stringContaining('"geo" values of "earn_ses_annual"') },
    });
    expect(error.data.recovery).toMatchObject({ hint: expect.stringContaining('unmatchedValues') });
    const text = textOf(result);
    expect(text).toContain('malformed SDMX metadata');
    expect(text).toContain('Recovery:');
    expect(text).toContain('reason upstream_fault');
    expect(text).not.toMatch(/async/i);
  });

  it('surfaces an unknown dimension as not_found on both surfaces', async () => {
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: 'nace_r2',
    });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found', recovery: { hint: expect.stringContaining('earn_ses_annual') } },
    });
    expect(textOf(result)).toContain('reason not_found');
  });

  it('surfaces a NUTS level the constraint lists no geo code at as no_results', async () => {
    serveStructure({ constraint: SDMX_CONSTRAINT_WITHOUT_COUNTRIES_XML });
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: 'geo',
    });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results', recovery: { hint: expect.stringContaining('"country"') } },
    });
    expect(textOf(result)).toContain('reason no_results');
  });

  it('rejects geo_level on a non-geo dimension as conflicting_params before any request', async () => {
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: 'unit',
      geo_level: 'nuts1',
    });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'conflicting_params', recovery: { hint: expect.stringContaining('"unit"') } },
    });
    expect(textOf(result)).toContain('reason conflicting_params');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('declares exactly the failures its metadata and staging paths can raise', () => {
    expect(eurostatGetDimensionValues.errors?.map(({ reason }) => reason)).toEqual([
      'not_found',
      'no_results',
      'conflicting_params',
      'upstream_fault',
      'canvas_not_found',
    ]);
  });
});
