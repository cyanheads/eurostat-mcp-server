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
    description: `Search the Eurostat catalogue by keyword for dataset codes, with labels, period coverage and theme breadcrumbs; datasets and predefined tables only, no folders. Pass a code to eurostat_get_dataset_info, then eurostat_query_dataset for a slice or eurostat_download_dataset for the whole dataset. The catalogue joins the dissemination table of contents with the Comext host's dataflow list, which adds the DS-* collections (detailed trade by CN8, HS, SITC, BEC and CPA, and PRODCOM); Comext entries report a last-update date but no period coverage or observation count. A collection on neither list, such as the legacy PRODCOM DS-056120, is not disseminated and cannot be reached.`,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    input: z.object({
      query: z
        .string()
        .min(1)
        .regex(/\S/, 'Query must contain at least one non-whitespace search term.')
        .describe(
          `Search words, at least one. Every word must match, in any order and ignoring case, somewhere in the dataset label, theme breadcrumb or code. Spacing beside punctuation in the catalogue is ignored ("Rev.2" finds "Rev. 2"); a word keeps its own punctuation ("R&D", "DS-045409"). When no dataset holds every word, a query of up to ${MAX_VALUE_SEARCH_WORDS} distinct words is searched again, each word a dataset lacks also matching at the start of a word in the English label of one of its dimension values (time excluded); those rows carry matchedValues. When nothing matches, the error names the words to drop.`,
        ),
      limit: (clampLimits ? z.number().multipleOf(1).min(1) : z.number().int().min(1).max(100))
        .default(20)
        .describe(
          `Datasets per page, default 20; ${clampLimits ? 'values above 100 clamp to 100 with a notice' : 'maximum 100, larger values are rejected'}. Fixed by the first call and ignored with cursor.`,
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          'Opaque nextCursor from the previous page; omit for the first. Bound to its query and to the catalogue snapshot that issued it: sent with another query, or after the catalogue refreshes, it is rejected.',
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
                  'Dataset code (e.g., "nama_10_gdp") for eurostat_get_dataset_info, eurostat_query_dataset and eurostat_download_dataset.',
                ),
              label: z.string().describe('Dataset title.'),
              type: z
                .enum(['dataset', 'table'])
                .describe('Entry type: "dataset", or "table" for a predefined table.'),
              dataStart: z
                .string()
                .optional()
                .describe('Earliest period (e.g., "1975"); omitted when not reported.'),
              dataEnd: z
                .string()
                .optional()
                .describe('Latest period (e.g., "2025"); omitted when not reported.'),
              lastUpdated: z
                .string()
                .optional()
                .describe(
                  'Date of the last data update (e.g., "22.05.2026"); omitted when not reported.',
                ),
              obsCount: z
                .number()
                .optional()
                .describe('Approximate observation count; omitted when not reported.'),
              themePath: z
                .array(z.string())
                .describe(
                  'Breadcrumb from the root theme to this dataset; for a dataset filed under several branches, the first that matched. Empty for top-level entries.',
                ),
              matchedValues: z
                .array(
                  z
                    .object({
                      dimension: z
                        .string()
                        .describe(
                          'Dimension code (e.g., "med_spec"), the key in eurostat_query_dataset filters.',
                        ),
                      code: z
                        .string()
                        .describe('Value code (e.g., "PHARM"), the value in those filters.'),
                      label: z.string().describe("The value's English label."),
                    })
                    .describe('A dimension value whose label carries a query word.'),
                )
                .optional()
                .describe(
                  "Only when no dataset's own text holds every query word: this dataset's dimension values whose labels carry the words its text lacks, those carrying the most words first, then in Eurostat's order.",
                ),
            })
            .describe('A matched dataset entry.'),
        )
        .describe(
          "This page of matches, up to limit, ordered: the query as a phrase from the start of a label word, then a label or code holding every word, then a match only through the theme breadcrumb; table-of-contents order within each group. Rows with matchedValues come by fewest words found only in value labels, then one value's label carrying all of them, then the groups above.",
        ),
      nextStep: z.string().optional().describe('Suggested next call, when one is clear.'),
    }),
    enrichment: {
      query: z.string().describe('Search terms as submitted.'),
      totalMatches: z.number().describe('Distinct datasets matching across all pages.'),
      truncated: z
        .boolean()
        .describe('True when more matches follow; pass nextCursor as cursor for them.'),
      nextCursor: z
        .string()
        .optional()
        .describe('Cursor for the next page. Omitted on the last page.'),
      comextListMissing: z
        .boolean()
        .optional()
        .describe(
          'True when the Comext dataflow list could not be loaded, so the DS-* collections were not searched and totalMatches counts the table of contents alone. Omitted otherwise.',
        ),
      catalogueLoadedAt: z
        .string()
        .optional()
        .describe(
          'When the catalogue that answered was loaded (ISO 8601); present only when a failed refresh left that older copy in service.',
        ),
      notice: z
        .string()
        .optional()
        .describe(
          'Says when results came through dimension value labels, and names any part of the catalogue missing from this answer and what to do about it.',
        ),
    },

    errors: [
      {
        reason: 'no_match',
        code: JsonRpcErrorCode.NotFound,
        when: 'No dataset matched the query. A DS-* code on neither catalogue list is not disseminated; while the Comext list cannot be loaded, only the table of contents is searched.',
        recovery:
          'Try a broader term, or eurostat_browse_themes to explore without text search; the hint names the words to drop. For a DS-* code on neither list, search for its subject (e.g. "prodcom", "CN8") instead.',
      },
      {
        reason: 'invalid_cursor',
        code: JsonRpcErrorCode.InvalidParams,
        when: 'The cursor is malformed, came from another query, or predates a catalogue or value-index refresh.',
        recovery:
          'Repeat the search without a cursor, then page using the nextCursor that call returns.',
      },
      {
        reason: 'upstream_fault',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: "No catalogue was loaded yet and Eurostat's table of contents could not be read: marked retryable after a timeout, rate limit, server error or unreachable host on every retry, not after a refusal Eurostat would repeat. Once a catalogue is loaded, a failed refresh serves that copy instead.",
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
