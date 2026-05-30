/**
 * @fileoverview Tool for searching the Eurostat dataset catalogue by keyword.
 * @module mcp-server/tools/definitions/eurostat-search-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';

export const eurostatSearchDatasets = tool('eurostat_search_datasets', {
  title: 'Search Eurostat Datasets',
  description:
    'Search the Eurostat catalogue (8,933 datasets) by keyword. Returns matching datasets with codes, descriptions, period coverage, and theme breadcrumbs. Use this to discover dataset codes before calling eurostat_get_dataset_info or eurostat_query_dataset. Results are limited to datasets and predefined tables — folders are excluded.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe('Search terms — case-insensitive substring match against dataset labels.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum number of results to return (1–100). Default is 20.'),
  }),
  output: z.object({
    datasets: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Dataset code (e.g., "nama_10_gdp"). Use this in eurostat_get_dataset_info and eurostat_query_dataset.',
              ),
            label: z.string().describe('Human-readable dataset title.'),
            type: z
              .enum(['dataset', 'table'])
              .describe(
                'Entry type: "dataset" for standard datasets, "table" for predefined tables.',
              ),
            dataStart: z
              .string()
              .optional()
              .describe(
                'Earliest data period available (e.g., "1975"). Omitted when not reported by Eurostat.',
              ),
            dataEnd: z
              .string()
              .optional()
              .describe(
                'Most recent data period available (e.g., "2025"). Omitted when not reported by Eurostat.',
              ),
            lastUpdated: z
              .string()
              .optional()
              .describe(
                'Date of last data update (e.g., "22.05.2026"). Omitted when not reported.',
              ),
            obsCount: z
              .number()
              .optional()
              .describe(
                'Approximate number of observations. Omitted when not reported by Eurostat.',
              ),
            themePath: z
              .array(z.string())
              .describe(
                'Breadcrumb path from root theme to this dataset (e.g., ["Economy and finance", "National accounts"]). Empty for top-level entries.',
              ),
          })
          .describe('A matched dataset entry.'),
      )
      .describe('Matching datasets, up to the requested limit.'),
  }),
  enrichment: {
    query: z.string().describe('Search terms as submitted.'),
    totalMatches: z.number().describe('Total datasets matching the query before the limit.'),
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No datasets matched the query string.',
      recovery:
        'Try a broader or different search term. Use eurostat_browse_themes to explore themes without text search.',
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatCatalogueService();
    const { datasets, totalMatches } = await svc.search(input.query, input.limit, ctx);

    if (datasets.length === 0) {
      throw ctx.fail('no_match', `No datasets matched "${input.query}".`, {
        recovery: {
          hint: `Try a broader term or use eurostat_browse_themes to explore themes without text search.`,
        },
      });
    }

    ctx.log.info('Dataset search complete', {
      query: input.query,
      totalMatches,
      returned: datasets.length,
    });
    ctx.enrich({ query: input.query, totalMatches });
    return { datasets };
  },

  format: (result) => {
    const lines: string[] = [
      `**Showing ${result.datasets.length} result${result.datasets.length !== 1 ? 's' : ''}**\n`,
    ];
    for (const d of result.datasets) {
      lines.push(`## ${d.label}`);
      lines.push(`**Code:** ${d.code} | **Type:** ${d.type}`);
      if (d.dataStart || d.dataEnd) {
        lines.push(`**Period:** ${d.dataStart ?? '?'} – ${d.dataEnd ?? '?'}`);
      }
      if (d.obsCount != null) lines.push(`**Observations:** ${d.obsCount.toLocaleString()}`);
      if (d.lastUpdated) lines.push(`**Last updated:** ${d.lastUpdated}`);
      if (d.themePath.length > 0) lines.push(`**Theme:** ${d.themePath.join(' › ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
