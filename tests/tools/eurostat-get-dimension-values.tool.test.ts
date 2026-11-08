/**
 * @fileoverview Tests for the eurostat_get_dimension_values tool.
 * @module tests/tools/eurostat-get-dimension-values.tool.test
 */

import { readFileSync } from 'node:fs';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatGetDimensionValues } from '@/mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { GEO_LEVEL_VALUES } from '@/services/eurostat-data/types.js';
import {
  CONSTRAINT_WITH_UNMAPPED_LEVELS_XML,
  DATAFLOW_WITH_UNMAPPED_LEVELS_XML,
  UNMAPPED_GEO_CODES,
} from '../fixtures/dimension-values/geo-unmapped-levels.js';
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
          data: { reason: 'no_results', geoLevel: 'country', availableGeoLevels: ['nuts2'] },
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

  beforeAll(async () => {
    ({ canvas, teardown } = withRealCanvas());
    // Loads the DuckDB binding once, so no single test pays for it against its timeout.
    await canvas.acquire(undefined, ctx());
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

  it('lists the staged tables through eurostat_dataframe_describe beside the bulk table, level on geo alone (#99)', async () => {
    const { canvasId, bulk } = await canvasWithBulkTable();
    const stage = async (input: Record<string, unknown>) =>
      (
        (
          await runToolContract(eurostatGetDimensionValues, {
            dataset_code: 'demo_r_pjangrp3',
            canvas_id: canvasId,
            ...input,
          } as never)
        ).structuredContent as { tableName: string }
      ).tableName;
    const geoTable = await stage({ dimension: 'geo', geo_level: 'nuts3' });
    const unitTable = await stage({ dimension: 'unit' });

    const { eurostatDataframeDescribe } = await import(
      '@/mcp-server/tools/definitions/eurostat-dataframe-describe.tool.js'
    );
    const described = await runToolContract(eurostatDataframeDescribe, { canvas_id: canvasId });
    const tables = (
      described.structuredContent as {
        tables: Array<{ columns: Array<{ name: string; type: string }>; name: string }>;
      }
    ).tables;
    expect(tables.map(({ name }) => name).sort()).toEqual([bulk, geoTable, unitTable].sort());
    const columnsOf = (table: string) =>
      tables.find(({ name }) => name === table)?.columns.map(({ name, type }) => [name, type]);
    expect(columnsOf(geoTable)).toEqual([
      ['code', 'VARCHAR'],
      ['label', 'VARCHAR'],
      ['level', 'VARCHAR'],
    ]);
    expect(columnsOf(unitTable)).toEqual([
      ['code', 'VARCHAR'],
      ['label', 'VARCHAR'],
    ]);
    // The describe tool's content[] carries the same column lists.
    expect(textOf(described)).toMatch(new RegExp(`${geoTable}[\\s\\S]*level`));
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

  it('stages every level, each code with its level, when geo_level is omitted (#99)', async () => {
    const { canvasId, bulk } = await canvasWithBulkTable();
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'geo',
      canvas_id: canvasId,
    });
    const { tableName, stagedRowCount, totalCount, values } = result.structuredContent as {
      stagedRowCount: number;
      tableName: string;
      totalCount: number;
      values: Value[];
    };
    // The inline page keeps its country default; the table does not.
    expect(values).toEqual([
      { code: 'DE', label: 'Germany' },
      { code: 'FR', label: 'France' },
    ]);
    expect(totalCount).toBe(2);
    expect(stagedRowCount).toBe(7);
    const instance = await canvas.acquire(canvasId, ctx());
    const rows = (await instance.query(`SELECT code, label, level FROM ${tableName}`)).rows;
    expect(rows).toEqual([
      { code: 'EU27_2020', label: 'European Union - 27 countries', level: 'aggregate' },
      { code: 'EA20', label: 'Euro area - 20 countries', level: 'aggregate' },
      { code: 'DE', label: 'Germany', level: 'country' },
      { code: 'FR', label: 'France', level: 'country' },
      { code: 'DE1', label: 'Baden-Württemberg', level: 'nuts1' },
      { code: 'DE11', label: 'Stuttgart', level: 'nuts2' },
      { code: 'DE111', label: 'Stuttgart, Stadtkreis', level: 'nuts3' },
    ]);
    // A JOIN labels every row of the download, DE112 aside, which no value list carries.
    const joined = await instance.query(
      `SELECT d.geo, g.level FROM ${bulk} d JOIN ${tableName} g ON d.geo = g.code ORDER BY d.obs_value`,
    );
    expect(joined.rows.map(({ geo }) => geo)).toEqual([
      'EU27_2020',
      'DE',
      'FR',
      'DE1',
      'DE11',
      'DE111',
    ]);
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

  it('fails an unknown canvas_id as canvas_not_found on both surfaces, with its declared recovery', async () => {
    const declared = eurostatGetDimensionValues.errors?.find(
      (e) => e.reason === 'canvas_not_found',
    )?.recovery;
    expect(declared).toContain('omit canvas_id to list the values inline only');

    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'unit',
      canvas_id: 'Zz9Zz9Zz9Z',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', canvasId: 'Zz9Zz9Zz9Z', recovery: { hint: declared } },
      },
    });
    // The canvas service's own advice — re-run the producing tool — is not what this tool says.
    expect(textOf(result)).toContain(`Recovery: ${declared}`);
    expect(textOf(result)).not.toContain('stage fresh data');
  });

  it('never looks up an unknown canvas_id for a dimension that lists no values', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue({
        dimensionCode: 'obs_status',
        dimensionLabel: 'Observation status',
        values: [],
        totalCount: 0,
        listedValues: [],
      }),
    } as never);
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'obs_status',
      canvas_id: 'Zz9Zz9Zz9Z',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ totalCount: 0, values: [] });
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
        listedValues: values.map((value) => ({ ...value, level: 'nuts3' })),
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
        listedValues: [],
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
// Every geo level on a canvas (#99) — the real data service over nama_10r_2gdp's
// dataflow and content constraint as Eurostat served them on 2026-11-08: 471 geo
// codes, 1 aggregate, 34 countries, 127 NUTS 1 and 309 NUTS 2.
// ---------------------------------------------------------------------------

const recordedXml = (name: string) =>
  readFileSync(new URL(`../fixtures/dimension-values/${name}.xml`, import.meta.url), 'utf8');

/** Answers both structure reads of any dataset with nama_10r_2gdp's recorded pair. */
async function namaRegionalFetch(input: unknown): Promise<Response> {
  const { pathname } = new URL(String(input));
  if (pathname.includes('/sdmx/2.1/dataflow/')) {
    return new Response(recordedXml('nama-10r-2gdp-dataflow'), { status: 200 });
  }
  if (pathname.includes('/sdmx/2.1/contentconstraint/')) {
    return new Response(recordedXml('nama-10r-2gdp-constraint'), { status: 200 });
  }
  throw new Error(`Unexpected URL: ${pathname}`);
}

/** Underscores at both ends: in running text, Markdown reads the ID as emphasis. */
const EMPHASIS_ID = '_abcdefgh_';

/** `canvas`, answering every acquire with one of its canvases under `id`, which it would never mint. */
async function underId(canvas: DataCanvas, id: string): Promise<DataCanvas> {
  const instance = await canvas.acquire(undefined, createMockContext({ tenantId: 'default' }));
  const renamed = new Proxy(instance, {
    get: (target, key) => {
      if (key === 'canvasId') return id;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { acquire: async () => renamed } as never;
}

describe('eurostatGetDimensionValues — every geo level on a canvas (#99)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  const ctx = () => createMockContext({ tenantId: 'default' });
  const geo = (extra: Record<string, unknown> = {}) =>
    runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'nama_10r_2gdp',
      dimension: 'geo',
      ...extra,
    } as never);

  beforeAll(async () => {
    ({ canvas, teardown } = withRealCanvas());
    await canvas.acquire(undefined, ctx());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(() => {
    setCanvas(canvas);
    vi.stubGlobal('fetch', vi.fn(namaRegionalFetch));
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    setCanvas(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pages the 34 countries inline when geo_level is omitted (characterization)', async () => {
    const result = await geo({ limit: 1000 });
    const body = result.structuredContent as {
      geoLevel: string;
      totalCount: number;
      values: Array<{ code: string; label: string }>;
    };
    expect(body.geoLevel).toBe('country');
    expect(body.totalCount).toBe(34);
    expect(body.values).toHaveLength(34);
    expect(body.values.every(({ code }) => /^[A-Z]{2}$/.test(code))).toBe(true);
    expect(body.values.slice(0, 3)).toEqual([
      { code: 'BE', label: 'Belgium' },
      { code: 'BG', label: 'Bulgaria' },
      { code: 'CZ', label: 'Czechia' },
    ]);
    expect(result.structuredContent).not.toHaveProperty('matchCount');
    expect(textOf(result)).toContain('**Geo level:** `country`');
    expect(textOf(result)).toContain('**Total values:** 34\n');
  });

  type Staged = {
    canvasId: string;
    geoLevel: string;
    notice?: string;
    stagedRowCount: number;
    tableName: string;
    totalCount: number;
    values: Array<{ code: string; label: string }>;
  };
  /** The payload through the production output parse, so every field is a declared one. */
  const stagedBody = (result: Awaited<ReturnType<typeof geo>>) =>
    eurostatGetDimensionValues.output.parse(result.structuredContent) as Staged;
  const levelsOf = async (canvasId: string, table: string) =>
    (
      await (
        await canvas.acquire(canvasId, ctx())
      ).query(
        `SELECT level, CAST(COUNT(*) AS INTEGER) AS n FROM ${table} GROUP BY level ORDER BY level NULLS LAST`,
      )
    ).rows;

  it('stages all 471 geo codes with their level when geo_level is omitted, the page unchanged', async () => {
    const { canvasId } = await canvas.acquire(undefined, ctx());
    const result = await geo({ canvas_id: canvasId, limit: 1000 });
    const body = stagedBody(result);
    const structured = result.structuredContent as Staged;

    // The inline page is the country default, exactly as without canvas_id.
    expect(body.geoLevel).toBe('country');
    expect(body.totalCount).toBe(34);
    expect(body.values).toHaveLength(34);
    expect(body.stagedRowCount).toBe(471);

    // stagedRowCount is the dataset's geo valuesCount, as eurostat_get_dataset_info reports it.
    const { eurostatGetDatasetInfo } = await import(
      '@/mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js'
    );
    const info = await runToolContract(eurostatGetDatasetInfo, { dataset_code: 'nama_10r_2gdp' });
    const geoInfo = (
      info.structuredContent as { dimensions: Array<{ code: string; valuesCount?: number }> }
    ).dimensions.find(({ code }) => code === 'geo');
    expect(geoInfo?.valuesCount).toBe(body.stagedRowCount);

    expect(await levelsOf(canvasId, body.tableName)).toEqual([
      { level: 'aggregate', n: 1 },
      { level: 'country', n: 34 },
      { level: 'nuts1', n: 127 },
      { level: 'nuts2', n: 309 },
    ]);

    // Both surfaces carry the every-level disclosure and the overlap warning.
    expect(structured.notice).toBe(
      `Table \`${body.tableName}\` on canvas \`${canvasId}\` holds every "geo" level "nama_10r_2gdp" lists, not only the country values listed here — aggregate 1, country 34, nuts1 127, nuts2 309 — with each code's level in a level column (NULL for a code with no NUTS level). Aggregates and regions overlap the countries they contain, so a JOIN on this table keeps them beside the countries: filter g.level (e.g. WHERE g.level = 'country') before summing or averaging, or pass geo_level to stage one level. Search or join it with eurostat_dataframe_query.`,
    );
    const text = textOf(result);
    expect(text).toContain(`> ${structured.notice}`);
    expect(text).toContain(
      `**Staged:** table \`${body.tableName}\` on canvas \`${canvasId}\` (stagedRowCount 471), columns code, label and level (NUTS level, NULL when the code has none) — every geo level the dataset lists, not only the country values below. Aggregates and regions overlap the countries they contain, so a JOIN on it keeps them beside the countries: filter level (e.g. g.level = 'country') before summing or averaging — inspect it with eurostat_dataframe_describe first, then join it in eurostat_dataframe_query`,
    );
  });

  it('labels every row of an all-level download through a JOIN, and selects countries by level', async () => {
    const instance = await canvas.acquire(undefined, ctx());
    const result = await geo({ canvas_id: instance.canvasId });
    const { tableName } = stagedBody(result);
    // A code-only table holding one row per geo code the dataset lists, as a download does.
    const codes = (await instance.query(`SELECT code FROM ${tableName}`)).rows.map(
      ({ code }) => code as string,
    );
    await instance.registerTable(
      'df_bulk0099',
      codes.map((code, i) => ({ geo: code, obs_value: i })),
      {
        schema: [
          { name: 'geo', type: 'VARCHAR' },
          { name: 'obs_value', type: 'DOUBLE' },
        ],
      },
    );
    const count = async (sql: string) =>
      (await instance.query(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${sql}`)).rows[0];
    expect(await count(`df_bulk0099 d JOIN ${tableName} g ON d.geo = g.code`)).toEqual({
      n: 471,
    });
    expect(
      await count(`df_bulk0099 d LEFT JOIN ${tableName} g ON d.geo = g.code WHERE g.label IS NULL`),
    ).toEqual({ n: 0 });
    expect(
      await count(`df_bulk0099 d JOIN ${tableName} g ON d.geo = g.code WHERE g.level = 'country'`),
    ).toEqual({ n: 34 });
  });

  it.each([
    ['nuts2', 309],
    ['country', 34],
  ] as const)(
    'stages only geo_level %s when it is passed, every row at that level, with no every-level notice',
    async (level, rows) => {
      const { canvasId } = await canvas.acquire(undefined, ctx());
      const result = await geo({ canvas_id: canvasId, geo_level: level, limit: 1000 });
      const body = stagedBody(result);
      expect(body).toMatchObject({ geoLevel: level, totalCount: rows, stagedRowCount: rows });
      expect(await levelsOf(canvasId, body.tableName)).toEqual([{ level, n: rows }]);
      expect(result.structuredContent).not.toHaveProperty('notice');
      const text = textOf(result);
      expect(text).toContain(
        `**Staged:** table \`${body.tableName}\` on canvas \`${canvasId}\` (stagedRowCount ${rows}), columns code, label and level (NUTS level, NULL when the code has none) — inspect it with eurostat_dataframe_describe first`,
      );
      expect(text).not.toContain('every geo level');
    },
  );

  it('sends the page notice and the every-level notice together, naming the table once', async () => {
    const { canvasId } = await canvas.acquire(undefined, ctx());
    const result = await geo({ canvas_id: canvasId, limit: 5 });
    const { notice, tableName } = result.structuredContent as Staged;
    expect(notice).toContain(
      'Values 1–5 of 34 "geo" values, in Eurostat\'s order; limit 5 ended this page.',
    );
    expect(notice).toContain('holds every "geo" level "nama_10r_2gdp" lists');
    expect(notice?.split(tableName)).toHaveLength(2);
    expect(notice).not.toContain('Every one of the');
    expect(textOf(result)).toContain(`> ${notice}`);
  });

  it.each([
    [{}, 'to stage all 471 "geo" values, every level, as a code/label/level table'],
    [
      { geo_level: 'nuts2' },
      'to stage all 309 "geo" values at geo_level "nuts2" as a code/label/level table',
    ],
  ])('offers canvas_id with the count a table would hold (%o)', async (extra, offer) => {
    const result = await geo({ limit: 5, ...extra });
    expect((result.structuredContent as Staged).notice).toContain(offer);
  });

  it('renders the canvas ID and table name as code spans in the every-level notice', async () => {
    setCanvas(await underId(canvas, EMPHASIS_ID));
    const result = await geo({ canvas_id: EMPHASIS_ID, limit: 1000 });
    const { notice, tableName } = result.structuredContent as Staged;
    const named = `Table \`${tableName}\` on canvas \`${EMPHASIS_ID}\` holds every "geo" level`;
    expect(notice).toContain(named);
    expect(textOf(result)).toContain(`> ${named}`);
  });
});

describe('eurostatGetDimensionValues — geo codes with no NUTS level (#99)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  const ctx = () => createMockContext({ tenantId: 'default' });

  beforeAll(async () => {
    ({ canvas, teardown } = withRealCanvas());
    await canvas.acquire(undefined, ctx());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(() => {
    setCanvas(canvas);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const { pathname } = new URL(String(input));
        if (pathname.includes('/sdmx/2.1/dataflow/'))
          return new Response(DATAFLOW_WITH_UNMAPPED_LEVELS_XML, { status: 200 });
        return new Response(CONSTRAINT_WITH_UNMAPPED_LEVELS_XML, { status: 200 });
      }),
    );
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    setCanvas(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stages a code whose LEVEL is OTH, 5 or absent with level NULL, and counts them', async () => {
    const instance = await canvas.acquire(undefined, ctx());
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: 'geo',
      canvas_id: instance.canvasId,
    });
    const { notice, stagedRowCount, tableName } = result.structuredContent as {
      notice: string;
      stagedRowCount: number;
      tableName: string;
    };
    expect(stagedRowCount).toBe(10);
    const unmapped = await instance.query(
      `SELECT code, label, level FROM ${tableName} WHERE level IS NULL`,
    );
    expect(unmapped.rows).toEqual(UNMAPPED_GEO_CODES.map((value) => ({ ...value, level: null })));
    expect(notice).toContain('aggregate 2, country 2, nuts1 1, nuts2 1, nuts3 1, NULL 3');
    expect(textOf(result)).toContain('NULL 3');
  });

  it('leaves them out of every explicit geo_level', async () => {
    const instance = await canvas.acquire(undefined, ctx());
    for (const geo_level of GEO_LEVEL_VALUES) {
      const result = await runToolContract(eurostatGetDimensionValues, {
        dataset_code: 'earn_ses_annual',
        dimension: 'geo',
        geo_level,
        canvas_id: instance.canvasId,
      });
      const { tableName } = result.structuredContent as { tableName: string };
      const nulls = await instance.query(
        `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${tableName} WHERE level IS NULL OR level <> '${geo_level}'`,
      );
      expect(nulls.rows).toEqual([{ n: 0 }]);
    }
  });
});

// ---------------------------------------------------------------------------
// code_prefix (#102) — the codes under a parent: the real data service over
// nama_10r_2gdp's recorded structure, and recorded CN and COICOP lists.
// ---------------------------------------------------------------------------

describe('eurostatGetDimensionValues — code_prefix (#102)', () => {
  type Page = {
    matchCount?: number;
    nextCursor?: string;
    notice?: string;
    totalCount: number;
    values: Value[];
  };
  const call = (input: Record<string, unknown>) =>
    runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'nama_10r_2gdp',
      dimension: 'geo',
      ...input,
    } as never);
  const body = (result: Awaited<ReturnType<typeof call>>) => result.structuredContent as Page;
  const errorReason = (result: Awaited<ReturnType<typeof call>>) =>
    (result.structuredContent as { error?: { data?: { reason?: string } } }).error?.data?.reason;

  beforeEach(() => {
    setCanvas(undefined);
    vi.stubGlobal('fetch', vi.fn(namaRegionalFetch));
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['DE', 'de', ' De '])(
    'lists the 38 German NUTS 2 regions with code_prefix "%s", matchCount 38 of 309',
    async (code_prefix) => {
      const result = await call({ geo_level: 'nuts2', code_prefix, limit: 1000 });
      expect(result.isError).not.toBe(true);
      const page = eurostatGetDimensionValues.output.parse(result.structuredContent);
      expect(page).toMatchObject({ geoLevel: 'nuts2', matchCount: 38, totalCount: 309 });
      expect(page.values).toHaveLength(38);
      expect(page.values.every(({ code }) => code.startsWith('DE'))).toBe(true);
      expect(page.values[0]).toEqual({ code: 'DE11', label: 'Stuttgart' });
      expect(page.values.at(-1)).toEqual({ code: 'DEG0', label: 'Thüringen' });
      expect(page.values.map(({ code }) => code)).not.toContain('ES30');
      const text = textOf(result);
      expect(text).toContain('**Total values:** 309\n**Matching:** 38\n');
      expect(text).toContain('- `DEG0` — Thüringen');
    },
  );

  it('narrows with filter: "ober" finds four NUTS 2 regions, three of them under DE', async () => {
    expect(
      body(await call({ geo_level: 'nuts2', filter: 'ober' })).values.map(({ code }) => code),
    ).toEqual(['DE21', 'DE23', 'DE24', 'AT31']);
    const both = await call({ geo_level: 'nuts2', filter: 'ober', code_prefix: 'DE' });
    expect(body(both)).toMatchObject({ matchCount: 3, totalCount: 309 });
    expect(body(both).values.map(({ code }) => code)).toEqual(['DE21', 'DE23', 'DE24']);
  });

  it('pages a prefix list and names code_prefix in the page notice', async () => {
    const first = await call({ geo_level: 'nuts2', code_prefix: 'FR', limit: 5 });
    expect(body(first)).toMatchObject({ matchCount: 28, totalCount: 309, truncated: true });
    expect(body(first).notice).toContain(
      'Values 1–5 of 28 values with code prefix "FR", in Eurostat\'s order; limit 5 ended this page.',
    );
    expect(textOf(first)).toContain('**Matching:** 28 — 5 listed below');
    const both = await call({
      geo_level: 'nuts2',
      code_prefix: 'DE',
      filter: 'r',
      limit: 2,
    });
    expect(body(both).notice).toContain(
      'Values 1–2 of 27 values with code prefix "DE" matching filter "r", in Eurostat\'s order',
    );
  });

  it('answers a prefix that matches nothing with an empty page, matchCount 0, and a notice naming code_prefix', async () => {
    const result = await call({ geo_level: 'nuts2', code_prefix: 'XX' });
    expect(result.isError).not.toBe(true);
    expect(body(result)).toMatchObject({ values: [], matchCount: 0, totalCount: 309 });
    expect(body(result)).not.toHaveProperty('nextCursor');
    expect(body(result).notice).toBe(
      'No "geo" value at geo_level "nuts2" of "nama_10r_2gdp" has a code starting with code_prefix "XX", ignoring case. code_prefix applies within geo_level "nuts2": pass another geo_level to list the codes of that level. Shorten or drop code_prefix, or call without it to page through all 309.',
    );
    expect(textOf(result)).toContain('**Matching:** 0');
    expect(textOf(result)).toContain(`> ${body(result).notice}`);
  });

  it('names both narrowings when a prefix and a filter together match nothing', async () => {
    const result = await call({ geo_level: 'nuts2', code_prefix: 'DE', filter: 'zz_nothing' });
    expect(body(result)).toMatchObject({ values: [], matchCount: 0 });
    expect(body(result).notice).toContain(
      'No "geo" value at geo_level "nuts2" of "nama_10r_2gdp" has a code starting with code_prefix "DE" and matches filter "zz_nothing", ignoring case.',
    );
  });

  it('keeps the country default: "DE1" finds no country, and the notice routes to geo_level', async () => {
    expect(body(await call({ code_prefix: 'de' })).values).toEqual([
      { code: 'DE', label: 'Germany' },
    ]);
    const result = await call({ code_prefix: 'DE1' });
    expect(body(result)).toMatchObject({ values: [], matchCount: 0, totalCount: 34 });
    expect(body(result).notice).toContain(
      'code_prefix applies within geo_level "country": pass another geo_level to list the codes of that level.',
    );
  });

  it('routes a geo filter that finds no country to geo_level, as code_prefix does', async () => {
    const result = await call({ filter: 'Oberbayern' });
    expect(body(result)).toMatchObject({ values: [], matchCount: 0, totalCount: 34 });
    expect(body(result).notice).toContain(
      'filter applies within geo_level "country": pass another geo_level to search the codes of that level.',
    );
    expect(body(await call({ geo_level: 'nuts2', filter: 'Oberbayern' })).values).toEqual([
      { code: 'DE21', label: 'Oberbayern' },
    ]);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \t '],
  ])('treats a code_prefix that is %s as omitted', async (_label, code_prefix) => {
    const plain = await call({ geo_level: 'nuts2' });
    const blank = await call({ geo_level: 'nuts2', code_prefix });
    expect(blank.structuredContent).toEqual(plain.structuredContent);
    expect(body(blank)).not.toHaveProperty('matchCount');
  });

  it('rejects a code_prefix longer than 100 characters at argument validation', () => {
    const parse = (code_prefix: string) =>
      eurostatGetDimensionValues.input.parse({
        dataset_code: 'nama_10r_2gdp',
        dimension: 'geo',
        code_prefix,
      });
    expect(parse('D'.repeat(100))).toMatchObject({ code_prefix: 'D'.repeat(100) });
    expect(() => parse('D'.repeat(101))).toThrow();
  });

  describe('the cursor binds code_prefix', () => {
    it('resumes with the same prefix in another case, and refuses another prefix or none before loading the structure', async () => {
      const first = await call({ geo_level: 'nuts2', code_prefix: 'DE', limit: 5 });
      const cursor = body(first).nextCursor;
      expect(decodeCursor(cursor as string, createMockContext())).toMatchObject({ prefix: 'de' });
      const next = await call({ geo_level: 'nuts2', code_prefix: 'de', cursor });
      expect(body(first).values.map(({ code }) => code)).toEqual([
        'DE11',
        'DE12',
        'DE13',
        'DE14',
        'DE21',
      ]);
      expect(body(next).values.map(({ code }) => code)).toEqual([
        'DE22',
        'DE23',
        'DE24',
        'DE25',
        'DE26',
      ]);
      vi.mocked(fetch).mockClear();
      for (const change of [{ code_prefix: 'FR' }, {}]) {
        const refused = await call({ geo_level: 'nuts2', ...change, cursor });
        expect(errorReason(refused)).toBe('invalid_cursor');
        expect(textOf(refused)).toContain('filter or code_prefix');
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    it('resumes a cursor issued before code_prefix existed on a call without one, and refuses it with one', async () => {
      const legacy = encodeCursor({
        offset: 5,
        limit: 5,
        after: 'DE14',
        dataset: 'nama_10r_2gdp',
        dimension: 'geo',
        filter: '',
        geoLevel: 'nuts2',
      });
      const resumed = await call({ geo_level: 'nuts2', cursor: legacy });
      expect(resumed.isError).not.toBe(true);
      expect(body(resumed).values[0]?.code).toBe('DE21');
      expect(
        errorReason(await call({ geo_level: 'nuts2', code_prefix: 'DE', cursor: legacy })),
      ).toBe('invalid_cursor');
    });

    it('walks a prefix list to its end and answers a cursor past it with an empty page', async () => {
      const codes: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 5; pages++) {
        const page = body(
          await call({
            geo_level: 'nuts2',
            code_prefix: 'FR',
            limit: 10,
            ...(cursor && { cursor }),
          }),
        );
        expect(page).toMatchObject({ matchCount: 28, totalCount: 309 });
        codes.push(...page.values.map(({ code }) => code));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(codes).toHaveLength(28);
      expect(new Set(codes).size).toBe(28);
      expect(codes.every((code) => code.startsWith('FR'))).toBe(true);
      const past = encodeCursor({
        offset: 28,
        limit: 10,
        after: codes.at(-1),
        dataset: 'nama_10r_2gdp',
        dimension: 'geo',
        filter: '',
        geoLevel: 'nuts2',
        prefix: 'fr',
      });
      const end = await call({ geo_level: 'nuts2', code_prefix: 'FR', cursor: past });
      expect(body(end).values).toEqual([]);
      expect(body(end)).not.toHaveProperty('nextCursor');
      expect(body(end).notice).toBe(
        'No "geo" values of "nama_10r_2gdp" follow the code this cursor resumes after: the list ends there.',
      );
    });

    it('refuses a cursor resuming after a code outside the prefix list, naming code_prefix', async () => {
      const stray = encodeCursor({
        offset: 5,
        limit: 5,
        after: 'DE11',
        dataset: 'nama_10r_2gdp',
        dimension: 'geo',
        filter: '',
        geoLevel: 'nuts2',
        prefix: 'fr',
      });
      const result = await call({ geo_level: 'nuts2', code_prefix: 'FR', cursor: stray });
      expect(errorReason(result)).toBe('invalid_cursor');
      expect(textOf(result)).toContain(
        'Unusable cursor: it resumes after "DE11", which the "geo" values of "nama_10r_2gdp" no longer list under this code_prefix.',
      );
    });

    it('refuses a cursor whose prefix field is not a string', async () => {
      const odd = encodeCursor({
        offset: 5,
        limit: 5,
        after: 'DE14',
        dataset: 'nama_10r_2gdp',
        dimension: 'geo',
        filter: '',
        geoLevel: 'nuts2',
        prefix: null,
      });
      expect(errorReason(await call({ geo_level: 'nuts2', cursor: odd }))).toBe('invalid_cursor');
    });

    it('names code_prefix among the bound inputs in the invalid_cursor contract', () => {
      const entry = eurostatGetDimensionValues.errors?.find(
        ({ reason }) => reason === 'invalid_cursor',
      );
      expect(entry?.when).toContain('filter or code_prefix');
      expect(entry?.recovery).toContain('filter and code_prefix');
    });
  });

  describe('beside a canvas', () => {
    let canvas: DataCanvas;
    let teardown: () => Promise<void>;
    const ctx = () => createMockContext({ tenantId: 'default' });
    beforeAll(async () => {
      ({ canvas, teardown } = withRealCanvas());
      await canvas.acquire(undefined, ctx());
    });
    afterAll(async () => {
      await teardown();
    });
    beforeEach(() => {
      setCanvas(canvas);
    });

    it.each([{}, { geo_level: 'nuts2' }])(
      'stages the same rows with code_prefix as without it (%o)',
      async (extra) => {
        const instance = await canvas.acquire(undefined, ctx());
        const stage = async (input: Record<string, unknown>) => {
          const result = await call({ canvas_id: instance.canvasId, ...extra, ...input });
          const { tableName } = result.structuredContent as { tableName: string };
          return (await instance.query(`SELECT code, label, level FROM ${tableName}`)).rows;
        };
        const plain = await stage({});
        expect(plain.length).toBeGreaterThan(38);
        expect(await stage({ code_prefix: 'DE' })).toEqual(plain);
      },
    );
  });

  it('lists the 193 CN codes under heading 2204, parent included, never 85022040', async () => {
    serveList(recordedValues('ds-045409-product-2204-excerpt'), {
      code: 'product',
      label: 'Product',
    });
    const product = (input: Record<string, unknown>) =>
      call({ dataset_code: 'DS-045409', dimension: 'product', limit: 1000, ...input });
    const result = await product({ code_prefix: '2204' });
    const page = body(result);
    expect(page.matchCount).toBe(193);
    expect(page.values).toHaveLength(193);
    expect(page.values[0]?.code).toBe('2204');
    expect(page.values.every(({ code }) => code.startsWith('2204'))).toBe(true);
    expect(page.values.map(({ code }) => code)).toContain('220410XX');
    expect(page.values.map(({ code }) => code)).not.toContain('85022040');
    // The same text as a filter word also matches a code that only contains it.
    const filtered = body(await product({ filter: '2204' }));
    expect(filtered.matchCount).toBe(194);
    expect(filtered.values.map(({ code }) => code)).toContain('85022040');
    // No code holds ".", so a CN code printed with separators says what to send instead.
    const dotted = body(await product({ code_prefix: '2204.21' }));
    expect(dotted).toMatchObject({ values: [], matchCount: 0 });
    expect(dotted.notice).toContain(
      'No Eurostat code contains ".": a code printed with separators is sent without them, so pass code_prefix "220421".',
    );
    expect(body(await product({ code_prefix: '220421' })).values[0]?.code).toBe('220421');
  });

  it('lists CP045 and its nine sub-items, never the ELC_GAS or NRG aggregates outside the code tree', async () => {
    serveList(recordedValues('prc-hicp-manr-coicop'), { code: 'coicop', label: 'COICOP' });
    const result = await call({
      dataset_code: 'prc_hicp_manr',
      dimension: 'coicop',
      code_prefix: 'cp045',
    });
    expect(body(result).values.map(({ code }) => code)).toEqual([
      'CP045',
      'CP0451',
      'CP0452',
      'CP04521',
      'CP04522',
      'CP0453',
      'CP0454',
      'CP04541',
      'CP04549',
      'CP0455',
    ]);
    expect(body(result).values[0]).toEqual({
      code: 'CP045',
      label: 'Electricity, gas and other fuels',
    });
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
    ['GEO', 'geo', { geo_level: 'country' as const }],
    ['TIME_PERIOD', 'time', {}],
  ])('resumes a real %s alias with its canonical %s code', async (alias, canonical, extra) => {
    const first = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: alias,
      limit: 1,
      ...extra,
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ dimensionCode: canonical });
    const cursor = (first.structuredContent as { nextCursor: string }).nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const second = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: canonical,
      cursor,
      ...extra,
    });
    expect(second.isError).not.toBe(true);
    const values = (second.structuredContent as { values: Value[] }).values;
    expect(values).toHaveLength(1);
    expect(values[0]?.code).not.toBe(
      (first.structuredContent as { values: Value[] }).values[0]?.code,
    );
    expect(textOf(second)).toContain(canonical);
    expect(textOf(second)).toContain(values[0]?.code);
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

  describe('the levels a no_results hint offers (#87)', () => {
    const captured = (name: string) =>
      readFileSync(new URL(`../fixtures/dimension-values/${name}.xml`, import.meta.url), 'utf8');
    const serveCaptured = (dataset: string) =>
      serveStructure({
        dataflow: captured(`${dataset}-dataflow`),
        constraint: captured(`${dataset}-constraint`),
      });
    const hintOf = (result: { structuredContent?: unknown }) =>
      (errorOf(result).data.recovery as { hint: string }).hint;

    const expectHint = (result: Parameters<typeof textOf>[0], hint: string) => {
      expect(errorOf(result as never)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_results' },
      });
      expect(hintOf(result as never)).toBe(hint);
      expect(textOf(result)).toContain(`Recovery: ${hint}`);
    };

    it.each(['nuts1', 'nuts2', 'nuts3'] as const)(
      'offers aggregate and country on nama_10_gdp after %s, with the omit sentence',
      async (geo_level) => {
        serveCaptured('nama-10-gdp');
        const result = await runToolContract(eurostatGetDimensionValues, {
          dataset_code: 'nama_10_gdp',
          dimension: 'geo',
          geo_level,
        });
        expectHint(
          result,
          `Dataset "nama_10_gdp" has no "geo" values at the "${geo_level}" level. Choose geo_level from the levels it lists: aggregate, country. Omitting geo_level requests country values.`,
        );
      },
    );

    it.each([
      ['omitted', undefined, 'country'],
      ['aggregate', 'aggregate', 'aggregate'],
      ['nuts3', 'nuts3', 'nuts3'],
    ] as const)(
      'offers nuts2 alone on tgs00010 with geo_level %s',
      async (_name, level, failed) => {
        serveCaptured('tgs00010');
        const result = await runToolContract(eurostatGetDimensionValues, {
          dataset_code: 'tgs00010',
          dimension: 'geo',
          ...(level && { geo_level: level }),
        });
        expectHint(
          result,
          `Dataset "tgs00010" has no "geo" values at the "${failed}" level. Choose geo_level from the levels it lists: nuts2.`,
        );
      },
    );

    it('never offers a level the codelist carries but the constraint lists no code at', async () => {
      serveStructure({
        constraint: SDMX_CONSTRAINT_WITHOUT_COUNTRIES_XML.replace('<c:Value>DE111</c:Value>', ''),
      });
      const result = await runToolContract(eurostatGetDimensionValues, {
        dataset_code: 'earn_ses_annual',
        dimension: 'geo',
        geo_level: 'nuts3',
      });
      expectHint(
        result,
        'Dataset "earn_ses_annual" has no "geo" values at the "nuts3" level. Choose geo_level from the levels it lists: aggregate, nuts1, nuts2.',
      );
    });

    it('offers no level and routes to eurostat_get_dataset_info when no geo code carries one', async () => {
      serveStructure({
        dataflow: SDMX_DATAFLOW_XML.replaceAll(
          /<c:Annotations><c:Annotation><c:AnnotationTitle>[^<]*<\/c:AnnotationTitle><c:AnnotationType>LEVEL<\/c:AnnotationType><\/c:Annotation><\/c:Annotations>/g,
          '',
        ),
      });
      const result = await runToolContract(eurostatGetDimensionValues, {
        dataset_code: 'earn_ses_annual',
        dimension: 'geo',
      });
      expectHint(
        result,
        'Dataset "earn_ses_annual" has no "geo" values at the "country" level. None of its "geo" codes carries a NUTS level, so no geo_level selects them. eurostat_get_dataset_info lists sample "geo" codes.',
      );
    });
  });

  it('rejects geo_level on a non-geo dimension after loading canonical dimension metadata', async () => {
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
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a cursor replayed for another dataset before downloading that dataset’s structure', async () => {
    const first = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'earn_ses_annual',
      dimension: 'geo',
      limit: 1,
    });
    const { nextCursor } = first.structuredContent as { nextCursor: string };
    expect(nextCursor).toEqual(expect.any(String));
    vi.mocked(fetch).mockClear();

    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'geo',
      cursor: nextCursor,
    });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_cursor' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('an unavailable structure endpoint (#71)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Run the call past the 1 s / 2 s / 4 s backoff (plus jitter) without waiting it out. */
    const callSettled = async (input: { dataset_code: string; dimension: string }) => {
      const pending = runToolContract(eurostatGetDimensionValues, input);
      await vi.advanceTimersByTimeAsync(60_000);
      return pending;
    };

    it('fails a host answering 503 to everything as a retryable upstream_fault on both surfaces', async () => {
      const fetchMock = vi.fn(
        async () => new Response('Service Unavailable', { status: 503, statusText: 'Unavailable' }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await callSettled({ dataset_code: 'nama_10_gdp', dimension: 'unit' });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_fault',
        retryable: true,
        recovery: { hint: expect.stringContaining('"unit" values of "nama_10_gdp"') },
      });
      const hint = (error.data.recovery as { hint: string }).hint;
      expect(hint).toBe(
        'Eurostat\'s SDMX structure endpoint answered HTTP 503 on every attempt, so the "unit" values of "nama_10_gdp" cannot be listed — an upstream outage, not a fault in the request. A failed read is not cached, so retry in a few minutes.',
      );
      const text = textOf(result);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).toContain('reason upstream_fault · retryable');
      // Both structure reads of the metadata load ran their full retry loop.
      expect(fetchMock).toHaveBeenCalledTimes(8);
    });

    it('fails an unreachable host the same way', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      );
      const result = await callSettled({ dataset_code: 'nama_10_gdp', dimension: 'geo' });
      const error = errorOf(result);
      expect(error.data).toMatchObject({ reason: 'upstream_fault', retryable: true });
      expect((error.data.recovery as { hint: string }).hint).toContain('could not be reached');
      expect(textOf(result)).toContain('reason upstream_fault · retryable');
    });

    it('keeps the unreadable-structure hint, with no retryable flag, for a malformed body', async () => {
      serveStructure({ dataflow: '' });
      const result = await callSettled({ dataset_code: 'earn_ses_annual', dimension: 'geo' });
      const error = errorOf(result);
      expect(error.data).toMatchObject({ reason: 'upstream_fault' });
      expect((error.data.recovery as { hint: string }).hint).toBe(
        'Eurostat returned a structure this server cannot read, so the "geo" values of "earn_ses_annual" cannot be listed. A failed read is not cached, so retry in a few minutes. If it fails the same way, filter eurostat_query_dataset on the code in question: a code the dataset lacks comes back in unmatchedValues.',
      );
      expect(error.data.retryable).toBeUndefined();
      expect(textOf(result)).not.toContain('retryable');
    });

    it('names an HTTP 501 the structure endpoint answered, rather than an unreadable structure (#94)', async () => {
      const fetchMock = vi.fn(
        async () => new Response('Not Implemented', { status: 501, statusText: 'Not Implemented' }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await callSettled({ dataset_code: 'nama_10_gdp', dimension: 'unit' });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'upstream_fault' });
      expect(error.data.retryable).toBeUndefined();
      const hint = (error.data.recovery as { hint: string }).hint;
      expect(hint).toBe(
        'Eurostat\'s SDMX structure endpoint answered HTTP 501, a status this server does not retry on its own, so the "unit" values of "nama_10_gdp" cannot be listed. A failed read is not cached, so retry in a few minutes. If it fails the same way, filter eurostat_query_dataset on the code in question: a code the dataset lacks comes back in unmatchedValues.',
      );
      expect(hint).not.toContain('cannot read');
      const text = textOf(result);
      expect(text).toContain('answered HTTP 501 to the');
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).not.toContain('retryable');
      // One attempt per structure read: the fetch layer does not retry a 501.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('leaves a cancelled call as a cancellation, not an outage', async () => {
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          controller.abort();
          return new Response('Service Unavailable', { status: 503 });
        }),
      );
      const pending = runToolContract(
        eurostatGetDimensionValues,
        { dataset_code: 'nama_10_gdp', dimension: 'unit' },
        { context: { signal: controller.signal } },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const error = errorOf(await pending);
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.data?.reason).not.toBe('upstream_fault');
    });
  });

  it('describes the 501 refusal in the upstream_fault contract (#94)', () => {
    const when = eurostatGetDimensionValues.errors?.find(
      ({ reason }) => reason === 'upstream_fault',
    )?.when;
    expect(when).toContain('answered HTTP 501, which is not retried');
    expect(when).toContain('could not be reached on every retry, which the error marks retryable');
  });

  it('declares exactly the failures its metadata, paging and staging paths can raise', () => {
    expect(eurostatGetDimensionValues.errors?.map(({ reason }) => reason)).toEqual([
      'not_found',
      'no_results',
      'conflicting_params',
      'invalid_cursor',
      'upstream_fault',
      'canvas_not_found',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Paging and filtering over recorded value lists (#64). The fixtures under
// tests/fixtures/dimension-values/ are the code/label lists the data service
// returned on 2026-10-14: avia_par_de airp_pr, demo_r_pjangrp3 geo at nuts3,
// sbs_ovw_act nace_r2 and nama_10_gdp na_item whole, and DS-045409 product as
// two excerpts (values 11,300-11,899 and 16,000-16,199 of 37,069), which hold
// its longest labels, 29349990's 4,505 bytes among them.
// ---------------------------------------------------------------------------

type Value = { code: string; label: string };

function recordedValues(name: string): Value[] {
  const pairs = JSON.parse(
    readFileSync(new URL(`../fixtures/dimension-values/${name}.json`, import.meta.url), 'utf8'),
  ) as Array<[string, string]>;
  return pairs.map(([code, label]) => ({ code, label }));
}

/**
 * The data service answering with one recorded list, as getDimensionValues
 * returns it: for geo, at the level requested, country when none was. The
 * recorded list is all there is, so it is also the whole list a canvas stages.
 */
function serveList(values: Value[], dimension = { code: 'unit', label: 'Unit' }) {
  const getDimensionValues = vi.fn(
    async (_dataset: string, _dimension: string, geoLevel?: string) => ({
      dimensionCode:
        _dimension.toLowerCase() === dimension.code.toLowerCase() ||
        (_dimension.toLowerCase() === 'time_period' && dimension.code === 'time')
          ? dimension.code
          : _dimension,
      dimensionLabel: dimension.label,
      ...(dimension.code === 'geo' && { geoLevel: geoLevel ?? 'country' }),
      values: [...values],
      totalCount: values.length,
      listedValues:
        dimension.code === 'geo'
          ? values.map((value) => ({ ...value, level: geoLevel ?? 'country' }))
          : [...values],
    }),
  );
  vi.mocked(getEurostatDataService).mockReturnValue({ getDimensionValues } as never);
  return getDimensionValues;
}

describe('eurostatGetDimensionValues — paging and filtering recorded lists (#64)', () => {
  beforeEach(() => {
    setCanvas(undefined);
  });
  it('uses count pages regardless of label width, defaults to 25 and binds aliases canonically', async () => {
    const values = Array.from({ length: 80 }, (_, i) => ({
      code: `V${i}`,
      label: 'x'.repeat(40000),
    }));
    serveList(values, { code: 'unit', label: 'Unit' });
    const first = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo',
      dimension: 'UNIT',
    });
    expect((first.structuredContent as { values: Value[] }).values).toEqual(values.slice(0, 25));
    const cursor = (first.structuredContent as { nextCursor: string }).nextCursor;
    expect(decodeCursor(cursor, createMockContext())).toMatchObject({
      dimension: 'unit',
      limit: 25,
    });
    const second = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo',
      dimension: 'unit',
      cursor,
      limit: 5000,
    });
    expect(second.structuredContent).toMatchObject({ values: values.slice(25, 50) });
    expect(textOf(second)).toContain(values[49]?.label);
    expect((second.structuredContent as { notice: string }).notice).not.toContain('requested');
    const forty = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'demo',
      dimension: 'unit',
      limit: 40,
    });
    expect((forty.structuredContent as { values: Value[] }).values).toEqual(values.slice(0, 40));
  });

  it('returns a list within an explicit count whole, exactly as before', async () => {
    const naItem = recordedValues('nama-10-gdp-na-item');
    serveList(naItem, { code: 'na_item', label: 'National accounts indicator (ESA 2010)' });
    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'nama_10_gdp',
      dimension: 'na_item',
      limit: 39,
    });
    expect(result.structuredContent).toEqual({
      dimensionCode: 'na_item',
      dimensionLabel: 'National accounts indicator (ESA 2010)',
      values: naItem,
      totalCount: 39,
    });
    const text = textOf(result);
    expect(text).toContain('**Total values:** 39\n');
    expect(text).toContain(`- \`${naItem[38]?.code}\` — ${naItem[38]?.label}`);
    expect(text).not.toMatch(/nextCursor|truncated/);
  });

  type Result = Awaited<ReturnType<typeof runToolContract>>;
  type Page = {
    matchCount?: number;
    nextCursor?: string;
    notice?: string;
    totalCount: number;
    truncated?: boolean;
    values: Value[];
  };
  const body = (result: Result) => result.structuredContent as Page;
  const call = (input: Record<string, unknown>) =>
    runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'avia_par_de',
      dimension: 'airp_pr',
      ...input,
    } as never);

  /**
   * Every page from the first call to the last, following nextCursor and bounded so a loop
   * cannot run away; then one call past the end, with a cursor resuming after the last value
   * returned, which must answer an empty page that closes the list.
   */
  async function walk(input: Record<string, unknown>, maxPages = 200): Promise<Result[]> {
    const { limit: _ignored, ...rest } = input;
    const pages = [await call(input)];
    while (body(pages.at(-1) as Result).nextCursor) {
      if (pages.length >= maxPages) throw new Error(`more than ${maxPages} pages`);
      pages.push(await call({ ...rest, cursor: body(pages.at(-1) as Result).nextCursor }));
    }
    expect(pages.length, 'the walk never left the first page').toBeGreaterThan(1);

    const issued = decodeCursor(
      body(pages.at(-2) as Result).nextCursor as string,
      createMockContext(),
    );
    const lastCode = body(pages.at(-1) as Result).values.at(-1)?.code;
    const past = await call({ ...rest, cursor: encodeCursor({ ...issued, after: lastCode }) });
    const { dataset_code = 'avia_par_de', dimension = 'airp_pr' } = rest as {
      dataset_code?: string;
      dimension?: string;
    };
    expect(past.isError).not.toBe(true);
    expect(body(past).values).toEqual([]);
    expect(body(past)).not.toHaveProperty('nextCursor');
    expect(body(past)).not.toHaveProperty('truncated');
    expect(body(past).notice).toBe(
      `No "${dimension}" values of "${dataset_code}" follow the code this cursor resumes after: the list ends there.`,
    );
    return pages;
  }

  /** Every page is a success within its count, cut pages say so, and the last closes the walk. */
  function expectWellFormedWalk(pages: Result[]) {
    for (const [i, page] of pages.entries()) {
      expect(page.isError).not.toBe(true);
      expect(body(page).values.length).toBeLessThanOrEqual(1000);
      const last = i === pages.length - 1;
      expect(body(page).truncated).toBe(last ? undefined : true);
      if (!last) {
        expect(body(page).values.length).toBeGreaterThan(0);
        expect(textOf(page)).toContain(`**nextCursor:** \`${body(page).nextCursor}\``);
      }
    }
  }

  const airports = recordedValues('avia-par-de-airp-pr');
  const airportDimension = { code: 'airp_pr', label: 'Airport pairs' };
  const frankfurt = airports.filter(({ label }) => /frankfurt/i.test(label));

  it('walks all 2,352 avia_par_de airport pairs through nextCursor, each once, in Eurostat order', async () => {
    serveList(airports, airportDimension);
    const pages = await walk({});
    expectWellFormedWalk(pages);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => body(page).values)).toEqual(airports);
    expect(body(pages[0] as Result)).toMatchObject({ totalCount: 2_352, truncated: true });
    expect(body(pages[0] as Result).notice).toContain('limit 25 ended this page');
    expect(body(pages[0] as Result).values).toHaveLength(25);
    expect(textOf(pages.at(-1) as Result)).not.toMatch(/nextCursor|truncated/);
    // Pagination disclosures reach the content surface too.
    const { nextCursor, notice } = body(pages[0] as Result);
    expect((pages[0] as Result).content.at(-1)).toEqual({
      type: 'text',
      text: `\n\n**truncated:** true\n**nextCursor:** \`${nextCursor}\`\n> ${notice}`,
    });
  });

  it('returns count-sized product pages, preserving the 4,505-byte label intact', async () => {
    const products = recordedValues('ds-045409-product-excerpt');
    serveList(products, { code: 'product', label: 'Product (CN8)' });
    const pages = await walk({ dataset_code: 'DS-045409', dimension: 'product' });
    expectWellFormedWalk(pages);
    expect(pages.flatMap((page) => body(page).values)).toEqual(products);

    const holding = pages.find((page) =>
      body(page).values.some(({ code }) => code === '29349990'),
    ) as Result;
    const long = products.find(({ code }) => code === '29349990') as Value;
    expect(Buffer.byteLength(long.label, 'utf8')).toBe(4_505);
    expect(textOf(holding)).toContain(long.label);
    const lengths = pages.slice(0, -1).map((page) => body(page).values.length);
    expect(new Set(lengths)).toEqual(new Set([25]));
  });

  it.each(['frankfurt palma', 'palma frankfurt'])(
    'finds the Frankfurt–Palma pairs with filter "%s", in any word order',
    async (filter) => {
      serveList(airports, airportDimension);
      const result = await call({ filter });
      expect(body(result)).toEqual({
        dimensionCode: 'airp_pr',
        dimensionLabel: 'Airport pairs',
        values: [
          { code: 'DE_EDDF_ES_LECP', label: 'FRANKFURT/MAIN airport - PALMA TACC airport' },
          { code: 'DE_EDDF_ES_LEPA', label: 'FRANKFURT/MAIN airport - PALMA DE MALLORCA airport' },
          { code: 'DE_EDFH_ES_LEPA', label: 'FRANKFURT-HAHN airport - PALMA DE MALLORCA airport' },
        ],
        totalCount: 2_352,
        matchCount: 3,
      });
      const text = textOf(result);
      expect(text).toContain('**Total values:** 2352\n**Matching:** 3\n');
      expect(text).toContain(
        '- `DE_EDFH_ES_LEPA` — FRANKFURT-HAHN airport - PALMA DE MALLORCA airport',
      );
    },
  );

  it('matches the code and label joined by a space, never a word spanning the two', async () => {
    serveList(airports, airportDimension);
    expect(body(await call({ filter: 'de_eddf' })).matchCount).toBe(316);
    expect(body(await call({ filter: 'LEPAFRANKFURT' })).matchCount).toBe(0);
    expect(
      body(await call({ filter: 'frankfurt/main lepa' })).values.map(({ code }) => code),
    ).toEqual(['DE_EDDF_ES_LEPA']);
  });

  it('pages a filtered list at limit: 20 of 428 FRANKFURT matches, then the rest through nextCursor', async () => {
    serveList(airports, airportDimension);
    const first = await call({ filter: 'FRANKFURT', limit: 20 });
    expect(body(first).values).toEqual(frankfurt.slice(0, 20));
    expect(body(first)).toMatchObject({ matchCount: 428, totalCount: 2_352, truncated: true });
    expect(body(first).nextCursor).toEqual(expect.any(String));
    expect(body(first).notice).toContain(
      'Values 1–20 of 428 values matching filter "FRANKFURT", in Eurostat\'s order; limit 20 ended this page.',
    );
    expect(textOf(first)).toContain('**Matching:** 428 — 20 listed below');
    expect(textOf(first)).toContain(`> ${body(first).notice}`);

    const pages = await walk({ filter: 'FRANKFURT', limit: 20 });
    expectWellFormedWalk(pages);
    expect(pages.map((page) => body(page).values.length)).toEqual([...Array(21).fill(20), 8]);
    expect(pages.flatMap((page) => body(page).values)).toEqual(frankfurt);
  });

  it('ends an exactly full final page without a further cursor', async () => {
    serveList(airports, airportDimension);
    const pages = await walk({ filter: 'frankfurt', limit: 107 });
    expect(pages.map((page) => body(page).values.length)).toEqual([107, 107, 107, 107]);
    expectWellFormedWalk(pages);
    expect(body(pages[3] as Result)).not.toHaveProperty('nextCursor');
    expect(body(pages[3] as Result)).not.toHaveProperty('notice');
  });

  it('carries the first call’s limit in the cursor, ignoring a different limit sent beside it', async () => {
    serveList(airports, airportDimension);
    const first = await call({ filter: 'frankfurt', limit: 20 });
    const second = await call({
      filter: 'frankfurt',
      limit: 5,
      cursor: body(first).nextCursor,
    });
    expect(body(second).values).toEqual(frankfurt.slice(20, 40));

    const unlimited = await call({});
    const next = await call({ limit: 3, cursor: body(unlimited).nextCursor });
    expect(body(next).values.length).toBeGreaterThan(3);
    expect(body(next).values).toHaveLength(25);
    expect(body(next).notice).toContain('limit 25 ended this page');
  });

  it('folds accents and case: "zurich" finds CH040 Zürich among the NUTS-3 regions', async () => {
    serveList(recordedValues('demo-r-pjangrp3-geo-nuts3'), {
      code: 'geo',
      label: 'Geopolitical entity (reporting)',
    });
    const result = await call({
      dataset_code: 'demo_r_pjangrp3',
      dimension: 'geo',
      geo_level: 'nuts3',
      filter: 'zurich',
    });
    expect(body(result)).toMatchObject({
      geoLevel: 'nuts3',
      values: [{ code: 'CH040', label: 'Zürich' }],
      totalCount: 1_621,
      matchCount: 1,
    });
    expect(
      body(
        await call({
          dataset_code: 'demo_r_pjangrp3',
          dimension: 'geo',
          geo_level: 'nuts3',
          filter: 'KOLN',
        }),
      ).values,
    ).toEqual([{ code: 'DEA23', label: 'Köln, Kreisfreie Stadt' }]);
  });

  it('answers a filter that matches nothing with an empty page, matchCount 0, and a notice echoing it', async () => {
    serveList(airports, airportDimension);
    const result = await call({ filter: '  münchen   lepa ' });
    expect(result.isError).not.toBe(true);
    expect(body(result)).toMatchObject({ values: [], totalCount: 2_352, matchCount: 0 });
    expect(body(result)).not.toHaveProperty('truncated');
    expect(body(result)).not.toHaveProperty('nextCursor');
    expect(body(result).notice).toContain('matched filter "münchen lepa"');
    expect(textOf(result)).toContain('**Matching:** 0');
    expect(textOf(result)).toContain(`> ${body(result).notice}`);
  });

  it('words the empty-filter notice without a canvas exactly as before (characterization)', async () => {
    serveList(airports, airportDimension);
    expect(body(await call({ filter: 'münchen lepa' })).notice).toBe(
      'No "airp_pr" value of "avia_par_de" matched filter "münchen lepa": every word must appear in a value\'s code or label, in any order, ignoring case and accents. Drop or shorten a word, or call without filter to page through all 2,352.',
    );
  });

  it('pages on with canvas_id beside cursor where there is no canvas, ignoring canvas_id as documented', async () => {
    serveList(airports, airportDimension);
    const first = await call({ limit: 5 });
    const result = await call({ canvas_id: 'Zz9Zz9Zz9Z', cursor: body(first).nextCursor });
    expect(result.isError).not.toBe(true);
    expect(body(result).values).toEqual(airports.slice(5, 10));
    expect(body(result)).toMatchObject({ totalCount: 2_352, truncated: true });
    expect(result.structuredContent).not.toHaveProperty('canvasId');
    expect(result.structuredContent).not.toHaveProperty('tableName');
    expect(textOf(result)).not.toMatch(/staged|canvas_id/i);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \t '],
  ])('treats a filter that is %s as omitted', async (_label, filter) => {
    serveList(airports, airportDimension);
    const plain = await call({});
    const blank = await call({ filter });
    expect(blank.structuredContent).toEqual(plain.structuredContent);
    expect(body(blank)).not.toHaveProperty('matchCount');
  });

  it.each([
    [
      'demo_r_pjangrp3 NUTS-3 geo (1,621 values)',
      'demo-r-pjangrp3-geo-nuts3',
      { dataset_code: 'demo_r_pjangrp3', dimension: 'geo', geo_level: 'nuts3' },
      1_621,
    ],
    [
      'sbs_ovw_act nace_r2 (920 values)',
      'sbs-ovw-act-nace-r2',
      { dataset_code: 'sbs_ovw_act', dimension: 'nace_r2' },
      920,
    ],
  ])('pages %s with a fixed default count', async (_label, fixture, input, total) => {
    const values = recordedValues(fixture);
    serveList(values, { code: input.dimension, label: input.dimension });
    const pages = await walk(input);
    expectWellFormedWalk(pages);
    expect(pages.length).toBe(Math.ceil(total / 25));
    expect(pages.flatMap((page) => body(page).values)).toEqual(values);
    const first = body(pages[0] as Result);
    expect(first.totalCount).toBe(total);
    expect(first.notice).toContain('Pass nextCursor as cursor for the next page');
    expect(first.notice).toContain('pass filter (words of the code or label)');
    // Without a canvas on this deployment, canvas_id is not offered as a route.
    expect(first.notice).not.toContain('canvas_id');
  });

  it('pages wide labels by the requested count without cutting any label', async () => {
    const values = [
      { code: 'A', label: 'x'.repeat(70_000) },
      { code: 'B', label: 'Bee' },
      { code: 'C', label: 'Cee' },
    ];
    serveList(values);
    const first = await call({ dataset_code: 'demo', dimension: 'unit', limit: 1 });
    expect(body(first).values).toEqual([values[0]]);
    expect(body(first).truncated).toBe(true);
    const second = await call({
      dataset_code: 'demo',
      dimension: 'unit',
      cursor: body(first).nextCursor,
    });
    expect(body(second).values).toEqual(values.slice(1, 2));
    const third = await call({
      dataset_code: 'demo',
      dimension: 'unit',
      cursor: body(second).nextCursor,
    });
    expect(body(third).values).toEqual(values.slice(2));
    expect(body(third)).not.toHaveProperty('nextCursor');
  });

  it('keeps exactly 1,000 values whole and clamps 1,001 with disclosure on both surfaces', async () => {
    const values = Array.from({ length: 1_001 }, (_, i) => ({
      code: `V${String(i).padStart(4, '0')}`,
      label: `Value ${i}`,
    }));
    serveList(values);
    const cut = await call({ dataset_code: 'demo', dimension: 'unit', limit: 1001 });
    expect(body(cut).truncated).toBe(true);
    expect(body(cut).values).toEqual(values.slice(0, 1000));
    expect(body(cut).notice).toContain('limit requested 1001; applied 1000');
    expect(textOf(cut)).toContain(body(cut).notice);
    const end = await call({
      dataset_code: 'demo',
      dimension: 'unit',
      cursor: body(cut).nextCursor,
    });
    expect(body(end).values).toEqual(values.slice(1000));
    expect(body(end)).not.toHaveProperty('nextCursor');
  });
  it.each([40, 5000, Number.MAX_SAFE_INTEGER])(
    'accepts a legacy cursor limit %s and encodes the effective successor count',
    async (legacyLimit) => {
      const values = Array.from({ length: 2100 }, (_, i) => ({
        code: `V${i}`,
        label: `Value ${i}`,
      }));
      serveList(values, { code: 'airp_pr', label: 'Airport pairs' });
      const cursor = encodeCursor({
        offset: 1,
        limit: legacyLimit,
        after: 'V0',
        dataset: 'avia_par_de',
        dimension: 'airp_pr',
        filter: '',
        geoLevel: null,
      });
      const result = await call({ cursor, limit: 9000 });
      const effective = Math.min(legacyLimit, 1000);
      expect(body(result).values).toEqual(values.slice(1, effective + 1));
      expect(decodeCursor(body(result).nextCursor as string, createMockContext()).limit).toBe(
        effective,
      );
      if (legacyLimit > 1000) {
        expect(body(result).notice).toContain(`limit requested ${legacyLimit}; applied 1000`);
        expect(textOf(result)).toContain(body(result).notice);
      } else {
        expect(body(result).notice).not.toContain('requested');
      }
    },
  );

  describe('a cursor that does not belong to the call', () => {
    const invalid = (result: Result) => {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'invalid_cursor',
            recovery: { hint: expect.stringContaining('without cursor') },
          },
        },
      });
      expect(textOf(result)).toContain('reason invalid_cursor');
    };

    it.each([
      ['not base64 JSON', 'not-a-cursor'],
      ['JSON without the paging fields', Buffer.from('{"after":"X"}').toString('base64url')],
    ])('refuses a malformed cursor (%s)', async (_label, cursor) => {
      serveList(airports, airportDimension);
      invalid(await call({ cursor }));
    });

    it.each([
      ['dataset_code', { dataset_code: 'avia_par_uk' }],
      ['dimension', { dimension: 'airp_pr_x' }],
      ['filter', { filter: 'frankfurt main' }],
    ])('refuses a cursor replayed with a different %s', async (_label, change) => {
      serveList(airports, airportDimension);
      const first = await call({ filter: 'frankfurt', limit: 5 });
      expect(body(first).nextCursor).toEqual(expect.any(String));
      // The same cursor with nothing changed still works.
      expect(
        (await call({ filter: 'frankfurt', cursor: body(first).nextCursor })).isError,
      ).not.toBe(true);
      invalid(await call({ filter: 'frankfurt', ...change, cursor: body(first).nextCursor }));
    });

    it.each([
      ['malformed', { cursor: 'not-a-cursor' }],
      ['replayed with a different dataset_code', { dataset_code: 'avia_par_uk' }],
      ['replayed with a different filter', { filter: 'frankfurt main' }],
    ])('refuses a cursor %s without loading the dimension list', async (_label, change) => {
      const getDimensionValues = serveList(airports, airportDimension);
      const first = await call({ filter: 'frankfurt', limit: 5 });
      getDimensionValues.mockClear();
      invalid(await call({ filter: 'frankfurt', cursor: body(first).nextCursor, ...change }));
      expect(getDimensionValues).not.toHaveBeenCalled();
    });

    it('binds a geo cursor to the level the list resolves, so omitted and "country" are one level', async () => {
      const regions = recordedValues('demo-r-pjangrp3-geo-nuts3');
      serveList(regions, { code: 'geo', label: 'Geo' });
      const geo = { dataset_code: 'demo_r_pjangrp3', dimension: 'geo' };
      const levels = [{}, { geo_level: 'country' }];
      for (const issuedAt of levels) {
        const { nextCursor } = body(await call({ ...geo, ...issuedAt, limit: 5 }));
        for (const replayedAt of levels) {
          const next = await call({ ...geo, ...replayedAt, cursor: nextCursor });
          expect(next.isError).not.toBe(true);
          expect(body(next).values).toEqual(regions.slice(5, 10));
        }
        invalid(await call({ ...geo, geo_level: 'nuts3', cursor: nextCursor }));
      }
    });

    it.each([
      ['another level', { geo_level: 'nuts2' }],
      ['the omitted default, country', {}],
    ])('refuses a geo cursor replayed at %s', async (_label, change) => {
      serveList(recordedValues('demo-r-pjangrp3-geo-nuts3'), { code: 'geo', label: 'Geo' });
      const geo = { dataset_code: 'demo_r_pjangrp3', dimension: 'geo' };
      const first = await call({ ...geo, geo_level: 'nuts3', limit: 5 });
      expect(
        (await call({ ...geo, geo_level: 'nuts3', cursor: body(first).nextCursor })).isError,
      ).not.toBe(true);
      invalid(await call({ ...geo, ...change, cursor: body(first).nextCursor }));
    });

    it('accepts the dataset code in another case, as the data service does', async () => {
      serveList(airports, airportDimension);
      const first = await call({ limit: 5 });
      const next = await call({ dataset_code: 'AVIA_PAR_DE', cursor: body(first).nextCursor });
      expect(body(next).values).toEqual(airports.slice(5, 10));
    });

    it('refuses a cursor whose last code the list no longer holds', async () => {
      serveList(airports, airportDimension);
      const first = await call({ limit: 5 });
      serveList(
        airports.filter(({ code }) => code !== airports[4]?.code),
        airportDimension,
      );
      const result = await call({ cursor: body(first).nextCursor });
      invalid(result);
      expect(textOf(result)).toContain(`resumes after "${airports[4]?.code}"`);
    });

    it('resumes after the cursor’s code wherever the list now puts it', async () => {
      serveList(airports, airportDimension);
      const first = await call({ limit: 5 });
      serveList([{ code: 'AA_NEW', label: 'Added' }, ...airports], airportDimension);
      const next = await call({ cursor: body(first).nextCursor });
      expect(body(next).values).toEqual(airports.slice(5, 10));
    });

    it('answers an empty page when nothing follows the cursor’s code any more', async () => {
      serveList(airports, airportDimension);
      const first = await call({ limit: 5 });
      serveList(airports.slice(0, 5), airportDimension);
      const result = await call({ cursor: body(first).nextCursor });
      expect(result.isError).not.toBe(true);
      expect(body(result).values).toEqual([]);
      expect(body(result)).not.toHaveProperty('nextCursor');
      expect(body(result).notice).toContain('the list ends there');
    });
  });
});

describe('eurostatGetDimensionValues — paging beside a canvas (#64)', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(() => {
    setCanvas(canvas);
    serveList(recordedValues('avia-par-de-airp-pr'), { code: 'airp_pr', label: 'Airport pairs' });
  });
  afterEach(() => {
    setCanvas(undefined);
    vi.restoreAllMocks();
  });

  const call = (input: Record<string, unknown>) =>
    runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'avia_par_de',
      dimension: 'airp_pr',
      ...input,
    } as never);

  it('names nextCursor, filter and canvas_id as the routes past a cut page', async () => {
    const notice = (await call({})).structuredContent as { notice: string };
    expect(notice.notice).toContain('Pass nextCursor as cursor');
    expect(notice.notice).toContain('pass filter');
    expect(notice.notice).toContain('pass canvas_id');
  });

  it('stages every value whatever filter and limit narrow the page to', async () => {
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId: 'default' }));
    const result = await call({ canvas_id: instance.canvasId, filter: 'frankfurt', limit: 20 });
    const body = result.structuredContent as {
      matchCount: number;
      notice: string;
      stagedRowCount: number;
      tableName: string;
      totalCount: number;
      values: unknown[];
    };
    expect(body.values).toHaveLength(20);
    expect(body).toMatchObject({ matchCount: 428, totalCount: 2_352, stagedRowCount: 2_352 });
    const counted = await instance.query(`SELECT count(*) AS n FROM ${body.tableName}`);
    expect(counted.rows).toEqual([{ n: '2352' }]);
    expect(body.notice).toContain(`staged as table \`${body.tableName}\``);
  });

  it('refuses canvas_id beside cursor as conflicting_params, staging nothing', async () => {
    const first = (await call({ limit: 5 })).structuredContent as { nextCursor: string };
    const acquire = vi.spyOn(canvas, 'acquire');
    const result = await call({ canvas_id: 'Zz9Zz9Zz9Z', cursor: first.nextCursor });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'conflicting_params',
          recovery: { hint: expect.stringContaining('Drop canvas_id') },
        },
      },
    });
    expect(textOf(result)).toContain('reason conflicting_params');
    expect(acquire).not.toHaveBeenCalled();
    // The first call may not have staged anything, so the hint claims no table exists.
    expect(
      (result.structuredContent as { error: { data: { recovery: { hint: string } } } }).error.data
        .recovery.hint,
    ).toBe(
      'Drop canvas_id to keep paging with cursor; a first call that carried canvas_id has already staged every value. To stage the list now, call again with canvas_id and without cursor.',
    );
  });

  it('words the empty-filter notice as before when canvas_id was not passed (characterization)', async () => {
    const notice = (
      (await call({ filter: 'münchen lepa' })).structuredContent as { notice: string }
    ).notice;
    expect(notice).toBe(
      'No "airp_pr" value of "avia_par_de" matched filter "münchen lepa": every word must appear in a value\'s code or label, in any order, ignoring case and accents. Drop or shorten a word, or call without filter to page through all 2,352.',
    );
  });

  it('points a filter that matched nothing at the table it staged, on both surfaces', async () => {
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId: 'default' }));
    const result = await call({ canvas_id: instance.canvasId, filter: 'münchen lepa' });
    const body = result.structuredContent as {
      matchCount: number;
      notice: string;
      stagedRowCount: number;
      tableName: string;
      values: unknown[];
    };
    expect(body).toMatchObject({ values: [], matchCount: 0, stagedRowCount: 2_352 });
    expect(body.notice).toBe(
      `No "airp_pr" value of "avia_par_de" matched filter "münchen lepa": every word must appear in a value's code or label, in any order, ignoring case and accents. Drop or shorten a word, or search all 2,352 values, staged as table \`${body.tableName}\` on canvas \`${instance.canvasId}\`, with eurostat_dataframe_query (e.g. \`SELECT code, label FROM ${body.tableName} WHERE label ILIKE '%term%'\`).`,
    );
    expect(textOf(result)).toContain(`> ${body.notice}`);
    // The SQL the notice offers runs against the staged table as written.
    const offered = await instance.query(
      `SELECT code, label FROM ${body.tableName} WHERE label ILIKE '%palma de mallorca%'`,
    );
    expect(offered.rows).toContainEqual({
      code: 'DE_EDDF_ES_LEPA',
      label: 'FRANKFURT/MAIN airport - PALMA DE MALLORCA airport',
    });
  });

  it.each([
    [
      'a cut page',
      {},
      (table: string) =>
        `Every one of the 2,352 values is staged as table \`${table}\` on canvas \`${EMPHASIS_ID}\` — search it with eurostat_dataframe_query (e.g. \`SELECT code, label FROM ${table} WHERE label ILIKE '%term%'\`).`,
    ],
    [
      'a filter that matched nothing',
      { filter: 'münchen lepa' },
      (table: string) =>
        `search all 2,352 values, staged as table \`${table}\` on canvas \`${EMPHASIS_ID}\`, with eurostat_dataframe_query (e.g. \`SELECT code, label FROM ${table} WHERE label ILIKE '%term%'\`).`,
    ],
  ])(
    'renders the canvas ID, table name and SQL as code spans after %s',
    async (_, extra, expected) => {
      setCanvas(await underId(canvas, EMPHASIS_ID));
      const result = await call({ canvas_id: EMPHASIS_ID, ...extra });
      const body = result.structuredContent as {
        canvasId: string;
        notice: string;
        tableName: string;
      };
      expect(body.canvasId).toBe(EMPHASIS_ID);
      expect(body.notice).toContain(expected(body.tableName));
      expect(textOf(result)).toContain(expected(body.tableName));
    },
  );
});

describe('eurostatGetDimensionValues — a geo list of countries alone on a canvas', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;

  beforeAll(() => {
    ({ canvas, teardown } = withRealCanvas());
  });
  afterAll(async () => {
    await teardown();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stages it without the every-level notice, which only a list holding other levels earns', async () => {
    const listed = [
      { code: 'DE', label: 'Germany', level: 'country' as const },
      { code: 'FR', label: 'France', level: 'country' as const },
    ];
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDimensionValues: vi.fn().mockResolvedValue({
        dimensionCode: 'geo',
        dimensionLabel: 'Geopolitical entity (reporting)',
        geoLevel: 'country',
        values: listed.map(({ code, label }) => ({ code, label })),
        totalCount: 2,
        listedValues: listed,
      }),
    } as never);
    const { canvasId } = await canvas.acquire(
      undefined,
      createMockContext({ tenantId: 'default' }),
    );

    const result = await runToolContract(eurostatGetDimensionValues, {
      dataset_code: 'country_only',
      dimension: 'geo',
      canvas_id: canvasId,
    } as never);

    const body = result.structuredContent as { notice?: string; stagedRowCount: number };
    expect(body.stagedRowCount).toBe(2);
    expect(body.notice).toBeUndefined();
    expect(textOf(result)).not.toContain('every geo level');
  });
});
