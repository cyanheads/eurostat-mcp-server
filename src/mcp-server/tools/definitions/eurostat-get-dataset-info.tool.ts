/**
 * @fileoverview Tool for fetching metadata about a specific Eurostat dataset.
 * @module mcp-server/tools/definitions/eurostat-get-dataset-info.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

export const eurostatGetDatasetInfo = tool('eurostat_get_dataset_info', {
  title: 'Get Eurostat Dataset Info',
  description:
    'Fetch metadata for a Eurostat dataset: dimensions with valid values, time range, observation count, and last-update date. Call this before eurostat_query_dataset or eurostat_download_dataset to discover what dimension codes are valid (unit, na_item, geo, etc.); eurostat_download_dataset builds its positional filter key from this dimension list, so a filter naming a dimension absent here is rejected outright. Returns up to 10 sample values per dimension for orientation; use eurostat_get_dimension_values to list the full set for large dimensions. A DS-* code (detailed trade and PRODCOM, in any case) is read from the Comext dissemination host, which reports no period coverage or observation count, so timeRange and obsCount come back unreported; the first call on a large Comext collection downloads its full structure (23 MB for DS-045409) and takes longer, and repeat calls within the hour reuse it.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    dataset_code: z
      .string()
      .min(1)
      .describe(
        'Dataset code (e.g., "nama_10_gdp", or "DS-045409" for a Comext collection). Use eurostat_search_datasets or eurostat_browse_themes to find codes.',
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
                'Dimension code (e.g., "unit", "geo", "na_item"). Use these as filter keys in eurostat_query_dataset and eurostat_download_dataset.',
              ),
            label: z.string().describe('Human-readable dimension name (e.g., "Unit of measure").'),
            valuesCount: z
              .number()
              .optional()
              .describe(
                'Number of dataset-available values in this dimension, taken from the dataset content constraint. For "time" this is the full period count. Omitted only when Eurostat does not supply a measurable value set.',
              ),
            sampleValues: z
              .array(
                z
                  .object({
                    code: z.string().describe('Dimension value code.'),
                    label: z.string().describe('Human-readable label for this value.'),
                  })
                  .describe('A dimension value code and label pair.'),
              )
              .optional()
              .describe(
                'First 10 dataset-available values for orientation. Use eurostat_get_dimension_values for the full constrained list. Omitted alongside valuesCount when Eurostat does not supply a measurable value set.',
              ),
          })
          .describe('A dataset dimension with its valid values.'),
      )
      .describe('All dimensions of the dataset with their valid codes and labels.'),
    timeRange: z
      .object({
        start: z
          .string()
          .optional()
          .describe(
            'Earliest available period (e.g., "1975"). Omitted when Eurostat does not report it.',
          ),
        end: z
          .string()
          .optional()
          .describe(
            'Most recent available period (e.g., "2024"). Omitted when Eurostat does not report it.',
          ),
      })
      .describe(
        'Overall data coverage period for this dataset. Each bound is omitted when Eurostat does not report it — an omitted bound is unknown, not empty.',
      ),
    obsCount: z
      .number()
      .optional()
      .describe(
        'Total number of observations in the full dataset (all periods). Omitted when Eurostat does not report it — an omitted count is unknown, not zero.',
      ),
    lastUpdated: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp of the most recent data update. Omitted when Eurostat does not report it.',
      ),
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
      reason: 'upstream_fault',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Eurostat returned a dataset structure or content constraint this server cannot read: malformed, truncated, not XML, or missing the requested dataset's dataflow.",
      recovery:
        'Retry in a few minutes, since a failed structure read is not cached. If it fails the same way, eurostat_query_dataset reads the observations, with dimension codes and labels, from a separate endpoint.',
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatDataService();
    let meta: Awaited<ReturnType<typeof svc.getDatasetInfo>>;
    try {
      meta = await svc.getDatasetInfo(input.dataset_code, ctx);
    } catch (err) {
      const reason = (err as McpError).data?.reason;
      if (reason === 'not_found') {
        throw ctx.fail('not_found', (err as Error).message, {
          recovery: {
            hint: `Dataset "${input.dataset_code}" not found. Use eurostat_search_datasets or eurostat_browse_themes to find a valid code.`,
          },
        });
      }
      if (reason === 'upstream_fault') {
        throw ctx.fail('upstream_fault', (err as Error).message, {
          recovery: {
            hint: `Eurostat returned a structure for "${input.dataset_code}" that this server cannot read. A failed read is not cached, so retry in a few minutes. If it fails the same way, eurostat_query_dataset reads the dataset's observations, with their dimension codes and labels, from the Statistics API, which does not depend on this structure; start with last_n_periods: 1 to keep the match small.`,
          },
        });
      }
      throw err;
    }
    ctx.log.info('Dataset info fetched', {
      datasetCode: input.dataset_code,
      dimensionCount: meta.dimensions.length,
      obsCount: meta.obsCount,
    });
    return meta;
  },

  format: (result) => {
    // Absent annotation-derived values are named as unreported rather than rendered as a
    // zero or a blank, so content[] carries the same uncertainty structuredContent does.
    const UNREPORTED = 'not reported by Eurostat';
    const { start, end } = result.timeRange;
    const lines: string[] = [
      `# ${result.label}`,
      `**Code:** ${result.code}`,
      `**Period:** ${start || end ? `${start ?? UNREPORTED} – ${end ?? UNREPORTED}` : UNREPORTED}`,
      `**Observations:** ${result.obsCount?.toLocaleString() ?? UNREPORTED}`,
      `**Last updated:** ${result.lastUpdated ?? UNREPORTED}`,
    ];
    if (result.metadataUrl) lines.push(`**Metadata:** ${result.metadataUrl}`);
    lines.push(`\n## Dimensions (${result.dimensions.length})`);
    for (const dim of result.dimensions) {
      const count =
        dim.valuesCount === undefined
          ? `value count ${UNREPORTED}`
          : `${dim.valuesCount} value${dim.valuesCount !== 1 ? 's' : ''}`;
      lines.push(`\n### ${dim.label} (\`${dim.code}\`) — ${count}`);
      const samples = dim.sampleValues ?? [];
      if (samples.length > 0) {
        lines.push(`Sample: ${samples.map((v) => `\`${v.code}\` ${v.label}`).join(', ')}`);
        if (dim.valuesCount !== undefined && dim.valuesCount > samples.length) {
          lines.push(
            `_(${dim.valuesCount - samples.length} more — use eurostat_get_dimension_values for the full list)_`,
          );
        }
      } else if (dim.valuesCount === undefined) {
        lines.push(`_(use eurostat_get_dimension_values to list this dimension's values)_`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
