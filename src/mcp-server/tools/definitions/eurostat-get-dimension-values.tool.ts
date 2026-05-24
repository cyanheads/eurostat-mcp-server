/**
 * @fileoverview Tool for listing all valid values for a specific Eurostat dataset dimension.
 * @module mcp-server/tools/definitions/eurostat-get-dimension-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import { GEO_LEVEL_VALUES } from '@/services/eurostat-data/types.js';

export const eurostatGetDimensionValues = tool('eurostat_get_dimension_values', {
  title: 'Get Eurostat Dimension Values',
  description:
    'List all valid values for a specific dimension in a Eurostat dataset (e.g., all unit codes for nama_10_gdp, all geo codes for a regional dataset). Use this when eurostat_get_dataset_info returns more values than the 10-item sample, or to confirm exact codes before querying. For the "geo" dimension, use geo_level to filter by NUTS hierarchy (country, nuts1, nuts2, nuts3). Invalid dimension_value codes passed to eurostat_query_dataset silently return no data; use this tool to verify codes first.',
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
        'NUTS hierarchy level filter — only relevant when dimension is "geo". Options: "aggregate" (EU/EA codes), "country" (2-letter codes, default), "nuts1" (3-char), "nuts2" (4-char), "nuts3" (5-char).',
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
                'Dimension value code. Use these as filter values in eurostat_query_dataset.',
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
  ],

  async handler(input, ctx) {
    const svc = getEurostatDataService();
    const result = await svc.getDimensionValues(
      input.dataset_code,
      input.dimension,
      input.geo_level,
      ctx,
    );
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
