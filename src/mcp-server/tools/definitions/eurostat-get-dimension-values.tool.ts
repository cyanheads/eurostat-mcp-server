/**
 * @fileoverview Tool for listing all valid values for a specific Eurostat dataset dimension.
 * @module mcp-server/tools/definitions/eurostat-get-dimension-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import { GEO_LEVEL_VALUES } from '@/services/eurostat-data/types.js';

export const eurostatGetDimensionValues = tool('eurostat_get_dimension_values', {
  title: 'Get Eurostat Dimension Values',
  description:
    'List all valid values for a specific dimension in a Eurostat dataset (e.g., all unit codes for nama_10_gdp, all geo codes for a regional dataset). Use this when eurostat_get_dataset_info returns more values than the 10-item sample, or to confirm exact codes before querying. For the "geo" dimension, use geo_level to filter by NUTS hierarchy (country, nuts1, nuts2, nuts3). Invalid dimension_value codes silently return no data from eurostat_query_dataset, and are rejected by Eurostat as a fault on eurostat_download_dataset; use this tool to verify codes first.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    dataset_code: z.string().min(1).describe('Dataset code (e.g., "nama_10_gdp").'),
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
  }),
  output: z.object({
    dimensionCode: z.string().describe('The dimension code that was queried.'),
    dimensionLabel: z.string().describe('Human-readable dimension name.'),
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
      .describe('All valid values for this dimension in the dataset.'),
    totalCount: z.number().describe('Total number of distinct values returned.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset code or dimension code does not exist.',
      recovery:
        'Verify the dataset code with eurostat_search_datasets and the dimension code with eurostat_get_dataset_info.',
    },
    {
      reason: 'async_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Eurostat returned an async warning — the dimension query matched too many observations.',
      retryable: false,
      recovery:
        'Use eurostat_get_dataset_info for a sampled value set, or narrow the request with geo_level for the geo dimension.',
    },
    {
      reason: 'conflicting_params',
      code: JsonRpcErrorCode.ValidationError,
      when: 'geo_level was combined with a dimension other than "geo", where it has no effect.',
      recovery:
        'Drop geo_level to list that dimension, or set dimension to "geo" to filter by NUTS level.',
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
      if (reason === 'async_response') {
        throw ctx.fail('async_response', (err as Error).message, {
          recovery: {
            hint: `The "${input.dimension}" dimension query for "${input.dataset_code}" matched too many observations. Use eurostat_get_dataset_info for a sampled value set, or narrow with geo_level for the geo dimension.`,
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
      throw err;
    }
    ctx.log.info('Dimension values fetched', {
      datasetCode: input.dataset_code,
      dimension: input.dimension,
      totalCount: result.totalCount,
    });
    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `**Dimension:** ${result.dimensionLabel} (\`${result.dimensionCode}\`)`,
      `**Total values:** ${result.totalCount}\n`,
    ];
    for (const v of result.values) {
      lines.push(`- \`${v.code}\` — ${v.label}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
