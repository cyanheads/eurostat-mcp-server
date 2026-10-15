/**
 * @fileoverview Tool for searching the Eurostat dataset catalogue by keyword.
 * @module mcp-server/tools/definitions/eurostat-search-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';
import { outageAnswer } from '@/services/eurostat-outage.js';

const COMEXT_NOT_SEARCHED =
  'The Comext dataflow list could not be loaded, so the DS-* collections (detailed trade and PRODCOM) were not searched; the merge is retried about once a minute. eurostat_get_dataset_info reads a DS-* code directly.';

const BROADEN_HINT =
  'Try a broader term or use eurostat_browse_themes to explore themes without text search.';

/**
 * The `no_match` recovery: first what the catalogue could not answer for (the unmerged
 * Comext list, or a DS-* code no source lists), then the expired copy a failed refresh
 * left in service, then each word whose removal alone finds matches, and the broaden hint
 * only when neither a count nor a code points elsewhere.
 */
function noMatchHint({
  catalogueLoadedAt,
  comextListMissing,
  undisseminatedCodes,
  wordRemovalCounts,
}: {
  catalogueLoadedAt?: string;
  comextListMissing?: boolean;
  undisseminatedCodes?: string[];
  wordRemovalCounts?: Array<{ totalMatches: number; word: string }>;
}): string {
  const codes = undisseminatedCodes?.join(', ');
  const plural = (undisseminatedCodes?.length ?? 0) > 1;
  const hint: string[] = [];
  if (comextListMissing) {
    hint.push(
      codes
        ? `The Comext dataflow list could not be loaded, so the DS-* collections (detailed trade and PRODCOM) were not searched and ${codes} could not be checked against it; the merge is retried about once a minute. Call eurostat_get_dataset_info with ${plural ? 'each code to check them' : 'the code to check it'} directly.`
        : COMEXT_NOT_SEARCHED,
    );
  } else if (codes) {
    hint.push(
      `Broadening will not find ${codes}: a collection on neither list is not disseminated. Search for its subject instead — "prodcom" or "CN8", for example — to find the DS-* collections Eurostat does disseminate.`,
    );
  }
  if (catalogueLoadedAt) {
    hint.push(
      `The catalogue could not be refreshed, so this search ran against the copy loaded at ${catalogueLoadedAt}; datasets Eurostat added or changed since then were not searched.`,
    );
  }
  if (wordRemovalCounts?.length) {
    for (const { word, totalMatches } of wordRemovalCounts) {
      hint.push(`Without "${word}": ${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'}.`);
    }
    hint.push('Search again without one of those words to see its matches.');
  } else if (!codes) {
    hint.push(BROADEN_HINT);
  }
  return hint.join(' ');
}

export const eurostatSearchDatasets = tool('eurostat_search_datasets', {
  title: 'Search Eurostat Datasets',
  description:
    'Search the Eurostat catalogue by keyword. Returns matching datasets with codes, descriptions, period coverage, and theme breadcrumbs. Use this to discover dataset codes before calling eurostat_get_dataset_info, then eurostat_query_dataset for a slice of a dataset or eurostat_download_dataset for the whole of one. Results are limited to datasets and predefined tables — folders are excluded. The catalogue joins two sources: the dissemination table of contents, and the Comext host\'s dataflow list, which adds the DS-* collections — detailed trade by CN8, HS, SITC, BEC and CPA, and PRODCOM — filed under "International trade in goods - detailed data (Comext)" and "Statistics on the production of manufactured goods (PRODCOM)". Comext entries report a last-update date but no period coverage or observation count. A collection on neither list, such as the legacy PRODCOM DS-056120, is not disseminated and cannot be reached through this server.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .regex(/\S/, 'Query must contain at least one non-whitespace search term.')
      .describe(
        'Search terms — at least one non-whitespace token is required. Split on whitespace into tokens; every token must match (AND), case-insensitively, somewhere across the dataset label, theme breadcrumb, or code. Spacing beside punctuation in the catalogue is ignored, so "Rev.2" also finds "Rev. 2" and "2015=100" finds "2015 = 100"; a token keeps its own punctuation, as in "R&D", "non-EU", or "DS-045409". Word order does not matter, so "business demography NUTS 3" or "regional economic accounts" resolve without naming a label verbatim. When nothing matches, the error names each word whose removal alone would find matches.',
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
    comextListMissing: z
      .boolean()
      .optional()
      .describe(
        'True when the Comext dataflow list could not be loaded, so the DS-* collections (detailed trade and PRODCOM) were not searched and totalMatches counts the dissemination table of contents alone. Omitted when both sources were searched.',
      ),
    catalogueLoadedAt: z
      .string()
      .optional()
      .describe(
        'When the catalogue that answered was loaded (ISO 8601). Present only when a refresh failed and that older copy is still in service; omitted otherwise.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Names each part of the catalogue this answer is missing — the Comext collections, or updates since a refresh failed — and what to do about it. Omitted when the whole catalogue answered.',
      ),
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No datasets matched the query string — including a query naming a DS-* code that neither the dissemination table of contents nor the Comext dataflow list carries, which is a collection Eurostat does not disseminate, and any query while the Comext dataflow list cannot be loaded and only the table of contents is searched.',
      recovery:
        'Try a broader or different search term, or eurostat_browse_themes to explore without text search; for a multi-word query the hint names each word whose removal alone finds matches, with the count. A DS-* code on neither list is not disseminated, so search for its subject (e.g. "prodcom", "CN8") to find the collections that are. While the Comext dataflow list cannot be loaded, eurostat_get_dataset_info reads a DS-* code directly.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The cursor is malformed, came from a different query, or came from a catalogue snapshot that has since refreshed.',
      recovery:
        'Repeat the search without a cursor, then page using the nextCursor that call returns.',
    },
    {
      reason: 'upstream_fault',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The server had no catalogue loaded yet, and Eurostat's table of contents answered HTTP 5xx or could not be reached on every retry, which the error marks retryable. Once a catalogue is loaded, a failed refresh serves that copy instead.",
      recovery:
        "Retry in a few minutes: the catalogue load failed on Eurostat's side and runs again on the next call.",
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatCatalogueService();
    let found: Awaited<ReturnType<typeof svc.search>>;
    try {
      found = await svc.search(input.query, input.limit, input.cursor, ctx);
    } catch (err) {
      const data = (err as McpError).data;
      if (data?.reason === 'invalid_cursor') {
        throw ctx.fail('invalid_cursor', (err as Error).message, {
          recovery: {
            hint: `Repeat the search for "${input.query}" without a cursor, then page using the nextCursor it returns.`,
          },
        });
      }
      if (data?.reason === 'upstream_fault' && data.retryable === true) {
        throw ctx.fail('upstream_fault', (err as Error).message, {
          retryable: true,
          recovery: {
            hint: `Eurostat's table of contents ${outageAnswer(data.status)} on every attempt, so there is no catalogue to search yet — an upstream outage, not a fault in the query. The load runs again on the next call, so retry in a few minutes.`,
          },
        });
      }
      throw err;
    }
    const {
      datasets,
      totalMatches,
      nextCursor,
      undisseminatedCodes,
      comextListMissing,
      catalogueLoadedAt,
    } = found;

    if (datasets.length === 0) {
      /**
       * A DS-* code on neither list is absent by design, so broadening cannot find it.
       * While the Comext list is not merged, its absence proves nothing — the code is
       * checked directly instead.
       */
      const codes = undisseminatedCodes?.join(', ');
      const plural = (undisseminatedCodes?.length ?? 0) > 1;
      throw ctx.fail(
        'no_match',
        codes && !comextListMissing
          ? `No datasets matched "${input.query}": ${codes} ${plural ? 'are' : 'is'} on neither the Eurostat dissemination catalogue nor the Comext dataflow list, so Eurostat does not disseminate ${plural ? 'them' : 'it'} through this API.`
          : `No datasets matched "${input.query}".`,
        { recovery: { hint: noMatchHint(found) } },
      );
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
      ...(comextListMissing && { comextListMissing }),
      ...(catalogueLoadedAt && { catalogueLoadedAt }),
    });
    // `notice` is last-wins, so every sentence is collected here and written once.
    const notices: string[] = [];
    if (comextListMissing) notices.push(COMEXT_NOT_SEARCHED);
    if (catalogueLoadedAt) {
      notices.push(
        `The catalogue could not be refreshed, so these results come from the copy loaded at ${catalogueLoadedAt}; datasets Eurostat added or changed since then are not reflected.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
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
