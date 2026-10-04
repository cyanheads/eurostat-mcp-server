/**
 * @fileoverview Tests for the DataCanvas accessor — presence reporting and the
 * translation of a scratch-directory failure into an actionable error.
 * @module tests/services/canvas-accessor.test
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasInstance, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { configurationError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireCanvas, getCanvas, setCanvas } from '@/services/canvas-accessor.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

const ctx = () => createMockContext({ tenantId: 'default' });

/** A canvas whose acquire fails the way the given error says it does. */
const failingCanvas = (err: unknown): DataCanvas =>
  ({ acquire: vi.fn().mockRejectedValue(err) }) as unknown as DataCanvas;

/** The shape Node throws when `mkdir` cannot write to the configured path. */
const errno = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

/**
 * The shape the framework's DuckDB provider throws when it cannot create its
 * private scratch directory: a `ConfigurationError` with the filesystem error on
 * `cause`.
 */
const scratchFailure = (cause: Error): McpError =>
  configurationError(
    'Canvas scratch directory could not be created: CANVAS_TEMP_PATH (the OS temp directory when unset) must be writable by the server process.',
    undefined,
    { cause },
  );

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

  // The framework's message names CANVAS_TEMP_PATH but carries the errno only on `cause`,
  // which never reaches the caller — so EACCES and ENOSPC would read the same. The re-throw
  // keeps the ConfigurationError code and adds the errno and the run-without-canvas option.
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC']) {
    it(`names the errno and both configuration knobs when the scratch directory fails with ${code}`, async () => {
      const fsErr = errno(code, `mkdir '/var/lib/eurostat-mcp-server/canvas-tmp'`);
      const canvas = failingCanvas(scratchFailure(fsErr));
      const err = (await acquireCanvas(canvas, undefined, ctx()).catch(
        (e: unknown) => e,
      )) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect(err.message).toContain('CANVAS_TEMP_PATH');
      expect(err.message).toContain('CANVAS_PROVIDER_TYPE=none');
      expect(err.message).toContain(code);
      expect(err.data).toMatchObject({ reason: 'canvas_unavailable', errno: code });
      expect((err.cause as McpError).cause).toBe(fsErr);
    });
  }

  it('finds an errno thrown bare, without a wrapping error', async () => {
    const canvas = failingCanvas(errno('EACCES', 'mkdir denied'));
    await expect(acquireCanvas(canvas, undefined, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
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

  it('leaves a scratch failure with an errno it was not written for exactly as it was', async () => {
    const original = scratchFailure(errno('ENOTDIR', 'mkdir: not a directory'));
    const canvas = failingCanvas(original);
    await expect(acquireCanvas(canvas, undefined, ctx())).rejects.toBe(original);
  });

  // Pins the framework behaviour the mapping depends on: a real DuckDB canvas pointed at
  // a parent it cannot write must still carry the errno on its error's cause chain.
  // Root bypasses the permission bit, and Windows ignores it, so neither can reproduce it.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'maps a real canvas whose CANVAS_TEMP_PATH parent is not writable',
    async () => {
      const readOnly = mkdtempSync(join(tmpdir(), 'eurostat-canvas-readonly-'));
      chmodSync(readOnly, 0o500);
      const { canvas, teardown } = withRealCanvas({ tempRootPath: join(readOnly, 'scratch') });
      try {
        await expect(acquireCanvas(canvas, undefined, ctx())).rejects.toMatchObject({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringContaining('(EACCES)'),
          data: { reason: 'canvas_unavailable', errno: 'EACCES' },
        });
      } finally {
        await teardown();
        chmodSync(readOnly, 0o700);
        rmSync(readOnly, { recursive: true, force: true });
      }
    },
  );
});
