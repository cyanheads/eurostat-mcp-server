/**
 * @fileoverview Tests for the eurostat_dataframe_describe tool, against a real
 * DuckDB canvas.
 * @module tests/tools/eurostat-dataframe-describe.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eurostatDataframeDescribe } from '@/mcp-server/tools/definitions/eurostat-dataframe-describe.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import {
  observationRowSchema,
  toObservationRow,
} from '@/services/eurostat-data/eurostat-data-service.js';
import { withRealCanvas } from '../helpers/real-canvas.js';

let canvas: DataCanvas;
let teardown: () => Promise<void>;
let stagedCanvasId: string;
let emptyCanvasId: string;

const ctx = () =>
  createMockContext({ errors: eurostatDataframeDescribe.errors, tenantId: 'default' });

const DIMS = ['geo', 'time'];

beforeAll(async () => {
  ({ canvas, teardown } = withRealCanvas());

  const staged = await canvas.acquire(undefined, ctx());
  stagedCanvasId = staged.canvasId;
  await staged.registerTable(
    'df_abcd1234',
    [
      toObservationRow(
        {
          dimensions: {
            geo: { code: 'DE', label: 'Germany' },
            time: { code: '2023', label: '2023' },
          },
          value: 1,
        },
        DIMS,
      ),
    ],
    { schema: observationRowSchema(DIMS) },
  );

  emptyCanvasId = (await canvas.acquire(undefined, ctx())).canvasId;
});

afterAll(async () => {
  await teardown();
});

describe('eurostatDataframeDescribe', () => {
  it('lists a staged table with the flat column set the query tool writes', async () => {
    const input = eurostatDataframeDescribe.input.parse({ canvas_id: stagedCanvasId });
    const result = await eurostatDataframeDescribe.handler(input, ctx());

    expect(result.canvasId).toBe(stagedCanvasId);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table?.name).toBe('df_abcd1234');
    expect(table?.kind).toBe('table');
    expect(table?.rowCount).toBe(1);
    // The names an agent needs to write SQL — one code column and one label column per
    // dimension, then the measure columns.
    expect(table?.columns.map((c) => c.name)).toEqual(
      observationRowSchema(DIMS).map((c) => c.name),
    );
    expect(table?.columns.find((c) => c.name === 'obs_value')?.type).toBe('DOUBLE');
    expect(table?.columns.find((c) => c.name === 'geo')?.type).toBe('VARCHAR');
  });

  it('tells the caller what to do when the canvas holds nothing', async () => {
    const c = ctx();
    const input = eurostatDataframeDescribe.input.parse({ canvas_id: emptyCanvasId });
    const result = await eurostatDataframeDescribe.handler(input, c);
    expect(result.tables).toEqual([]);
    // An empty list with no explanation is a dead end for the agent.
    expect(getEnrichment(c).notice).toContain('eurostat_query_dataset');
  });

  it('reports an unknown canvas as not found rather than describing an empty new one', async () => {
    const input = eurostatDataframeDescribe.input.parse({ canvas_id: 'zzzzzzzzzz' });
    await expect(eurostatDataframeDescribe.handler(input, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('rejects a malformed canvas_id at argument validation, before any canvas lookup', async () => {
    const result = await runToolContract(eurostatDataframeDescribe, { canvas_id: 'not-an-id' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('canvas_id');
  });

  it('fails with an actionable error when the deployment has no canvas', async () => {
    setCanvas(undefined);
    try {
      const input = eurostatDataframeDescribe.input.parse({ canvas_id: stagedCanvasId });
      const err = (await Promise.resolve(eurostatDataframeDescribe.handler(input, ctx())).catch(
        (e: unknown) => e,
      )) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'canvas_disabled' });
      expect((err.data as { recovery?: { hint?: string } }).recovery?.hint).toContain(
        'eurostat_query_dataset',
      );
    } finally {
      setCanvas(canvas);
    }
  });

  it('renders every table field into content[] (format parity)', () => {
    const blocks = eurostatDataframeDescribe.format!({
      canvasId: 'cnv0000001',
      expiresAt: '2026-08-05T00:00:00.000Z',
      tables: [
        {
          name: 'df_abcd1234',
          kind: 'table' as const,
          rowCount: 42,
          expiresAt: '2026-08-04T12:00:00.000Z',
          columns: [{ name: 'geo', type: 'VARCHAR', nullable: true }],
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('cnv0000001');
    expect(text).toContain('df_abcd1234');
    expect(text).toContain('42');
    expect(text).toContain('2026-08-04T12:00:00.000Z');
    expect(text).toContain('`geo` VARCHAR (nullable: true)');
  });

  it('renders a table that ages with the canvas without an empty expiry field', () => {
    const blocks = eurostatDataframeDescribe.format!({
      canvasId: 'cnv0000001',
      expiresAt: '2026-08-05T00:00:00.000Z',
      tables: [
        {
          name: 'df_abcd1234',
          kind: 'table' as const,
          rowCount: 42,
          columns: [{ name: 'geo', type: 'VARCHAR', nullable: true }],
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('**Rows:** 42');
    expect(text).not.toContain('expiresAt:');
  });
});
