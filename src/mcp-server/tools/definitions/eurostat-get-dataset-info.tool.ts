/**
 * @fileoverview Tool for fetching metadata about a specific Eurostat dataset.
 * @module mcp-server/tools/definitions/eurostat-get-dataset-info.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

export const eurostatGetDatasetInfo = tool('eurostat_get_dataset_info', {
  title: 'Get Eurostat Dataset Info',
  description:
    'Fetch metadata for a Eurostat dataset: dimensions with valid values, time range, observation count, and last-update date. Call this before eurostat_query_dataset to discover what dimension codes are valid (unit, na_item, geo, etc.). Uses a minimal Statistics API call (most recent period only) to extract dimension structure. Returns up to 10 sample values per dimension for orientation; use eurostat_get_dimension_values to list the full set for large dimensions.',
  annotations: { readOnlyHint: true },
  input: z.object({
    dataset_code: z
      .string()
      .min(1)
      .describe(
        'Dataset code (e.g., "nama_10_gdp"). Use eurostat_search_datasets or eurostat_browse_themes to find codes.',
      ),
  }),
  output: z.object({
    code: z.string().describe('Dataset code as provided.'),
    label: z.string().describe('Human-readable dataset title.'),
    dimensions: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Dimension code (e.g., "unit", "geo", "na_item"). Use these as filter keys in eurostat_query_dataset.',
              ),
            label: z.string().describe('Human-readable dimension name (e.g., "Unit of measure").'),
            valuesCount: z
              .number()
              .describe('Number of distinct values in this dimension for the most recent period.'),
            sampleValues: z
              .array(
                z
                  .object({
                    code: z.string().describe('Dimension value code.'),
                    label: z.string().describe('Human-readable label for this value.'),
                  })
                  .describe('A dimension value code and label pair.'),
              )
              .describe(
                'First 10 dimension values for orientation. Use eurostat_get_dimension_values for the full list.',
              ),
          })
          .describe('A dataset dimension with its valid values.'),
      )
      .describe('All dimensions of the dataset with their valid codes and labels.'),
    timeRange: z
      .object({
        start: z.string().describe('Earliest available period (e.g., "1975").'),
        end: z.string().describe('Most recent available period (e.g., "2024").'),
      })
      .describe('Overall data coverage period for this dataset.'),
    obsCount: z
      .number()
      .describe('Total number of observations in the full dataset (all periods).'),
    lastUpdated: z.string().describe('ISO 8601 timestamp of the most recent data update.'),
    metadataUrl: z
      .string()
      .optional()
      .describe(
        'URL to the ESMS HTML metadata page for this dataset. Omitted when not provided by Eurostat.',
      ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset code does not exist or is not available for dissemination.',
      recovery:
        'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.',
    },
    {
      reason: 'async_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Eurostat returned an async response (query too large for the API).',
      retryable: true,
      recovery:
        'This is unexpected for a metadata call; retry in a few seconds. If it persists, the dataset may be unusually large.',
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatDataService();
    const meta = await svc.getDatasetInfo(input.dataset_code, ctx);
    ctx.log.info('Dataset info fetched', {
      datasetCode: input.dataset_code,
      dimensionCount: meta.dimensions.length,
      obsCount: meta.obsCount,
    });
    return meta;
  },

  format: (result) => {
    const lines: string[] = [
      `# ${result.label}`,
      `**Code:** ${result.code}`,
      `**Period:** ${result.timeRange.start} – ${result.timeRange.end}`,
      `**Observations:** ${result.obsCount.toLocaleString()}`,
      `**Last updated:** ${result.lastUpdated}`,
    ];
    if (result.metadataUrl) lines.push(`**Metadata:** ${result.metadataUrl}`);
    lines.push(`\n## Dimensions (${result.dimensions.length})`);
    for (const dim of result.dimensions) {
      lines.push(
        `\n### ${dim.label} (\`${dim.code}\`) — ${dim.valuesCount} value${dim.valuesCount !== 1 ? 's' : ''}`,
      );
      if (dim.sampleValues.length > 0) {
        const samples = dim.sampleValues.map((v) => `\`${v.code}\` ${v.label}`).join(', ');
        lines.push(`Sample: ${samples}`);
        if (dim.valuesCount > dim.sampleValues.length) {
          lines.push(
            `_(${dim.valuesCount - dim.sampleValues.length} more — use eurostat_get_dimension_values for the full list)_`,
          );
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
