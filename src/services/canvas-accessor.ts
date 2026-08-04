/**
 * @fileoverview Module-level accessor for the framework's optional DataCanvas
 * service, plus the acquire helper every canvas-touching handler goes through.
 * @module services/canvas-accessor
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

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
 * `ENOENT` is deliberately absent — `mkdir` is recursive, so a missing parent
 * is created rather than reported.
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
 * Acquire a canvas, translating a scratch-directory permission failure into an
 * error that names the variable to change.
 *
 * DuckDB writes spill files under `CANVAS_TEMP_PATH`, whose directory is created
 * on the first acquire. A container running as a non-root user against a
 * root-owned or read-only path otherwise surfaces a bare `EACCES … mkdir` with
 * nothing to connect it to a configuration knob.
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
    throw serviceUnavailable(
      `DataCanvas could not create its scratch directory (${errno}). Point CANVAS_TEMP_PATH at a directory the server process can write to, or set CANVAS_PROVIDER_TYPE=none to run without the dataframe tools.`,
      { reason: 'canvas_unavailable', errno },
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
