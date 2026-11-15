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
  PERIOD_FORMS,
  periodSpan,
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
      'Fetch a filtered slice of a Eurostat dataset as decoded observations: dimension codes and labels, numeric value, OBS_FLAG status and CONF_STATUS confidentiality marker. Returns a deterministic inline prefix (preview_limit) beside totals over the whole match; filters and period inputs shrink the match itself. Read dimension codes with eurostat_get_dataset_info and their values with eurostat_get_dimension_values first. Filter large slices: Eurostat refuses an oversized query (extraction_too_big) or prepares a large one in the background (async_response). On a deployment with a dataframe canvas, a match above 5,000 observations, or any match with stage=true, is staged as a SQL table (tableName). For a whole dataset, eurostat_download_dataset is the cheaper route.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    input: z.object({
      dataset_code: z
        .string()
        .min(1)
        .describe(
          'Dataset code (e.g., "nama_10_gdp"). DS-* codes (Comext trade and PRODCOM, in any case) work too; their trade flows mix annual and monthly series, so filter freq.',
        ),
      filters: z
        .record(z.string(), z.array(z.string()))
        .default({})
        .describe(
          'Map of dimension code → values to keep, e.g. {"unit": ["CP_MEUR"], "geo": ["DE", "FR"]}; eurostat_get_dimension_values lists the values. Keys match in any case and must be dimensions: one naming a request control (lang, format, geoLevel, sinceTimePeriod, untilTimePeriod, lastTimePeriod) is rejected as invalid_dimension. An empty array or a blank value is no filter. A value holding "+" is split into separate values (OR); one holding "." matches nothing, since no Eurostat code contains it. Leave out "geo" when geo_level is set, and "time"/"time_period" when a period input is. A value that matches nothing is named in unmatchedValues, and a valid one with no cell in the selected periods in emptyValues; neither is an error.',
        ),
      geo_level: z
        .enum(GEO_LEVEL_VALUES)
        .optional()
        .describe(
          'NUTS level to keep, mutually exclusive with filters.geo: "aggregate" (EU/EA totals), "country" (member and candidate states), "nuts1", "nuts2" or "nuts3". A code of the level with no cell in the match is named in emptyValues.',
        ),
      since_period: z
        .string()
        .optional()
        .describe(
          `Start of the range, inclusive: ${PERIOD_FORMS}, e.g. "2020", "2023-Q1", "2024-01". Any form works on any dataset, but Eurostat keeps only periods wholly inside the range, per frequency: a bound that falls inside a period excludes it, and a notice names that period when the response shows its frequency. A one-day range (both bounds on the same day) selects that day alone. A malformed or non-existent period, or a since_period after until_period, fails as invalid_period.`,
        ),
      until_period: z
        .string()
        .optional()
        .describe(
          'End of the range, inclusive (e.g., "2024"), in the forms and under the wholly-inside rule of since_period. Omit for data through the latest period.',
        ),
      last_n_periods: z
        .number()
        .multipleOf(1)
        .min(1)
        .optional()
        .describe(
          "Select the N most recent time positions of the dataset. N counts back from the dataset's latest period, not this slice's, so a slice that lags can come back short or empty; a notice names each selected period with no cell. Mutually exclusive with since_period and until_period.",
        ),
      preview_limit: (clampLimits
        ? z.number().multipleOf(1).min(1)
        : z.number().int().min(1).max(PREVIEW_MAX)
      )
        .default(25)
        .describe(
          `Observations returned inline, from the start of the dataset's cell order. Default 25; ${clampLimits ? 'positive integers above 500 are clamped to 500 with a notice' : 'maximum 500; larger values are rejected'}. Shortens only the inline prefix: the counts, timeRange and staged rows still cover the whole match.`,
        ),
      stage: z
        .boolean()
        .default(false)
        .describe(
          'Stage the whole match as a SQL table whatever its size; by default only a match above 5,000 observations is staged. Without a dataframe canvas, a notice says nothing was staged.',
        ),
      lang: z.enum(['EN', 'FR', 'DE']).default('EN').describe('Language of the labels.'),
      canvas_id: CanvasIdSchema.optional().describe(
        'A canvasId from an earlier staging response, to stage this result beside its tables for joins; omit for a fresh canvas. Used only when this call stages.',
      ),
    }),
    output: z.object({
      datasetCode: z.string().describe('Dataset code as provided.'),
      datasetLabel: z.string().describe('Human-readable dataset title.'),
      dimensionsUsed: z.array(z.string()).describe('Dimension codes in the response, in order.'),
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
                  'Dimension code → {code, label}, one entry per dimensionsUsed code (e.g., {"geo": {"code": "DE", "label": "Germany"}}).',
                ),
              value: z
                .number()
                .nullable()
                .describe(
                  'Numeric value, or null when unavailable, withheld (confStatus says so) or published as text (valueText).',
                ),
              valueText: z
                .string()
                .optional()
                .describe(
                  'A value published as text, verbatim (a PRODCOM unit such as "KG"), with value null; PRODCOM\'s ":C" becomes confStatus "C" instead. Omitted otherwise.',
                ),
              status: z
                .object({
                  code: z.string().describe('OBS_FLAG code (e.g., "p", "e", "d").'),
                  label: z.string().describe('Flag label (e.g., "provisional", "estimated").'),
                })
                .optional()
                .describe(
                  'OBS_FLAG marker. Omitted when unflagged; confidentiality arrives in confStatus.',
                ),
              confStatus: z
                .object({
                  code: z.string().describe('CONF_STATUS code: "C", "N", or "P".'),
                  label: z.string().describe('Confidentiality label (e.g., "confidential").'),
                })
                .optional()
                .describe(
                  'CONF_STATUS marker, a separate codelist from status: present when Eurostat restricts the cell, usually why value is null.',
                ),
            })
            .describe('One decoded observation.'),
        )
        .describe(
          "The first preview_limit observations in the dataset's cell order: the leading dimension combinations, not a sample and not necessarily the latest periods. tableName, when set, holds every matched row.",
        ),
      obsCount: z.number().describe('Observations matched, over the whole match.'),
      truncated: z
        .boolean()
        .describe(
          'True only when the match exceeds 5,000 observations, the automatic staging threshold. Independent of preview_limit: observations can be a shorter prefix while this is false.',
        ),
      canvasId: z
        .string()
        .optional()
        .describe(
          'Canvas holding the staged table; pass it as canvas_id to the dataframe tools or a later staging call. Omitted when nothing was staged.',
        ),
      tableName: z
        .string()
        .optional()
        .describe(
          'Canvas table holding every matched observation, with flat dimension, label and obs_* columns. Call eurostat_dataframe_describe with canvasId for its columns first, then eurostat_dataframe_query. Omitted when nothing was staged.',
        ),
      stagedRowCount: z
        .number()
        .optional()
        .describe('Rows staged; equals obsCount. Omitted with tableName.'),
      timeRange: z
        .object({
          start: z
            .string()
            .optional()
            .describe(
              'Earliest period matched; omitted when neither the match nor Eurostat reports one.',
            ),
          end: z.string().optional().describe('Latest period matched, omitted the same way.'),
        })
        .describe(
          'Period coverage of the whole match (what obsCount counts), so it can reach past the inline observations. An omitted bound is unknown, not empty.',
        ),
      missingObsCount: z
        .number()
        .describe(
          'Matched observations with no numeric value, over the whole match: cells published without a number, carrying a flag, a confidentiality marker or text. A wholly confidential slice makes this equal obsCount without the data being absent. A period with no cell at all counts in absentCellCount instead.',
        ),
      absentCellCount: z
        .number()
        .describe(
          "Periods the matched series lack: for each series (one combination of the non-time dimensions) with a cell in the match, the periods of a frequency it carries where Eurostat publishes no cell for it. Only periods from that frequency's first to its latest period with a cell in any series count; one before or after that span is named in the notice instead. A series lacks no period of a frequency it does not carry (an annual series lacks no months). Absent cells are not observations: obsCount, missingObsCount, observations and staged rows leave them out.",
        ),
      unmatchedValues: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          'Filter values that matched nothing in the dataset, by dimension, as sent; the observations cover only the rest. Omitted when every value matched.',
        ),
      emptyValues: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          'Selected values the dataset has but this match carries no cell for, by dimension: filter values as sent, and under geo_level each "geo" code of that level with no cell. Never a time value or one in unmatchedValues. Such a value can have data in other periods or beside other filter values. Omitted when every selected value has a cell.',
        ),
    }),
    enrichment: {
      appliedFilters: z
        .object({
          filters: z
            .record(z.string(), z.array(z.string()))
            .describe(
              'Filters sent to Eurostat: "+" values split, blank values and empty dimensions dropped.',
            ),
          geoLevel: z.string().optional().describe('geo_level applied, if any.'),
          sincePeriod: z.string().optional().describe('since_period applied, if any.'),
          untilPeriod: z.string().optional().describe('until_period applied, if any.'),
          lastNPeriods: z.number().optional().describe('last_n_periods applied, if any.'),
        })
        .describe('The query as sent.'),
      notice: z
        .string()
        .optional()
        .describe(
          "Disclosures, when any apply: a period a bound excludes, unmatchedValues, emptyValues (up to 24 named), last_n_periods positions with no cell (the newest 24 named), periods before or after a frequency's span and absent cells (see absentCellCount), the inline preview, and staging, with the eurostat_dataframe_describe then eurostat_dataframe_query sequence.",
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
        when: 'The dataset code does not exist.',
        recovery:
          'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.',
      },
      {
        reason: 'no_results',
        code: JsonRpcErrorCode.NotFound,
        when: "No cell of a valid dataset carries a value or flag for the filters and period range. The error names what it can: the filter values that matched nothing (data.unmatchedValues) with, when the dataset's values can be read, the codes of each such dimension holding at most 25 or a value search (data.validValues); the selected periods with no value (data.matchedPeriods, the newest 24; data.matchedPeriodCount counts all); whether a range misses the coverage, holds no whole period or no published one; and geo_level when it likely selects no code.",
        recovery:
          'Replace an unmatched value with a code the error lists, or verify dimension values with eurostat_get_dimension_values, and keep the period range inside the dataset coverage, holding a whole period; an unmatched value, an out-of-coverage range and a range inside one period all return no data rather than an error. When the error names geo_level, drop it instead, and filter the "geo" codes the query then returns, or the dimension that holds geography.',
      },
      {
        reason: 'invalid_period',
        code: JsonRpcErrorCode.ValidationError,
        when: 'A period bound is not an accepted form or names a period that does not exist, or since_period starts after until_period ends (bounds of different frequencies compare by day). Checked before any request.',
        recovery: `Write since_period/until_period as ${PERIOD_FORMS}, for example "2020", "2020-01" or "2020-Q1", with since_period starting no later than until_period ends.`,
      },
      {
        reason: 'async_response',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'Eurostat is preparing this extraction in the background and serves the identical query minutes later. The server sends the request once and does not repeat it.',
        retryable: true,
        recovery:
          'Repeat the identical call in a few minutes, once Eurostat has prepared the extraction, or filter on the dimensions this query left unfiltered or narrow the period range.',
      },
      {
        reason: 'extraction_too_big',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'Eurostat refused the query as too large to serve (its extraction limit is 5,000,000 rows); the same query is refused again.',
        retryable: false,
        recovery:
          'Filter on the dataset dimensions this query left unfiltered, or narrow the period range, then retry.',
      },
      {
        reason: 'invalid_dimension',
        code: JsonRpcErrorCode.ValidationError,
        when: `${UNKNOWN_FILTER_KEY_WHEN}, or only the key Eurostat names when the structure cannot be read. A request-control key (see filters) fails here before any request, naming the input that sets it.`,
        recovery: `${RENAME_FILTER_KEYS_HINT} When it lists none, eurostat_get_dataset_info lists them. Set a request control through its own input (lang, geo_level, since_period, until_period, last_n_periods), not filters.`,
      },
      {
        reason: 'conflicting_params',
        code: JsonRpcErrorCode.ValidationError,
        when: 'Mutually exclusive inputs were combined: filters.geo with geo_level, since_period/until_period with last_n_periods, or a "time"/"time_period" filter with a period input.',
        recovery:
          'Keep one of each pair: filters.geo or geo_level; since_period/until_period or last_n_periods; filters.time or a period input.',
      },
      {
        reason: 'canvas_not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'canvas_id is unknown or has expired.',
        recovery: 'Omit canvas_id so the response starts a fresh canvas and returns its canvasId.',
      },
      {
        reason: 'upstream_fault',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'The Statistics API failed or could not be reached on every attempt; retryable says whether a later call can succeed.',
        recovery:
          "The failure is on Eurostat's side, not in the request: when the error is marked retryable, call again in a few minutes.",
      },
      {
        reason: 'retry_deadline_exceeded',
        code: JsonRpcErrorCode.Timeout,
        when: "The Statistics API did not finish within the server's request deadline (30 s by default), every attempt included: an uncached extraction or a large answer can take longer.",
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
        if (reason === 'async_response' || reason === 'extraction_too_big') {
          const dimensions = await dimensionsToNarrow(input.dataset_code, [], ctx);
          const filtered = [
            ...Object.keys(normalizeFilters(input.filters)),
            ...(input.geo_level ? ['geo'] : []),
          ];
          const advice = narrowingAdvice(input.dataset_code, dimensions, filtered);
          // A served repeat can still outlast the request deadline, so the hint promises no fit.
          if (reason === 'async_response') {
            throw ctx.fail('async_response', (err as Error).message, {
              recovery: {
                hint: `Eurostat is preparing this extraction of "${input.dataset_code}" and serves the identical query once it is ready: repeat the call in a few minutes, or narrow it. ${advice}`,
              },
            });
          }
          throw ctx.fail('extraction_too_big', (err as Error).message, {
            recovery: {
              hint: `Query matched too many observations for "${input.dataset_code}". ${advice}`,
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
