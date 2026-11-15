/**
 * @fileoverview Tool for running read-only SQL against tables staged on a
 * Eurostat DataCanvas.
 * @module mcp-server/tools/definitions/eurostat-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas, getCanvas, isCanvasFailure } from '@/services/canvas-accessor.js';

const QueryOutputSchema = z.object({
  canvasId: z.string().describe('Canvas the query ran against.'),
  columns: z.array(z.string()).describe('Column names in projection order.'),
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      'Complete rows keyed by column name, nested cells as JSON. 64-bit integers arrive as strings; cast to DOUBLE in SQL for a number.',
    ),
  rowCount: z.number().describe('Complete rows returned.'),
  truncated: z
    .boolean()
    .describe(
      'True when the canvas row limit cut rows: page the same deterministic SELECT over unchanged tables with a total ORDER BY (tie-breakers for tied keys) and LIMIT/OFFSET, advancing OFFSET by rowCount; an unordered first page restarts sorted at OFFSET 0.',
    ),
});
type QueryOutput = z.infer<typeof QueryOutputSchema>;

/** JSON cells preserve nested values, string quoting and escaped line breaks. */
function renderRow(columns: string[], row: Record<string, unknown>): string {
  return columns.map((column) => `${column}=${JSON.stringify(row[column])}`).join(' | ');
}

/** Render every complete row without changing cell values. */
function renderText(result: QueryOutput): string {
  return [
    `# Query result (canvas \`${result.canvasId}\`)`,
    `**Rows:** ${result.rowCount} | **Truncated:** ${result.truncated}`,
    `**Columns:** ${result.columns.join(', ')}\n`,
    ...result.rows.map((row) => renderRow(result.columns, row)),
  ].join('\n');
}

/** Paging depends on a fixed deterministic SELECT over unchanged staged tables. */
function cutNotice(rows: number): string {
  return `Returned ${rows.toLocaleString('en-US')} complete rows; the canvas row limit cut this result. Page with the same deterministic SELECT and a total ORDER BY (add tie-breakers for tied keys), using LIMIT/OFFSET and advancing OFFSET by the actual returned rowCount, not the requested LIMIT. If the first page had no ORDER BY, restart sorted at OFFSET 0. Volatile expressions and changing or expired tables do not support stable paging.`;
}

export const eurostatDataframeQuery = tool('eurostat_dataframe_query', {
  title: 'Query Eurostat Dataframes',
  description:
    'Run one read-only SQL SELECT against the tables staged on a Eurostat dataframe canvas, to reach observations past an inline preview and to aggregate or join them without re-fetching. Call eurostat_dataframe_describe first for the table and column names. Statement chaining, other verbs, and functions that read files or external data are rejected. Returns every complete row up to the canvas row limit.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'The canvasId a eurostat_query_dataset, eurostat_download_dataset or eurostat_get_dimension_values response returned.',
    ),
    sql: z
      .string()
      .min(1)
      .describe(
        "One read-only SELECT over the names eurostat_dataframe_describe reports, e.g. SELECT geo, AVG(obs_value) AS mean FROM df_a1b2c3d4 WHERE time >= '2020' GROUP BY geo ORDER BY mean DESC.",
      ),
  }),
  output: QueryOutputSchema,
  enrichment: {
    notice: z.string().optional().describe('Row-limit cut disclosure with SQL paging guidance.'),
  },

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'This deployment runs without a dataframe canvas.',
      retryable: false,
      recovery:
        'Query the data inline with eurostat_query_dataset, narrowing dimension filters until the result fits.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id is unknown or expired.',
      recovery:
        'Re-run eurostat_query_dataset or eurostat_download_dataset without canvas_id and use the canvasId it returns; eurostat_get_dimension_values stages onto that canvas but never starts one.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL names a table not staged on this canvas, or expired.',
      recovery:
        'Call eurostat_dataframe_describe for the staged table names, or re-run the tool that staged them (eurostat_query_dataset, eurostat_download_dataset, or eurostat_get_dimension_values with canvas_id).',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled');
    }

    /**
     * Both are re-thrown so the declared recovery replaces the canvas service's
     * generic one. A canvas can also expire between the acquire and the query,
     * so both calls go through the same mapping.
     */
    const asDeclared = (err: unknown): never => {
      if (isCanvasFailure(err, 'canvas_not_found')) {
        throw ctx.fail(
          'canvas_not_found',
          err.message,
          { canvasId: input.canvas_id },
          { cause: err },
        );
      }
      if (isCanvasFailure(err, 'missing_table')) {
        throw ctx.fail(
          'missing_table',
          err.message,
          { tableName: err.data?.tableName },
          { cause: err },
        );
      }
      throw err;
    };

    const instance = await acquireCanvas(canvas, input.canvas_id, ctx).catch(asDeclared);

    /**
     * The SQL is not sanitized here on purpose. The canvas gate rejects
     * anything that is not a single SELECT — statement count, statement type,
     * an EXPLAIN-plan operator allowlist, and a table-function deny-list — and
     * a rejection there is a typed ValidationError carrying the reason. A
     * second, weaker string filter in front of it would only shadow those
     * reasons with a vaguer message.
     */
    const result = await instance.query(input.sql, { signal: ctx.signal }).catch(asDeclared);

    const output: QueryOutput = {
      canvasId: instance.canvasId,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      truncated: result.truncated === true,
    };
    if (output.truncated) ctx.enrich.notice(cutNotice(output.rowCount));
    ctx.log.info('Canvas query complete', {
      canvasId: instance.canvasId,
      rowCount: output.rowCount,
      truncated: output.truncated,
    });
    return output;
  },

  format: (result) => [{ type: 'text', text: renderText(result) }],
});
