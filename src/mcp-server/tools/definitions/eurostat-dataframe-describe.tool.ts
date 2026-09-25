/**
 * @fileoverview Tool for listing the tables staged on a Eurostat DataCanvas.
 * @module mcp-server/tools/definitions/eurostat-dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas, getCanvas } from '@/services/canvas-accessor.js';

export const eurostatDataframeDescribe = tool('eurostat_dataframe_describe', {
  title: 'Describe Eurostat Dataframes',
  description:
    'List the tables staged on a Eurostat dataframe canvas, with their row counts and column names and types. Call this before eurostat_dataframe_query to learn the table and column names to write SQL against. The canvas_id comes from a eurostat_query_dataset or eurostat_download_dataset response that reported a staged table. Every observation column is flat, but the two stagers write different dimension columns, so read the columns reported here rather than assuming: eurostat_query_dataset gives each dimension a code column named after the dimension (e.g. "geo") plus a label companion (e.g. "geo_label"); eurostat_download_dataset gives code columns only — the bulk endpoint carries no labels — plus a "time" column. Both write the same five measure columns — obs_value, obs_flag, obs_flag_label, conf_status, conf_status_label — carrying the same codes for the same observation, so tables from the two stagers join on dimension codes and time and compare like with like.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas identifier returned as canvasId by eurostat_query_dataset or eurostat_download_dataset. Identifies the workspace holding the staged tables.',
    ),
  }),
  output: z.object({
    canvasId: z.string().describe('Canvas identifier the tables were read from.'),
    expiresAt: z
      .string()
      .describe(
        'ISO 8601 timestamp when the canvas expires. Every call on it slides this forward.',
      ),
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table name to reference in SQL.'),
            kind: z
              .enum(['table', 'view'])
              .describe('Whether the entry is a base table or a view.'),
            rowCount: z.number().describe('Rows the table holds.'),
            expiresAt: z
              .string()
              .optional()
              .describe(
                'ISO 8601 expiry of this table specifically. Omitted when the table ages with the canvas rather than on its own clock.',
              ),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('SQL column type (e.g. "VARCHAR", "DOUBLE").'),
                    nullable: z.boolean().describe('Whether the column admits NULL.'),
                  })
                  .describe('One column of the table.'),
              )
              .describe('Columns in declaration order.'),
          })
          .describe('One table or view staged on the canvas.'),
      )
      .describe(
        'Tables staged on this canvas. Empty when nothing has been staged yet, or when every staged table has expired.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the canvas holds no tables. Omitted when it holds at least one.'),
  },

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'This deployment runs without a dataframe canvas, so there is nothing to describe.',
      retryable: false,
      recovery:
        'Query the data inline with eurostat_query_dataset, narrowing dimension filters until the result fits.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id is unknown or its lifetime has elapsed.',
      recovery:
        'Re-run the tool that staged it (eurostat_query_dataset or eurostat_download_dataset) and use the canvasId it returns.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled', undefined, ctx.recoveryFor('canvas_disabled'));
    }

    const instance = await acquireCanvas(canvas, input.canvas_id, ctx);
    const tables = await instance.describe();

    ctx.log.info('Described canvas', { canvasId: instance.canvasId, tableCount: tables.length });

    if (tables.length === 0) {
      ctx.enrich.notice(
        `Canvas ${instance.canvasId} holds no tables. Staged tables expire on their own schedule — re-run eurostat_query_dataset to stage the data again.`,
      );
    }

    return {
      canvasId: instance.canvasId,
      expiresAt: instance.expiresAt,
      tables: tables.map((t) => ({
        name: t.name,
        kind: t.kind,
        rowCount: t.rowCount,
        ...(t.expiresAt !== undefined && { expiresAt: t.expiresAt }),
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable ?? true,
        })),
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `# Canvas \`${result.canvasId}\``,
      `**Expires:** ${result.expiresAt} | **Tables:** ${result.tables.length}\n`,
    ];
    for (const table of result.tables) {
      const expiry = table.expiresAt === undefined ? '' : ` | **expiresAt:** ${table.expiresAt}`;
      lines.push(`## \`${table.name}\` (${table.kind})`);
      lines.push(`**Rows:** ${table.rowCount}${expiry}`);
      for (const col of table.columns) {
        lines.push(`- \`${col.name}\` ${col.type} (nullable: ${col.nullable})`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
