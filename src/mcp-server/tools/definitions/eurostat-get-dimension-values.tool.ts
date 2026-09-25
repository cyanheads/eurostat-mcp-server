/**
 * @fileoverview Tool for listing all valid values for a specific Eurostat dataset dimension.
 * @module mcp-server/tools/definitions/eurostat-get-dimension-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas, getCanvas, newTableName } from '@/services/canvas-accessor.js';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import { GEO_LEVEL_VALUES } from '@/services/eurostat-data/types.js';

/**
 * The staged value list: the same `{code, label}` pairs as the inline `values`,
 * declared rather than sniffed. The service falls back to the code when Eurostat
 * publishes no label, so neither column is ever null.
 */
const VALUE_TABLE_SCHEMA: ColumnSchema[] = [
  { name: 'code', type: 'VARCHAR', nullable: false },
  { name: 'label', type: 'VARCHAR', nullable: false },
];

/**
 * Most values returned inline. Every NUTS level and classification list measured on
 * the main host fits (the largest, NUTS-3 geo, is 1,621); daily time lists (13,900 on
 * ert_bil_eur_d), the largest airport-pair lists (2,383 on avia_par_uk) and the Comext
 * product lists (37,069 CN8 codes on DS-045409, an 11 MB response uncapped) do not.
 * A staged table always holds the whole list.
 */
const INLINE_VALUE_CAP = 2_000;

export const eurostatGetDimensionValues = tool('eurostat_get_dimension_values', {
  title: 'Get Eurostat Dimension Values',
  description: `List the valid values for a specific dimension in a Eurostat dataset (e.g., all unit codes for nama_10_gdp, all geo codes for a regional dataset). Use this when eurostat_get_dataset_info returns more values than the 10-item sample, or to confirm exact codes before querying. For the "geo" dimension, use geo_level to filter by NUTS hierarchy (country, nuts1, nuts2, nuts3). An invalid code matches nothing: eurostat_query_dataset names it in unmatchedValues, or in its no_results error when the query matched nothing at all, and Eurostat rejects it as a fault on eurostat_download_dataset; use this tool to verify codes first. At most ${INLINE_VALUE_CAP.toLocaleString('en-US')} values come back inline — a longer list, such as the 37,069 CN8 product codes of DS-045409 or a daily time dimension, is cut there and says so. Pass canvas_id to also stage the whole list, whatever its length, as a two-column code/label table on that dataframe canvas: search it with SQL, or join it to a eurostat_download_dataset table, whose columns carry dimension codes only.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    dataset_code: z
      .string()
      .min(1)
      .describe('Dataset code (e.g., "nama_10_gdp", or "DS-045409" for a Comext collection).'),
    dimension: z
      .string()
      .min(1)
      .describe(
        'Dimension code to retrieve values for (e.g., "unit", "na_item", "geo"). Use eurostat_get_dataset_info to see available dimensions.',
      ),
    geo_level: z
      .enum(GEO_LEVEL_VALUES)
      .optional()
      .describe(
        'NUTS hierarchy level filter — applies only when dimension is "geo"; passing it with any other dimension is rejected. Options: "aggregate" (EU/EA codes), "country" (2-letter codes, default), "nuts1" (3-char), "nuts2" (4-char), "nuts3" (5-char).',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Also stage the values on this dataframe canvas as a table with two columns, code and label, holding every value the dimension lists — past the inline cap too — at the geo_level requested, country when it is omitted. Pass the canvasId a eurostat_download_dataset or eurostat_query_dataset response returned, then search the staged table with SQL or join it to a download on the dimension column (e.g., d.geo = g.code). Omit to return the values inline only: this tool never starts a canvas. Ignored on deployments without a dataframe canvas.',
    ),
  }),
  output: z.object({
    dimensionCode: z.string().describe('The dimension code that was queried.'),
    dimensionLabel: z.string().describe('Human-readable dimension name.'),
    geoLevel: z
      .enum(GEO_LEVEL_VALUES)
      .optional()
      .describe(
        'Effective NUTS hierarchy level for the geo value set. Present only for the geo dimension; country is reported when geo_level was omitted.',
      ),
    values: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Dimension value code. Use these as filter values in eurostat_query_dataset and eurostat_download_dataset.',
              ),
            label: z.string().describe('Human-readable label for this value.'),
          })
          .describe('A dimension value code and label pair.'),
      )
      .describe(
        `Dataset-available values for this dimension, in Eurostat's order — for geo, the subset at geoLevel. Holds every value up to ${INLINE_VALUE_CAP.toLocaleString('en-US')}; past that, the first ${INLINE_VALUE_CAP.toLocaleString('en-US')}, with truncated set and the whole list on the canvas table when canvas_id was passed.`,
      ),
    totalCount: z
      .number()
      .describe(
        'Number of distinct values the dimension lists, after geoLevel filtering for geo — all of them, including any past the inline cap.',
      ),
    canvasId: z
      .string()
      .optional()
      .describe(
        'Dataframe canvas the values were staged on — the canvas_id supplied. Omitted when nothing was staged: canvas_id was omitted, this deployment runs without a dataframe canvas, or the dimension lists no values.',
      ),
    tableName: z
      .string()
      .optional()
      .describe(
        'Canvas table holding every value as two VARCHAR columns, code and label. Call eurostat_dataframe_describe with canvasId first to confirm it, then join it in eurostat_dataframe_query. Omitted alongside canvasId.',
      ),
    stagedRowCount: z
      .number()
      .optional()
      .describe(
        'Rows written to the canvas table. Equals totalCount. Omitted alongside tableName.',
      ),
  }),
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the dimension lists more values than the inline cap and values holds only the first of them. Omitted when values holds every one.',
      ),
    shown: z.number().optional().describe('Values returned inline. Present alongside truncated.'),
    cap: z.number().optional().describe('The inline cap applied. Present alongside truncated.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Where the values past the inline cap are: the staged table when canvas_id was passed, or how to stage them. Present alongside truncated.',
      ),
  },
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset code or dimension code does not exist.',
      recovery:
        'Verify the dataset code with eurostat_search_datasets and the dimension code with eurostat_get_dataset_info.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset has no geo values at the effective geo_level.',
      recovery: 'Choose a different geo_level. Omitted geo_level means country.',
    },
    {
      reason: 'conflicting_params',
      code: JsonRpcErrorCode.ValidationError,
      when: 'geo_level was combined with a dimension other than "geo", where it has no effect.',
      recovery:
        'Drop geo_level to list that dimension, or set dimension to "geo" to filter by NUTS level.',
    },
    {
      reason: 'upstream_fault',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Eurostat returned a dataset structure or content constraint this server cannot read: malformed, truncated, not XML, or missing the requested dataset's dataflow.",
      recovery:
        'Retry in a few minutes, since a failed structure read is not cached. If it fails the same way, filter eurostat_query_dataset on the code in question: a code the dataset lacks comes back in unmatchedValues.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A canvas_id was supplied for staging but is unknown or its lifetime has elapsed.',
      recovery:
        'Pass the canvasId a recent eurostat_download_dataset or eurostat_query_dataset response returned, or omit canvas_id to list the values inline only.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatDataService();
    let result: Awaited<ReturnType<typeof svc.getDimensionValues>>;
    try {
      result = await svc.getDimensionValues(
        input.dataset_code,
        input.dimension,
        input.geo_level,
        ctx,
      );
    } catch (err) {
      const reason = (err as McpError).data?.reason;
      if (reason === 'not_found') {
        throw ctx.fail('not_found', (err as Error).message, {
          recovery: {
            hint: `Verify the dataset code with eurostat_search_datasets and the dimension code for "${input.dataset_code}" with eurostat_get_dataset_info.`,
          },
        });
      }
      if (reason === 'no_results') {
        const effectiveGeoLevel = input.geo_level ?? 'country';
        throw ctx.fail('no_results', (err as Error).message, {
          recovery: {
            hint: `Dataset "${input.dataset_code}" has no "geo" values at the "${effectiveGeoLevel}" level. Choose another geo_level (aggregate, nuts1, nuts2, or nuts3); omitting geo_level requests country values.`,
          },
        });
      }
      if (reason === 'conflicting_params') {
        throw ctx.fail('conflicting_params', (err as Error).message, {
          recovery: {
            hint: `geo_level applies only to the "geo" dimension and had no effect on "${input.dimension}". Re-send without geo_level, or set dimension to "geo".`,
          },
        });
      }
      if (reason === 'upstream_fault') {
        throw ctx.fail('upstream_fault', (err as Error).message, {
          recovery: {
            hint: `Eurostat returned a structure this server cannot read, so the "${input.dimension}" values of "${input.dataset_code}" cannot be listed. A failed read is not cached, so retry in a few minutes. If it fails the same way, filter eurostat_query_dataset on the code in question: a code the dataset lacks comes back in unmatchedValues.`,
          },
        });
      }
      throw err;
    }
    /**
     * Staging needs a caller-supplied canvas: without canvas_id there is nothing
     * to acquire, so a plain lookup never takes a canvas slot. An empty list
     * stages nothing rather than a 0-row table. The table is written from the
     * service's whole value list, whatever bound applies to the inline array.
     */
    const canvas = input.canvas_id ? getCanvas() : undefined;
    let staged: { canvasId: string; stagedRowCount: number; tableName: string } | undefined;
    if (canvas && result.values.length > 0) {
      const instance = await acquireCanvas(canvas, input.canvas_id, ctx);
      const handle = await instance.registerTable(newTableName(), result.values, {
        schema: VALUE_TABLE_SCHEMA,
        signal: ctx.signal,
      });
      staged = {
        canvasId: instance.canvasId,
        stagedRowCount: handle.rowCount,
        tableName: handle.tableName,
      };
    }

    const values = result.values.slice(0, INLINE_VALUE_CAP);
    if (values.length < result.totalCount) {
      const shown = `The first ${values.length.toLocaleString('en-US')} of ${result.totalCount.toLocaleString('en-US')} "${input.dimension}" values of "${input.dataset_code}" are inline, in Eurostat's order.`;
      ctx.enrich.truncated({
        shown: values.length,
        cap: INLINE_VALUE_CAP,
        guidance: staged
          ? `${shown} All ${staged.stagedRowCount.toLocaleString('en-US')} are staged as table "${staged.tableName}" on canvas "${staged.canvasId}" — search them with eurostat_dataframe_query (e.g. SELECT code, label FROM ${staged.tableName} WHERE label ILIKE '%term%').`
          : getCanvas()
            ? `${shown} To reach the rest, call again with canvas_id set to the canvasId of a eurostat_query_dataset or eurostat_download_dataset response: all ${result.totalCount.toLocaleString('en-US')} are then staged as a code/label table to search with eurostat_dataframe_query.`
            : `${shown} This deployment runs without a dataframe canvas, so the other ${(result.totalCount - values.length).toLocaleString('en-US')} cannot be listed; to check one code, filter eurostat_query_dataset on it — a code the dataset does not have comes back in unmatchedValues.`,
      });
    }

    ctx.log.info('Dimension values fetched', {
      datasetCode: input.dataset_code,
      dimension: input.dimension,
      totalCount: result.totalCount,
      shown: values.length,
      ...(staged && { canvasId: staged.canvasId, tableName: staged.tableName }),
    });
    return { ...result, values, ...staged };
  },

  format: (result) => {
    const lines: string[] = [
      `**Dimension:** ${result.dimensionLabel} (\`${result.dimensionCode}\`)`,
      ...(result.geoLevel ? [`**Geo level:** \`${result.geoLevel}\``] : []),
      `**Total values:** ${result.totalCount}${
        result.values.length < result.totalCount
          ? ` — the first ${result.values.length} are listed below`
          : ''
      }`,
      ...(result.tableName
        ? [
            `**Staged:** table \`${result.tableName}\` on canvas \`${result.canvasId}\` (stagedRowCount ${result.stagedRowCount}), columns code and label — inspect it with eurostat_dataframe_describe first, then join it in eurostat_dataframe_query`,
          ]
        : []),
      '',
    ];
    for (const v of result.values) {
      lines.push(`- \`${v.code}\` — ${v.label}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
