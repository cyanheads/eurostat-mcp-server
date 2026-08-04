/**
 * @fileoverview Tool for searching the Eurostat dataset catalogue by keyword.
 * @module mcp-server/tools/definitions/eurostat-search-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';

export const eurostatSearchDatasets = tool('eurostat_search_datasets', {
  title: 'Search Eurostat Datasets',
  description:
    'Search the Eurostat catalogue by keyword. Returns matching datasets with codes, descriptions, period coverage, and theme breadcrumbs. Use this to discover dataset codes before calling eurostat_get_dataset_info, then eurostat_query_dataset for a slice of a dataset or eurostat_download_dataset for the whole of one. Results are limited to datasets and predefined tables — folders are excluded.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .regex(/\S/, 'Query must contain at least one non-whitespace search term.')
      .describe(
        'Search terms — at least one non-whitespace token is required. Split on whitespace into tokens; every token must match (AND), case-insensitively, somewhere across the dataset label, theme breadcrumb, or code. Word order does not matter, so "business demography NUTS 3" or "regional economic accounts" resolve without naming a label verbatim.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Page size — maximum datasets returned per page (1–100). Default is 20. To retrieve matches beyond one page, pass the returned nextCursor back as cursor; the page size is fixed by this first call.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque pagination cursor from a previous call's nextCursor. Omit for the first page; pass it back — with the same query — to fetch the next page of matches over a stable order. A cursor is bound to the query that produced it and to the catalogue snapshot in effect at that time, so reusing one with a different query, or after the catalogue refreshes, is rejected rather than silently paging a different result set.",
      ),
  }),
  output: z.object({
    datasets: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Dataset code (e.g., "nama_10_gdp"). Use this in eurostat_get_dataset_info, eurostat_query_dataset, and eurostat_download_dataset.',
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
                'Breadcrumb path from root theme to this dataset (e.g., ["Database by themes", "Economy and finance"]). Eurostat files some datasets under several branches; this is the first branch that matched the query. Empty for top-level entries.',
              ),
          })
          .describe('A matched dataset entry.'),
      )
      .describe('Matching datasets for the current page, up to the requested limit.'),
    nextStep: z
      .string()
      .optional()
      .describe(
        'Suggested next action based on these results. Populated when there is a clear follow-up call.',
      ),
  }),
  enrichment: {
    query: z.string().describe('Search terms as submitted.'),
    totalMatches: z
      .number()
      .describe(
        'Total distinct dataset codes matching the query across all pages, before the page limit.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when more matches remain beyond this page — pass nextCursor as cursor to fetch them.',
      ),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Opaque cursor for the next page of matches. Pass it back as cursor with the same query; it stops working once the catalogue refreshes. Omitted on the last page.',
      ),
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No datasets matched the query string.',
      recovery:
        'Try a broader or different search term. Use eurostat_browse_themes to explore themes without text search.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The cursor is malformed, came from a different query, or came from a catalogue snapshot that has since refreshed.',
      recovery:
        'Repeat the search without a cursor, then page using the nextCursor that call returns.',
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatCatalogueService();
    let found: Awaited<ReturnType<typeof svc.search>>;
    try {
      found = await svc.search(input.query, input.limit, input.cursor, ctx);
    } catch (err) {
      if ((err as McpError).data?.reason === 'invalid_cursor') {
        throw ctx.fail('invalid_cursor', (err as Error).message, {
          recovery: {
            hint: `Repeat the search for "${input.query}" without a cursor, then page using the nextCursor it returns.`,
          },
        });
      }
      throw err;
    }
    const { datasets, totalMatches, nextCursor } = found;

    if (datasets.length === 0) {
      throw ctx.fail('no_match', `No datasets matched "${input.query}".`, {
        recovery: {
          hint: `Try a broader term or use eurostat_browse_themes to explore themes without text search.`,
        },
      });
    }

    const hasMore = nextCursor !== undefined;
    ctx.log.info('Dataset search complete', {
      query: input.query,
      totalMatches,
      returned: datasets.length,
      hasMore,
    });
    ctx.enrich({
      query: input.query,
      totalMatches,
      truncated: hasMore,
      ...(hasMore && { nextCursor }),
    });
    return {
      datasets,
      nextStep: `Pass a "code" value to eurostat_get_dataset_info to inspect dimensions, to eurostat_query_dataset to fetch a slice, or to eurostat_download_dataset to pull the whole dataset.`,
    };
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
    if (result.nextStep) lines.push(`\n**Next step:** ${result.nextStep}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
