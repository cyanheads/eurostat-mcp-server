/**
 * @fileoverview Tests for the too-large refusal's dimension lookup — a failed read
 * degrades the hint, a cancelled call does not.
 * @module tests/tools/narrowing-advice.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { dimensionsToNarrow } from '@/mcp-server/tools/narrowing-advice.js';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

vi.mock('@/services/eurostat-data/eurostat-data-service.js', () => ({
  getEurostatDataService: vi.fn(),
}));

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
