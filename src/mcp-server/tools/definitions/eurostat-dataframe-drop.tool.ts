/**
 * @fileoverview Tool for removing one staged table from a Eurostat DataCanvas.
 * @module mcp-server/tools/definitions/eurostat-dataframe-drop.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CANVAS_IDENTIFIER_REGEX, CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas, getCanvas } from '@/services/canvas-accessor.js';

export const eurostatDataframeDrop = tool('eurostat_dataframe_drop', {
  title: 'Drop Eurostat Dataframe',
  description:
    'Remove one table from a Eurostat dataframe canvas, leaving the canvas and every other table on it in place — to free the memory a large eurostat_download_dataset table holds once its analysis is done, or to discard an intermediate result. Pass the table name exactly as eurostat_dataframe_describe lists it, case included. A drop cannot be undone: re-run the tool that staged the table to stage it again. A name with nothing staged under it — never staged, already dropped, or expired — returns dropped: false rather than an error, so repeating a drop is safe.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas identifier returned as canvasId by eurostat_query_dataset, eurostat_download_dataset, or eurostat_get_dimension_values. Identifies the workspace holding the table to drop.',
    ),
    table_name: z
      .string()
      .regex(
        CANVAS_IDENTIFIER_REGEX,
        'Expected a table name exactly as eurostat_dataframe_describe lists it: letters, digits, and underscores, starting with a letter or underscore, at most 63 characters.',
      )
      .describe(
        'Name of the table to drop, exactly as eurostat_dataframe_describe lists it, case included (e.g. "df_a1b2c3d4"): letters, digits, and underscores.',
      ),
  }),
  output: z.object({
    canvasId: z.string().describe('Canvas identifier the drop ran against.'),
    tableName: z.string().describe('Table name the drop was asked to remove, as sent.'),
    dropped: z
      .boolean()
      .describe(
        'True when a table by that name was staged and is now removed. False when nothing by that name was staged at call time — never staged, already dropped, or expired — so the canvas is unchanged.',
      ),
    expiresAt: z
      .string()
      .describe(
        'ISO 8601 timestamp when the canvas expires. The drop slid it forward; the canvas and its other tables remain.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing by that name was staged, so nothing was dropped. Omitted when a table was dropped.',
      ),
  },

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'This deployment runs without a dataframe canvas, so there are no staged tables to drop.',
      retryable: false,
      recovery:
        'Nothing is staged without a dataframe canvas, so there is nothing to drop; eurostat_query_dataset answers inline with narrower dimension filters.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id is unknown or its lifetime has elapsed.',
      recovery:
        'An expired canvas has already released every table it held, so nothing is left to drop; otherwise copy the canvasId exactly as eurostat_query_dataset, eurostat_download_dataset, or eurostat_get_dimension_values returned it.',
    },
    {
      reason: 'identifier_reserved',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The table_name is a bare SQL keyword (e.g. "select"), which no staged table can carry.',
      recovery: 'Call eurostat_dataframe_describe and copy a table name exactly as it is listed.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_disabled');
    }

    /**
     * The canvas words both rejections for staging — re-run the tool that
     * staged the data, choose another table name — which for a drop restores
     * what was meant to go. Re-thrown through `ctx.fail`, they carry this tool's
     * declared recovery instead.
     */
    const asDropFailure = (err: unknown): never => {
      if (err instanceof McpError && err.data?.reason === 'canvas_not_found') {
        throw ctx.fail('canvas_not_found', err.message, { canvasId: input.canvas_id });
      }
      if (err instanceof McpError && err.data?.reason === 'identifier_reserved') {
        throw ctx.fail(
          'identifier_reserved',
          `"${input.table_name}" is a reserved SQL keyword, so no staged table carries that name.`,
          { tableName: input.table_name },
        );
      }
      throw err;
    };

    const instance = await acquireCanvas(canvas, input.canvas_id, ctx).catch(asDropFailure);
    const dropped = await instance.drop(input.table_name).catch(asDropFailure);

    ctx.log.info('Canvas table drop', {
      canvasId: instance.canvasId,
      tableName: input.table_name,
      dropped,
    });

    if (!dropped) {
      ctx.enrich.notice(
        `Canvas ${instance.canvasId} holds no table named "${input.table_name}", so nothing was dropped. Names match exactly, case included — eurostat_dataframe_describe lists what is staged.`,
      );
    }

    return {
      canvasId: instance.canvasId,
      tableName: input.table_name,
      dropped,
      expiresAt: instance.expiresAt,
    };
  },

  format: (result) => [
    {
      type: 'text',
      text: [
        `# Drop \`${result.tableName}\` (canvas \`${result.canvasId}\`)`,
        `**Dropped:** ${result.dropped} — ${
          result.dropped
            ? 'removed; the canvas and its other tables are unchanged'
            : 'nothing by that name was staged'
        }`,
        `**Canvas expires:** ${result.expiresAt}`,
      ].join('\n'),
    },
  ],
});
