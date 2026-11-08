/**
 * @fileoverview Tool for searching the Eurostat dataset catalogue by keyword.
 * @module mcp-server/tools/definitions/eurostat-search-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { clampReadLimit } from '@/mcp-server/tools/clamp-read-limit.js';
import {
  getEurostatCatalogueService,
  MAX_UNMATCHED_WORD_CHECKS,
  MAX_VALUE_SEARCH_WORDS,
  type ValuesNotSearched,
} from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';
import { outageAnswer } from '@/services/eurostat-outage.js';

const COMEXT_NOT_SEARCHED =
  'The Comext dataflow list could not be loaded, so the DS-* collections (detailed trade and PRODCOM) were not searched; the merge is retried about once a minute. eurostat_get_dataset_info reads a DS-* code directly.';

const BROADEN_HINT =
  'Try a broader term or use eurostat_browse_themes to explore themes without text search.';

const UNMATCHED_WORDS_PARTIAL = `Only the first ${MAX_UNMATCHED_WORD_CHECKS} distinct words of the query were checked for words no dataset carries.`;

const MATCHED_THROUGH_VALUES =
  'No dataset label, theme breadcrumb, or code holds every word of the query, so these datasets were found by also matching the words they lack at the start of a word in the English labels of their dimension values. Each row\'s matchedValues names those values; a value\'s code filters its dimension in eurostat_query_dataset, as in filters `{"med_spec": ["PHARM"]}`.';

/** The sentence a `no_match` hint closes with when dimension value labels were not searched. */
const VALUES_NOT_SEARCHED: Record<ValuesNotSearched, string> = {
  index_unavailable:
    'Dimension value labels were not searched because their index has not loaded yet; it loads in the background, so the same search may later find datasets through them.',
  too_many_words: `Dimension value labels were not searched because the query has more than ${MAX_VALUE_SEARCH_WORDS} distinct words; a query of ${MAX_VALUE_SEARCH_WORDS} or fewer is also matched against them.`,
};

/**
 * The `no_match` recovery: first what the catalogue could not answer for (the unmerged
 * Comext list, or a DS-* code no source lists), then the expired copy a failed refresh
 * left in service, then each word whose removal alone finds matches — or, when none
 * does, the words no dataset carries, unless the unmerged Comext list leaves that
 * unproven, and that only the first words were read for them when a later one may be
 * such a word — and the broaden hint only when neither a count, a word left to search,
 * nor a code points elsewhere. Last, that dimension value labels were not searched.
 */
function noMatchHint({
  allWordsUnmatched,
  catalogueLoadedAt,
  comextListMissing,
  undisseminatedCodes,
  unmatchedWords,
  unmatchedWordsPartial,
  valuesNotSearched,
  wordRemovalCounts,
}: {
  allWordsUnmatched?: true;
  catalogueLoadedAt?: string;
  comextListMissing?: boolean;
  undisseminatedCodes?: string[];
  unmatchedWords?: string[];
  unmatchedWordsPartial?: true;
  valuesNotSearched?: ValuesNotSearched;
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
  } else {
    const dead = comextListMissing ? undefined : unmatchedWords?.map((word) => `"${word}"`);
    const one = dead?.length === 1;
    if (dead?.length) {
      const named = one ? dead[0] : `${dead.slice(0, -1).join(', ')} and ${dead.at(-1)}`;
      hint.push(
        `${named} ${one ? 'matches' : 'match'} no dataset label, theme breadcrumb, or code.`,
      );
    }
    if (unmatchedWordsPartial && !comextListMissing) hint.push(UNMATCHED_WORDS_PARTIAL);
    if (dead?.length && !allWordsUnmatched)
      hint.push(`Search again without ${one ? 'it' : 'them'}.`);
    else if (!codes) hint.push(BROADEN_HINT);
  }
  if (valuesNotSearched) hint.push(VALUES_NOT_SEARCHED[valuesNotSearched]);
  return hint.join(' ');
}

/** One row's matched values: codes verbatim as code spans, labels escaped. */
function renderMatchedValues(
  values: ReadonlyArray<{ code: string; dimension: string; label: string }>,
) {
  return values
    .map((v) => `\`${v.dimension}=${v.code}\` ${escapeMarkdownInline(v.label)}`)
    .join('; ');
}

/** Selects the advertised limit policy before registration. */
export const createEurostatSearchDatasets = (clampLimits: boolean) =>
  tool('eurostat_search_datasets', {
    title: 'Search Eurostat Datasets',
    description: `Search the Eurostat catalogue by keyword. Returns matching datasets with codes, descriptions, period coverage, and theme breadcrumbs. Matches are ordered by where the words were found: first datasets whose label contains the query as a phrase beginning at the start of a word, then those whose label or code contains every word, then those that match a word only through their theme breadcrumb, each group in table-of-contents order. When no dataset's label, theme breadcrumb, or code holds every word, a query of up to ${MAX_VALUE_SEARCH_WORDS} distinct words also has the words a dataset lacks looked for at the start of a word in the English labels of the dimension values Eurostat lists for it (time excluded); those rows carry matchedValues, whose codes are the filters eurostat_query_dataset takes. Use this to discover dataset codes before calling eurostat_get_dataset_info, then eurostat_query_dataset for a slice of a dataset or eurostat_download_dataset for the whole of one. Results are limited to datasets and predefined tables — folders are excluded. The catalogue joins two sources: the dissemination table of contents, and the Comext host's dataflow list, which adds the DS-* collections — detailed trade by CN8, HS, SITC, BEC and CPA, and PRODCOM — filed under "International trade in goods - detailed data (Comext)" and "Statistics on the production of manufactured goods (PRODCOM)". Comext entries report a last-update date but no period coverage or observation count. A collection on neither list, such as the legacy PRODCOM DS-056120, is not disseminated and cannot be reached through this server.`,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    input: z.object({
      query: z
        .string()
        .min(1)
        .regex(/\S/, 'Query must contain at least one non-whitespace search term.')
        .describe(
          `Search terms — at least one non-whitespace token is required. Split on whitespace into tokens; every token must match (AND), case-insensitively, somewhere across the dataset label, theme breadcrumb, or code. Spacing beside punctuation in the catalogue is ignored, so "Rev.2" also finds "Rev. 2" and "2015=100" finds "2015 = 100"; a token keeps its own punctuation, as in "R&D", "non-EU", or "DS-045409". Word order does not matter, so "business demography NUTS 3" or "regional economic accounts" resolve without naming a label verbatim. When no dataset holds every token, a query of up to ${MAX_VALUE_SEARCH_WORDS} distinct tokens is searched again with each token a dataset lacks also matching where it begins a word of the English label of one of its dimension values: "pharmacist" finds "Pharmacists" (med_spec=PHARM), "sex" does not find "Essex". When nothing matches, the error names each word whose removal alone would find matches or, when no single removal would and both catalogue sources were searched, the words that match no dataset label, theme breadcrumb, or code, and says when dimension value labels were not searched.`,
        ),
      limit: (clampLimits ? z.number().multipleOf(1).min(1) : z.number().int().min(1).max(100))
        .default(20)
        .describe(
          `Page size — maximum datasets returned per page. Default 20; ${clampLimits ? 'positive integers above 100 are clamped to 100 with a notice' : 'maximum 100; larger values are rejected'}. To retrieve matches beyond one page, pass the returned nextCursor back as cursor; the page size is fixed by this first call and limit is ignored on cursor calls.`,
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
              matchedValues: z
                .array(
                  z
                    .object({
                      dimension: z
                        .string()
                        .describe(
                          'Dimension the value belongs to (e.g., "med_spec") — the key in eurostat_query_dataset filters.',
                        ),
                      code: z
                        .string()
                        .describe(
                          'The value\'s code (e.g., "PHARM") — the value in eurostat_query_dataset filters.',
                        ),
                      label: z
                        .string()
                        .describe(
                          "The value's English label, which holds a query word at the start of a word.",
                        ),
                    })
                    .describe(
                      'A dimension value of this dataset whose label carries a query word.',
                    ),
                )
                .optional()
                .describe(
                  "Present only when no dataset's label, theme breadcrumb, or code holds every query word: this dataset's dimension values whose English labels carry the words its own text lacks, those carrying the most of the words first and then in Eurostat's metabase order, each value once. Omitted on every other search.",
                ),
            })
            .describe('A matched dataset entry.'),
        )
        .describe(
          "Matching datasets for the current page, up to the requested limit. Ordered first by label phrase matches (the query as a phrase beginning at the start of a word of the label), then datasets whose label or code holds every word, then datasets that match a word only through their theme breadcrumb; table-of-contents order within each group. Rows matched through dimension values (each carrying matchedValues) are ordered by fewer words found only in value labels, then datasets where one value's label carries all of those words, then the groups above over the words the dataset's own text holds, then table-of-contents order.",
        ),
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
          'Says when the results came through dimension value labels, and names each part of the catalogue this answer is missing — the Comext collections, or updates since a refresh failed — and what to do about it. Omitted when the whole catalogue answered through its own text.',
        ),
    },

    errors: [
      {
        reason: 'no_match',
        code: JsonRpcErrorCode.NotFound,
        when: 'No datasets matched the query string — including a query naming a DS-* code that neither the dissemination table of contents nor the Comext dataflow list carries, which is a collection Eurostat does not disseminate, and any query while the Comext dataflow list cannot be loaded and only the table of contents is searched.',
        recovery: `Try a broader or different search term, or eurostat_browse_themes to explore without text search; for a multi-word query the hint names each word whose removal alone finds matches, with the count, or else, when both catalogue sources were searched, the words that match no dataset label, theme breadcrumb, or code. A DS-* code on neither list is not disseminated, so search for its subject (e.g. "prodcom", "CN8") to find the collections that are. While the Comext dataflow list cannot be loaded, eurostat_get_dataset_info reads a DS-* code directly. The hint also says when dimension value labels were not searched: while their index loads, or for a query of more than ${MAX_VALUE_SEARCH_WORDS} distinct words.`,
      },
      {
        reason: 'invalid_cursor',
        code: JsonRpcErrorCode.InvalidParams,
        when: 'The cursor is malformed, came from a different query, or came from a catalogue snapshot — or, for results matched through dimension values, a value index — that has since refreshed.',
        recovery:
          'Repeat the search without a cursor, then page using the nextCursor that call returns.',
      },
      {
        reason: 'upstream_fault',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: "The server had no catalogue loaded yet, and Eurostat's table of contents answered HTTP 501, which is not retried, or a 4xx status, which its URL carries no caller input to cause; or it answered another HTTP 5xx or could not be reached on every retry, which the error marks retryable. Once a catalogue is loaded, a failed refresh serves that copy instead.",
        recovery:
          "Retry in a few minutes: the catalogue load failed on Eurostat's side and runs again on the next call.",
      },
    ],

    async handler(input, ctx) {
      const pageLimit = input.cursor
        ? { value: input.limit }
        : clampReadLimit(input.limit, 100, 'limit', 'eurostat_search_datasets', ctx);
      const svc = getEurostatCatalogueService();
      let found: Awaited<ReturnType<typeof svc.search>>;
      try {
        found = await svc.search(input.query, pageLimit.value, input.cursor, ctx);
      } catch (err) {
        const data = (err as McpError).data;
        if (data?.reason === 'invalid_cursor') {
          throw ctx.fail(
            'invalid_cursor',
            (err as Error).message,
            {
              recovery: {
                hint: `Repeat the search for "${input.query}" without a cursor, then page using the nextCursor it returns.`,
              },
            },
            { literals: [input.query] },
          );
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
        matchedThroughValues,
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
      const notices: string[] = pageLimit.notice ? [pageLimit.notice] : [];
      if (matchedThroughValues) notices.push(MATCHED_THROUGH_VALUES);
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
        if (d.obsCount != null)
          lines.push(`**Observations:** ${d.obsCount.toLocaleString('en-US')}`);
        if (d.lastUpdated) lines.push(`**Last updated:** ${d.lastUpdated}`);
        if (d.themePath.length > 0) lines.push(`**Theme:** ${d.themePath.join(' › ')}`);
        if (d.matchedValues) {
          lines.push(`**Matched values:** ${renderMatchedValues(d.matchedValues)}`);
        }
      }
      if (result.nextStep) lines.push(`\n**Next step:** ${result.nextStep}`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
  });

/** Default-on read-limit policy; startup selects the deployment policy explicitly. */
export const eurostatSearchDatasets = createEurostatSearchDatasets(true);
