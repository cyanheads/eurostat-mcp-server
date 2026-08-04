/**
 * @fileoverview Tool for running read-only SQL against tables staged on a
 * Eurostat DataCanvas.
 * @module mcp-server/tools/definitions/eurostat-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas, getCanvas } from '@/services/canvas-accessor.js';

export const eurostatDataframeQuery = tool('eurostat_dataframe_query', {
  title: 'Query Eurostat Dataframes',
  description:
    'Run a read-only SQL SELECT against tables staged on a Eurostat dataframe canvas — the way to reach observations past the 5,000-row inline cap of eurostat_query_dataset and past the inline preview of a eurostat_download_dataset bulk download, and to aggregate, group, or join across staged tables without re-fetching from Eurostat. Call eurostat_dataframe_describe first for the table and column names, which differ between the two stagers. Only a single SELECT statement runs: statement chaining, non-SELECT verbs, and functions that read files or external data are rejected. Columns are flat — every dimension is a code column named after the dimension, the measure is obs_value, the observation flag is obs_flag / obs_flag_label and the confidentiality marker is conf_status / conf_status_label; a "_label" companion per dimension exists only on tables eurostat_query_dataset staged. Both stagers write the same five measure columns with the same codes, so join their tables on dimension codes and time and compare obs_flag or conf_status across them directly.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .min(1)
      .describe(
        'Canvas identifier returned as canvasId by eurostat_query_dataset or eurostat_download_dataset. Identifies the workspace holding the staged tables.',
      ),
    sql: z
      .string()
      .min(1)
      .describe(
        "A single read-only SELECT statement. Reference tables by the names eurostat_dataframe_describe reports. Example: SELECT geo, geo_label, AVG(obs_value) AS mean FROM df_a1b2c3d4 WHERE time >= '2020' GROUP BY geo, geo_label ORDER BY mean DESC.",
      ),
  }),
  output: z.object({
    canvasId: z.string().describe('Canvas identifier the query ran against.'),
    columns: z.array(z.string()).describe('Column names in projection order.'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Result rows, each keyed by column name. Bounded by the canvas row limit. 64-bit integer results — COUNT(*) among them — arrive as strings so values outside the JSON number range survive intact; cast to DOUBLE in the SQL if a number is wanted.',
      ),
    rowCount: z
      .number()
      .describe(
        'Rows materialized into this response. Equals the full result size unless truncated is true.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the result exceeded the canvas row limit and was cut short. Add a LIMIT, an aggregate, or a narrower WHERE clause to see the rest.',
      ),
  }),

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'This deployment runs without a dataframe canvas, so there is nothing to query.',
      retryable: false,
      recovery:
        'Query the data inline with eurostat_query_dataset, narrowing dimension filters until the result fits.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id is unknown or its lifetime has elapsed.',
      recovery:
        'Re-run eurostat_query_dataset to stage the data again and use the canvasId it returns.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL names a table that is not staged on this canvas, or that has expired.',
      recovery:
        'Call eurostat_dataframe_describe for the staged table names, or re-run eurostat_query_dataset to stage them again.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled', undefined, ctx.recoveryFor('canvas_disabled'));
    }

    const instance = await acquireCanvas(canvas, input.canvas_id, ctx);

    /**
     * The SQL is not sanitized here on purpose. The canvas gate rejects
     * anything that is not a single SELECT — statement count, statement type,
     * an EXPLAIN-plan operator allowlist, and a table-function deny-list — and
     * a rejection there is a typed ValidationError carrying the reason. A
     * second, weaker string filter in front of it would only shadow those
     * reasons with a vaguer message.
     */
    const result = await instance.query(input.sql, { signal: ctx.signal });

    ctx.log.info('Canvas query complete', {
      canvasId: instance.canvasId,
      rowCount: result.rowCount,
      truncated: result.truncated === true,
    });

    return {
      canvasId: instance.canvasId,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated === true,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `# Query result (canvas \`${result.canvasId}\`)`,
      `**Rows:** ${result.rowCount} | **Truncated:** ${result.truncated}${
        result.truncated ? ' — add a LIMIT, an aggregate, or a narrower WHERE clause' : ''
      }`,
      `**Columns:** ${result.columns.join(', ')}\n`,
    ];
    // Every row renders, so content[] carries the same set structuredContent does.
    for (const row of result.rows) {
      lines.push(
        result.columns.map((col) => `${col}=${row[col] === null ? 'NULL' : row[col]}`).join(' | '),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
