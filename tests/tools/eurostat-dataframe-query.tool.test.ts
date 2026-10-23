/**
 * @fileoverview Tests for the eurostat_dataframe_query tool, against a real
 * DuckDB canvas.
 * @module tests/tools/eurostat-dataframe-query.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  it('preserves scalar values, bigint strings and empty results before response shaping', async () => {
    const result = await runToolContract(
      eurostatDataframeQuery,
      {
        canvas_id: canvasId,
        sql: 'SELECT 42 AS n, 9223372036854775807::BIGINT AS big, NULL AS nil',
      },
      { context: { tenantId: 'default' } },
    );
    expect(result.structuredContent).toMatchObject({
      rows: [{ n: 42, big: '9223372036854775807', nil: null }],
      rowCount: 1,
      truncated: false,
    });
    const empty = await runToolContract(
      eurostatDataframeQuery,
      { canvas_id: canvasId, sql: 'SELECT geo FROM df_test0001 WHERE false' },
      { context: { tenantId: 'default' } },
    );
    expect(empty.structuredContent).toMatchObject({ rows: [], rowCount: 0, truncated: false });
    expect(empty.structuredContent).not.toHaveProperty('notice');
    expect(result.content.map((block) => ('text' in block ? block.text : '')).join('\n')).toContain(
      'big="9223372036854775807"',
    );
  });

  it('renders nested cells as lossless JSON through the production formatter', async () => {
    const result = await runToolContract(
      eurostatDataframeQuery,
      {
        canvas_id: canvasId,
        sql: `SELECT [{'period':'2024','value':42}, {'period':'2023','value':NULL}] AS series, 'NULL' AS literal, NULL AS nil, true AS yes, '雪\n" | =' AS text`,
      },
      { context: { tenantId: 'default' } },
    );
    expect(result.isError).not.toBe(true);
    const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('series=[{"period":"2024","value":42},{"period":"2023","value":null}]');
    expect(text).toContain('literal="NULL" | nil=null | yes=true | text="雪\\n\\" | ="');
  });

  it('bounds full production envelopes and pages by the returned rowCount', async () => {
    const sql =
      "SELECT i, repeat('雪\\\"', 5000) AS wide FROM (VALUES (0), (1), (2)) AS r(i) ORDER BY i LIMIT 3";
    const first = await runToolContract(
      eurostatDataframeQuery,
      { canvas_id: canvasId, sql },
      { context: { tenantId: 'default' } },
    );
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      rowCount: 1,
      truncated: true,
      notice: expect.stringContaining('64,000'),
    });
    expect(Buffer.byteLength(JSON.stringify(first.structuredContent))).toBeLessThanOrEqual(64000);
    expect(Buffer.byteLength(JSON.stringify(first.content))).toBeLessThanOrEqual(64000);
    const next = await runToolContract(
      eurostatDataframeQuery,
      { canvas_id: canvasId, sql: `${sql} OFFSET 1` },
      { context: { tenantId: 'default' } },
    );
    expect(next.structuredContent).toMatchObject({
      rows: [{ i: 1 }],
      rowCount: 1,
      truncated: true,
    });
    const last = await runToolContract(
      eurostatDataframeQuery,
      { canvas_id: canvasId, sql: `${sql} OFFSET 2` },
      { context: { tenantId: 'default' } },
    );
    expect(last.structuredContent).toMatchObject({
      rows: [{ i: 2 }],
      rowCount: 1,
      truncated: false,
    });
    expect(last.structuredContent).not.toHaveProperty('notice');
    const ids = [first, next, last].flatMap((page) =>
      (page.structuredContent as { rows: { i: number }[] }).rows.map((row) => row.i),
    );
    expect(ids).toEqual([0, 1, 2]);
    expect(first.content.map((b) => ('text' in b ? b.text : '')).join('\n')).toContain(
      (first.structuredContent as { notice: string }).notice,
    );
    const end = await runToolContract(
      eurostatDataframeQuery,
      { canvas_id: canvasId, sql: `${sql} OFFSET 3` },
      { context: { tenantId: 'default' } },
    );
    expect(end.structuredContent).toMatchObject({ rows: [], rowCount: 0, truncated: false });
  });

  it('bounds nested-row costs and keeps empty containers and scalar JSON on both surfaces', async () => {
    const result = await runToolContract(
      eurostatDataframeQuery,
      {
        canvas_id: canvasId,
        sql: "SELECT i, {'deep': [{'value': repeat('x', 40000)}]} AS nested, []::INTEGER[] AS empty, false AS flag, 1.25::DOUBLE AS scalar FROM (VALUES (0), (1)) r(i) ORDER BY i",
      },
      { context: { tenantId: 'default' } },
    );
    expect(result.structuredContent).toMatchObject({
      rowCount: 1,
      truncated: true,
      rows: [
        {
          i: 0,
          nested: { deep: [{ value: 'x'.repeat(40000) }] },
          empty: [],
          flag: false,
          scalar: 1.25,
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(64000);
    expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThanOrEqual(64000);
    const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain(`nested=${JSON.stringify({ deep: [{ value: 'x'.repeat(40000) }] })}`);
    expect(text).toContain('empty=[] | flag=false | scalar=1.25');
  });

  it('keeps a full result that fits even when a partial result plus notice would not', async () => {
    const result = await runToolContract(
      eurostatDataframeQuery,
      {
        canvas_id: canvasId,
        sql: "SELECT i, CASE WHEN i=0 THEN repeat('x', 63500) ELSE '' END AS value FROM (VALUES (0), (1), (2)) r(i) ORDER BY i",
      },
      { context: { tenantId: 'default' } },
    );
    expect(result.structuredContent).toMatchObject({ rowCount: 3, truncated: false });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThanOrEqual(64000);
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(64000);
  });

  it('retains one oversized complete nested row without claiming data was omitted', async () => {
    const result = await runToolContract(
      eurostatDataframeQuery,
      { canvas_id: canvasId, sql: "SELECT {'nested': [{'text': repeat('雪', 30000)}]} AS huge" },
      { context: { tenantId: 'default' } },
    );
    expect(result.structuredContent).toMatchObject({
      rowCount: 1,
      truncated: false,
      rows: [{ huge: { nested: [{ text: '雪'.repeat(30000) }] } }],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(Buffer.byteLength(JSON.stringify(result.content))).toBeGreaterThan(64000);
    expect(result.content.map((b) => ('text' in b ? b.text : '')).join('')).toContain(
      JSON.stringify({ nested: [{ text: '雪'.repeat(30000) }] }),
    );
  });
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

  describe('declared recoveries reach the caller, not the canvas service hints', () => {
    const declared = (reason: string) =>
      eurostatDataframeQuery.errors?.find((e) => e.reason === reason)?.recovery;
    const call = (input: { canvas_id: string; sql: string }) =>
      runToolContract(eurostatDataframeQuery, input, { context: { tenantId: 'default' } });
    const textOf = (result: Awaited<ReturnType<typeof call>>) =>
      result.content.map((block) => ('text' in block ? block.text : '')).join('\n');

    it('canvas_not_found carries the declared recovery on both surfaces', async () => {
      const hint = declared('canvas_not_found');
      expect(hint).toContain('without canvas_id');

      const result = await call({ canvas_id: 'qwertyuiop', sql: 'SELECT 1' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: { reason: 'canvas_not_found', canvasId: 'qwertyuiop', recovery: { hint } },
        },
      });
      expect(textOf(result)).toContain(`Recovery: ${hint}`);
      expect(textOf(result)).not.toContain('stage fresh data');
    });

    it('canvas_not_found raised by the query itself, after the acquire, carries the declared recovery too', async () => {
      // Only Date is faked: the canvas reads its clock from Date.now, and DuckDB needs real timers.
      vi.useFakeTimers({ toFake: ['Date'] });
      const shortLived = withRealCanvas({ ttlMs: 50 });
      try {
        // The acquire hands back a live handle; the canvas then lapses before the SQL runs.
        const stale = await shortLived.canvas.acquire(undefined, ctx());
        vi.setSystemTime(Date.now() + 1_000);
        const acquire = vi.spyOn(shortLived.canvas, 'acquire').mockResolvedValue(stale);

        const result = await call({ canvas_id: stale.canvasId, sql: 'SELECT 1' });
        expect(acquire).toHaveBeenCalledOnce();
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: {
              reason: 'canvas_not_found',
              canvasId: stale.canvasId,
              recovery: { hint: declared('canvas_not_found') },
            },
          },
        });
        expect(textOf(result)).not.toContain('stage fresh data');
      } finally {
        await shortLived.teardown();
        setCanvas(canvas);
        vi.useRealTimers();
      }
    });

    for (const [label, sql, table] of [
      ['a FROM', 'SELECT * FROM df_nope0001', 'df_nope0001'],
      [
        'the second side of a JOIN',
        'SELECT * FROM df_test0001 JOIN df_nope0002 USING (geo)',
        'df_nope0002',
      ],
      ['a CTE body', 'WITH x AS (SELECT * FROM df_nope0003) SELECT * FROM x', 'df_nope0003'],
    ] as const) {
      it(`missing_table in ${label} carries the declared recovery and names the table`, async () => {
        const hint = declared('missing_table');
        expect(hint).toContain('eurostat_dataframe_describe');

        const result = await call({ canvas_id: canvasId, sql });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.NotFound,
            message: expect.stringContaining(`"${table}"`),
            data: { reason: 'missing_table', tableName: table, recovery: { hint } },
          },
        });
        const text = textOf(result);
        expect(text).toContain(`"${table}"`);
        expect(text).toContain(`Recovery: ${hint}`);
        expect(text).not.toContain('Re-run the tool that produced this table');
      });
    }

    it('leaves a SQL gate rejection with its own reason and hint, even when it names a missing table', async () => {
      const result = await call({ canvas_id: canvasId, sql: 'DROP TABLE df_nope0001' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'non_select_statement',
            recovery: { hint: expect.stringContaining('Rewrite as a single SELECT') },
          },
        },
      });
      expect(textOf(result)).not.toContain(declared('missing_table'));
    });
  });

  it('names a mistyped column instead of returning nothing', async () => {
    const input = eurostatDataframeQuery.input.parse({
      canvas_id: canvasId,
      sql: 'SELECT no_such_column FROM df_test0001',
    });
    const err = (await Promise.resolve(eurostatDataframeQuery.handler(input, ctx())).catch(
      (e: unknown) => e,
    )) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_sql' });
  });

  it('fails with an actionable error when the deployment has no canvas', async () => {
    // The registration gate keeps this tool off tools/list without a canvas; the handler
    // still has to answer honestly rather than dereference an absent service.
    // Run through runToolContract, which fills the declared recovery hint as production
    // does: the handler throws only the reason.
    setCanvas(undefined);
    try {
      const result = await runToolContract(eurostatDataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT 1',
      });
      expect(result.isError).toBe(true);
      // The caller is told what to do instead, not just that something is off.
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'canvas_disabled',
            recovery: { hint: expect.stringContaining('eurostat_query_dataset') },
          },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toMatch(/Recovery:.*eurostat_query_dataset/s);
    } finally {
      setCanvas(canvas);
    }
  });

  it('discloses a result cut short by the canvas row limit', async () => {
    // A separate canvas with a row limit of 2, so the cap is reachable without staging
    // 10,000 rows. Both the truncation flag and the paging notice disclose omitted rows.
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

      const production = await runToolContract(
        eurostatDataframeQuery,
        { canvas_id: instance.canvasId, sql: 'SELECT geo FROM df_capped01 ORDER BY geo' },
        { context: { tenantId: 'default' } },
      );
      expect(production.structuredContent).toMatchObject({
        rowCount: 2,
        truncated: true,
        notice: expect.stringContaining('Returned 2 complete rows'),
      });
      const productionText = production.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(productionText).toContain('advancing OFFSET by the actual returned rowCount');
      expect(productionText).toContain('restart sorted at OFFSET 0');
      expect(productionText).toContain('tie-breakers');
      expect(productionText).toContain('Volatile expressions and changing or expired tables');

      // The domain formatter also preserves the returned count and truncation flag.
      const text = eurostatDataframeQuery.format!(result)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');
      expect(text).toContain('**Truncated:** true');
      expect(text).toContain('**Rows:** 2');
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
    expect(text).toContain('geo="DE"');
    expect(text).toContain('obs_value=1');
    // JSON null remains distinct from a quoted string or an empty cell.
    expect(text).toContain('obs_value=null');
    const renderedRows = text.split('\n').filter((l) => l.startsWith('geo=')).length;
    expect(renderedRows).toBe(2);
  });
});
