/**
 * @fileoverview Tests for the eurostat_dataframe_query tool, against a real
 * DuckDB canvas.
 * @module tests/tools/eurostat-dataframe-query.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eurostatDataframeQuery } from '@/mcp-server/tools/definitions/eurostat-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import {
  observationRowSchema,
  toObservationRow,
} from '@/services/eurostat-data/eurostat-data-service.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

let canvas: DataCanvas;
let teardown: () => Promise<void>;
let canvasId: string;

/** Canvas operations are tenant-scoped; stdio and auth-off HTTP both resolve to 'default'. */
const ctx = () => createMockContext({ errors: eurostatDataframeQuery.errors, tenantId: 'default' });

beforeAll(async () => {
  ({ canvas, teardown } = withRealCanvas());
  const instance = await canvas.acquire(undefined, ctx());
  canvasId = instance.canvasId;
  // Staged through the production row builder and column schema, so the table under test has
  // the columns and types eurostat_query_dataset actually writes — not a hand-typed lookalike.
  const dims = ['geo', 'time'];
  const observation = (
    geo: string,
    geoLabel: string,
    time: string,
    value: number | null,
    flag?: string,
  ) => ({
    dimensions: { geo: { code: geo, label: geoLabel }, time: { code: time, label: time } },
    value,
    ...(flag && { status: { code: flag, label: 'provisional' } }),
  });
  await instance.registerTable(
    'df_test0001',
    [
      observation('DE', 'Germany', '2023', 3_867_000),
      observation('FR', 'France', '2023', 2_785_000, 'p'),
      observation('DE', 'Germany', '2024', 3_900_000),
      observation('IT', 'Italy', '2024', null),
    ].map((obs) => toObservationRow(obs, dims)),
    { schema: observationRowSchema(dims) },
  );
});

afterAll(async () => {
  await teardown();
});

describe('eurostatDataframeQuery', () => {
  it('runs a SELECT and returns rows keyed by column name', async () => {
    const input = eurostatDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: "SELECT geo, obs_value FROM df_test0001 WHERE time = '2024' ORDER BY geo",
    });
    const result = await eurostatDataframeQuery.handler(input, ctx());
    expect(result.canvasId).toBe(canvasId);
    expect(result.columns).toEqual(['geo', 'obs_value']);
    expect(result.rows).toEqual([
      { geo: 'DE', obs_value: 3_900_000 },
      { geo: 'IT', obs_value: null },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('aggregates across the staged rows — the reason the table exists', async () => {
    const input = eurostatDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT geo, AVG(obs_value) AS mean FROM df_test0001 GROUP BY geo ORDER BY geo',
    });
    const result = await eurostatDataframeQuery.handler(input, ctx());
    expect(result.rows).toEqual([
      { geo: 'DE', mean: 3_883_500 },
      { geo: 'FR', mean: 2_785_000 },
      { geo: 'IT', mean: null },
    ]);
  });

  it('reports a table it cannot find rather than an empty result', async () => {
    const input = eurostatDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT * FROM df_does_not_exist',
    });
    await expect(eurostatDataframeQuery.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table' },
    });
  });

  it('reports an unknown canvas as not found rather than minting an empty one', async () => {
    const input = eurostatDataframeQuery.input.parse({
      canvas_id: 'zzzzzzzzzz',
      sql: 'SELECT 1',
    });
    await expect(eurostatDataframeQuery.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('names a mistyped column instead of returning nothing', async () => {
    const input = eurostatDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT no_such_column FROM df_test0001',
    });
    const err = (await eurostatDataframeQuery
      .handler(input, ctx())
      .catch((e: unknown) => e)) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_sql' });
  });

  it('fails with an actionable error when the deployment has no canvas', async () => {
    // The registration gate keeps this tool off tools/list without a canvas; the handler
    // still has to answer honestly rather than dereference an absent service.
    setCanvas(undefined);
    try {
      const input = eurostatDataframeQuery.input.parse({
        canvas_id: canvasId,
        sql: 'SELECT 1',
      });
      const err = (await eurostatDataframeQuery
        .handler(input, ctx())
        .catch((e: unknown) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'canvas_disabled' });
      // The caller is told what to do instead, not just that something is off.
      expect((err.data as { recovery?: { hint?: string } }).recovery?.hint).toContain(
        'eurostat_query_dataset',
      );
    } finally {
      setCanvas(canvas);
    }
  });

  it('discloses a result cut short by the canvas row limit', async () => {
    // A separate canvas with a row limit of 2, so the cap is reachable without staging
    // 10,000 rows. `truncated` is the only signal that rows are missing — a result that
    // silently drops them reads as a complete answer.
    const capped = withRealCanvas({ defaultRowLimit: 2 });
    try {
      const instance = await capped.canvas.acquire(undefined, ctx());
      const dims = ['geo'];
      await instance.registerTable(
        'df_capped01',
        ['AT', 'BE', 'CY', 'DE'].map((geo) =>
          toObservationRow({ dimensions: { geo: { code: geo, label: geo } }, value: 1 }, dims),
        ),
        { schema: observationRowSchema(dims) },
      );

      const result = await eurostatDataframeQuery.handler(
        eurostatDataframeQuery.input.parse({
          canvas_id: instance.canvasId,
          sql: 'SELECT geo FROM df_capped01 ORDER BY geo',
        }),
        ctx(),
      );
      expect(result.truncated).toBe(true);
      expect(result.rows).toHaveLength(2);
      expect(result.rowCount).toBe(2);

      // …and the caller is told how to get the rest, in content[] as well as the field.
      const text = eurostatDataframeQuery.format!(result)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');
      expect(text).toContain('**Truncated:** true');
      expect(text).toContain('add a LIMIT, an aggregate, or a narrower WHERE clause');
    } finally {
      await capped.teardown();
      setCanvas(canvas);
    }
  });

  it('renders every row and column into content[] (format parity)', () => {
    const blocks = eurostatDataframeQuery.format!({
      canvasId: 'cnv0000001',
      columns: ['geo', 'obs_value'],
      rows: [
        { geo: 'DE', obs_value: 1 },
        { geo: 'FR', obs_value: null },
      ],
      rowCount: 2,
      truncated: false,
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('cnv0000001');
    expect(text).toContain('geo=DE');
    expect(text).toContain('obs_value=1');
    // A null cell renders as NULL rather than as an empty string a reader would misread.
    expect(text).toContain('obs_value=NULL');
    const renderedRows = text.split('\n').filter((l) => l.startsWith('geo=')).length;
    expect(renderedRows).toBe(2);
  });
});
