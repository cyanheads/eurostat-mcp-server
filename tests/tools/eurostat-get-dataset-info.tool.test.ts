/**
 * @fileoverview Tests for the eurostat_get_dataset_info tool.
 * @module tests/tools/eurostat-get-dataset-info.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatGetDatasetInfo } from '@/mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { SDMX_CONSTRAINT_XML, SDMX_DATAFLOW_XML } from '../fixtures/eurostat-sdmx-metadata.js';

// Only the accessor is replaced, so a test can hand the tool the real service class.
vi.mock('@/services/eurostat-data/eurostat-data-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/eurostat-data/eurostat-data-service.js')>()),
  getEurostatDataService: vi.fn(),
}));

import {
  EurostatDataService,
  getEurostatDataService,
} from '@/services/eurostat-data/eurostat-data-service.js';

const mockMeta = {
  code: 'nama_10_gdp',
  label: 'GDP and main components (output, expenditure and income)',
  dimensions: [
    {
      code: 'unit',
      label: 'Unit of measure',
      valuesCount: 12,
      sampleValues: [
        { code: 'CP_MEUR', label: 'Current prices, million euro' },
        { code: 'CLV10_MEUR', label: 'Chain linked volumes (2010), million euro' },
      ],
    },
    {
      code: 'na_item',
      label: 'National accounts indicator (ESA 2010)',
      valuesCount: 25,
      sampleValues: [{ code: 'B1GQ', label: 'Gross domestic product at market prices' }],
    },
    {
      code: 'geo',
      label: 'Geopolitical entity (reporting)',
      valuesCount: 41,
      sampleValues: [
        { code: 'DE', label: 'Germany' },
        { code: 'FR', label: 'France' },
      ],
    },
    {
      code: 'time',
      label: 'Time',
      valuesCount: 51,
      sampleValues: [
        { code: '1975', label: '1975' },
        { code: '1976', label: '1976' },
      ],
    },
  ],
  timeRange: { start: '1975', end: '2024' },
  obsCount: 1_100_000,
  lastUpdated: '2026-05-01T00:00:00Z',
  metadataUrl: 'https://ec.europa.eu/eurostat/cache/metadata/en/nama_10_gdp_esms.htm',
};

describe('eurostatGetDatasetInfo', () => {
  beforeEach(() => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(mockMeta),
    } as never);
  });

  it('returns dataset metadata for a valid code', async () => {
    const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
    const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatGetDatasetInfo.handler(input, ctx);
    expect(result.code).toBe('nama_10_gdp');
    expect(result.dimensions).toHaveLength(4);
    expect(result.obsCount).toBe(1_100_000);
    expect(result.timeRange.start).toBe('1975');
    // The time dimension reports the dataset's period count, not the metadata query's slice of 1.
    expect(result.dimensions.find((d) => d.code === 'time')?.valuesCount).toBe(51);
  });

  it('throws not_found for an unknown dataset code', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not found'), { data: { reason: 'not_found' } }),
        ),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
    const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'nonexistent_xyz' });
    await expect(eurostatGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found', recovery: { hint: expect.stringContaining('nonexistent_xyz') } },
    });
  });

  it('formats output with all required fields', () => {
    const blocks = eurostatGetDatasetInfo.format!(mockMeta);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nama_10_gdp');
    expect(text).toContain('GDP and main components');
    expect(text).toContain('1975');
    expect(text).toContain('2024');
    expect(text).toContain('1,100,000');
    expect(text).toContain('unit');
    expect(text).toContain('CP_MEUR');
    expect(text).toContain('esms.htm');
  });

  it('formats sparse metadata without metadataUrl', () => {
    const sparseMeta = {
      ...mockMeta,
      metadataUrl: undefined,
      dimensions: [
        {
          code: 'geo',
          label: 'Geopolitical entity',
          valuesCount: 2,
          sampleValues: [{ code: 'DE', label: 'Germany' }],
        },
      ],
    };
    const blocks = eurostatGetDatasetInfo.format!(sparseMeta);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('nama_10_gdp');
    expect(text).not.toContain('Metadata:');
  });

  it('advertises the annotation-derived fields as optional in the output schema', () => {
    // The wire contract, not just the handler: a payload with no annotation-derived values
    // must validate, or a sparse dataset cannot be represented without fabricating one.
    const parsed = eurostatGetDatasetInfo.output.parse({
      code: 'xyz',
      label: 'Sparse dataset',
      dimensions: [],
      timeRange: {},
    });
    expect(parsed.obsCount).toBeUndefined();
    expect(parsed.lastUpdated).toBeUndefined();
    expect(parsed.timeRange).toEqual({});
  });

  it('names absent annotation-derived metadata as unreported rather than zero or blank', () => {
    const sparseMeta = {
      code: 'xyz',
      label: 'Sparse dataset',
      dimensions: [
        {
          code: 'geo',
          label: 'Geopolitical entity',
          valuesCount: 1,
          sampleValues: [{ code: 'DE', label: 'Germany' }],
        },
      ],
      timeRange: {},
    };
    const blocks = eurostatGetDatasetInfo.format!(sparseMeta);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('**Observations:** not reported by Eurostat');
    expect(text).toContain('**Period:** not reported by Eurostat');
    expect(text).toContain('**Last updated:** not reported by Eurostat');
    // The pre-fix rendering of the same payload.
    expect(text).not.toContain('**Observations:** 0');
    expect(text).not.toContain('**Period:**  – ');
  });

  it('renders a half-known period range without inventing the missing bound', () => {
    const blocks = eurostatGetDatasetInfo.format!({
      ...mockMeta,
      timeRange: { start: '1975' },
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('**Period:** 1975 – not reported by Eurostat');
  });

  it('returns sparse metadata unchanged through the handler', async () => {
    const sparseMeta = {
      code: 'xyz',
      label: 'Sparse dataset',
      dimensions: [],
      timeRange: {},
    };
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(sparseMeta),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
    const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'xyz' });
    const result = await eurostatGetDatasetInfo.handler(input, ctx);
    expect(result.obsCount).toBeUndefined();
    expect(result.lastUpdated).toBeUndefined();
    expect(result.timeRange.start).toBeUndefined();
    expect(result.timeRange.end).toBeUndefined();
  });

  it('advertises a dimension value set as optional in the output schema (#34)', () => {
    // The wire contract: a `time` entry whose count was never measured must validate, or the
    // only ways to answer are a fabricated number or a failed call.
    const parsed = eurostatGetDatasetInfo.output.parse({
      code: 'nama_10_gdp',
      label: 'GDP',
      dimensions: [{ code: 'time', label: 'Time' }],
      timeRange: {},
    });
    expect(parsed.dimensions[0]?.valuesCount).toBeUndefined();
    expect(parsed.dimensions[0]?.sampleValues).toBeUndefined();
  });

  it('surfaces an unmeasured time period count as omitted, not as one (#34)', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue({
        ...mockMeta,
        dimensions: [
          ...mockMeta.dimensions.filter((d) => d.code !== 'time'),
          { code: 'time', label: 'Time' },
        ],
      }),
    } as never);
    const ctx = createMockContext({ errors: eurostatGetDatasetInfo.errors });
    const input = eurostatGetDatasetInfo.input.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatGetDatasetInfo.handler(input, ctx);
    const time = result.dimensions.find((d) => d.code === 'time');
    expect(time?.valuesCount).toBeUndefined();
    expect(time?.valuesCount).not.toBe(1);
    // The dimension is still advertised, and every measured dimension is untouched.
    expect(time?.label).toBe('Time');
    expect(result.dimensions.find((d) => d.code === 'geo')?.valuesCount).toBe(41);
  });

  it('formats an unmeasured dimension without crashing or printing "undefined" (#34)', () => {
    const blocks = eurostatGetDatasetInfo.format!({
      ...mockMeta,
      dimensions: [{ code: 'time', label: 'Time' }],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('value count not reported by Eurostat');
    expect(text).toContain('eurostat_get_dimension_values');
    expect(text).not.toContain('undefined');
  });

  it('formats hint when dimension has more values than sample', () => {
    const blocks = eurostatGetDatasetInfo.format!(mockMeta);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    // unit has 12 values but only 2 samples shown — expect "more" hint
    expect(text).toContain('more');
    expect(text).toContain('eurostat_get_dimension_values');
  });
});

// ---------------------------------------------------------------------------
// The metadata path end to end: the real data service, only fetch stubbed, so the
// SDMX fetch, the parse and its failure classification are what run.
// ---------------------------------------------------------------------------

/** The recorded dataflow, cut off inside the GEO codelist — three levels below the root. */
const TRUNCATED_DATAFLOW_XML = SDMX_DATAFLOW_XML.slice(
  0,
  SDMX_DATAFLOW_XML.indexOf('<s:Code id="DE111">') + 20,
);

interface StructureBodies {
  constraint?: { body: string; status?: number };
  dataflow?: { body: string; status?: number };
}

/** Answer the two structure reads from `bodies`, defaulting to the recorded fixtures. */
function structureFetch(bodies: StructureBodies) {
  return vi.fn(async (input: unknown): Promise<Response> => {
    const url = new URL(String(input));
    const code = url.pathname.split('/').at(-2)?.toUpperCase() ?? 'EARN_SES_ANNUAL';
    if (url.pathname.includes('/sdmx/2.1/dataflow/')) {
      const { body, status = 200 } = bodies.dataflow ?? {
        body: SDMX_DATAFLOW_XML.replaceAll('EARN_SES_ANNUAL', code),
      };
      return new Response(body, { status });
    }
    if (url.pathname.includes('/sdmx/2.1/contentconstraint/')) {
      const { body, status = 200 } = bodies.constraint ?? { body: SDMX_CONSTRAINT_XML };
      return new Response(body, { status });
    }
    return new Response(
      '{"warning":{"status":413,"label":"ASYNCHRONOUS_RESPONSE. Your request will be treated asynchronously."}}',
      { status: 200 },
    );
  });
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((block) => block.text ?? '').join('\n');

const errorOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: { code: number; data: Record<string, unknown> } }).error;

describe('eurostatGetDatasetInfo — the metadata path through the real data service', () => {
  let fetchMock: ReturnType<typeof structureFetch>;

  const serve = (bodies: StructureBodies = {}) => {
    fetchMock = structureFetch(bodies);
    vi.stubGlobal('fetch', fetchMock);
  };

  beforeEach(() => {
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
    serve();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads only the SDMX structure and constraint, never the Statistics API', async () => {
    const result = await runToolContract(eurostatGetDatasetInfo, {
      dataset_code: 'earn_ses_annual',
    });
    expect(result.isError).not.toBe(true);
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.includes('/sdmx/2.1/'))).toBe(true);
    expect(paths.some((path) => path.includes('/statistics/1.0/'))).toBe(false);
  });

  it('surfaces a 404 structure read as not_found on both surfaces', async () => {
    serve({ dataflow: { body: 'Not found', status: 404 } });
    const result = await runToolContract(eurostatGetDatasetInfo, { dataset_code: 'nope_xyz' });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found', recovery: { hint: expect.stringContaining('nope_xyz') } },
    });
    expect(textOf(result)).toContain('reason not_found');
  });

  it.each([
    ['a dataflow cut off inside a nested codelist', { dataflow: { body: TRUNCATED_DATAFLOW_XML } }],
    ['an empty dataflow body', { dataflow: { body: '' } }],
    [
      'an HTML page answered with HTTP 200',
      { dataflow: { body: '<!DOCTYPE html><html><body>Service busy</body></html>' } },
    ],
    [
      'a dataflow that omits the requested dataset',
      { dataflow: { body: SDMX_DATAFLOW_XML.replaceAll('EARN_SES_ANNUAL', 'OTHER_SET') } },
    ],
    [
      'a content constraint cut off mid-region',
      {
        constraint: {
          body: SDMX_CONSTRAINT_XML.slice(0, SDMX_CONSTRAINT_XML.indexOf('<c:KeyValue id="geo">')),
        },
      },
    ],
  ] satisfies Array<[string, StructureBodies]>)(
    'surfaces %s as the declared upstream_fault on both surfaces',
    async (_label, bodies) => {
      serve(bodies);
      const result = await runToolContract(eurostatGetDatasetInfo, {
        dataset_code: 'earn_ses_annual',
      });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_fault',
        recovery: { hint: expect.stringContaining('earn_ses_annual') },
      });
      expect(error.data.recovery).toMatchObject({
        hint: expect.stringContaining('eurostat_query_dataset'),
      });
      const text = textOf(result);
      expect(text).toContain('malformed SDMX metadata');
      expect(text).toContain('Recovery:');
      expect(text).toContain('reason upstream_fault');
      expect(text).not.toMatch(/async/i);
    },
  );

  it('does not cache a failed structure read: the next call downloads it afresh', async () => {
    serve({ dataflow: { body: TRUNCATED_DATAFLOW_XML } });
    const failed = await runToolContract(eurostatGetDatasetInfo, {
      dataset_code: 'earn_ses_annual',
    });
    expect(errorOf(failed).data.reason).toBe('upstream_fault');

    serve();
    const recovered = await runToolContract(eurostatGetDatasetInfo, {
      dataset_code: 'earn_ses_annual',
    });
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      code: 'earn_ses_annual',
      obsCount: 6160543,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('declares exactly the failures its metadata path can raise', () => {
    expect(eurostatGetDatasetInfo.errors?.map(({ reason }) => reason)).toEqual([
      'not_found',
      'upstream_fault',
    ]);
  });
});
