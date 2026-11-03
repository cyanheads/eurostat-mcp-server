/**
 * @fileoverview Tests for the eurostat-dataset resource.
 * @module tests/resources/eurostat-dataset.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eurostatDatasetResource } from '@/mcp-server/resources/definitions/eurostat-dataset.resource.js';
import { eurostatGetDatasetInfo } from '@/mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { SDMX_CONSTRAINT_XML, SDMX_DATAFLOW_XML } from '../fixtures/eurostat-sdmx-metadata.js';

// Only the accessor is replaced, so a test can hand the resource the real service class.
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
  label: 'GDP and main components',
  dimensions: [
    {
      code: 'unit',
      label: 'Unit of measure',
      valuesCount: 12,
      sampleValues: [{ code: 'CP_MEUR', label: 'Current prices, million euro' }],
    },
  ],
  timeRange: { start: '1975', end: '2024' },
  obsCount: 1_100_000,
  lastUpdated: '2026-05-01T00:00:00Z',
  metadataUrl: 'https://ec.europa.eu/eurostat/cache/metadata/en/nama_10_gdp_esms.htm',
};

const resourceParams = eurostatDatasetResource.params;
if (!resourceParams) throw new Error('eurostatDatasetResource must declare params');

describe('eurostatDatasetResource', () => {
  beforeEach(() => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(mockMeta),
    } as never);
  });

  it('returns metadata for a valid dataset_code', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: eurostatDatasetResource.errors });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    expect(result).toMatchObject({
      code: 'nama_10_gdp',
      label: 'GDP and main components',
      obsCount: 1_100_000,
    });
  });

  it('delegates to the data service with correct dataset code', async () => {
    const mockGetInfo = vi.fn().mockResolvedValue(mockMeta);
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: mockGetInfo,
    } as never);
    const ctx = createMockContext({ tenantId: 'test', errors: eurostatDatasetResource.errors });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    await eurostatDatasetResource.handler(params, ctx);
    expect(mockGetInfo).toHaveBeenCalledWith('nama_10_gdp', ctx);
  });

  it('propagates service errors to the caller', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockRejectedValue(new Error('Dataset not found')),
    } as never);
    const ctx = createMockContext({ tenantId: 'test', errors: eurostatDatasetResource.errors });
    const params = resourceParams.parse({ dataset_code: 'nonexistent_xyz' });
    await expect(eurostatDatasetResource.handler(params, ctx)).rejects.toThrow('Dataset not found');
  });

  it('carries the real time period count through to the caller', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue({
        ...mockMeta,
        dimensions: [
          ...mockMeta.dimensions,
          {
            code: 'time',
            label: 'Time',
            valuesCount: 51,
            sampleValues: [{ code: '1975', label: '1975' }],
          },
        ],
      }),
    } as never);
    const ctx = createMockContext({ tenantId: 'test', errors: eurostatDatasetResource.errors });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    expect(result.dimensions.find((d) => d.code === 'time')?.valuesCount).toBe(51);
  });

  it('advertises the annotation-derived fields as optional in the output schema', () => {
    const parsed = eurostatDatasetResource.output!.parse({
      code: 'xyz',
      label: 'Sparse dataset',
      dimensions: [],
      timeRange: {},
    });
    expect(parsed.obsCount).toBeUndefined();
    expect(parsed.lastUpdated).toBeUndefined();
    expect(parsed.timeRange).toEqual({});
  });

  it('omits annotation-derived fields absent from the upstream metadata', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue({
        code: 'xyz',
        label: 'Sparse dataset',
        dimensions: [],
        timeRange: {},
      }),
    } as never);
    const ctx = createMockContext({ tenantId: 'test', errors: eurostatDatasetResource.errors });
    const params = resourceParams.parse({ dataset_code: 'xyz' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    // Absent upstream annotations must not surface as 0 / '' — the resource schema declares
    // these optional so a consumer can tell "unknown" from "zero".
    expect(result.obsCount).toBeUndefined();
    expect(result.lastUpdated).toBeUndefined();
    expect(result.timeRange.start).toBeUndefined();
    expect(result.timeRange.end).toBeUndefined();
  });

  it('advertises a dimension value set as optional in the output schema (#34)', () => {
    // Declared independently of the tool's schema — both must accept the same payload, or
    // the resource is the surface that cannot represent an unmeasured period count.
    const parsed = eurostatDatasetResource.output!.parse({
      code: 'nama_10_gdp',
      label: 'GDP',
      dimensions: [{ code: 'time', label: 'Time' }],
      timeRange: {},
    });
    expect(parsed.dimensions[0]?.valuesCount).toBeUndefined();
    expect(parsed.dimensions[0]?.sampleValues).toBeUndefined();
  });

  it('carries an unmeasured time period count through as omitted, not as one (#34)', async () => {
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue({
        ...mockMeta,
        dimensions: [...mockMeta.dimensions, { code: 'time', label: 'Time' }],
      }),
    } as never);
    const ctx = createMockContext({ tenantId: 'test', errors: eurostatDatasetResource.errors });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    const time = result.dimensions.find((d) => d.code === 'time');
    expect(time?.valuesCount).toBeUndefined();
    expect(time?.valuesCount).not.toBe(1);
    // Everything the first metadata request carried is still here.
    expect(result.obsCount).toBe(1_100_000);
    expect(result.dimensions.find((d) => d.code === 'unit')?.valuesCount).toBe(12);
  });

  it('handles sparse metadata without metadataUrl', async () => {
    const sparseMeta = { ...mockMeta, metadataUrl: undefined };
    vi.mocked(getEurostatDataService).mockReturnValue({
      getDatasetInfo: vi.fn().mockResolvedValue(sparseMeta),
    } as never);
    const ctx = createMockContext({ tenantId: 'test', errors: eurostatDatasetResource.errors });
    const params = resourceParams.parse({ dataset_code: 'nama_10_gdp' });
    const result = await eurostatDatasetResource.handler(params, ctx);
    expect(result.metadataUrl).toBeUndefined();
    expect(result.code).toBe('nama_10_gdp');
  });
});

// ---------------------------------------------------------------------------
// Read failures as a client receives them (#91): the resource served from a worker
// handler and read with `resources/read`, so the resource factory's recovery fill runs.
// The real data service answers, with only `fetch` stubbed, so its retry loop, status
// classification and parse are what raise each failure.
// ---------------------------------------------------------------------------

const NOT_FOUND_HINT =
  'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.';
const UPSTREAM_FAULT_HINT =
  'Retry in a few minutes, since a failed structure read is not cached. If it fails the same way, eurostat_query_dataset reads the observations, with dimension codes and labels, from a separate endpoint.';

interface RpcError {
  code: number;
  data: Record<string, unknown>;
  message: string;
}

describe('eurostatDatasetResource — read failures through resources/read (#91)', () => {
  const worker = createWorkerHandler({
    name: 'eurostat-mcp-server',
    title: 'eurostat-mcp-server',
    resources: [eurostatDatasetResource],
  });
  const executionContext = { waitUntil() {}, passThroughOnException() {} };

  /** One `resources/read` on protocol revision 2026-07-28; the reply's `result` or `error`. */
  async function read(uri: string): Promise<{ error?: RpcError; result?: unknown }> {
    const response = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'resources/read',
          'Mcp-Name': uri,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: {
            uri,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
      // The failures under test log at error; keep them out of the test output.
      { LOG_LEVEL: 'emerg' },
      executionContext as never,
    );
    const body = await response.text();
    const frame = body.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(frame ? frame.slice('data: '.length) : body);
  }

  /** Read and return the JSON-RPC error, failing when the read succeeded. */
  async function readError(uri: string): Promise<RpcError> {
    const reply = await read(uri);
    if (!reply.error) throw new Error(`Expected ${uri} to fail; it returned a result.`);
    return reply.error;
  }

  /** Answer every request through `answer`, recording each requested URL path. */
  let paths: string[];
  const serve = (answer: (path: string, init?: RequestInit) => Promise<Response>) => {
    paths = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const { pathname } = new URL(String(input));
        paths.push(pathname);
        return answer(pathname, init);
      }),
    );
  };

  beforeEach(() => {
    // A fresh service per case, so no cached metadata carries over.
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('declares the tool’s not_found and upstream_fault entries verbatim, as service throws', () => {
    const fields = (entries: typeof eurostatGetDatasetInfo.errors) =>
      entries?.map(({ code, reason, recovery, when }) => ({ code, reason, recovery, when }));
    expect(fields(eurostatDatasetResource.errors)).toEqual(fields(eurostatGetDatasetInfo.errors));
    expect(eurostatDatasetResource.errors?.map(({ thrownBy }) => thrownBy)).toEqual([
      'service',
      'service',
    ]);
  });

  it('reads a dataset through resources/read (characterization)', async () => {
    serve(async (path) =>
      path.includes('/dataflow/')
        ? new Response(SDMX_DATAFLOW_XML)
        : new Response(SDMX_CONSTRAINT_XML),
    );
    const reply = await read('eurostat://dataset/earn_ses_annual');
    expect(reply.error).toBeUndefined();
    const { contents } = reply.result as { contents: Array<{ text: string; uri: string }> };
    expect(contents[0]?.uri).toBe('eurostat://dataset/earn_ses_annual');
    expect(JSON.parse(contents[0]?.text ?? '{}')).toMatchObject({
      code: 'earn_ses_annual',
      obsCount: 6160543,
    });
  });

  it('fails an unknown code as not_found with the discovery hint', async () => {
    serve(async () => new Response('Not found', { status: 404 }));
    const error = await readError('eurostat://dataset/ZZZZ_DOES_NOT_EXIST');
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(
      'Dataset "ZZZZ_DOES_NOT_EXIST" was not found in Eurostat\'s SDMX dataflows. Verify the code with eurostat_search_datasets or eurostat_browse_themes.',
    );
    expect(error.data).toEqual({
      reason: 'not_found',
      datasetCode: 'ZZZZ_DOES_NOT_EXIST',
      recovery: { hint: NOT_FOUND_HINT },
      requestId: expect.any(String),
    });
  });

  it('fails a 503 on every structure attempt as a retryable upstream_fault with the hint', async () => {
    vi.useFakeTimers();
    serve(async () => new Response('Service Unavailable', { status: 503 }));
    const pending = readError('eurostat://dataset/nama_10_gdp');
    // Past the 1 s / 2 s / 4 s backoff, plus jitter, of both structure reads.
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await pending;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(
      /^Eurostat's SDMX structure endpoint answered HTTP 503 to the (dataflow|contentconstraint) read of dataset "nama_10_gdp" \(failed after 4 attempts\)\.$/,
    );
    expect(error.data).toEqual({
      reason: 'upstream_fault',
      datasetCode: 'nama_10_gdp',
      status: 503,
      retryable: true,
      recovery: { hint: UPSTREAM_FAULT_HINT },
      requestId: expect.any(String),
    });
    expect(paths).toHaveLength(8);
  });

  it.each([
    [
      'an unreadable structure',
      async () => new Response('<!DOCTYPE html><html><body>Service busy</body></html>'),
      {},
    ],
    [
      'an HTTP 501 refusal',
      async () => new Response('Not Implemented', { status: 501 }),
      { status: 501 },
    ],
  ])(
    'fails %s as a non-retryable upstream_fault with the same hint',
    async (_label, answer, extra) => {
      serve(answer);
      const error = await readError('eurostat://dataset/nama_10_gdp');
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toEqual({
        reason: 'upstream_fault',
        datasetCode: 'nama_10_gdp',
        ...extra,
        retryable: false,
        recovery: { hint: UPSTREAM_FAULT_HINT },
        requestId: expect.any(String),
      });
      // Neither is retried: one request for each of the two structure reads.
      expect(paths).toHaveLength(2);
    },
  );

  it('keeps a structure read past its deadline as retry_deadline_exceeded, with no hint', async () => {
    vi.useFakeTimers();
    // Never answers; a request ends only when its signal aborts.
    serve(
      (_path, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = readError('eurostat://dataset/nama_10_gdp');
    // The constraint read's 30 s allowance runs out first; the 120 s dataflow read settles too.
    await vi.advanceTimersByTimeAsync(150_000);
    const error = await pending;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded', deadlineMs: 30_000 });
    expect(error.data).not.toHaveProperty('recovery');
  });
});
