/**
 * @fileoverview Tool for querying statistical data from a Eurostat dataset.
 * @module mcp-server/tools/definitions/eurostat-query-dataset.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { clampReadLimit } from '@/mcp-server/tools/clamp-read-limit.js';
import { hoistDimensions } from '@/mcp-server/tools/hoist-dimensions.js';
import {
  dimensionsToNarrow,
  dimensionValuesForHint,
  formatValues,
  narrowingAdvice,
  RENAME_FILTER_KEYS_HINT,
  UNKNOWN_FILTER_KEY_WHEN,
  unmatchedValuesAdvice,
} from '@/mcp-server/tools/narrowing-advice.js';
import { countOf, listEmptyValues, spanOf } from '@/mcp-server/tools/notice-text.js';
import {
  acquireCanvas,
  getCanvas,
  isCanvasFailure,
  newTableName,
} from '@/services/canvas-accessor.js';
import {
  getEurostatDataService,
  observationRowSchema,
  TIME_DIMENSION_KEYS,
} from '@/services/eurostat-data/eurostat-data-service.js';
import {
  GEO_LEVEL_VALUES,
  type GeoLevel,
  type NoResultsDiagnosis,
  OBS_CAP,
  type OutsideSpan,
  type StatisticsDeadlineData,
} from '@/services/eurostat-data/types.js';
import {
  normalizeFilters,
  unknownDimensionsMessage,
  unknownFilterKeys,
} from '@/services/eurostat-filters.js';
import { isComextDataset } from '@/services/eurostat-hosts.js';
import { outageAnswer } from '@/services/eurostat-outage.js';
import {
  cutNotice,
  cutSelector,
  normalizePeriod,
  PERIOD_FORMS,
  resolvePeriods,
} from '@/services/eurostat-periods.js';

/** Upper bound on the deterministic observation prefix returned inline. */
const PREVIEW_MAX = 500;

/**
 * Newest unpopulated periods listed in empty-result errors and successful gap notices.
 * Daily indexes can contain thousands of positions; each disclosure keeps the full count.
 */
const MATCHED_PERIODS_LISTED = 24;

/** Selects the advertised limit policy before registration. */
export const createEurostatQueryDataset = (clampLimits: boolean) =>
  tool('eurostat_query_dataset', {
    title: 'Query Eurostat Dataset',
    description:
      'Fetch statistical data from a Eurostat dataset with dimension filters. Returns a deterministic inline prefix of decoded observations with dimension codes and labels, numeric values, an OBS_FLAG status (e.g., "p" = provisional, "e" = estimated) and a separate CONF_STATUS confidentiality marker (e.g., "C" = confidential, which is usually why a value is null). preview_limit controls only that prefix; filters and period controls reduce the matched result itself. Call eurostat_get_dataset_info first to discover valid dimension codes and values. Apply filters to keep the result set manageable — large unfiltered queries may trigger an async response error. Use filters.geo for specific country/region codes, or geo_level for NUTS hierarchy filtering (mutually exclusive). Use last_n_periods for the N most recent dataset time positions without knowing the end date; a notice names selected periods with no populated cells for the slice. Set stage=true to stage the whole match at any size on a canvas-enabled deployment; matches above 5,000 observations stage automatically. Call eurostat_dataframe_describe first, then eurostat_dataframe_query. When the target is a whole dataset rather than a slice, eurostat_download_dataset reads the SDMX bulk endpoint instead and is the cheaper route.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    input: z.object({
      dataset_code: z
        .string()
        .min(1)
        .describe(
          'Dataset code (e.g., "nama_10_gdp"). Required. A DS-* code — Comext detailed trade or PRODCOM, in any case — is served by the Comext host: filter freq on its trade flows, which mix annual and monthly series, and note that product, reporter and partner carry aggregates (TOTAL, EU27_2020) that double-count when summed with their members.',
        ),
      filters: z
        .record(z.string(), z.array(z.string()))
        .default({})
        .describe(
          'Dimension filters as a map of dimension code → array of valid values. Example: {"unit": ["CP_MEUR"], "na_item": ["B1GQ"], "geo": ["DE", "FR"]}. An empty array is treated as no filter for that dimension and is dropped from the request, and so is a blank or whitespace-only value ([""] is no filter, ["", "DE"] is ["DE"]). No Eurostat code contains "+" or ".": a value holding "+" is split into separate values, read as OR (["DE+FR"] is ["DE", "FR"]), and a value holding "." stays one value that matches nothing. Dimension codes match in any case ("GEO" is geo). Keys are dimensions only: one naming a request control (lang, format, geoLevel, sinceTimePeriod, untilTimePeriod, lastTimePeriod, in any case) is rejected as invalid_dimension — use the lang, geo_level, since_period, until_period and last_n_periods inputs. Do not include "geo" here if using geo_level, nor "time"/"time_period" if using since_period, until_period or last_n_periods. A value that matches nothing contributes no rows rather than an error; the response names it in unmatchedValues, or in the no_results error when nothing matched at all. A valid value with no cell in the selected periods contributes no rows either; the response names it in emptyValues. eurostat_get_dimension_values lists the valid values.',
        ),
      geo_level: z
        .enum(GEO_LEVEL_VALUES)
        .optional()
        .describe(
          'Filter by NUTS hierarchy level. Mutually exclusive with a "geo" key in filters. Options: "aggregate" (EU/EA totals), "country" (member and candidate states), "nuts1" (major regions), "nuts2" (basic regions), "nuts3" (small regions). How many codes a level holds varies by dataset; a code of the level with no cell in the match is named in emptyValues.',
        ),
      since_period: z
        .string()
        .optional()
        .describe(
          `Start of the time range, inclusive. Accepted forms: ${PERIOD_FORMS} (e.g., "2020", "2023-Q1", "2024-01"). Extra leading zeros after the letter are dropped ("2020-Q01" is sent as "2020-Q1"), a day of the year is sent as three digits ("2026-D1" as "2026-D001"), and YYYY-A1 is sent as YYYY. Any form works on any dataset, read as a span of days, but Eurostat keeps only periods wholly inside the range, per frequency: "2022-06" on annual data excludes 2022, which starts before the bound, and a notice names that period when the response shows its frequency. A range whose first and last day are the same day is sent as that one date. A malformed or non-existent period (e.g., "2020-13") is rejected as invalid_period. Mutually exclusive with last_n_periods.`,
        ),
      until_period: z
        .string()
        .optional()
        .describe(
          'End of the time range, inclusive (e.g., "2024"), in the same forms as since_period. Omit for data through the latest available period. A bound that falls inside a period excludes it here too: "2023-06" on annual data excludes 2023, which ends after the bound. The range must hold at least one day: a since_period that starts after until_period ends is rejected as invalid_period, and bounds of different frequencies are compared by day. Mutually exclusive with last_n_periods.',
        ),
      last_n_periods: z
        .number()
        .multipleOf(1)
        .min(1)
        .optional()
        .describe(
          "Return only the N most recent dataset time positions. Selected periods without populated cells for this slice are disclosed in a notice on successful queries, which advises a larger N only when every such period follows the slice's latest period with a cell. N counts back from the dataset's latest period, not from the latest period published for this slice, so a slice that lags can come back empty — increase N, or replace last_n_periods with a since_period/until_period range ending at a period the slice has published (until_period alone selects every period up to it). Mutually exclusive with since_period and until_period.",
        ),
      preview_limit: (clampLimits
        ? z.number().multipleOf(1).min(1)
        : z.number().int().min(1).max(PREVIEW_MAX)
      )
        .default(25)
        .describe(
          `How many matched observations to return inline, from the deterministic start of the JSON-stat cell order. Default 25; ${clampLimits ? 'positive integers above 500 are clamped to 500 with a notice' : 'maximum 500; larger values are rejected'}. This changes only the inline prefix: it does not reduce obsCount, missingObsCount, timeRange, the upstream response, or staged rows. Use filters or period controls to reduce the match itself.`,
        ),
      stage: z
        .boolean()
        .default(false)
        .describe(
          'Stage every matched observation on a dataframe canvas, regardless of preview length or match size. Default false preserves automatic staging only above 5,000 observations. Ignored with an unavailable-staging notice on deployments without a canvas.',
        ),
      lang: z
        .enum(['EN', 'FR', 'DE'])
        .default('EN')
        .describe(
          'Language for labels in the response. Default is "EN". Options: "EN", "FR", "DE".',
        ),
      canvas_id: CanvasIdSchema.optional().describe(
        'Reuse an existing dataframe canvas, so a result staged by this call lands beside earlier ones and can be joined against them. Pass the canvasId a previous eurostat_query_dataset or eurostat_download_dataset response returned; omit to start a fresh canvas. Used only when staging: stage=true or a match above 5,000 observations, on a canvas-enabled deployment.',
      ),
    }),
    output: z.object({
      datasetCode: z.string().describe('Dataset code as provided.'),
      datasetLabel: z.string().describe('Human-readable dataset title.'),
      dimensionsUsed: z
        .array(z.string())
        .describe(
          'Ordered list of dimension codes present in the response (e.g., ["freq", "unit", "na_item", "geo", "time"]).',
        ),
      observations: z
        .array(
          z
            .object({
              // dimensions is a dynamic map (keys = dimension codes from dimensionsUsed).
              // Using passthrough so the full {code, label} pairs flow to structuredContent
              // even though the keys are not known at schema definition time.
              dimensions: z
                .object({})
                .passthrough()
                .describe(
                  'Map of dimension code → {code, label}. One entry per dimension in dimensionsUsed, keyed by dimension code (e.g., {"geo": {"code": "DE", "label": "Germany"}, "time": {"code": "2023", "label": "2023"}}).',
                ),
              value: z
                .number()
                .nullable()
                .describe(
                  'Numeric observation value, or null when Eurostat reports none — unavailable in the source data, withheld (confStatus says so), or published as text (valueText holds it).',
                ),
              valueText: z
                .string()
                .optional()
                .describe(
                  'A value Eurostat published as text rather than a number, verbatim — PRODCOM (DS-*) flag and unit indicators such as QNTUNIT publish a unit like "KG" — with value null. PRODCOM\'s ":C" is decoded to confStatus "C" instead. Omitted for numeric and missing values.',
                ),
              status: z
                .object({
                  code: z.string().describe('OBS_FLAG code (e.g., "p", "e", "d").'),
                  label: z
                    .string()
                    .describe(
                      'Status description (e.g., "provisional", "estimated", "definition differs").',
                    ),
                })
                .optional()
                .describe(
                  'Eurostat OBS_FLAG for this observation. Omitted for unflagged observations, and never carries a confidentiality code — that arrives in confStatus.',
                ),
              confStatus: z
                .object({
                  code: z.string().describe('CONF_STATUS code: "C", "N", or "P".'),
                  label: z
                    .string()
                    .describe(
                      'Confidentiality description (e.g., "confidential", "not for publication").',
                    ),
                })
                .optional()
                .describe(
                  'Eurostat CONF_STATUS for this observation — a different codelist from status. Present when Eurostat restricts the cell, which is usually why value is null. Omitted otherwise.',
                ),
            })
            .describe(
              'A single decoded observation with dimension values, numeric value, and the optional OBS_FLAG and CONF_STATUS markers.',
            ),
        )
        .describe(
          'The first preview_limit decoded observations in deterministic JSON-stat cell order — the leading combinations of the dataset dimensions, neither a sample nor necessarily the most recent periods. This prefix is independent of the 5,000-observation staging threshold. When tableName is set, the table holds every matched row; otherwise use filters or a period range to reduce the match itself.',
        ),
      obsCount: z.number().describe('Total number of observations matched (before any cap).'),
      truncated: z
        .boolean()
        .describe(
          'True only when the match exceeded the 5,000-observation staging threshold. Independent of preview_limit: observations can be a shorter prefix while truncated is false. When tableName is set, call eurostat_dataframe_describe first and then eurostat_dataframe_query; when it is absent, use filters or period controls to reduce the match.',
        ),
      canvasId: z
        .string()
        .optional()
        .describe(
          'Dataframe canvas holding the staged result. Pass to eurostat_dataframe_describe, eurostat_dataframe_query, or a later eurostat_query_dataset call. Omitted when nothing was staged.',
        ),
      tableName: z
        .string()
        .optional()
        .describe(
          'Canvas table holding every matched observation in flat form — one code column per dimension plus a "_label" companion, then obs_value, obs_flag, obs_flag_label, conf_status, conf_status_label. A DS-* table also carries obs_value_text, the valueText of each row. Call eurostat_dataframe_describe with canvasId first to confirm the table and columns, then eurostat_dataframe_query. Omitted when nothing was staged: stage was false with at most 5,000 observations, or this deployment runs without a dataframe canvas.',
        ),
      stagedRowCount: z
        .number()
        .optional()
        .describe(
          'Rows written to the canvas table. Matches obsCount. Omitted alongside tableName when nothing was staged.',
        ),
      timeRange: z
        .object({
          start: z
            .string()
            .optional()
            .describe(
              'Earliest period matched. Omitted when the match carries no time dimension and Eurostat reports no overall period.',
            ),
          end: z
            .string()
            .optional()
            .describe(
              'Most recent period matched. Omitted when the match carries no time dimension and Eurostat reports no overall period.',
            ),
        })
        .describe(
          'Time coverage of everything matched — the same set obsCount counts, so it can reach periods absent from observations when truncated is true. Each bound is omitted when neither the match nor Eurostat report it — an omitted bound is unknown, not empty.',
        ),
      missingObsCount: z
        .number()
        .describe(
          'Number of matched observations carrying no numeric value, counted across everything matched rather than only the returned rows. Covers both unavailable and withheld cells — a slice can be wholly confidential, so this equalling obsCount does not mean the data is absent. A missing observation is a cell Eurostat publishes without a number (with a flag, a confidentiality marker, or text); a period of a frequency the series carries in which it has no cell at all is an absent cell, counted in absentCellCount instead.',
        ),
      absentCellCount: z
        .number()
        .describe(
          "Periods the matched series lack: for each series (one combination of the non-time dimensions) with at least one cell in the match, the periods of a frequency it carries in which Eurostat publishes no cell for it, with no value and no flag. Only periods from that frequency's first to its latest period with a cell in any series count; a period before or after that span, which no series has a cell in, is named in the notice instead. Absent cells are not observations, so obsCount, missingObsCount, observations and staged rows leave them out. A series lacks no period of a frequency it does not carry: an annual series beside a monthly one lacks no months. 0 when every series has a cell in every period of those spans.",
        ),
      unmatchedValues: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          'Filter values that matched nothing in the dataset, keyed by dimension code and spelled as sent (matching ignores case). The observations cover only the values that did match. Omitted when every filter value matched.',
        ),
      emptyValues: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          'Values the query selects that the dataset has but this match carries no cell for, with no value and no flag in the selected periods, so they contribute no rows. Keyed by dimension code: filter values spelled as sent (matching ignores case), and under geo_level every "geo" code of that level with no cell. Never a value unmatchedValues holds, a time value, or a value of a dimension that neither filters nor geo_level selects. Such a value can carry data in other periods or beside other filter values. Omitted when every selected value has a cell.',
        ),
    }),
    enrichment: {
      appliedFilters: z
        .object({
          filters: z
            .record(z.string(), z.array(z.string()))
            .describe(
              'Dimension filters actually sent to Eurostat. Blank values, and dimensions left with no value (empty arrays included), are dropped and do not appear here.',
            ),
          geoLevel: z.string().optional().describe('NUTS geo level filter applied, if any.'),
          sincePeriod: z.string().optional().describe('Start of time range applied, if any.'),
          untilPeriod: z.string().optional().describe('End of time range applied, if any.'),
          lastNPeriods: z.number().optional().describe('Last N periods filter applied, if any.'),
        })
        .describe('Effective query parameters applied to the Eurostat API.'),
      notice: z
        .string()
        .optional()
        .describe(
          "Composed guidance for a period a bound falls inside, which Eurostat excludes, unmatched filter values, values with no cell (emptyValues), selected last_n_periods positions with no populated cells, periods no series has a cell in before or after a frequency's span with cells, absent cells (periods a series lacks inside that span, with how many series lack any), inline previews, staging and unavailable explicit staging. Period gaps list up to the newest 24 periods and values with no cell up to 24, each with an omitted count; staged matches give the describe-then-query sequence. Omitted when none of these disclosures applies.",
        ),
    },

    enrichmentTrailer: {
      appliedFilters: {
        render: (f) => {
          const parts: string[] = [];
          if (Object.keys(f.filters).length > 0) {
            parts.push(`- **Filters:** ${formatValues(f.filters, escapeMarkdownInline)}`);
          }
          if (f.geoLevel) parts.push(`- **Geo level:** ${f.geoLevel}`);
          if (f.sincePeriod || f.untilPeriod) {
            parts.push(`- **Period:** ${f.sincePeriod ?? '…'} – ${f.untilPeriod ?? 'latest'}`);
          }
          if (f.lastNPeriods) parts.push(`- **Last N periods:** ${f.lastNPeriods}`);
          return parts.length > 0
            ? `**Applied Filters:**\n${parts.join('\n')}`
            : '**Applied Filters:** none';
        },
      },
    },

    errors: [
      {
        reason: 'not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'The dataset code does not exist (HTTP 404 carrying Eurostat error id 100).',
        recovery:
          'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.',
      },
      {
        reason: 'no_results',
        code: JsonRpcErrorCode.NotFound,
        when: 'The query matched no observation cells — including Eurostat HTTP-200 error id 100. The dataset is valid, but no cell carries a value or a status flag for that filter combination and period range. When Eurostat returns the empty table, the error names the filter values that matched nothing (data.unmatchedValues) and, when the values of the dataset are read within 5 s, the codes and labels of each such dimension holding at most 25, or the total and a value search for each value sent otherwise (data.validValues), the selected periods that carry no value (data.matchedPeriods, the newest 24, with data.matchedPeriodCount counting all of them), and, for a range that selected no period, whether it misses the coverage, holds no whole period, or holds no published one. When error id 100 answers a query that set geo_level, the error names geo_level as the likely cause, and lists the dataset\'s dimensions when it has no "geo" dimension.',
        recovery:
          'Replace an unmatched value with a code the error lists, or verify dimension values with eurostat_get_dimension_values, and keep the period range inside the dataset coverage, holding a whole period; an unmatched value, an out-of-coverage range and a range inside one period all return no data rather than an error. When the error names geo_level, drop it instead, and filter the "geo" codes the query then returns, or the dimension that holds geography.',
      },
      {
        reason: 'invalid_period',
        code: JsonRpcErrorCode.ValidationError,
        when: 'since_period or until_period is not a period literal, or names a month, quarter, semester, trimester, week or day that does not exist, or since_period starts after until_period ends. Checked before any request; a period Eurostat itself rejects maps here too.',
        recovery: `Write since_period/until_period as ${PERIOD_FORMS}, for example "2020", "2020-01" or "2020-Q1", with since_period starting no later than until_period ends.`,
      },
      {
        reason: 'async_response',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: "Eurostat returned an async warning or an HTTP-413 error array — the query matched too many observations, including an EXTRACTION_TOO_BIG refusal past Eurostat's 5,000,000-row limit.",
        retryable: false,
        recovery:
          'Filter on the dataset dimensions this query left unfiltered, or narrow the period range, then retry.',
      },
      {
        reason: 'invalid_dimension',
        code: JsonRpcErrorCode.ValidationError,
        when: `${UNKNOWN_FILTER_KEY_WHEN} (HTTP 400, Eurostat error id 150), or only the one key Eurostat names when the dataset's structure cannot be read. A filter key that names a request control (lang, format, geoLevel, sinceTimePeriod, untilTimePeriod, lastTimePeriod, in any case) rather than a dimension fails here too, rejected before any request and naming the input that sets it.`,
        recovery: `${RENAME_FILTER_KEYS_HINT} When it lists none, eurostat_get_dataset_info lists them. Set a request control through its own input (lang, geo_level, since_period, until_period, last_n_periods), not filters.`,
      },
      {
        reason: 'conflicting_params',
        code: JsonRpcErrorCode.ValidationError,
        when: 'Mutually exclusive parameters were combined: "geo" filter + geo_level, since_period/until_period + last_n_periods, or a "time"/"time_period" filter + since_period, until_period or last_n_periods. Checked before any request; Eurostat\'s own refusal of two time selections maps here too.',
        recovery:
          'Keep one of each pair: filters.geo or geo_level; since_period/until_period or last_n_periods; filters.time or a period input.',
      },
      {
        reason: 'canvas_not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'A canvas_id was supplied for staging but is unknown or its lifetime has elapsed.',
        recovery: 'Omit canvas_id so the response starts a fresh canvas and returns its canvasId.',
      },
      {
        reason: 'upstream_fault',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'The Statistics API answered HTTP 5xx or could not be reached on every attempt of the retry loop. The error is marked retryable, except for HTTP 501, which is marked not retryable.',
        recovery:
          "The failure is on Eurostat's side, not in the request: when the error is marked retryable, call again in a few minutes.",
      },
      {
        reason: 'retry_deadline_exceeded',
        code: JsonRpcErrorCode.Timeout,
        when: "The Statistics API did not complete the query within the server's request deadline (30 s by default), every attempt and backoff included: Eurostat can take longer than that to prepare an uncached extraction, or to send a large answer.",
        recovery:
          'Repeat the call in a minute or two when Eurostat had not started answering, read the same slice with eurostat_download_dataset on a deployment with a dataframe canvas, or filter the dimensions the query left open.',
      },
    ],

    async handler(request, ctx) {
      const preview = clampReadLimit(
        request.preview_limit,
        PREVIEW_MAX,
        'preview_limit',
        'eurostat_query_dataset',
        ctx,
      );
      const input = { ...request, preview_limit: preview.value };
      const svc = getEurostatDataService();

      // Trimmed, checked, and rewritten to canonical form: this is both what is sent and
      // what appliedFilters echoes. The period notice quotes the literals as written.
      const written = {
        since_period: input.since_period?.trim() || undefined,
        until_period: input.until_period?.trim() || undefined,
      };
      const periods = resolvePeriods(written);
      if (!periods.ok) {
        throw ctx.fail('invalid_period', periods.message);
      }
      const { since_period: sinceP, until_period: untilP } = periods;

      let result: Awaited<ReturnType<typeof svc.queryDataset>>;
      try {
        result = await svc.queryDataset(
          input.dataset_code,
          input.filters,
          input.geo_level,
          sinceP,
          untilP,
          input.last_n_periods,
          input.lang,
          input.preview_limit,
          ctx,
        );
      } catch (err) {
        const data = (err as McpError).data as
          | (NoResultsDiagnosis &
              Partial<Omit<StatisticsDeadlineData, 'reason'>> & {
                reason?: string;
                recovery?: { hint?: string };
              })
          | undefined;
        const reason = data?.reason;
        // A rule the service checked before the request names its own remedy; Eurostat's
        // refusals carry none and take the generic one below.
        const serviceHint = data?.recovery?.hint;
        if (data && reason === 'no_results') {
          // The one extra read this path makes: an empty reply with an envelope names the
          // unmatched values, and a bare one (geo_level's read below) names none.
          const metadata =
            data.unmatchedValues && (await dimensionValuesForHint(input.dataset_code, ctx));
          const valueAdvice =
            data.unmatchedValues && metadata
              ? unmatchedValuesAdvice(input.dataset_code, data.unmatchedValues, metadata)
              : undefined;
          const explained =
            explainNoResults(
              input.dataset_code,
              data,
              { lastN: input.last_n_periods, ranged: Boolean(sinceP || untilP) },
              valueAdvice,
            ) ??
            (input.geo_level
              ? await explainGeoLevel(input.dataset_code, input.geo_level, ctx)
              : undefined);
          throw ctx.fail(
            'no_results',
            explained?.message ?? (err as Error).message,
            {
              ...(data.unmatchedValues && { unmatchedValues: data.unmatchedValues }),
              ...(valueAdvice &&
                Object.keys(valueAdvice.validValues).length > 0 && {
                  validValues: valueAdvice.validValues,
                }),
              ...(data.matchedPeriods && {
                matchedPeriods: data.matchedPeriods.slice(-MATCHED_PERIODS_LISTED),
                matchedPeriodCount: data.matchedPeriods.length,
              }),
              recovery: {
                hint:
                  explained?.hint ??
                  `No observation cells matched. Verify dimension values for "${input.dataset_code}" using eurostat_get_dimension_values, and check the period range is inside the dataset's coverage — an unmatched value and an out-of-coverage range both return no data rather than an error.`,
              },
            },
            { literals: valueAdvice?.literals ?? [] },
          );
        }
        if (reason === 'invalid_period') {
          throw ctx.fail('invalid_period', (err as Error).message);
        }
        if (reason === 'async_response') {
          const dimensions = await dimensionsToNarrow(input.dataset_code, [], ctx);
          const filtered = [
            ...Object.keys(normalizeFilters(input.filters)),
            ...(input.geo_level ? ['geo'] : []),
          ];
          throw ctx.fail('async_response', (err as Error).message, {
            recovery: {
              hint: `Query matched too many observations for "${input.dataset_code}". ${narrowingAdvice(input.dataset_code, dimensions, filtered)}`,
            },
          });
        }
        if (reason === 'not_found') {
          throw ctx.fail('not_found', (err as Error).message, {
            recovery: {
              hint: `Dataset "${input.dataset_code}" not found. Use eurostat_search_datasets or eurostat_browse_themes to find a valid code.`,
            },
          });
        }
        if (reason === 'invalid_dimension') {
          // Eurostat's id 150 names one undefined key per reply, so the structure names them all.
          const order = serviceHint
            ? undefined
            : await dimensionsToNarrow(input.dataset_code, [], ctx);
          const unknown = order
            ? unknownFilterKeys(
                order,
                Object.keys(normalizeFilters(input.filters)).filter(
                  (key) => !TIME_DIMENSION_KEYS.has(key.toLowerCase()),
                ),
              )
            : [];
          if (order && unknown.length > 0) {
            throw ctx.fail(
              'invalid_dimension',
              unknownDimensionsMessage(unknown, order),
              {
                unknownDimensions: unknown,
                dimensionOrder: order,
                recovery: { hint: RENAME_FILTER_KEYS_HINT },
              },
              { cause: err, literals: order },
            );
          }
          throw ctx.fail('invalid_dimension', (err as Error).message, {
            recovery: {
              hint:
                serviceHint ??
                `Use eurostat_get_dataset_info to see valid dimension codes for "${input.dataset_code}".`,
            },
          });
        }
        if (reason === 'conflicting_params') {
          throw ctx.fail('conflicting_params', (err as Error).message, {
            recovery: {
              hint:
                serviceHint ??
                'Use filters.geo or geo_level, not both. For time, use since_period/until_period or last_n_periods, not both.',
            },
          });
        }
        if (reason === 'upstream_fault' && (err as McpError).data?.retryable === true) {
          throw ctx.fail('upstream_fault', (err as Error).message, {
            retryable: true,
            recovery: {
              hint: `Eurostat's Statistics API ${outageAnswer((err as McpError).data?.status)} for "${input.dataset_code}" on every attempt — an upstream outage, not a fault in the request. Retry in a few minutes.`,
            },
          });
        }
        if (data && reason === 'retry_deadline_exceeded') {
          const { deadlineMs, elapsedMs, retryAttempts, headersReceived } = data;
          const dimensions = await dimensionsToNarrow(input.dataset_code, [], ctx);
          const advice = deadlineAdvice(input, { sinceP, untilP }, dimensions, {
            headersReceived,
            canvas: getCanvas() !== undefined,
          });
          throw ctx.fail(
            'retry_deadline_exceeded',
            (err as Error).message,
            { deadlineMs, elapsedMs, retryAttempts, recovery: { hint: advice.hint } },
            { cause: err, literals: advice.literals },
          );
        }
        throw err;
      }

      // The service bounds `observations` to the requested preview, so its length says nothing
      // about match size. `obsCount` is the full total and is what truncation turns on.
      const {
        absentSeries,
        appliedFilters,
        latestWithCell,
        outsideSpans,
        periodCuts,
        rows,
        unpopulatedPeriods,
        ...queryResult
      } = result;
      const truncated = result.obsCount > OBS_CAP;

      /**
       * Stage the whole match on explicit request or above the independent
       * 5,000-row threshold. Preview length never triggers staging by itself.
       *
       * `rows()` is a generator over the response body already in memory, so this
       * costs no extra upstream request and never builds the full row set as an
       * array — the canvas appender pulls one row at a time.
       */
      const availableCanvas = getCanvas();
      const canvas = truncated || input.stage ? availableCanvas : undefined;
      let staged: { canvasId: string; tableName: string; stagedRowCount: number } | undefined;
      if (canvas) {
        // Re-thrown so the declared recovery replaces the canvas service's generic one.
        const instance = await acquireCanvas(canvas, input.canvas_id, ctx).catch((err: unknown) => {
          if (isCanvasFailure(err, 'canvas_not_found')) {
            throw ctx.fail(
              'canvas_not_found',
              err.message,
              { canvasId: input.canvas_id },
              { cause: err },
            );
          }
          throw err;
        });
        const handle = await instance.registerTable(newTableName(), rows(), {
          schema: observationRowSchema(result.dimensionsUsed, isComextDataset(input.dataset_code)),
          signal: ctx.signal,
        });
        staged = {
          canvasId: instance.canvasId,
          tableName: handle.tableName,
          stagedRowCount: handle.rowCount,
        };
      }

      ctx.log.info('Dataset query complete', {
        datasetCode: input.dataset_code,
        obsCount: result.obsCount,
        truncated,
        missingObsCount: result.missingObsCount,
        absentCellCount: result.absentCellCount,
        ...(staged && { canvasId: staged.canvasId, tableName: staged.tableName }),
      });

      // Sourced from the service's applied set, not raw input: blank values and zero-length
      // filter arrays are dropped from the upstream request, so echoing them back would claim
      // a restriction that was never sent.
      ctx.enrich({
        appliedFilters: {
          filters: appliedFilters,
          ...(input.geo_level && { geoLevel: input.geo_level }),
          ...(sinceP && { sincePeriod: sinceP }),
          ...(untilP && { untilPeriod: untilP }),
          ...(input.last_n_periods && { lastNPeriods: input.last_n_periods }),
        },
      });
      // `notice` is last-wins, so every sentence is collected here and written once.
      const notices: string[] = preview.notice ? [preview.notice] : [];
      if (periodCuts) notices.push(cutNotice(periodCuts, written));
      if (input.last_n_periods && unpopulatedPeriods?.length) {
        const listed = unpopulatedPeriods.slice(-MATCHED_PERIODS_LISTED);
        const omitted = unpopulatedPeriods.length - listed.length;
        notices.push(
          `${countOf(unpopulatedPeriods.length, 'selected period')} (${listed.join(', ')}${omitted ? `; ${countOf(omitted, 'earlier period')} omitted` : ''}) ${unpopulatedPeriods.length === 1 ? 'carries' : 'carry'} no populated cells anywhere in this match. last_n_periods counts dataset time positions, not periods with populated cells for this slice; preview_limit does not select periods.${lastNAdvice(input.last_n_periods, unpopulatedPeriods, outsideSpans, latestWithCell)}`,
        );
      }
      if (outsideSpans) notices.push(outsideSpanNotice(outsideSpans));
      if (absentSeries) {
        notices.push(
          `${countOf(result.absentCellCount, 'absent cell')} in ${absentSeries.affected.toLocaleString('en-US')} of ${absentSeries.total.toLocaleString('en-US')} series: periods a series lacks at a frequency it carries (no value, no flag). They are not observations: obsCount, missingObsCount, the rows and any staged table leave them out, so a per-period total across series covers only the series present.`,
        );
      }
      if (input.stage && !availableCanvas) {
        notices.push(
          'Dataframe staging is unavailable on this deployment, so stage=true did not stage any rows. Use dimension filters or period controls to reduce the match.',
        );
      }
      if (result.unmatchedValues) {
        notices.push(
          `These filter values matched nothing and contribute no rows: ${formatValues(result.unmatchedValues, escapeMarkdownInline)}. Check the valid codes for ${joinAnd(Object.keys(result.unmatchedValues).map((dim) => escapeMarkdownInline(dim)))} with eurostat_get_dimension_values.`,
        );
      }
      if (result.emptyValues) notices.push(emptyValuesNotice(result.emptyValues));
      if (result.obsCount > result.observations.length) {
        // This dataset's own dimensions: a DS-* flow has no geo, unit, or na_item to name.
        const filterOn = `dimension filters (${result.dimensionsUsed.filter((dim) => dim !== 'time').join(', ')})`;
        notices.push(
          staged
            ? `preview_limit=${input.preview_limit.toLocaleString('en-US')} returns the first ${result.observations.length.toLocaleString('en-US')} of ${result.obsCount.toLocaleString('en-US')} matched rows inline; it does not reduce the match. All ${staged.stagedRowCount.toLocaleString('en-US')} matched rows are staged as table \`${staged.tableName}\` on canvas \`${staged.canvasId}\`. Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query. Use ${filterOn} or a period range when the match itself should be smaller.`
            : `preview_limit=${input.preview_limit.toLocaleString('en-US')} returns the first ${result.observations.length.toLocaleString('en-US')} of ${result.obsCount.toLocaleString('en-US')} matched rows inline; it does not reduce the match. ${availableCanvas ? 'Set stage=true to retain every matched row on a dataframe canvas. ' : ''}Use ${filterOn} or a period range to reduce the match itself.`,
        );
      }
      if (staged && result.obsCount <= result.observations.length) {
        notices.push(
          `All ${staged.stagedRowCount.toLocaleString('en-US')} matched rows are staged as table \`${staged.tableName}\` on canvas \`${staged.canvasId}\`. Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query.`,
        );
      }
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

      return { ...queryResult, truncated, ...staged };
    },

    format: (result) => {
      // An absent period bound is named as unreported rather than rendered as a blank, so
      // content[] carries the same uncertainty structuredContent does.
      const UNREPORTED = 'not reported by Eurostat';
      const { start, end } = result.timeRange;
      const period = start || end ? `${start ?? UNREPORTED} – ${end ?? UNREPORTED}` : UNREPORTED;
      const truncationNote = !result.truncated
        ? ''
        : result.tableName
          ? ' — the match crossed the 5,000-row staging threshold; the whole match is staged on the canvas below'
          : ' — the match crossed the 5,000-row staging threshold. Add dimension filters or a period range to reduce the match.';
      const lines: string[] = [
        `# ${result.datasetLabel} (\`${result.datasetCode}\`)`,
        `**Observations:** ${result.obsCount} (${result.missingObsCount} missing) | **Period:** ${period} | **Absent cells:** ${result.absentCellCount}`,
        `**Truncated:** ${result.truncated}${truncationNote}`,
        `**Dimensions:** ${result.dimensionsUsed.join(', ')}`,
      ];
      if (result.unmatchedValues) {
        lines.push(
          `**Unmatched filter values:** ${formatValues(result.unmatchedValues, escapeMarkdownInline)} — these matched nothing, so the rows cover only the other values; check them with eurostat_get_dimension_values`,
        );
      }
      if (result.emptyValues) {
        lines.push(
          `**Values with no cell:** ${formatValues(result.emptyValues, escapeMarkdownInline)} — in the dataset but with no value or flag in this match, so the rows cover only the other values`,
        );
      }
      if (result.obsCount > result.observations.length) {
        lines.push(
          `**Inline preview:** first ${result.observations.length} of ${result.obsCount} matched rows — preview_limit changes only this prefix; filters and period controls reduce the match itself`,
        );
      }
      if (result.tableName) {
        lines.push(
          `**Staged:** table \`${result.tableName}\` on canvas \`${result.canvasId}\` (stagedRowCount ${result.stagedRowCount}) — inspect it with eurostat_dataframe_describe first, then query it with eurostat_dataframe_query`,
        );
      }
      const cell = (obs: (typeof result.observations)[number], dim: string) => {
        // dimensions is typed as {} from passthrough() — cast to the runtime shape for rendering
        const value = (
          obs.dimensions as Record<string, { code: string; label: string } | undefined>
        )[dim];
        return value && `${dim}=${value.code} (${value.label})`;
      };
      const { header, hoisted } = hoistDimensions(result.observations, result.dimensionsUsed, cell);
      if (header) lines.push(header);
      lines.push('');

      // Render every observation so content[] carries the same rows as structuredContent —
      // both surfaces are already bounded by the row cap the decoder applies.
      const varying = result.dimensionsUsed.filter((dim) => !hoisted.has(dim));
      for (const obs of result.observations) {
        const dimParts = varying.map((dim) => cell(obs, dim) ?? `${dim}=? (?)`);
        const val = obs.value != null ? String(obs.value) : 'N/A';
        const textPart = obs.valueText ? ` [valueText "${obs.valueText}"]` : '';
        const statusPart = obs.status ? ` [${obs.status.code}: ${obs.status.label}]` : '';
        const confPart = obs.confStatus
          ? ` [CONF_STATUS ${obs.confStatus.code}: ${obs.confStatus.label}]`
          : '';
        lines.push(`${dimParts.join(' | ')} → ${val}${textPart}${statusPart}${confPart}`);
      }

      return [{ type: 'text', text: lines.join('\n') }];
    },
  });

/** Default-on read-limit policy; startup selects the deployment policy explicitly. */
export const eurostatQueryDataset = createEurostatQueryDataset(true);

/** The values a query selects with no cell in the match. */
function emptyValuesNotice(values: Record<string, string[]>): string {
  const { list, total } = listEmptyValues(values);
  const one = total === 1;
  return `${countOf(total, 'value')} the query selects ${one ? 'exists' : 'exist'} in the dataset but ${one ? 'has' : 'have'} no cell in this match, so ${one ? 'it contributes' : 'they contribute'} no rows: ${list}. A value can still carry data in other periods or beside other filter values.`;
}

/**
 * Name each frequency's periods that no series has a cell in, outside the span from its first
 * to its latest period with one: those `absentCellCount` leaves out.
 */
function outsideSpanNotice(spans: OutsideSpan[]): string {
  const carry = (periods: string[]) =>
    `${spanOf(periods)} ${periods.length === 1 ? 'carries' : 'carry'} no cell in any series`;
  const clauses = spans.flatMap((span) => {
    if (span.kind === 'empty') {
      return [
        `${carry(span.periods)}, the only ${span.periods.length === 1 ? 'period' : 'periods'} of its frequency in this match`,
      ];
    }
    return [
      ...(span.before.length > 0
        ? [`${carry(span.before)}, before the first period with one (${span.first})`]
        : []),
      ...(span.after.length > 0
        ? [`${carry(span.after)}, after the latest period with one (${span.last})`]
        : []),
    ];
  });
  return `${clauses.join('; ')}. absentCellCount leaves such periods out: it counts only periods from a frequency's first to its latest period with a cell.`;
}

/**
 * The closing advice of the last-N notice. A larger N reaches only earlier periods, so it is
 * advised only when every empty selected period follows its frequency's span (or belongs to a
 * frequency with no cell in the window); when the slice starts inside the window, the notice
 * says so instead, and an empty period inside a span gets no advice. With one frequency the
 * empty tail is exactly `trailing` positions, so N + trailing ends the window at `latest`.
 * The alternative is a range: `until_period` excludes `last_n_periods`, so alone it would
 * select every period up to `latest`.
 */
function lastNAdvice(
  lastN: number,
  unpopulated: string[],
  outside: OutsideSpan[] | undefined,
  latest: string | undefined,
): string {
  if (outside?.some((span) => span.kind === 'edges' && span.before.length > 0)) {
    return ' This slice starts later than the selection, so a larger last_n_periods only reaches earlier periods.';
  }
  const trailing = (outside ?? []).reduce(
    (n, span) => n + (span.kind === 'empty' ? span.periods.length : span.after.length),
    0,
  );
  if (!latest || trailing !== unpopulated.length) return '';
  const raise =
    outside?.length === 1 && outside[0]?.kind === 'edges'
      ? `Set last_n_periods to ${lastN + trailing} for the ${lastN} periods ending at ${latest}`
      : 'Increase last_n_periods';
  return ` ${raise}, or set a since_period/until_period range ending at ${latest}, the latest period with a cell in this match; until_period alone selects every period up to it.`;
}

function joinAnd(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Turn the diagnosis an empty JSON-stat match carries into a message and a
 * recovery hint, or `undefined` when the reply offered none (the HTTP-200
 * `NO_RESULTS` answer carries no envelope to read).
 *
 * Each signal contributes a sentence to both. Valueless periods are explained
 * by how the caller chose them: `last_n_periods` counts back from the dataset's
 * latest period rather than the slice's, an explicit range can fall outside a
 * slice's narrower coverage, and with neither the combination itself is empty.
 * `valueAdvice`, when the dataset's values were read, replaces the generic pointer for
 * every unmatched dimension but those it left `unresolved`.
 */
function explainNoResults(
  datasetCode: string,
  diagnosis: NoResultsDiagnosis,
  periods: { lastN: number | undefined; ranged: boolean },
  valueAdvice: { sentences: string[]; unresolved: string[] } | undefined,
): { hint: string; message: string } | undefined {
  const { unmatchedValues, matchedPeriods, emptyRange } = diagnosis;
  if (!unmatchedValues && !matchedPeriods && !emptyRange) return;

  const found: string[] = [];
  const next: string[] = [];
  if (unmatchedValues) {
    found.push(
      `These filter values match nothing in "${datasetCode}": ${formatValues(unmatchedValues)}.`,
    );
    const unchecked = valueAdvice?.unresolved ?? Object.keys(unmatchedValues);
    next.push(...(valueAdvice?.sentences ?? []));
    if (unchecked.length > 0) {
      next.push(
        `Check the valid codes for ${joinAnd(unchecked)} with eurostat_get_dimension_values.`,
      );
    }
  }
  if (emptyRange) {
    const { oldest, latest } = emptyRange.coverage;
    const reported = oldest || latest;
    const span = `${oldest ?? 'an unreported start'} – ${latest ?? 'an unreported end'}`;
    const overlap = reported ? `overlaps ${span} but ` : '';
    switch (emptyRange.kind) {
      case 'outside_coverage':
        found.push(
          `The requested period range selects no period of "${datasetCode}", whose data runs ${span}.`,
        );
        next.push(
          reported
            ? `Set since_period/until_period inside ${span}.`
            : "Set since_period/until_period inside the dataset's coverage, which eurostat_get_dataset_info reports.",
        );
        break;
      case 'no_whole_period':
        found.push(
          `The requested period range ${overlap}holds no whole ${emptyRange.cuts[0]?.frequency} period of "${datasetCode}": Eurostat keeps only periods wholly inside the range.`,
        );
        next.push(`Set ${emptyRange.cuts.map(cutSelector).join(' or ')} to select a whole period.`);
        break;
      case 'no_published_period':
        found.push(
          `The requested period range ${overlap}holds no published period of "${datasetCode}".`,
        );
        next.push(
          `List the periods "${datasetCode}" publishes with eurostat_get_dimension_values, dimension "time", then set since_period/until_period on one of them.`,
        );
        break;
      default:
        return emptyRange satisfies never;
    }
  }
  if (matchedPeriods) {
    const selected = spanOf(matchedPeriods);
    if (periods.lastN !== undefined) {
      const empty =
        periods.lastN === 1
          ? `The last period (${selected}) carries no value`
          : `None of the last ${periods.lastN} periods (${selected}) carries a value`;
      found.push(
        `${empty} for this slice: last_n_periods counts back from the dataset's latest period, not from the latest period published for this slice.`,
      );
      next.push(
        'Raise last_n_periods, or replace it with a since_period/until_period range ending at a period this slice has published; until_period alone selects every period up to it.',
      );
    } else if (periods.ranged) {
      found.push(
        `The requested range selects ${countOf(matchedPeriods.length, 'period')} (${selected}), none carrying a value for this slice.`,
      );
      next.push(
        "This slice's coverage is narrower than the dataset's: move or widen since_period/until_period, or drop them to see which periods the slice carries.",
      );
    } else {
      found.push(
        `This filter combination carries no value in the ${countOf(matchedPeriods.length, 'returned period')} (${selected}).`,
      );
      if (!unmatchedValues) {
        next.push(
          'Each filter value exists in the dataset, but not in this combination — try other values; eurostat_get_dimension_values lists each dimension.',
        );
      }
    }
  }
  return { message: `No observations matched. ${found.join(' ')}`, hint: next.join(' ') };
}

/**
 * Name `geo_level` behind a reply {@link explainNoResults} could not read. Eurostat answers
 * with no envelope when the level selects no code, whatever the period range, and with
 * an envelope when it selects some, so the empty reply alone points at the level.
 *
 * The recovery depends on whether the dataset has a `geo` dimension, which only its
 * structure definition says: geography can sit on `cities` or `reporter`, where Eurostat
 * still applies the level. Nothing in hand tells the two apart when that read fails, so
 * the hint then keeps to what holds in both.
 */
async function explainGeoLevel(
  datasetCode: string,
  geoLevel: string,
  ctx: Context,
): Promise<{ hint: string; message: string }> {
  const dimensions = await dimensionsToNarrow(datasetCode, [], ctx);
  const message = `No observations matched. geo_level "${geoLevel}" likely selects no code for this query.`;
  if (!dimensions) return { message, hint: 'Drop geo_level and send the query again.' };
  if (dimensions.includes('geo')) {
    return {
      message,
      hint: 'Drop geo_level. If the other filters and the period range match anything, the same query then returns the "geo" codes this slice carries, and they work in filters.geo.',
    };
  }
  const listed = dimensions.join(', ');
  return {
    message: `${message} "${datasetCode}" has no "geo" dimension; its dimensions are ${listed}.`,
    hint: `Drop geo_level. To select geography, filter whichever of ${listed} holds it, with codes from eurostat_get_dimension_values.`,
  };
}

/**
 * The recovery for a query that outlasted the Statistics API deadline, built from its input,
 * with each route offered only where it works.
 *
 * A repeat helps only a deadline that cut Eurostat off before it answered: it goes on
 * preparing the extraction and caches it, while an answer cut mid-transfer takes as long
 * again. The bulk endpoint serves the same slice, but without a canvas the download keeps
 * only its preview, so the route needs one, and it takes neither `last_n_periods`,
 * `geo_level` nor a time filter: each becomes the period inputs or `filters.geo`, and with no
 * `geo` dimension (or none known) `geo_level` has no download equivalent. Narrowing names the
 * dimensions the query left open, as a too-large refusal does. `literals` holds the values
 * the hint quotes for sending back.
 */
function deadlineAdvice(
  input: {
    dataset_code: string;
    filters: Record<string, string[]>;
    geo_level?: GeoLevel | undefined;
    last_n_periods?: number | undefined;
  },
  periods: { sinceP: string | undefined; untilP: string | undefined },
  dimensions: string[] | undefined,
  state: { canvas: boolean; headersReceived: boolean | undefined },
): { hint: string; literals: string[] } {
  const code = input.dataset_code;
  const applied = normalizeFilters(input.filters);
  const keys = Object.keys(applied);
  const timeKey = keys.find((key) => TIME_DIMENSION_KEYS.has(key.toLowerCase()));
  const literals = [code];
  const sentences: string[] = [];
  if (state.headersReceived === false) {
    sentences.push(
      'Eurostat goes on preparing the extraction after the request is dropped and caches it, so repeat this call in a minute or two.',
    );
  }
  if (state.canvas && (!input.geo_level || dimensions?.includes('geo'))) {
    const quoted = (value: string) => {
      literals.push(value);
      return `"${value}"`;
    };
    const parts = [`dataset_code "${code}"`];
    if (keys.some((key) => key !== timeKey)) parts.push('the same filters');
    if (input.geo_level) {
      parts.push(
        `filters.geo set to the codes eurostat_get_dimension_values lists for dimension "geo" at geo_level "${input.geo_level}"`,
      );
    }
    if (periods.sinceP) parts.push(`since_period ${quoted(periods.sinceP)}`);
    if (periods.untilP) parts.push(`until_period ${quoted(periods.untilP)}`);
    if (input.last_n_periods) {
      parts.push(
        input.last_n_periods === 1
          ? 'since_period set to the latest period eurostat_get_dimension_values lists for dimension "time"'
          : `since_period set to the earliest of the last ${input.last_n_periods} periods eurostat_get_dimension_values lists for dimension "time"`,
      );
    }
    if (timeKey) {
      const span = periodSpan(applied[timeKey] ?? []);
      parts.push(
        span
          ? `since_period ${quoted(span.since)} and until_period ${quoted(span.until)} in place of filters.${timeKey}`
          : `since_period/until_period in place of filters.${timeKey}`,
      );
    }
    sentences.push(
      `The bulk endpoint serves the same slice: call eurostat_download_dataset with ${joinAnd(parts)}.`,
    );
  }
  sentences.push(narrowingAdvice(code, dimensions, [...keys, ...(input.geo_level ? ['geo'] : [])]));
  return { hint: sentences.join(' '), literals };
}

/**
 * The range spanning a time filter's periods, as the bounds to send, or `undefined` when one
 * is not a period literal this server reads.
 */
function periodSpan(values: string[]): { since: string; until: string } | undefined {
  let first: { firstDay: number; period: string } | undefined;
  let last: { lastDay: number; period: string } | undefined;
  for (const value of values) {
    const period = normalizePeriod(value.trim());
    if ('problem' in period) return;
    if (!first || period.firstDay < first.firstDay) first = period;
    if (!last || period.lastDay > last.lastDay) last = period;
  }
  return first && last ? { since: first.period, until: last.period } : undefined;
}
