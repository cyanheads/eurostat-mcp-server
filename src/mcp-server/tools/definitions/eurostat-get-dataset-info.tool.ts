/**
 * @fileoverview Tool for fetching metadata about a specific Eurostat dataset.
 * @module mcp-server/tools/definitions/eurostat-get-dataset-info.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import { outageAnswer } from '@/services/eurostat-outage.js';

export const eurostatGetDatasetInfo = tool('eurostat_get_dataset_info', {
  title: 'Get Eurostat Dataset Info',
  description:
    "Fetch a Eurostat dataset's metadata: dimensions with sample values, time range, observation count and last update. Call it before eurostat_query_dataset or eurostat_download_dataset to learn the dimension codes their filters take; the download rejects a filter naming a dimension absent here. Up to 10 sample values per dimension; eurostat_get_dimension_values lists the rest. A DS-* code (detailed trade and PRODCOM, any case) is read from the Comext host, which reports no period coverage or observation count; the first call on a large Comext collection downloads its full structure and takes longer, and repeat calls within the hour reuse it.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    dataset_code: z
      .string()
      .min(1)
      .describe(
        'Dataset code (e.g., "nama_10_gdp", or "DS-045409" for a Comext collection), from eurostat_search_datasets or eurostat_browse_themes.',
      ),
  }),
  output: z.object({
    code: z.string().describe('Dataset code as provided.'),
    label: z.string().describe('Dataset title.'),
    dimensions: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Dimension code (e.g., "geo"), the filter key in eurostat_query_dataset and eurostat_download_dataset.',
              ),
            label: z.string().describe('Dimension name (e.g., "Unit of measure").'),
            valuesCount: z
              .number()
              .optional()
              .describe(
                'Values the dataset carries in this dimension; for "time", its period count. Omitted when Eurostat supplies no measurable value set.',
              ),
            sampleValues: z
              .array(
                z
                  .object({
                    code: z.string().describe('Value code.'),
                    label: z.string().describe('Value label.'),
                  })
                  .describe('A dimension value code and label pair.'),
              )
              .optional()
              .describe(
                'The first 10 values; eurostat_get_dimension_values lists all. Omitted alongside valuesCount.',
              ),
          })
          .describe('A dataset dimension with its valid values.'),
      )
      .describe("The dataset's dimensions."),
    timeRange: z
      .object({
        start: z
          .string()
          .optional()
          .describe('Earliest period (e.g., "1975"); omitted when not reported.'),
        end: z
          .string()
          .optional()
          .describe('Latest period (e.g., "2024"); omitted when not reported.'),
      })
      .describe('Dataset coverage. An omitted bound is unknown, not empty.'),
    obsCount: z
      .number()
      .optional()
      .describe(
        'Observations across the whole dataset; omitted when not reported, which means unknown, not zero.',
      ),
    lastUpdated: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of the last data update; omitted when not reported.'),
    metadataUrl: z
      .string()
      .optional()
      .describe('ESMS metadata page URL; omitted when Eurostat gives none.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset code does not exist or is not disseminated.',
      recovery:
        'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.',
    },
    {
      reason: 'upstream_fault',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Eurostat returned a dataset structure this server cannot read, or refused the structure read, which is not retried; marked retryable when the structure endpoint failed or could not be reached on every retry.',
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
      if (reason === 'upstream_fault' && (err as McpError).data?.retryable === true) {
        throw ctx.fail('upstream_fault', (err as Error).message, {
          retryable: true,
          recovery: {
            hint: `Eurostat's SDMX structure endpoint ${outageAnswer((err as McpError).data?.status)} for "${input.dataset_code}" on every attempt — an upstream outage, not a fault in the request. A failed read is not cached, so retry in a few minutes.`,
          },
        });
      }
      const status = (err as McpError).data?.status;
      if (reason === 'upstream_fault' && typeof status === 'number') {
        // An HTTP status the fetch layer does not retry (a 501): an answer, not a body to read.
        throw ctx.fail('upstream_fault', (err as Error).message, {
          recovery: {
            hint: `Eurostat's SDMX structure endpoint answered HTTP ${status} for "${input.dataset_code}", a status this server does not retry on its own. A failed read is not cached, so retry in a few minutes. If it fails the same way, eurostat_query_dataset reads the dataset's observations, with their dimension codes and labels, from the Statistics API, which does not depend on this structure; start with last_n_periods: 1 to keep the match small.`,
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
      `**Observations:** ${result.obsCount?.toLocaleString('en-US') ?? UNREPORTED}`,
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
