/**
 * @fileoverview Security and edge-case tests across all Eurostat tools and the resource.
 * Covers injection attempts, oversized inputs, missing optional fields, and the
 * invariant that no secret or internal env value appears in tool output.
 * @module tests/tools/security-and-edge-cases.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatDatasetResource } from '@/mcp-server/resources/definitions/eurostat-dataset.resource.js';
import { eurostatBrowseThemes } from '@/mcp-server/tools/definitions/eurostat-browse-themes.tool.js';
import { eurostatGetDatasetInfo } from '@/mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { eurostatGetDimensionValues } from '@/mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { eurostatQueryDataset } from '@/mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { eurostatSearchDatasets } from '@/mcp-server/tools/definitions/eurostat-search-datasets.tool.js';

// Mock catalogue service
vi.mock('@/services/eurostat-catalogue/eurostat-catalogue-service.js', () => ({
  getEurostatCatalogueService: vi.fn(),
}));

// Mock data service
vi.mock('@/services/eurostat-data/eurostat-data-service.js', () => ({
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
  ],
  timeRange: { start: '2020', end: '2024' },
  obsCount: 100,
  lastUpdated: '2026-01-01T00:00:00Z',
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
};

// ---------------------------------------------------------------------------
// Input validation — Zod rejects bad inputs before the handler runs
// ---------------------------------------------------------------------------

describe('Input validation', () => {
  describe('eurostatSearchDatasets', () => {
    it('rejects empty query string', () => {
      expect(() => eurostatSearchDatasets.input.parse({ query: '' })).toThrow();
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
    it('sets truncated:true and applies 5000 cap', async () => {
      const manyObs = Array.from({ length: 5100 }, (_, i) => ({
        dimensions: {
          geo: { code: `G${i}`, label: `Country ${i}` },
          time: { code: '2024', label: '2024' },
        },
        value: i * 10,
      }));
      vi.mocked(getEurostatDataService).mockReturnValue({
        queryDataset: vi.fn().mockResolvedValue({
          datasetCode: 'nama_10_gdp',
          datasetLabel: 'GDP',
          dimensionsUsed: ['geo', 'time'],
          observations: manyObs,
          obsCount: 5100,
          timeRange: { start: '2024', end: '2024' },
          missingObsCount: 0,
        }),
      } as never);
      const ctx = createMockContext({ errors: eurostatQueryDataset.errors });
      const input = eurostatQueryDataset.input.parse({ dataset_code: 'nama_10_gdp' });
      const result = await eurostatQueryDataset.handler(input, ctx);
      expect(result.truncated).toBe(true);
      expect(result.observations).toHaveLength(5000);
      expect(result.obsCount).toBe(5100);
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
        data: { reason: 'async_response' },
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
