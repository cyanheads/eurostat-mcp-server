/**
 * @fileoverview Module-level accessor for the framework's optional DataCanvas
 * service, plus the acquire helper every canvas-touching handler goes through.
 * @module services/canvas-accessor
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';

let _canvas: DataCanvas | undefined;

/** Wired from `setup(core)` in `src/index.ts`. `undefined` when canvas is off. */
export function setCanvas(canvas: DataCanvas | undefined): void {
  _canvas = canvas;
}

/**
 * The DataCanvas service, or `undefined` when `CANVAS_PROVIDER_TYPE` is not
 * `duckdb`. Callers branch on the absence rather than assuming a canvas exists:
 * the server is a supported configuration with and without one.
 */
export function getCanvas(): DataCanvas | undefined {
  return _canvas;
}

/**
 * A fresh handle for one staged table. Distinct per call — every staging call is
 * its own result set, and a reused name would replace the previous table.
 */
export function newTableName(): string {
  return `df_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Errno codes meaning the configured scratch root cannot be written to.
 *
 * `ENOENT` is deliberately absent — the provider creates `CANVAS_TEMP_PATH`
 * recursively, so a missing parent is created rather than reported.
 */
const UNWRITABLE_ERRNOS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

/** First `errno` code found on an error or any link of its `cause` chain. */
function errnoOf(err: unknown): string | undefined {
  for (let cur = err, depth = 0; cur instanceof Error && depth < 5; depth++) {
    const code = (cur as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && UNWRITABLE_ERRNOS.has(code)) return code;
    cur = cur.cause;
  }
  return;
}

/**
 * Acquire a canvas, re-throwing a scratch-directory failure with its errno and
 * both configuration ways out.
 *
 * On the first acquire the DuckDB provider creates `CANVAS_TEMP_PATH` (the OS
 * temp directory when unset) and a private `mcp-canvas-XXXXXX` directory inside
 * it. A parent it cannot write — a root-owned or read-only path under a non-root
 * container user, or a full disk — fails the acquire as a `ConfigurationError`
 * whose `cause` is the filesystem error. Its message names `CANVAS_TEMP_PATH`
 * but not the errno, which never reaches the caller from `cause`, nor
 * `CANVAS_PROVIDER_TYPE=none`; this keeps the code and adds both, plus a stable
 * `data.reason`.
 */
export async function acquireCanvas(
  canvas: DataCanvas,
  canvasId: string | undefined,
  ctx: Context,
): Promise<CanvasInstance> {
  try {
    return await canvas.acquire(canvasId, ctx);
  } catch (err) {
    const errno = errnoOf(err);
    if (!errno) throw err;
    throw configurationError(
      `DataCanvas could not create its private scratch directory inside CANVAS_TEMP_PATH (${errno}). Point CANVAS_TEMP_PATH at a parent directory the server process can write to (the OS temp directory is used when it is unset), or set CANVAS_PROVIDER_TYPE=none to run without the dataframe tools.`,
      { reason: 'canvas_unavailable', errno },
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
