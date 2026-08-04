/**
 * @fileoverview Tests for the DataCanvas accessor — presence reporting and the
 * translation of a scratch-directory permission failure into an actionable error.
 * @module tests/services/canvas-accessor.test
 */

import type { CanvasInstance, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireCanvas, getCanvas, setCanvas } from '@/services/canvas-accessor.js';

const ctx = () => createMockContext({ tenantId: 'default' });

/** A canvas whose acquire fails the way the given error says it does. */
const failingCanvas = (err: unknown): DataCanvas =>
  ({ acquire: vi.fn().mockRejectedValue(err) }) as unknown as DataCanvas;

/** The shape Node throws when `mkdir` cannot write to the configured path. */
const errno = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

afterEach(() => {
  setCanvas(undefined);
});

describe('canvas accessor', () => {
  it('reports absence rather than throwing when no canvas is wired', () => {
    setCanvas(undefined);
    expect(getCanvas()).toBeUndefined();
  });

  it('returns the wired canvas', () => {
    const canvas = {} as DataCanvas;
    setCanvas(canvas);
    expect(getCanvas()).toBe(canvas);
  });

  it('passes a successful acquire straight through', async () => {
    const instance = { canvasId: 'abc0123456' } as CanvasInstance;
    const canvas = { acquire: vi.fn().mockResolvedValue(instance) } as unknown as DataCanvas;
    await expect(acquireCanvas(canvas, 'abc0123456', ctx())).resolves.toBe(instance);
  });

  // `acquire` creates the scratch root before opening DuckDB, so CANVAS_TEMP_PATH is the
  // path that fails here — a read-only mount or a directory the non-root container user
  // does not own. A bare `EACCES … mkdir '/var/lib/…'` gives an operator nothing to act
  // on; the variable that controls the path has to be named.
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC']) {
    it(`names the configuration knob when the scratch directory fails with ${code}`, async () => {
      const canvas = failingCanvas(errno(code, `mkdir '/var/lib/eurostat-mcp-server/canvas-tmp'`));
      const err = (await acquireCanvas(canvas, undefined, ctx()).catch(
        (e: unknown) => e,
      )) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toContain('CANVAS_TEMP_PATH');
      expect(err.message).toContain(code);
      expect(err.data).toMatchObject({ reason: 'canvas_unavailable', errno: code });
    });
  }

  it('finds the errno through a wrapped cause chain', async () => {
    const canvas = failingCanvas(
      new Error('Canvas init failed', { cause: errno('EACCES', 'mkdir denied') }),
    );
    await expect(acquireCanvas(canvas, undefined, ctx())).rejects.toMatchObject({
      data: { reason: 'canvas_unavailable', errno: 'EACCES' },
    });
  });

  it('leaves an unrelated failure exactly as it was', async () => {
    // Only filesystem-permission failures are reinterpreted; a NotFound for an unknown
    // canvas_id must reach the caller with its own reason and recovery hint intact.
    const original = Object.assign(new Error('Canvas not found'), {
      data: { reason: 'canvas_not_found' },
    });
    const canvas = failingCanvas(original);
    await expect(acquireCanvas(canvas, 'zzzzzzzzzz', ctx())).rejects.toBe(original);
  });

  it('does not reinterpret an errno it was not written for', async () => {
    const original = errno('ETIMEDOUT', 'connect timed out');
    const canvas = failingCanvas(original);
    await expect(acquireCanvas(canvas, undefined, ctx())).rejects.toBe(original);
  });
});
