/**
 * @fileoverview Tool for running read-only SQL against tables staged on a
 * Eurostat DataCanvas.
 * @module mcp-server/tools/definitions/eurostat-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  fitPage,
  INLINE_BUDGET_BYTES,
  type SurfaceBytes,
  utf8Bytes,
} from '@/mcp-server/tools/value-list-paging.js';
import { acquireCanvas, getCanvas, isCanvasFailure } from '@/services/canvas-accessor.js';

const QueryOutputSchema = z.object({
  canvasId: z.string().describe('Canvas identifier the query ran against.'),
  columns: z.array(z.string()).describe('Column names in projection order.'),
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      'Complete result rows, keyed by column name, bounded by the canvas row limit and 64,000 bytes per serialized surface. Nested cells render as JSON; 64-bit integers arrive as strings so they survive intact. Cast to DOUBLE in SQL if a number is wanted.',
    ),
  rowCount: z
    .number()
    .describe(
      'Complete rows returned after the canvas row limit and the 64,000-byte budget per serialized response surface. Advance SQL OFFSET by this actual count.',
    ),
  truncated: z
    .boolean()
    .describe(
      'True when the canvas row limit or the 64,000-byte budget per serialized response surface omitted rows. At least one complete row is retained even if oversized. Follow notice for SQL paging.',
    ),
});
type QueryOutput = z.infer<typeof QueryOutputSchema>;

/** JSON cells preserve nested values, string quoting and escaped line breaks. */
function renderRow(columns: string[], row: Record<string, unknown>): string {
  return columns.map((column) => `${column}=${JSON.stringify(row[column])}`).join(' | ');
}

/** Shared by the formatter and the serialized response budget. */
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
  return `Returned ${rows.toLocaleString('en-US')} complete rows; the canvas row limit or the 64,000-byte budget per serialized response surface cut this result. Page with the same deterministic SELECT and a total ORDER BY (add tie-breakers for tied keys), using LIMIT/OFFSET and advancing OFFSET by the actual returned rowCount, not the requested LIMIT. If the first page had no ORDER BY, restart sorted at OFFSET 0. Volatile expressions and changing or expired tables do not support stable paging.`;
}

export const eurostatDataframeQuery = tool('eurostat_dataframe_query', {
  title: 'Query Eurostat Dataframes',
  description:
    'Run a read-only SQL SELECT against tables staged on a Eurostat dataframe canvas — the way to reach observations past the 5,000-row inline cap of eurostat_query_dataset and past the inline preview of a eurostat_download_dataset bulk download, and to aggregate, group, or join across staged tables without re-fetching from Eurostat. Call eurostat_dataframe_describe first for the table and column names, which differ between the tools that stage them. Only a single SELECT statement runs: statement chaining, non-SELECT verbs, and functions that read files or external data are rejected. Columns are flat — every dimension is a code column named after the dimension, the measure is obs_value, the observation flag is obs_flag / obs_flag_label and the confidentiality marker is conf_status / conf_status_label; a "_label" companion per dimension exists only on tables eurostat_query_dataset staged. Both observation stagers write the same five measure columns with the same codes, so join their tables on dimension codes and time and compare obs_flag or conf_status across them directly; a DS-* table also carries obs_value_text, a value published as text (e.g. a PRODCOM unit "KG"). A value list eurostat_get_dimension_values staged has two columns, code and label: join it to the code column of a download (e.g. JOIN df_x g ON d.geo = g.code) to label that table. Returns complete rows within the canvas row limit and 64,000 bytes per serialized response surface, retaining at least one complete row even if oversized. Nested cells render as JSON. A cut sets truncated and adds a notice: page the same deterministic SELECT over unchanged tables with a total ORDER BY and LIMIT/OFFSET, advancing by actual rowCount; restart an unordered first page sorted at offset zero. Tied keys need tie-breakers; volatile SQL and changing or expired tables cannot provide stable paging.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas identifier returned as canvasId by eurostat_query_dataset, eurostat_download_dataset, or eurostat_get_dimension_values. Identifies the workspace holding the staged tables.',
    ),
    sql: z
      .string()
      .min(1)
      .describe(
        "A single read-only SELECT statement. Reference tables by the names eurostat_dataframe_describe reports. Example: SELECT geo, geo_label, AVG(obs_value) AS mean FROM df_a1b2c3d4 WHERE time >= '2020' GROUP BY geo, geo_label ORDER BY mean DESC.",
      ),
  }),
  output: QueryOutputSchema,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Whole-row cut disclosure and deterministic SQL paging guidance. Omitted when no rows were omitted.',
      ),
  },

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
        'Re-run eurostat_query_dataset or eurostat_download_dataset without canvas_id and use the canvasId it returns; eurostat_get_dimension_values stages onto that canvas but never starts one.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL names a table that is not staged on this canvas, or that has expired.',
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

    const page = (count: number): QueryOutput => ({
      canvasId: instance.canvasId,
      columns: result.columns,
      rows: result.rows.slice(0, count),
      rowCount: count,
      truncated: result.truncated === true || count < result.rows.length,
    });
    const measure = (count: number) => {
      const output = page(count);
      const notice = output.truncated ? cutNotice(count) : undefined;
      const content = [
        { type: 'text', text: renderText(output) },
        ...(notice ? [{ type: 'text', text: `\n\n> ${notice}` }] : []),
      ];
      return {
        structured: utf8Bytes(JSON.stringify({ ...output, ...(notice && { notice }) })),
        text: utf8Bytes(JSON.stringify(content)),
      };
    };
    const costs: SurfaceBytes[] = [];
    const costOf = (index: number): SurfaceBytes => {
      const cached = costs[index];
      if (cached) return cached;
      const row = result.rows[index] as QueryOutput['rows'][number];
      const cost = {
        structured: utf8Bytes(JSON.stringify(row)) + 1,
        text: utf8Bytes(JSON.stringify(`\n${renderRow(result.columns, row)}`)) - 2,
      };
      costs[index] = cost;
      return cost;
    };
    /**
     * A full result has no cut notice, so it can fit when a partial prefix plus
     * that notice cannot. Test that case with additive row costs, stopping at
     * the budget instead of serializing an arbitrarily large full result.
     */
    const empty = {
      ...page(0),
      rowCount: result.rows.length,
      truncated: result.truncated === true,
    };
    let structured = utf8Bytes(JSON.stringify(empty));
    let text = utf8Bytes(JSON.stringify([{ type: 'text', text: renderText(empty) }]));
    let fullFits = !empty.truncated;
    for (let index = 0; fullFits && index < result.rows.length; index++) {
      const cost = costOf(index);
      structured += cost.structured - (index === 0 ? 1 : 0);
      text += cost.text;
      fullFits = structured <= INLINE_BUDGET_BYTES && text <= INLINE_BUDGET_BYTES;
    }
    const count = fullFits ? result.rows.length : fitPage(result.rows.length, measure, costOf);
    const output = page(count);
    if (output.truncated) ctx.enrich.notice(cutNotice(count));
    ctx.log.info('Canvas query complete', {
      canvasId: instance.canvasId,
      rowCount: output.rowCount,
      truncated: output.truncated,
    });
    return output;
  },

  format: (result) => [{ type: 'text', text: renderText(result) }],
});
