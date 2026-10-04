/**
 * @fileoverview Tests for the eurostat_dataframe_drop tool, against a real
 * DuckDB canvas.
 * @module tests/tools/eurostat-dataframe-drop.tool.test
 */

import type { CallToolResult } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eurostatDataframeDescribe } from '@/mcp-server/tools/definitions/eurostat-dataframe-describe.tool.js';
import { eurostatDataframeDrop } from '@/mcp-server/tools/definitions/eurostat-dataframe-drop.tool.js';
import { eurostatDataframeQuery } from '@/mcp-server/tools/definitions/eurostat-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import {
  observationRowSchema,
  toObservationRow,
} from '@/services/eurostat-data/eurostat-data-service.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

let canvas: DataCanvas;
let teardown: () => Promise<void>;

/** Canvas operations are tenant-scoped; stdio and auth-off HTTP both resolve to 'default'. */
const ctx = () => createMockContext({ errors: eurostatDataframeDrop.errors, tenantId: 'default' });

const DIMS = ['geo', 'time'];

/**
 * Stage observation tables through the production row builder and column
 * schema, so the tables under test are the ones eurostat_query_dataset writes.
 */
async function stage(instance: CanvasInstance, ...names: string[]): Promise<void> {
  for (const name of names) {
    await instance.registerTable(
      name,
      ['DE', 'FR'].map((geo) =>
        toObservationRow(
          {
            dimensions: { geo: { code: geo, label: geo }, time: { code: '2024', label: '2024' } },
            value: 1,
          },
          DIMS,
        ),
      ),
      { schema: observationRowSchema(DIMS) },
    );
  }
}

/** A fresh canvas holding `names`, so each case starts from its own state. */
async function canvasWith(...names: string[]): Promise<string> {
  const instance = await canvas.acquire(undefined, ctx());
  await stage(instance, ...names);
  return instance.canvasId;
}

/** Names of the tables eurostat_dataframe_describe lists on `canvasId`. */
async function stagedNames(canvasId: string): Promise<string[]> {
  const described = await eurostatDataframeDescribe.handler(
    eurostatDataframeDescribe.input.parse({ canvas_id: canvasId }),
    createMockContext({ errors: eurostatDataframeDescribe.errors, tenantId: 'default' }),
  );
  return described.tables.map((t) => t.name).sort();
}

const drop = (canvasId: string, tableName: string, c = ctx()) =>
  eurostatDataframeDrop.handler(
    eurostatDataframeDrop.input.parse({ canvas_id: canvasId, table_name: tableName }),
    c,
  );

const textOf = (result: CallToolResult): string =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');

beforeAll(() => {
  ({ canvas, teardown } = withRealCanvas());
});

afterAll(async () => {
  await teardown();
});

describe('eurostatDataframeDrop', () => {
  it('removes the named table and leaves every other table on the canvas intact', async () => {
    const canvasId = await canvasWith('df_drop0001', 'df_keep0001');

    const result = await drop(canvasId, 'df_drop0001');
    expect(result).toEqual({
      canvasId,
      tableName: 'df_drop0001',
      dropped: true,
      expiresAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(result.expiresAt))).toBe(false);

    expect(await stagedNames(canvasId)).toEqual(['df_keep0001']);

    // The survivor still answers SQL with its rows, not just a name in the listing.
    const survivor = await eurostatDataframeQuery.handler(
      eurostatDataframeQuery.input.parse({
        canvas_id: canvasId,
        sql: 'SELECT geo FROM df_keep0001 ORDER BY geo',
      }),
      createMockContext({ errors: eurostatDataframeQuery.errors, tenantId: 'default' }),
    );
    expect(survivor.rows).toEqual([{ geo: 'DE' }, { geo: 'FR' }]);

    // …and the dropped table is gone to SQL as well.
    await expect(
      eurostatDataframeQuery.handler(
        eurostatDataframeQuery.input.parse({
          canvas_id: canvasId,
          sql: 'SELECT * FROM df_drop0001',
        }),
        createMockContext({ errors: eurostatDataframeQuery.errors, tenantId: 'default' }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'missing_table' } });
  });

  it('reports dropped: false with guidance, not an error, when nothing by that name is staged', async () => {
    const canvasId = await canvasWith('df_keep0002');
    const c = ctx();

    const result = await drop(canvasId, 'df_never_staged', c);
    expect(result.dropped).toBe(false);
    expect(result.tableName).toBe('df_never_staged');
    expect(getEnrichment(c).notice).toContain('eurostat_dataframe_describe');
    expect(await stagedNames(canvasId)).toEqual(['df_keep0002']);
  });

  it('matches the name exactly, so a different case drops nothing', async () => {
    const canvasId = await canvasWith('df_case0001');
    expect((await drop(canvasId, 'DF_CASE0001')).dropped).toBe(false);
    expect(await stagedNames(canvasId)).toEqual(['df_case0001']);
  });

  it('treats a repeated drop as a no-op rather than a failure', async () => {
    const canvasId = await canvasWith('df_twice001', 'df_keep0003');
    expect((await drop(canvasId, 'df_twice001')).dropped).toBe(true);

    const c = ctx();
    const again = await drop(canvasId, 'df_twice001', c);
    expect(again.dropped).toBe(false);
    expect(getEnrichment(c).notice).toContain('df_twice001');
    expect(await stagedNames(canvasId)).toEqual(['df_keep0003']);
  });

  it('drops a view without touching the table it reads from', async () => {
    const instance = await canvas.acquire(undefined, ctx());
    await stage(instance, 'df_base0001');
    await instance.registerView('df_view0001', 'SELECT geo FROM df_base0001');

    expect((await drop(instance.canvasId, 'df_view0001')).dropped).toBe(true);
    expect(await stagedNames(instance.canvasId)).toEqual(['df_base0001']);
  });

  it('carries the same result on structuredContent and content[]', async () => {
    const canvasId = await canvasWith('df_parity01');
    const result = await runToolContract(
      eurostatDataframeDrop,
      { canvas_id: canvasId, table_name: 'df_parity01' },
      { context: { tenantId: 'default' } },
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ canvasId, tableName: 'df_parity01', dropped: true });
    expect(structured.notice).toBeUndefined();

    const text = textOf(result);
    expect(text).toContain(canvasId);
    expect(text).toContain('df_parity01');
    expect(text).toContain('**Dropped:** true');
    expect(text).toContain(structured.expiresAt as string);
  });

  it('puts the nothing-dropped notice on both surfaces', async () => {
    const canvasId = await canvasWith('df_keep0004');
    const result = await runToolContract(
      eurostatDataframeDrop,
      { canvas_id: canvasId, table_name: 'df_absent01' },
      { context: { tenantId: 'default' } },
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      dropped: false,
      notice: expect.stringContaining('eurostat_dataframe_describe'),
    });
    const text = textOf(result);
    expect(text).toContain('**Dropped:** false');
    expect(text).toMatch(/holds no table named "df_absent01".*eurostat_dataframe_describe/s);
  });

  it('reports an unknown canvas as not found rather than minting an empty one', async () => {
    await expect(drop('zzzzzzzzzz', 'df_any00001')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });

    // On the wire the failure carries this tool's recovery on both surfaces — not the
    // canvas service's advice to re-stage, which for a drop restores what was meant to go.
    const declared = eurostatDataframeDrop.errors?.find(
      (e) => e.reason === 'canvas_not_found',
    )?.recovery;
    expect(declared).toContain('nothing is left to drop');
    const result = await runToolContract(
      eurostatDataframeDrop,
      { canvas_id: 'zzzzzzzzzz', table_name: 'df_any00001' },
      { context: { tenantId: 'default' } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', canvasId: 'zzzzzzzzzz', recovery: { hint: declared } },
      },
    });
    expect(textOf(result)).toContain(`Recovery: ${declared}`);
    expect(textOf(result)).not.toContain('stage fresh data');
  });

  it('reports an expired canvas as not found', async () => {
    const shortLived = withRealCanvas({ ttlMs: 50 });
    try {
      /**
       * Nothing is staged between acquire and the wait: a staging call that runs
       * past the TTL under suite load would hit the expiry itself, before the
       * drop under test.
       */
      const instance = await shortLived.canvas.acquire(undefined, ctx());
      await new Promise((resolve) => setTimeout(resolve, 200));

      await expect(drop(instance.canvasId, 'df_stale001')).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found' },
      });
    } finally {
      await shortLived.teardown();
      setCanvas(canvas);
    }
  });

  it('rejects a table name that is not an identifier at argument validation, pointing at describe', async () => {
    const canvasId = await canvasWith('df_keep0005');
    for (const tableName of ['df-keep0005', 'df keep', '1df', '', 'df_keep0005; DROP TABLE x']) {
      const result = await runToolContract(
        eurostatDataframeDrop,
        { canvas_id: canvasId, table_name: tableName },
        { context: { tenantId: 'default' } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments' },
        },
      });
      expect(textOf(result)).toContain('eurostat_dataframe_describe');
    }
    expect(await stagedNames(canvasId)).toEqual(['df_keep0005']);
  });

  it('rejects a bare SQL keyword as a table name, pointing at the staged names', async () => {
    const canvasId = await canvasWith('df_keep0006');

    await expect(drop(canvasId, 'select')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'identifier_reserved', tableName: 'select' },
    });

    // The canvas's own message and hint are worded for naming a new table; the caller gets this tool's.
    const result = await runToolContract(
      eurostatDataframeDrop,
      { canvas_id: canvasId, table_name: 'SELECT' },
      { context: { tenantId: 'default' } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'identifier_reserved',
          recovery: {
            hint: 'Call eurostat_dataframe_describe and copy a table name exactly as it is listed.',
          },
        },
      },
    });
    expect(textOf(result)).toContain('"SELECT" is a reserved SQL keyword');
    expect(textOf(result)).not.toContain('Choose another name');
    expect(await stagedNames(canvasId)).toEqual(['df_keep0006']);
  });

  it('rejects a malformed canvas_id at argument validation, before any canvas lookup', async () => {
    const result = await runToolContract(eurostatDataframeDrop, {
      canvas_id: 'df_keep0001',
      table_name: 'df_keep0001',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      },
    });
    expect(textOf(result)).toContain('canvas_id');
  });

  it('fails with an actionable error when the deployment has no canvas', async () => {
    // The registration gate keeps this tool off tools/list without a canvas; the handler
    // still has to answer honestly rather than dereference an absent service.
    // Run through runToolContract, which fills the declared recovery hint as production
    // does: the handler throws only the reason.
    setCanvas(undefined);
    try {
      const result = await runToolContract(eurostatDataframeDrop, {
        canvas_id: 'zzzzzzzzzz',
        table_name: 'df_any00001',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'canvas_disabled',
            recovery: { hint: expect.stringContaining('eurostat_query_dataset') },
          },
        },
      });
      expect(textOf(result)).toMatch(/Recovery:.*eurostat_query_dataset/s);
    } finally {
      setCanvas(canvas);
    }
  });

  it('renders every output field into content[] (format parity)', () => {
    for (const dropped of [true, false]) {
      const text = eurostatDataframeDrop.format!({
        canvasId: 'cnv0000001',
        tableName: 'df_abcd1234',
        dropped,
        expiresAt: '2026-08-05T00:00:00.000Z',
      })
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');
      expect(text).toContain('cnv0000001');
      expect(text).toContain('df_abcd1234');
      expect(text).toContain(`**Dropped:** ${dropped}`);
      expect(text).toContain('2026-08-05T00:00:00.000Z');
    }
  });
});
