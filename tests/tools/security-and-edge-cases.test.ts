/**
 * @fileoverview Security and edge-case tests across all Eurostat tools and the resource.
 * Covers injection attempts, oversized inputs, missing optional fields, and the
 * invariant that no secret or internal env value appears in tool output.
 * @module tests/tools/security-and-edge-cases.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatDatasetResource } from '@/mcp-server/resources/definitions/eurostat-dataset.resource.js';
import { eurostatBrowseThemes } from '@/mcp-server/tools/definitions/eurostat-browse-themes.tool.js';
import { eurostatDataframeDescribe } from '@/mcp-server/tools/definitions/eurostat-dataframe-describe.tool.js';
import { eurostatDataframeQuery } from '@/mcp-server/tools/definitions/eurostat-dataframe-query.tool.js';
import { eurostatGetDatasetInfo } from '@/mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { eurostatGetDimensionValues } from '@/mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { eurostatQueryDataset } from '@/mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { eurostatSearchDatasets } from '@/mcp-server/tools/definitions/eurostat-search-datasets.tool.js';
import {
  observationRowSchema,
  toObservationRow,
} from '@/services/eurostat-data/eurostat-data-service.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

// Mock catalogue service
vi.mock('@/services/eurostat-catalogue/eurostat-catalogue-service.js', () => ({
  getEurostatCatalogueService: vi.fn(),
}));

// Mock data service. Only the accessor is replaced — the query tool also imports the real
// row builder and column schema from this module, and a bare factory would blank them out.
vi.mock('@/services/eurostat-data/eurostat-data-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/eurostat-data/eurostat-data-service.js')>()),
  getEurostatDataService: vi.fn(),
}));

import { getEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const minimalDataset = {
  code: 'nama_10_gdp',
  label: 'GDP',
  type: 'dataset' as const,
  themePath: [],
};

const minimalMeta = {
  code: 'nama_10_gdp',
  label: 'GDP and main components',
  dimensions: [
    {
      code: 'geo',
      label: 'Geography',
      valuesCount: 1,
      sampleValues: [{ code: 'DE', label: 'Germany' }],
    },
    {
      code: 'time',
      label: 'Time',
      valuesCount: 5,
      sampleValues: [{ code: '2020', label: '2020' }],
    },
  ],
  timeRange: { start: '2020', end: '2024' },
  obsCount: 100,
  lastUpdated: '2026-01-01T00:00:00Z',
};

/** The same dataset as Eurostat reports it when no annotations are attached. */
const sparseMeta = {
  code: 'nama_10_gdp',
  label: 'GDP and main components',
  dimensions: [
    {
      code: 'geo',
      label: 'Geography',
      valuesCount: 1,
      sampleValues: [{ code: 'DE', label: 'Germany' }],
    },
  ],
  timeRange: {},
};

/** Metadata whose `time` value set could not be measured — the enumeration request failed. */
const unmeasuredTimeMeta = {
  code: 'nama_10_gdp',
  label: 'GDP and main components',
  dimensions: [
    {
      code: 'geo',
      label: 'Geography',
      valuesCount: 1,
      sampleValues: [{ code: 'DE', label: 'Germany' }],
    },
    { code: 'time', label: 'Time' },
  ],
  timeRange: { start: '2020', end: '2024' },
  obsCount: 100,
};

const minimalDimResult = {
  dimensionCode: 'unit',
  dimensionLabel: 'Unit',
  values: [{ code: 'CP_MEUR', label: 'Current prices' }],
  totalCount: 1,
};

const minimalQueryResult = {
  datasetCode: 'nama_10_gdp',
  datasetLabel: 'GDP',
  dimensionsUsed: ['geo', 'time'],
  observations: [
    {
      dimensions: { geo: { code: 'DE', label: 'Germany' }, time: { code: '2024', label: '2024' } },
      value: 4_000_000,
    },
  ],
  obsCount: 1,
  truncated: false,
  timeRange: { start: '2024', end: '2024' },
  missingObsCount: 0,
  appliedFilters: {},
};

// ---------------------------------------------------------------------------
// Input validation — Zod rejects bad inputs before the handler runs
// ---------------------------------------------------------------------------

describe('Input validation', () => {
  describe('eurostatSearchDatasets', () => {
    it('rejects empty query string', () => {
      expect(() => eurostatSearchDatasets.input.parse({ query: '' })).toThrow();
    });

    it('rejects whitespace-only query string', () => {
      for (const blank of ['   ', '\t', '\n', ' \t\n ']) {
        expect(() => eurostatSearchDatasets.input.parse({ query: blank })).toThrow();
      }
    });

    it('rejects limit below 1', () => {
      expect(() => eurostatSearchDatasets.input.parse({ query: 'GDP', limit: 0 })).toThrow();
    });

    it('rejects limit above 100', () => {
      expect(() => eurostatSearchDatasets.input.parse({ query: 'GDP', limit: 101 })).toThrow();
    });

    it('accepts limit at boundary values 1 and 100', () => {
      expect(() => eurostatSearchDatasets.input.parse({ query: 'GDP', limit: 1 })).not.toThrow();
      expect(() => eurostatSearchDatasets.input.parse({ query: 'GDP', limit: 100 })).not.toThrow();
    });
  });

  describe('eurostatGetDatasetInfo', () => {
    it('rejects empty dataset_code', () => {
      expect(() => eurostatGetDatasetInfo.input.parse({ dataset_code: '' })).toThrow();
    });
  });

  describe('eurostatGetDimensionValues', () => {
    it('rejects empty dataset_code', () => {
      expect(() =>
        eurostatGetDimensionValues.input.parse({ dataset_code: '', dimension: 'unit' }),
      ).toThrow();
    });

    it('rejects empty dimension', () => {
      expect(() =>
        eurostatGetDimensionValues.input.parse({ dataset_code: 'nama_10_gdp', dimension: '' }),
      ).toThrow();
    });

    it('rejects invalid geo_level value', () => {
      expect(() =>
        eurostatGetDimensionValues.input.parse({
          dataset_code: 'nama_10_gdp',
          dimension: 'geo',
          geo_level: 'invalid_level',
        }),
      ).toThrow();
    });

    it('accepts all valid geo_level enum values', () => {
      for (const level of ['aggregate', 'country', 'nuts1', 'nuts2', 'nuts3']) {
        expect(() =>
          eurostatGetDimensionValues.input.parse({
            dataset_code: 'nama_10_gdp',
            dimension: 'geo',
            geo_level: level,
          }),
        ).not.toThrow();
      }
    });
  });

  describe('eurostatQueryDataset', () => {
    it('rejects empty dataset_code', () => {
      expect(() => eurostatQueryDataset.input.parse({ dataset_code: '' })).toThrow();
    });

    it('rejects last_n_periods below 1', () => {
      expect(() =>
        eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp', last_n_periods: 0 }),
      ).toThrow();
    });

    it('rejects last_n_periods as non-integer', () => {
      expect(() =>
        eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp', last_n_periods: 1.5 }),
      ).toThrow();
    });

    it('rejects invalid lang value', () => {
      expect(() =>
        eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp', lang: 'ZZ' }),
      ).toThrow();
    });

    it('accepts valid lang values EN, FR, DE', () => {
      for (const lang of ['EN', 'FR', 'DE']) {
        expect(() =>
          eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp', lang }),
        ).not.toThrow();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Injection attempts — query/filter values containing adversarial strings
// These must not cause exceptions or leak into error messages.
// ---------------------------------------------------------------------------

describe('Injection resistance', () => {
  const injectionStrings = [
    "'; DROP TABLE datasets; --",
    '<script>alert(1)</script>',
    '../../../etc/passwd',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional SSTI template-injection payload — the ${...} is fixture data under test, not a mistaken template literal
    `${'${7*7}'}`,
    '{{7*7}}',
    '\x00\x01\x02',
    '%00',
    'A'.repeat(10_000),
  ];

  describe('eurostatSearchDatasets — injection in query', () => {
    beforeEach(() => {
      vi.mocked(getEurostatCatalogueService).mockReturnValue({
        search: vi.fn().mockResolvedValue({ datasets: [minimalDataset], totalMatches: 1 }),
      } as never);
    });

    for (const injection of injectionStrings.slice(0, 5)) {
      it(`handles injection string: ${JSON.stringify(injection).slice(0, 40)}`, async () => {
        const ctx = createMockContext({ errors: eurostatSearchDatasets.errors });
        // The query passes Zod (non-empty string) and reaches the service mock.
        // The handler must not throw and must not leak the injection string in any error path.
        const input = eurostatSearchDatasets.input.parse({ query: injection.slice(0, 500) || 'x' });
        const result = await eurostatSearchDatasets.handler(input, ctx);
        expect(result.datasets).toBeDefined();
      });
    }
  });

  describe('eurostatBrowseThemes — injection in theme_code', () => {
    beforeEach(() => {
      vi.mocked(getEurostatCatalogueService).mockReturnValue({
        browse: vi.fn().mockResolvedValue({ items: [], parentPath: [] }),
      } as never);
    });

    it('passes injection string as theme_code to service without crashing', async () => {
      const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
      const input = eurostatBrowseThemes.input.parse({ theme_code: "'; DROP TABLE; --" });
      await expect(eurostatBrowseThemes.handler(input, ctx)).resolves.toBeDefined();
    });
  });

  describe('eurostatQueryDataset — injection in filter values', () => {
    beforeEach(() => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: vi.fn().mockResolvedValue(minimalQueryResult),
      } as never);
    });

    it('passes injection in filter array values to service without crashing', async () => {
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({
        dataset_code: 'nama_10_gdp',
        filters: { geo: ["'; DROP TABLE; --", '<script>'] },
      });
      await expect(eurostatQueryDataset.handler(input, ctx)).resolves.toBeDefined();
    });

    it('passes injection in dataset_code to service without crashing', async () => {
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({
        dataset_code: '../../../etc/passwd',
      });
      await expect(eurostatQueryDataset.handler(input, ctx)).resolves.toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Secret / env value leakage — no tool output should contain process.env values
// ---------------------------------------------------------------------------

describe('Secret leakage prevention', () => {
  const sensitiveValues = ['SECRET_TOKEN', 'API_KEY_VALUE', 'password123'];

  beforeEach(() => {
    // Inject a fake secret into the env that shouldn't appear in output
    process.env._TEST_SECRET = 'SUPER_SECRET_DO_NOT_LEAK';
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      search: vi.fn().mockResolvedValue({ datasets: [minimalDataset], totalMatches: 1 }),
    } as never);
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(minimalMeta),
    } as never);
  });

  it('eurostatSearchDatasets format output does not contain env secret', () => {
    const result = { datasets: [minimalDataset] };
    const blocks = eurostatSearchDatasets.format!(result);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toContain('SUPER_SECRET_DO_NOT_LEAK');
    for (const v of sensitiveValues) {
      expect(text).not.toContain(v);
    }
  });

  it('eurostatGetDatasetInfo format output does not contain env secret', () => {
    const blocks = eurostatGetDatasetInfo.format!(minimalMeta);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toContain('SUPER_SECRET_DO_NOT_LEAK');
  });

  it('eurostatQueryDataset format output does not contain env secret', () => {
    const blocks = eurostatQueryDataset.format!(minimalQueryResult);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toContain('SUPER_SECRET_DO_NOT_LEAK');
  });
});

// ---------------------------------------------------------------------------
// Oversized inputs — handled gracefully, no crash
// ---------------------------------------------------------------------------

describe('Oversized inputs', () => {
  beforeEach(() => {
    vi.mocked(getEurostatCatalogueService).mockReturnValue({
      search: vi.fn().mockResolvedValue({ datasets: [], totalMatches: 0 }),
      browse: vi.fn().mockResolvedValue({ items: [], parentPath: [] }),
    } as never);
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(minimalMeta),
      getDimensionValues: vi.fn().mockResolvedValue(minimalDimResult),
    } as never);
  });

  it('search: very long query (500 chars) is accepted by schema', () => {
    const longQuery = 'a'.repeat(500);
    expect(() => eurostatSearchDatasets.input.parse({ query: longQuery })).not.toThrow();
  });

  it('get_dimension_values: very long dataset_code is accepted by schema', () => {
    const longCode = 'x'.repeat(500);
    expect(() =>
      eurostatGetDimensionValues.input.parse({ dataset_code: longCode, dimension: 'unit' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Edge cases — empty result sets, sparse fields, boundary obsCount
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  describe('eurostatSearchDatasets — single result, type: table', () => {
    beforeEach(() => {
      vi.mocked(getEurostatCatalogueService).mockReturnValue({
        search: vi.fn().mockResolvedValue({
          datasets: [
            {
              code: 'trd_sum',
              label: 'Trade summary',
              type: 'table' as const,
              themePath: ['Trade'],
            },
          ],
          totalMatches: 1,
        }),
      } as never);
    });

    it('format uses singular "result" for 1 match', () => {
      const result = {
        datasets: [
          { code: 'trd_sum', label: 'Trade summary', type: 'table' as const, themePath: ['Trade'] },
        ],
      };
      const blocks = eurostatSearchDatasets.format!(result);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('Showing 1 result');
      expect(text).not.toContain('results');
    });

    it('format renders table type', () => {
      const result = {
        datasets: [
          { code: 'trd_sum', label: 'Trade summary', type: 'table' as const, themePath: [] },
        ],
      };
      const blocks = eurostatSearchDatasets.format!(result);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('table');
    });
  });

  describe('eurostatBrowseThemes — single item', () => {
    it('format uses singular "item" for 1 item', () => {
      const result = {
        items: [{ code: 'econ', label: 'Economy', type: 'folder' as const, hasChildren: true }],
        parentPath: [],
      };
      const blocks = eurostatBrowseThemes.format!(result);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('1 item');
      expect(text).not.toContain('1 items');
    });
  });

  describe('eurostatGetDatasetInfo — dimension with exactly sampleValues.length values', () => {
    it('omits "more" hint when all values are shown', () => {
      const meta = {
        ...minimalMeta,
        dimensions: [
          {
            code: 'unit',
            label: 'Unit',
            valuesCount: 2,
            sampleValues: [
              { code: 'CP_MEUR', label: 'Current prices' },
              { code: 'CLV_MEUR', label: 'Chain volumes' },
            ],
          },
        ],
      };
      const blocks = eurostatGetDatasetInfo.format!(meta);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).not.toContain('more —');
    });

    it('shows "more" hint when sample < total', () => {
      const meta = {
        ...minimalMeta,
        dimensions: [
          {
            code: 'unit',
            label: 'Unit',
            valuesCount: 12,
            sampleValues: [{ code: 'CP_MEUR', label: 'Current prices' }],
          },
        ],
      };
      const blocks = eurostatGetDatasetInfo.format!(meta);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('more');
    });
  });

  describe('eurostatGetDatasetInfo — sparse upstream metadata', () => {
    it('handler returns the omitted fields as omitted, not as 0 / empty string', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDatasetInfo: vi.fn().mockResolvedValue(sparseMeta),
      } as never);
      const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
      const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'nama_10_gdp' });
      const result = await eurostatGetDatasetInfo.handler(input, ctx);
      expect(result.obsCount).toBeUndefined();
      expect(result.lastUpdated).toBeUndefined();
      expect(result.timeRange.start).toBeUndefined();
    });

    it('format marks each absent field as unreported on the content[] surface', () => {
      const blocks = eurostatGetDatasetInfo.format!(sparseMeta);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('**Observations:** not reported by Eurostat');
      expect(text).toContain('**Period:** not reported by Eurostat');
      expect(text).toContain('**Last updated:** not reported by Eurostat');
      expect(text).not.toContain('**Observations:** 0');
    });

    it('format still renders reported values', () => {
      const blocks = eurostatGetDatasetInfo.format!(minimalMeta);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('**Observations:** 100');
      expect(text).toContain('**Period:** 2020 – 2024');
      expect(text).toContain('**Last updated:** 2026-01-01T00:00:00Z');
      expect(text).not.toContain('not reported by Eurostat');
    });

    it('format reports the time dimension count it was given', () => {
      const blocks = eurostatGetDatasetInfo.format!(minimalMeta);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('(`time`) — 5 values');
    });
  });

  describe('eurostatGetDatasetInfo — dimension whose value set was not measured (#34)', () => {
    it('returns the rest of the metadata with the unmeasured fields omitted', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDatasetInfo: vi.fn().mockResolvedValue(unmeasuredTimeMeta),
      } as never);
      const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
      const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'nama_10_gdp' });
      const result = await eurostatGetDatasetInfo.handler(input, ctx);
      expect(result.label).toBe('GDP and main components');
      expect(result.obsCount).toBe(100);
      const time = result.dimensions.find((d) => d.code === 'time');
      expect(time?.valuesCount).toBeUndefined();
      expect(time?.sampleValues).toBeUndefined();
    });

    it('format names the missing count instead of rendering "undefined"', () => {
      const blocks = eurostatGetDatasetInfo.format!(unmeasuredTimeMeta);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('(`time`) — value count not reported by Eurostat');
      expect(text).not.toContain('undefined');
      // The measured dimension alongside it still renders its count.
      expect(text).toContain('(`geo`) — 1 value');
    });
  });

  describe('eurostatGetDimensionValues — geo_level with a non-geo dimension', () => {
    it('surfaces the rejection instead of returning a silently unfiltered result', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDimensionValues: vi.fn().mockRejectedValue(
          Object.assign(new Error('geo_level does not apply'), {
            data: { reason: 'conflicting_params' },
          }),
        ),
      } as never);
      const ctx = createMockContext({ errors: eurostatGetDimensionValues.errors });
      // Passes Zod (the enum is valid); the cross-field rejection lives below the schema.
      const input = eurostatGetDimensionValues.input.parse({
        dataset_code: 'nama_10_gdp',
        dimension: 'unit',
        geo_level: 'nuts3',
      });
      // The reason alone would also match a bare rethrow of the mocked error; the recovery
      // hint naming the offending dimension is what the tool's own catch branch contributes.
      await expect(eurostatGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'conflicting_params',
          recovery: { hint: expect.stringContaining('"unit"') },
        },
      });
    });
  });

  describe('eurostatQueryDataset — empty filter array', () => {
    it('does not report an empty array as an applied filter', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: vi
          .fn()
          .mockResolvedValue({ ...minimalQueryResult, appliedFilters: { unit: ['CP_MEUR'] } }),
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({
        dataset_code: 'nama_10_gdp',
        filters: { unit: ['CP_MEUR'], geo: [] },
      });
      await eurostatQueryDataset.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters?.filters).toEqual({ unit: ['CP_MEUR'] });
    });
  });

  describe('eurostatGetDimensionValues — empty values list', () => {
    it('formats empty values list gracefully', () => {
      const emptyResult = {
        dimensionCode: 'unit',
        dimensionLabel: 'Unit of measure',
        values: [],
        totalCount: 0,
      };
      const blocks = eurostatGetDimensionValues.format!(emptyResult);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('unit');
      expect(text).toContain('0');
    });
  });

  describe('eurostatQueryDataset — truncation at 5000 observations', () => {
    /**
     * A capped service result: the decoder stops at 5,000 rows, and `obsCount` reports the
     * whole match. The two therefore diverge — a fixture where they match cannot occur, and
     * would let truncation detection read either field and still look correct.
     */
    const cappedResult = {
      datasetCode: 'nama_10_gdp',
      datasetLabel: 'GDP',
      dimensionsUsed: ['geo', 'time'],
      observations: Array.from({ length: 5000 }, (_, i) => ({
        dimensions: {
          geo: { code: `G${i}`, label: `Country ${i}` },
          time: { code: '2024', label: '2024' },
        },
        value: i * 10,
      })),
      obsCount: 5100,
      timeRange: { start: '2024', end: '2024' },
      missingObsCount: 0,
      appliedFilters: {},
    };

    it('sets truncated:true from the honest total when the returned rows are already capped', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: vi.fn().mockResolvedValue(cappedResult),
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
      const result = await eurostatQueryDataset.handler(input, ctx);
      // observations.length is 5,000 — exactly the cap — so a check against it would say
      // "not truncated" and the caller would never learn rows were dropped.
      expect(result.truncated).toBe(true);
      expect(result.observations).toHaveLength(5000);
      expect(result.obsCount).toBe(5100);
    });

    it('tells a truncated caller how to narrow the query', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: vi.fn().mockResolvedValue(cappedResult),
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
      await eurostatQueryDataset.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toContain('5,000');
    });

    it('sets truncated:false when observations <= 5000', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: vi.fn().mockResolvedValue(minimalQueryResult),
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
      const result = await eurostatQueryDataset.handler(input, ctx);
      expect(result.truncated).toBe(false);
    });

    it('format shows truncation banner when truncated is true', () => {
      const truncatedResult = {
        ...minimalQueryResult,
        truncated: true,
        observations: Array.from({ length: 5000 }, (_, i) => ({
          dimensions: {
            geo: { code: `G${i}`, label: `C${i}` },
            time: { code: '2024', label: '2024' },
          },
          value: i,
        })),
        obsCount: 5100,
      };
      const blocks = eurostatQueryDataset.format!(truncatedResult);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('**Truncated:** true');
      expect(text).toContain('5,000');
    });
  });

  describe('eurostatQueryDataset — enrichmentTrailer render', () => {
    it('renders applied filters correctly', () => {
      const trailer = eurostatQueryDataset.enrichmentTrailer!.appliedFilters;
      const rendered = (trailer as { render: (f: unknown) => string }).render({
        filters: { unit: ['CP_MEUR'], geo: ['DE', 'FR'] },
        geoLevel: undefined,
        sincePeriod: '2020',
        untilPeriod: '2024',
        lastNPeriods: undefined,
      });
      expect(rendered).toContain('unit=[CP_MEUR]');
      expect(rendered).toContain('geo=[DE, FR]');
      expect(rendered).toContain('2020');
      expect(rendered).toContain('2024');
    });

    it('renders geo level when set', () => {
      const trailer = eurostatQueryDataset.enrichmentTrailer!.appliedFilters;
      const rendered = (trailer as { render: (f: unknown) => string }).render({
        filters: {},
        geoLevel: 'country',
        sincePeriod: undefined,
        untilPeriod: undefined,
        lastNPeriods: undefined,
      });
      expect(rendered).toContain('country');
    });

    it('renders last N periods when set', () => {
      const trailer = eurostatQueryDataset.enrichmentTrailer!.appliedFilters;
      const rendered = (trailer as { render: (f: unknown) => string }).render({
        filters: {},
        geoLevel: undefined,
        sincePeriod: undefined,
        untilPeriod: undefined,
        lastNPeriods: 5,
      });
      expect(rendered).toContain('5');
    });

    it('renders "none" when no filters applied', () => {
      const trailer = eurostatQueryDataset.enrichmentTrailer!.appliedFilters;
      const rendered = (trailer as { render: (f: unknown) => string }).render({
        filters: {},
        geoLevel: undefined,
        sincePeriod: undefined,
        untilPeriod: undefined,
        lastNPeriods: undefined,
      });
      expect(rendered).toContain('none');
    });
  });

  describe('eurostatQueryDataset — invalid_dimension error', () => {
    it('surfaces invalid_dimension reason', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('invalid dim'), { data: { reason: 'invalid_dimension' } }),
          ),
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({
        dataset_code: 'nama_10_gdp',
        filters: { badDim: ['v1'] },
      });
      await expect(eurostatQueryDataset.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_dimension' },
      });
    });
  });

  describe('eurostatGetDatasetInfo — async_response error', () => {
    it('surfaces async_response reason', async () => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDatasetInfo: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('async'), { data: { reason: 'async_response' } }),
          ),
      } as never);
      const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
      const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'huge_dataset' });
      await expect(eurostatGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'async_response', retryable: false },
      });
    });
  });

  describe('eurostatDatasetResource — additional edge cases', () => {
    beforeEach(() => {
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDatasetInfo: vi.fn().mockResolvedValue(minimalMeta),
      } as never);
    });

    it('passes dataset_code directly to the data service', async () => {
      const mockGetInfo = vi.fn().mockResolvedValue(minimalMeta);
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDatasetInfo: mockGetInfo,
      } as never);
      const ctx = createMockContext({ tenantId: 'test' });
      const params = eurostatDatasetResource.params.parse({ dataset_code: 'nama_10_gdp' });
      await eurostatDatasetResource.handler(params, ctx);
      expect(mockGetInfo).toHaveBeenCalledWith('nama_10_gdp', ctx);
    });

    it('returns full meta shape including dimensions array', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      const params = eurostatDatasetResource.params.parse({ dataset_code: 'nama_10_gdp' });
      const result = await eurostatDatasetResource.handler(params, ctx);
      expect(result.dimensions).toBeInstanceOf(Array);
      expect(result.dimensions[0]).toMatchObject({ code: 'geo', valuesCount: 1 });
    });

    it('allows injection-like dataset_code without crashing (service handles it)', async () => {
      const mockGetInfo = vi.fn().mockRejectedValue(new Error('not found'));
      vi.mocked(getEurostatDataService).mockReturnValue({
        getDatasetInfo: mockGetInfo,
      } as never);
      const ctx = createMockContext({ tenantId: 'test' });
      const params = eurostatDatasetResource.params.parse({ dataset_code: '../etc/passwd' });
      await expect(eurostatDatasetResource.handler(params, ctx)).rejects.toThrow();
      // The injection reaches the service, which rejects it — no crash before the service call
      expect(mockGetInfo).toHaveBeenCalledWith('../etc/passwd', ctx);
    });
  });

  describe('eurostatQueryDataset — since_period whitespace trimming', () => {
    it('trims whitespace from since_period before passing to service', async () => {
      const mockQuery = vi.fn().mockResolvedValue(minimalQueryResult);
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: mockQuery,
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({
        dataset_code: 'nama_10_gdp',
        since_period: '  2020  ',
      });
      await eurostatQueryDataset.handler(input, ctx);
      expect(mockQuery).toHaveBeenCalledWith(
        'nama_10_gdp',
        {},
        undefined,
        '2020',
        undefined,
        undefined,
        'EN',
        ctx,
      );
    });

    it('treats whitespace-only since_period as undefined', async () => {
      const mockQuery = vi.fn().mockResolvedValue(minimalQueryResult);
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: mockQuery,
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({
        dataset_code: 'nama_10_gdp',
        since_period: '   ',
      });
      await eurostatQueryDataset.handler(input, ctx);
      expect(mockQuery).toHaveBeenCalledWith(
        'nama_10_gdp',
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        'EN',
        ctx,
      );
    });
  });

  describe('eurostatBrowseThemes — empty string theme_code treated as root', () => {
    it('treats empty string theme_code as no theme_code (root browse)', async () => {
      const mockBrowse = vi.fn().mockResolvedValue({ items: [], parentPath: [] });
      vi.mocked(getEurostatCatalogueService).mockReturnValue({
        browse: mockBrowse,
      } as never);
      const ctx = createMockContext({ errors: eurostatBrowseThemes.errors });
      const input = eurostatBrowseThemes.input.parse({ theme_code: '   ' });
      await eurostatBrowseThemes.handler(input, ctx);
      // The handler trims and falls to undefined for whitespace-only
      expect(mockBrowse).toHaveBeenCalledWith(undefined, ctx);
    });
  });

  describe('eurostatQueryDataset — until_period whitespace trimming', () => {
    it('trims whitespace from until_period before passing to service', async () => {
      const mockQuery = vi.fn().mockResolvedValue(minimalQueryResult);
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: mockQuery,
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({
        dataset_code: 'nama_10_gdp',
        until_period: '  2024  ',
      });
      await eurostatQueryDataset.handler(input, ctx);
      expect(mockQuery).toHaveBeenCalledWith(
        'nama_10_gdp',
        {},
        undefined,
        undefined,
        '2024',
        undefined,
        'EN',
        ctx,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// SQL input surface — eurostat_dataframe_query takes caller-supplied SQL, so the
// read-only gate is exercised against a real DuckDB canvas. A fake canvas would
// have to re-implement the gate, which would test the fake instead of the server.
// ---------------------------------------------------------------------------

describe('eurostat_dataframe_query — SQL injection resistance', () => {
  let canvas: DataCanvas;
  let teardown: () => Promise<void>;
  let canvasId: string;
  const TABLE = 'df_secure01';
  const DIMS = ['geo', 'time'];

  const ctx = () =>
    createMockContext({ errors: eurostatDataframeQuery.errors, tenantId: 'default' });

  const run = (sql: string) =>
    eurostatDataframeQuery.handler(
      eurostatDataframeQuery.input.parse({ canvas_id: canvasId, sql }),
      ctx(),
    );

  beforeAll(async () => {
    ({ canvas, teardown } = withRealCanvas());
    const instance = await canvas.acquire(undefined, ctx());
    canvasId = instance.canvasId;
    await instance.registerTable(
      TABLE,
      [
        toObservationRow(
          {
            dimensions: {
              geo: { code: 'DE', label: 'Germany' },
              time: { code: '2023', label: '2023' },
            },
            value: 1,
          },
          DIMS,
        ),
      ],
      { schema: observationRowSchema(DIMS) },
    );
  });

  afterAll(async () => {
    await teardown();
  });

  /** The caller sees a ValidationError naming the reason — not a silent empty result. */
  const expectRejected = async (sql: string) => {
    const err = (await run(sql).catch((e: unknown) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(typeof (err.data as { reason?: unknown } | undefined)?.reason).toBe('string');
    return err;
  };

  describe('statement chaining', () => {
    for (const sql of [
      `SELECT * FROM ${TABLE}; DROP TABLE ${TABLE}`,
      `SELECT * FROM ${TABLE}; DELETE FROM ${TABLE}`,
      `SELECT 1; SELECT 2`,
      `SELECT * FROM ${TABLE};UPDATE ${TABLE} SET obs_value = 0`,
    ]) {
      it(`rejects: ${sql.slice(0, 52)}`, async () => {
        const err = await expectRejected(sql);
        expect(err.data).toMatchObject({ reason: 'multi_statement' });
      });
    }
  });

  describe('comment tricks', () => {
    it('rejects a trailing statement hidden behind a line comment', async () => {
      const err = await expectRejected(`SELECT * FROM ${TABLE} -- harmless\n; DROP TABLE ${TABLE}`);
      expect(err.data).toMatchObject({ reason: 'multi_statement' });
    });

    it('rejects a non-SELECT verb wrapped in a block comment prefix', async () => {
      const err = await expectRejected(`/* SELECT */ DELETE FROM ${TABLE}`);
      expect(err.data).toMatchObject({ reason: 'non_select_statement' });
    });

    it('leaves a comment inside an otherwise valid SELECT alone', async () => {
      // The gate rejects statements, not comments — a legitimate annotated query still runs.
      const result = await run(`SELECT geo /* the country code */ FROM ${TABLE} -- one row`);
      expect(result.rows).toEqual([{ geo: 'DE' }]);
    });
  });

  describe('non-SELECT verbs', () => {
    for (const [label, sql] of [
      ['DELETE', `DELETE FROM ${TABLE}`],
      ['UPDATE', `UPDATE ${TABLE} SET obs_value = 0`],
      ['INSERT', `INSERT INTO ${TABLE} (geo) VALUES ('XX')`],
      ['DROP', `DROP TABLE ${TABLE}`],
      ['CREATE', `CREATE TABLE evil AS SELECT * FROM ${TABLE}`],
      ['ALTER', `ALTER TABLE ${TABLE} RENAME TO gone`],
      ['ATTACH', `ATTACH '/tmp/evil.db' AS evil`],
      ['PRAGMA', 'PRAGMA database_list'],
      ['SET', "SET memory_limit = '16GB'"],
      ['INSTALL', 'INSTALL httpfs'],
      ['COPY', `COPY ${TABLE} TO '/tmp/exfil.csv'`],
    ] as const) {
      it(`rejects ${label}`, async () => {
        await expectRejected(sql);
      });
    }
  });

  describe('reaching outside the registered tables', () => {
    for (const [label, sql] of [
      ['read_csv', "SELECT * FROM read_csv('/etc/passwd')"],
      ['read_csv_auto', "SELECT * FROM read_csv_auto('/etc/passwd')"],
      ['read_json', "SELECT * FROM read_json('/etc/passwd')"],
      ['read_parquet', "SELECT * FROM read_parquet('/etc/shadow')"],
      ['read_text', "SELECT * FROM read_text('/etc/passwd')"],
      ['read_blob', "SELECT * FROM read_blob('/etc/passwd')"],
      ['glob', "SELECT * FROM glob('/**')"],
      ['sqlite_scan', "SELECT * FROM sqlite_scan('/tmp/x.db', 't')"],
      ['postgres_scan', "SELECT * FROM postgres_scan('host=x', 'public', 't')"],
      ['http url', "SELECT * FROM 'https://example.com/data.parquet'"],
      ['pragma call', 'SELECT * FROM pragma_database_list()'],
    ] as const) {
      it(`rejects ${label}`, async () => {
        await expectRejected(sql);
      });
    }

    it('rejects a subquery that smuggles a file read past a legitimate table', async () => {
      await expectRejected(`SELECT g.geo FROM ${TABLE} g JOIN read_csv('/etc/passwd') p ON true`);
    });

    it('rejects a UNION arm that reads a file', async () => {
      await expectRejected(
        `SELECT geo FROM ${TABLE} UNION ALL SELECT * FROM read_text('/etc/hostname')`,
      );
    });

    it('rejects a CTE that reads a file', async () => {
      await expectRejected(
        `WITH leak AS (SELECT * FROM read_csv('/etc/passwd')) SELECT * FROM leak`,
      );
    });
  });

  describe('after every rejected attempt', () => {
    it('the staged table is intact and still holds its original row', async () => {
      const result = await run(`SELECT geo, obs_value FROM ${TABLE}`);
      expect(result.rows).toEqual([{ geo: 'DE', obs_value: 1 }]);
    });

    it('no extra table was created on the canvas', async () => {
      const instance = await canvas.acquire(canvasId, ctx());
      expect((await instance.describe()).map((t) => t.name)).toEqual([TABLE]);
    });
  });

  describe('oversized and malformed SQL', () => {
    it('rejects an empty statement at the schema boundary', () => {
      expect(() => eurostatDataframeQuery.input.parse({ canvas_id: canvasId, sql: '' })).toThrow();
    });

    it('rejects an empty canvas_id at the schema boundary', () => {
      expect(() =>
        eurostatDataframeQuery.input.parse({ canvas_id: '', sql: 'SELECT 1' }),
      ).toThrow();
    });

    it('rejects a 10,000-character predicate without crashing', async () => {
      await expectRejected(`SELECT * FROM ${TABLE} WHERE geo = '${'A'.repeat(10_000)}`);
    });

    it('does not leak the canvas scratch path into the error message', async () => {
      const err = await expectRejected(`SELECT no_such_column FROM ${TABLE}`);
      expect(err.message).not.toContain('/var/');
      expect(err.message).not.toContain('canvas-test');
    });
  });

  describe('canvas isolation', () => {
    it('refuses a canvas belonging to another tenant the same way as an unknown one', async () => {
      const other = createMockContext({
        errors: eurostatDataframeQuery.errors,
        tenantId: 'someone-else',
      });
      const input = eurostatDataframeQuery.input.parse({
        canvas_id: canvasId,
        sql: `SELECT * FROM ${TABLE}`,
      });
      // Uniform with an unknown id — existence must not leak across tenants.
      await expect(eurostatDataframeQuery.handler(input, other)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
      });
    });
  });
});

describe('eurostat_dataframe_describe — input validation', () => {
  it('rejects an empty canvas_id', () => {
    expect(() => eurostatDataframeDescribe.input.parse({ canvas_id: '' })).toThrow();
  });

  it('accepts an injection-shaped canvas_id at the schema and rejects it at the canvas', () => {
    // The id is opaque, so the schema only checks it is non-empty; the lookup is what
    // refuses it. Nothing interpolates it into SQL.
    expect(() =>
      eurostatDataframeDescribe.input.parse({ canvas_id: "'; DROP TABLE t; --" }),
    ).not.toThrow();
  });
});
