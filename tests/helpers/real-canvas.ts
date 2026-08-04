/**
 * @fileoverview Test helper: a real DuckDB-backed DataCanvas.
 *
 * The dataframe tools are thin wrappers over the framework's canvas — what is
 * worth testing about them is the behaviour a caller sees when real SQL runs,
 * above all which statements the read-only gate refuses. A fake canvas would
 * have to re-implement that gate to answer those questions, which tests the
 * fake rather than the server. `@duckdb/node-api` is a runtime dependency, so
 * this runs the genuine engine.
 *
 * @module tests/helpers/real-canvas
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { createCanvasService } from '@cyanheads/mcp-ts-core/canvas';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { setCanvas } from '@/services/canvas-accessor.js';

/**
 * Build a real canvas, wire it into the module accessor the tools read, and
 * return a teardown that unwires it. Scratch and export roots are per-suite
 * temp directories so a run never touches the repository working tree.
 *
 * `overrides` reaches the framework's canvas settings — pass a small
 * `defaultRowLimit` to exercise the row cap without staging 10,000 rows.
 */
export function withRealCanvas(overrides: Partial<AppConfig['canvas']> = {}): {
  canvas: DataCanvas;
  teardown: () => Promise<void>;
} {
  const root = mkdtempSync(join(tmpdir(), 'eurostat-canvas-test-'));
  const canvas = createCanvasService({
    canvas: {
      providerType: 'duckdb',
      defaultMemoryLimitMb: 256,
      exportRootPath: join(root, 'exports'),
      tempRootPath: join(root, 'tmp'),
      maxCanvasesPerTenant: 100,
      ttlMs: 60_000,
      absoluteCapMs: 120_000,
      // No background sweeper: a timer outliving the suite is a leak, not coverage.
      sweeperIntervalMs: 0,
      defaultRowLimit: 10_000,
      schemaSniffRows: 100,
      ...overrides,
    },
  } as AppConfig);

  if (!canvas) throw new Error('createCanvasService returned no canvas for providerType=duckdb');
  setCanvas(canvas);

  return {
    canvas,
    teardown: async () => {
      setCanvas(undefined);
      await canvas.shutdown({ requestId: 'test-teardown', timestamp: new Date().toISOString() });
    },
  };
}
