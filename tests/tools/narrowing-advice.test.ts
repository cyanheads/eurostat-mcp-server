/**
 * @fileoverview Tests for the structure read behind a recovery hint — a failed read
 * degrades the hint, a cancelled call does not, and one deadline bounds the read across
 * every attempt and backoff.
 * @module tests/tools/narrowing-advice.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as serverConfig from '@/config/server-config.js';
import { dimensionsToNarrow } from '@/mcp-server/tools/narrowing-advice.js';

// Only the accessor is replaced, so a test can hand the helper the real service class.
vi.mock('@/services/eurostat-data/eurostat-data-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/eurostat-data/eurostat-data-service.js')>()),
  getEurostatDataService: vi.fn(),
}));

import {
  EurostatDataService,
  getEurostatDataService,
} from '@/services/eurostat-data/eurostat-data-service.js';

const failingRead = (err: Error) =>
  vi
    .mocked(getEurostatDataService)
    .mockReturnValue({ getDimensionOrder: vi.fn().mockRejectedValue(err) } as never);

describe('dimensionsToNarrow', () => {
  it('reuses a dimension order the request already read', async () => {
    const getDimensionOrder = vi.fn();
    vi.mocked(getEurostatDataService).mockReturnValue({ getDimensionOrder } as never);
    await expect(dimensionsToNarrow('nama_10_gdp', ['geo'], createMockContext())).resolves.toEqual([
      'geo',
    ]);
    expect(getDimensionOrder).not.toHaveBeenCalled();
  });

  it('leaves the hint generic when the structure read fails', async () => {
    failingRead(new Error('structure unavailable'));
    await expect(
      dimensionsToNarrow('nama_10_gdp', [], createMockContext()),
    ).resolves.toBeUndefined();
  });

  it('rethrows when the call was cancelled, so the cancellation is not masked', async () => {
    const abort = new Error('aborted');
    failingRead(abort);
    const controller = new AbortController();
    controller.abort();
    await expect(
      dimensionsToNarrow('nama_10_gdp', [], createMockContext({ signal: controller.signal })),
    ).rejects.toBe(abort);
  });
});

/**
 * The real service with only fetch faked, because the retry ladder and its deadline are
 * what is under test. Every path the helper serves goes through this one read, so the
 * tools' own tests prove only that they reach it.
 */
describe('dimensionsToNarrow — one deadline across the read (#85)', () => {
  const unavailable = () => new Response('Service Unavailable', { status: 503 });
  /** A request that never answers: it settles only when its signal aborts. */
  const hang = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  const track = <T>(read: Promise<T>) => {
    let settled = false;
    const outcome = read.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    return { outcome, settled: () => settled };
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Far past the deadline on both, so neither default stall timeout can end a read for it.
    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      ...serverConfig.getServerConfig(),
      requestTimeoutMs: 600_000,
      metadataTimeoutMs: 600_000,
    });
    fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
      throw new Error(`Unmocked fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getEurostatDataService).mockReturnValue(
      new EurostatDataService({} as never, {} as never),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the dimensions a captured structure definition lists, on one attempt', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          readFileSync(
            new URL('../fixtures/nama-10-gdp-datastructure.xml', import.meta.url),
            'utf8',
          ),
        ),
    );
    await expect(dimensionsToNarrow('nama_10_gdp', [], createMockContext())).resolves.toEqual([
      'freq',
      'unit',
      'na_item',
      'geo',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      '/eurostat/api/dissemination/sdmx/2.1/datastructure/ESTAT/nama_10_gdp',
    );
  });

  it('gives up on a read that never answers at 5 s, on its one attempt', async () => {
    fetchMock.mockImplementation(hang);
    const read = track(dimensionsToNarrow('nama_10_gdp', [], createMockContext()));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toEqual({ value: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts a retry against the same 5 s, so a stalled second attempt ends at 5 s, not 6 s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchMock.mockImplementationOnce(async () => unavailable()).mockImplementation(hang);
    const read = track(dimensionsToNarrow('nama_10_gdp', [], createMockContext()));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read.settled()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toEqual({ value: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the low end', 0],
    ['the middle', 0.5],
    ['the high end', 0.999],
  ])(
    'fails over a read answering 503 after 3 attempts at %s of the jitter',
    async (_name, random) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      fetchMock.mockImplementation(async () => unavailable());
      const read = track(dimensionsToNarrow('nama_10_gdp', [], createMockContext()));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(read.settled()).toBe(true);
      await expect(read.outcome).resolves.toEqual({ value: undefined });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    ['a 404', () => new Response('<fault/>', { status: 404 })],
    ['a body that is not XML', () => new Response('<<<', { status: 200 })],
  ])('fails over %s on its one attempt', async (_name, reply) => {
    fetchMock.mockImplementation(async () => reply());
    const read = track(dimensionsToNarrow('nama_10_gdp', [], createMockContext()));
    await vi.advanceTimersByTimeAsync(0);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toEqual({ value: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows a cancellation during an attempt as a cancellation, with no further attempt', async () => {
    fetchMock.mockImplementation(hang);
    const controller = new AbortController();
    const read = track(
      dimensionsToNarrow('nama_10_gdp', [], createMockContext({ signal: controller.signal })),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read.settled()).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows a cancellation during a backoff, with no further attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchMock.mockImplementation(async () => unavailable());
    const controller = new AbortController();
    const reason = new DOMException('caller went away', 'AbortError');
    const read = track(
      dimensionsToNarrow('nama_10_gdp', [], createMockContext({ signal: controller.signal })),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(read.settled()).toBe(false);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.settled()).toBe(true);
    await expect(read.outcome).resolves.toEqual({ error: reason });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
