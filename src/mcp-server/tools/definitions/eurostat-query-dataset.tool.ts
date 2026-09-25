/**
 * @fileoverview Tool for querying statistical data from a Eurostat dataset.
 * @module mcp-server/tools/definitions/eurostat-query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { dimensionsToNarrow, narrowingAdvice } from '@/mcp-server/tools/narrowing-advice.js';
import { acquireCanvas, getCanvas, newTableName } from '@/services/canvas-accessor.js';
import {
  getEurostatDataService,
  observationRowSchema,
} from '@/services/eurostat-data/eurostat-data-service.js';
import {
  GEO_LEVEL_VALUES,
  type NoResultsDiagnosis,
  OBS_CAP,
  type UnmatchedValues,
} from '@/services/eurostat-data/types.js';
import { isComextDataset } from '@/services/eurostat-hosts.js';
import { PERIOD_FORMS, resolvePeriods } from '@/services/eurostat-periods.js';

/** Upper bound on the deterministic observation prefix returned inline. */
const PREVIEW_MAX = 500;

/**
 * Newest valueless periods a `no_results` error lists. A daily dataset's time index
 * runs to ~14,000 periods, so the list is bounded; `matchedPeriodCount` carries the
 * full count and the message the full span.
 */
const MATCHED_PERIODS_LISTED = 24;

export const eurostatQueryDataset = tool('eurostat_query_dataset', {
  title: 'Query Eurostat Dataset',
  description:
    'Fetch statistical data from a Eurostat dataset with dimension filters. Returns a deterministic inline prefix of decoded observations with dimension codes and labels, numeric values, an OBS_FLAG status (e.g., "p" = provisional, "e" = estimated) and a separate CONF_STATUS confidentiality marker (e.g., "C" = confidential, which is usually why a value is null). preview_limit controls only that prefix; filters and period controls reduce the matched result itself. Call eurostat_get_dataset_info first to discover valid dimension codes and values. Apply filters to keep the result set manageable — large unfiltered queries may trigger an async response error. Use filters.geo for specific country/region codes, or geo_level for NUTS hierarchy filtering (mutually exclusive). Use last_n_periods for the N most recent periods without knowing the end date. Matches above 5,000 observations are staged whole when this deployment runs a dataframe canvas: call eurostat_dataframe_describe first, then eurostat_dataframe_query. Matches at or below 5,000 are never staged. When the target is a whole dataset rather than a slice, eurostat_download_dataset reads the SDMX bulk endpoint instead and is the cheaper route.',
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
        'Dimension filters as a map of dimension code → array of valid values. Example: {"unit": ["CP_MEUR"], "na_item": ["B1GQ"], "geo": ["DE", "FR"]}. An empty array is treated as no filter for that dimension and is dropped from the request. Dimension codes match in any case ("GEO" is geo). Do not include "geo" here if using geo_level. A value that matches nothing contributes no rows rather than an error; the response names it in unmatchedValues, or in the no_results error when nothing matched at all. eurostat_get_dimension_values lists the valid values.',
      ),
    geo_level: z
      .enum(GEO_LEVEL_VALUES)
      .optional()
      .describe(
        'Filter by NUTS hierarchy level. Mutually exclusive with a "geo" key in filters. Options: "aggregate" (EU/EA totals), "country" (41 member/candidate states), "nuts1" (127 major regions), "nuts2" (309 basic regions), "nuts3" (1,343 small regions).',
      ),
    since_period: z
      .string()
      .optional()
      .describe(
        `Start of the time range, inclusive. Accepted forms: ${PERIOD_FORMS} (e.g., "2020", "2023-Q1", "2024-01"). Extra leading zeros after the letter are dropped ("2020-Q01" is sent as "2020-Q1"), a day of the year is sent as three digits ("2026-D1" as "2026-D001"), and YYYY-A1 is sent as YYYY. A period of another frequency is mapped onto the dataset's own, so "2020-01" works on annual data. A malformed or non-existent period (e.g., "2020-13") is rejected as invalid_period. Mutually exclusive with last_n_periods.`,
      ),
    until_period: z
      .string()
      .optional()
      .describe(
        'End of the time range, inclusive (e.g., "2024"), in the same forms as since_period. Omit for data through the latest available period. The range must hold at least one day: a since_period that starts after until_period ends is rejected as invalid_period, while pairs of different frequencies are fine ("2020-06" to "2020"). Mutually exclusive with last_n_periods.',
      ),
    last_n_periods: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Return only the N most recent periods. N counts back from the dataset's latest period, not from the latest period published for this slice, so a slice that lags the rest of the dataset can come back empty — raise N, or use until_period ending at a period the slice has published. Mutually exclusive with since_period and until_period.",
      ),
    preview_limit: z
      .number()
      .int()
      .min(1)
      .max(PREVIEW_MAX)
      .default(50)
      .describe(
        'How many matched observations to return inline, from the deterministic start of the JSON-stat cell order. Default 50; maximum 500. This changes only the inline prefix: it does not reduce obsCount, missingObsCount, timeRange, the upstream response, or the rows staged when the match exceeds 5,000. Use filters or period controls to reduce the match itself.',
      ),
    lang: z
      .enum(['EN', 'FR', 'DE'])
      .default('EN')
      .describe('Language for labels in the response. Default is "EN". Options: "EN", "FR", "DE".'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Reuse an existing dataframe canvas, so a result staged by this call lands beside earlier ones and can be joined against them. Pass the canvasId a previous eurostat_query_dataset or eurostat_download_dataset response returned; omit to start a fresh canvas. Ignored on deployments without a dataframe canvas and when the match is at or below 5,000 observations.',
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
        'Canvas table holding every matched observation in flat form — one code column per dimension plus a "_label" companion, then obs_value, obs_flag, obs_flag_label, conf_status, conf_status_label. A DS-* table also carries obs_value_text, the valueText of each row. Call eurostat_dataframe_describe with canvasId first to confirm the table and columns, then eurostat_dataframe_query. Omitted when nothing was staged: either the match was at or below 5,000 observations, or this deployment runs without a dataframe canvas.',
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
        'Number of matched observations carrying no numeric value, counted across everything matched rather than only the returned rows. Covers both unavailable and withheld cells — a slice can be wholly confidential, so this equalling obsCount does not mean the data is absent.',
      ),
    unmatchedValues: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        'Filter values that matched nothing in the dataset, keyed by dimension code and spelled as sent (matching ignores case). The observations cover only the values that did match. Omitted when every filter value matched.',
      ),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        filters: z
          .record(z.string(), z.array(z.string()))
          .describe(
            'Dimension filters actually sent to Eurostat. Empty arrays from the request are dropped and do not appear here.',
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
        'Guidance when a filter value matched nothing, when preview_limit omits matched rows, or when the match was staged — names the unmatched values, distinguishes the inline prefix from filters that reduce the match and, when staged, gives the describe-then-query sequence. Omitted when every filter value matched and the preview contains the whole match.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (f) => {
        const parts: string[] = [];
        const filterKeys = Object.keys(f.filters);
        if (filterKeys.length > 0) {
          parts.push(
            `- **Filters:** ${filterKeys.map((k) => `${k}=[${(f.filters[k] ?? []).join(', ')}]`).join('; ')}`,
          );
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
      when: 'The query matched no observation cells — including Eurostat HTTP-200 error id 100. The dataset is valid, but no cell carries a value or a status flag for that filter combination and period range. When Eurostat returns the empty table, the error names the filter values that matched nothing (data.unmatchedValues) and the selected periods that carry no value (data.matchedPeriods, the newest 24, with data.matchedPeriodCount counting all of them).',
      recovery:
        'Verify dimension values with eurostat_get_dimension_values and keep the period range inside the dataset coverage; both an unmatched value and an out-of-coverage range return no data rather than an error.',
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
      when: 'A dimension code in filters does not exist in this dataset (HTTP 400, Eurostat error id 150).',
      recovery: 'Use eurostat_get_dataset_info to see valid dimension codes for this dataset.',
    },
    {
      reason: 'conflicting_params',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mutually exclusive parameters were combined: "geo" filter + geo_level, or since_period/until_period + last_n_periods.',
      recovery:
        'Use "geo" or geo_level (not both); use since_period/until_period or last_n_periods (not both).',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A canvas_id was supplied for staging but is unknown or its lifetime has elapsed.',
      recovery: 'Omit canvas_id so the response starts a fresh canvas and returns its canvasId.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatDataService();

    // Trimmed, checked, and rewritten to canonical form: this is both what is sent and
    // what appliedFilters echoes.
    const periods = resolvePeriods({
      since_period: input.since_period?.trim() || undefined,
      until_period: input.until_period?.trim() || undefined,
    });
    if (!periods.ok) {
      throw ctx.fail('invalid_period', periods.message, ctx.recoveryFor('invalid_period'));
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
      const data = (err as McpError).data as (NoResultsDiagnosis & { reason?: string }) | undefined;
      const reason = data?.reason;
      if (data && reason === 'no_results') {
        const explained = explainNoResults(input.dataset_code, data, {
          lastN: input.last_n_periods,
          ranged: Boolean(sinceP || untilP),
        });
        throw ctx.fail('no_results', explained?.message ?? (err as Error).message, {
          ...(data.unmatchedValues && { unmatchedValues: data.unmatchedValues }),
          ...(data.matchedPeriods && {
            matchedPeriods: data.matchedPeriods.slice(-MATCHED_PERIODS_LISTED),
            matchedPeriodCount: data.matchedPeriods.length,
          }),
          recovery: {
            hint:
              explained?.hint ??
              `No observation cells matched. Verify dimension values for "${input.dataset_code}" using eurostat_get_dimension_values, and check the period range is inside the dataset's coverage — an unmatched value and an out-of-coverage range both return no data rather than an error.`,
          },
        });
      }
      if (reason === 'invalid_period') {
        throw ctx.fail('invalid_period', (err as Error).message, ctx.recoveryFor('invalid_period'));
      }
      if (reason === 'async_response') {
        const dimensions = await dimensionsToNarrow(input.dataset_code, [], ctx);
        const filtered = [
          ...Object.keys(input.filters).filter((key) => (input.filters[key] ?? []).length > 0),
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
        throw ctx.fail('invalid_dimension', (err as Error).message, {
          recovery: {
            hint: `Use eurostat_get_dataset_info to see valid dimension codes for "${input.dataset_code}".`,
          },
        });
      }
      if (reason === 'conflicting_params') {
        throw ctx.fail('conflicting_params', (err as Error).message, {
          recovery: {
            hint: 'Use filters.geo or geo_level, not both. For time, use since_period/until_period or last_n_periods, not both.',
          },
        });
      }
      throw err;
    }

    // The service bounds `observations` to the requested preview, so its length says nothing
    // about match size. `obsCount` is the full total and is what truncation turns on.
    const { appliedFilters, rows, ...queryResult } = result;
    const truncated = result.obsCount > OBS_CAP;

    /**
     * Stage the whole match only above the independent 5,000-row threshold.
     * A smaller preview does not make an under-threshold match eligible, so it
     * cannot burn a per-tenant canvas slot by itself.
     *
     * `rows()` is a generator over the response body already in memory, so this
     * costs no extra upstream request and never builds the full row set as an
     * array — the canvas appender pulls one row at a time.
     */
    const canvas = truncated ? getCanvas() : undefined;
    let staged: { canvasId: string; tableName: string; stagedRowCount: number } | undefined;
    if (canvas) {
      const instance = await acquireCanvas(canvas, input.canvas_id, ctx);
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
      ...(staged && { canvasId: staged.canvasId, tableName: staged.tableName }),
    });

    // Sourced from the service's applied set, not raw input: a zero-length filter array is
    // dropped from the upstream request, so echoing it back would claim a restriction that
    // was never sent.
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
    const notices: string[] = [];
    if (result.unmatchedValues) {
      notices.push(
        `These filter values matched nothing and contribute no rows: ${formatValues(result.unmatchedValues)}. Check the valid codes for ${joinAnd(Object.keys(result.unmatchedValues))} with eurostat_get_dimension_values.`,
      );
    }
    if (result.obsCount > result.observations.length) {
      // This dataset's own dimensions: a DS-* flow has no geo, unit, or na_item to name.
      const filterOn = `dimension filters (${result.dimensionsUsed.filter((dim) => dim !== 'time').join(', ')})`;
      notices.push(
        staged
          ? `preview_limit=${input.preview_limit.toLocaleString()} returns the first ${result.observations.length.toLocaleString()} of ${result.obsCount.toLocaleString()} matched rows inline; it does not reduce the match. All ${staged.stagedRowCount.toLocaleString()} matched rows are staged as table "${staged.tableName}" on canvas "${staged.canvasId}". Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query. Use ${filterOn} or a period range when the match itself should be smaller.`
          : `preview_limit=${input.preview_limit.toLocaleString()} returns the first ${result.observations.length.toLocaleString()} of ${result.obsCount.toLocaleString()} matched rows inline; it does not reduce the match. Use ${filterOn} or a period range to reduce the match itself${truncated ? ', or call eurostat_download_dataset when the whole dataset is wanted' : ''}.`,
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
        : ' — the match crossed the 5,000-row staging threshold. Add dimension filters, or call eurostat_download_dataset for the whole dataset.';
    const lines: string[] = [
      `# ${result.datasetLabel} (\`${result.datasetCode}\`)`,
      `**Observations:** ${result.obsCount} (${result.missingObsCount} missing) | **Period:** ${period}`,
      `**Truncated:** ${result.truncated}${truncationNote}`,
      `**Dimensions:** ${result.dimensionsUsed.join(', ')}`,
    ];
    if (result.unmatchedValues) {
      lines.push(
        `**Unmatched filter values:** ${formatValues(result.unmatchedValues)} — these matched nothing, so the rows cover only the other values; check them with eurostat_get_dimension_values`,
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
    lines.push('');

    // Render every observation so content[] carries the same rows as structuredContent —
    // both surfaces are already bounded by the row cap the decoder applies.
    for (const obs of result.observations) {
      // dimensions is typed as {} from passthrough() — cast to the runtime shape for rendering
      const dims = obs.dimensions as Record<string, { code: string; label: string } | undefined>;
      const dimParts = result.dimensionsUsed.map(
        (dim) => `${dim}=${dims[dim]?.code ?? '?'} (${dims[dim]?.label ?? '?'})`,
      );
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

/** `geo=[DE, XX]; age=[ZZZ]` — the same rendering the applied-filters trailer uses. */
function formatValues(values: UnmatchedValues): string {
  return Object.entries(values)
    .map(([dim, codes]) => `${dim}=[${codes.join(', ')}]`)
    .join('; ');
}

function joinAnd(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** `2026-08`, or `1975 – 1980` for several periods. */
function spanOf(periods: string[]): string {
  return periods.length === 1 ? (periods[0] ?? '') : `${periods[0]} – ${periods.at(-1)}`;
}

const countOf = (n: number, noun: string): string =>
  `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Turn the diagnosis an empty JSON-stat match carries into a message and a
 * recovery hint, or `undefined` when the reply offered none (the HTTP-200
 * `NO_RESULTS` answer carries no envelope to read).
 *
 * Each signal contributes a sentence to both. Valueless periods are explained
 * by how the caller chose them: `last_n_periods` counts back from the dataset's
 * latest period rather than the slice's, an explicit range can fall outside a
 * slice's narrower coverage, and with neither the combination itself is empty.
 */
function explainNoResults(
  datasetCode: string,
  diagnosis: NoResultsDiagnosis,
  periods: { lastN: number | undefined; ranged: boolean },
): { hint: string; message: string } | undefined {
  const { unmatchedValues, matchedPeriods, outsideCoverage } = diagnosis;
  if (!unmatchedValues && !matchedPeriods && !outsideCoverage) return;

  const found: string[] = [];
  const next: string[] = [];
  if (unmatchedValues) {
    found.push(
      `These filter values match nothing in "${datasetCode}": ${formatValues(unmatchedValues)}.`,
    );
    next.push(
      `Check the valid codes for ${joinAnd(Object.keys(unmatchedValues))} with eurostat_get_dimension_values.`,
    );
  }
  if (outsideCoverage) {
    const { oldest, latest } = outsideCoverage;
    const span = `${oldest ?? 'an unreported start'} – ${latest ?? 'an unreported end'}`;
    found.push(
      `The requested period range selects no period of "${datasetCode}", whose data runs ${span}.`,
    );
    next.push(
      oldest || latest
        ? `Set since_period/until_period inside ${span}.`
        : "Set since_period/until_period inside the dataset's coverage, which eurostat_get_dataset_info reports.",
    );
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
        'Raise last_n_periods, or replace it with an until_period ending at a period this slice has published.',
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
