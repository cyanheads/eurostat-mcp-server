/**
 * @fileoverview Tool for listing the tables staged on a Eurostat DataCanvas.
 * @module mcp-server/tools/definitions/eurostat-dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas, getCanvas, isCanvasFailure } from '@/services/canvas-accessor.js';

export const eurostatDataframeDescribe = tool('eurostat_dataframe_describe', {
  title: 'Describe Eurostat Dataframes',
  description:
    'List the tables on a Eurostat dataframe canvas with row counts and column names and types; call it before eurostat_dataframe_query for the names to write SQL against, and read the columns here rather than assuming them. eurostat_query_dataset tables give each dimension a code column (e.g. "geo") and a label column ("geo_label"); eurostat_download_dataset tables carry code columns only, plus "time". Both write the same measure columns (obs_value, obs_flag, obs_flag_label, conf_status, conf_status_label) with the same codes, so they join on dimension codes and time; DS-* tables add obs_value_text for a value published as text. A eurostat_get_dimension_values table has code and label, plus level for geo (NULL for a code with no NUTS level), and labels a download\'s codes through a join (d.geo = g.code); staged without geo_level, a geo list holds every level, so filter level before aggregating.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'The canvasId a eurostat_query_dataset, eurostat_download_dataset or eurostat_get_dimension_values response returned.',
    ),
  }),
  output: z.object({
    canvasId: z.string().describe('Canvas the tables were read from.'),
    expiresAt: z
      .string()
      .describe('ISO 8601 expiry of the canvas; each call on it slides this forward.'),
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table name to reference in SQL.'),
            kind: z.enum(['table', 'view']).describe('Base table or view.'),
            rowCount: z.number().describe('Rows the table holds.'),
            expiresAt: z
              .string()
              .optional()
              .describe('ISO 8601 expiry of this table; omitted when it ages with the canvas.'),
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
      .describe('Staged tables; empty when none is staged or all have expired.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when the canvas holds no tables.'),
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
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled');
    }

    /**
     * Re-thrown so the declared recovery replaces the canvas service's generic one. A
     * canvas can also expire between the acquire and the describe, so both calls go
     * through the same mapping.
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
      throw err;
    };

    const instance = await acquireCanvas(canvas, input.canvas_id, ctx).catch(asDeclared);
    const tables = await instance.describe().catch(asDeclared);

    ctx.log.info('Described canvas', { canvasId: instance.canvasId, tableCount: tables.length });

    if (tables.length === 0) {
      ctx.enrich.notice(
        `Canvas \`${instance.canvasId}\` holds no tables. Staged tables expire on their own schedule — re-run the tool that staged the data to stage it again: eurostat_query_dataset, eurostat_download_dataset, or eurostat_get_dimension_values with this canvas_id.`,
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
