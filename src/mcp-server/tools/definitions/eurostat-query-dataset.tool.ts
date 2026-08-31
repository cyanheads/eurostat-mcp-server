/**
 * @fileoverview Tool for querying statistical data from a Eurostat dataset.
 * @module mcp-server/tools/definitions/eurostat-query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas, getCanvas, newTableName } from '@/services/canvas-accessor.js';
import {
  getEurostatDataService,
  observationRowSchema,
} from '@/services/eurostat-data/eurostat-data-service.js';
import { GEO_LEVEL_VALUES, OBS_CAP } from '@/services/eurostat-data/types.js';

/** Upper bound on the deterministic observation prefix returned inline. */
const PREVIEW_MAX = 500;

export const eurostatQueryDataset = tool('eurostat_query_dataset', {
  title: 'Query Eurostat Dataset',
  description:
    'Fetch statistical data from a Eurostat dataset with dimension filters. Returns a deterministic inline prefix of decoded observations with dimension codes and labels, numeric values, an OBS_FLAG status (e.g., "p" = provisional, "e" = estimated) and a separate CONF_STATUS confidentiality marker (e.g., "C" = confidential, which is usually why a value is null). preview_limit controls only that prefix; filters and period controls reduce the matched result itself. Call eurostat_get_dataset_info first to discover valid dimension codes and values. Apply filters to keep the result set manageable — large unfiltered queries may trigger an async response error. Use filters.geo for specific country/region codes, or geo_level for NUTS hierarchy filtering (mutually exclusive). Use last_n_periods for the N most recent periods without knowing the end date. Matches above 5,000 observations are staged whole when this deployment runs a dataframe canvas: call eurostat_dataframe_describe first, then eurostat_dataframe_query. Matches at or below 5,000 are never staged. When the target is a whole dataset rather than a slice, eurostat_download_dataset reads the SDMX bulk endpoint instead and is the cheaper route.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    dataset_code: z.string().min(1).describe('Dataset code (e.g., "nama_10_gdp"). Required.'),
    filters: z
      .record(z.string(), z.array(z.string()))
      .default({})
      .describe(
        'Dimension filters as a map of dimension code → array of valid values. Example: {"unit": ["CP_MEUR"], "na_item": ["B1GQ"], "geo": ["DE", "FR"]}. An empty array is treated as no filter for that dimension and is dropped from the request. Do not include "geo" here if using geo_level. Invalid dimension values silently return no data — verify with eurostat_get_dimension_values first.',
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
        'Start of time range (e.g., "2020", "2023-Q1", "2024-01"). Mutually exclusive with last_n_periods.',
      ),
    until_period: z
      .string()
      .optional()
      .describe(
        'End of time range (e.g., "2024"). Omit for data through the latest available period. Mutually exclusive with last_n_periods.',
      ),
    last_n_periods: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Return only the N most recent periods. Mutually exclusive with since_period and until_period.',
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
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Reuse an existing dataframe canvas, so a result staged by this call lands beside earlier ones and can be joined against them. Pass a canvasId from a previous response; omit to start a fresh canvas. Ignored on deployments without a dataframe canvas and when the match is at or below 5,000 observations.',
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
                'Numeric observation value, or null when Eurostat reports none — either unavailable in the source data or withheld, in which case confStatus says so.',
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
        'Canvas table holding every matched observation in flat form — one code column per dimension plus a "_label" companion, then obs_value, obs_flag, obs_flag_label, conf_status, conf_status_label. Call eurostat_dataframe_describe with canvasId first to confirm the table and columns, then eurostat_dataframe_query. Omitted when nothing was staged: either the match was at or below 5,000 observations, or this deployment runs without a dataframe canvas.',
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
        'Guidance when preview_limit omits matched rows or the match was staged — distinguishes the inline prefix from filters that reduce the match and, when staged, gives the describe-then-query sequence. Omitted when the preview contains the whole match.',
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
      when: 'The query matched no observation cells — including Eurostat HTTP-200 error id 100. The dataset is valid, but no cell carries a value or a status flag for that filter combination and period range.',
      recovery:
        'Verify dimension values with eurostat_get_dimension_values and keep the period range inside the dataset coverage; both an unmatched value and an out-of-coverage range return no data rather than an error.',
    },
    {
      reason: 'async_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Eurostat returned an async warning or HTTP-413 error array — the query matched too many observations.',
      retryable: false,
      recovery: 'Add dimension filters (geo, unit, na_item) to reduce the result size, then retry.',
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
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatDataService();

    const sinceP = input.since_period?.trim() || undefined;
    const untilP = input.until_period?.trim() || undefined;

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
      const reason = (err as McpError).data?.reason;
      if (reason === 'no_results') {
        throw ctx.fail('no_results', (err as Error).message, {
          recovery: {
            hint: `No observation cells matched. Verify dimension values for "${input.dataset_code}" using eurostat_get_dimension_values, and check the period range is inside the dataset's coverage — an unmatched value and an out-of-coverage range both return no data rather than an error.`,
          },
        });
      }
      if (reason === 'async_response') {
        throw ctx.fail('async_response', (err as Error).message, {
          recovery: {
            hint: `Query matched too many observations. Add dimension filters (e.g., unit, na_item, geo) to reduce the result size for "${input.dataset_code}".`,
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
        schema: observationRowSchema(result.dimensionsUsed),
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
    if (result.obsCount > result.observations.length) {
      ctx.enrich.notice(
        staged
          ? `preview_limit=${input.preview_limit.toLocaleString()} returns the first ${result.observations.length.toLocaleString()} of ${result.obsCount.toLocaleString()} matched rows inline; it does not reduce the match. All ${staged.stagedRowCount.toLocaleString()} matched rows are staged as table "${staged.tableName}" on canvas "${staged.canvasId}". Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query. Use dimension filters (geo, unit, na_item) or a period range when the match itself should be smaller.`
          : `preview_limit=${input.preview_limit.toLocaleString()} returns the first ${result.observations.length.toLocaleString()} of ${result.obsCount.toLocaleString()} matched rows inline; it does not reduce the match. Use dimension filters (geo, unit, na_item) or a period range to reduce the match itself${truncated ? ', or call eurostat_download_dataset when the whole dataset is wanted' : ''}.`,
      );
    }

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
      const statusPart = obs.status ? ` [${obs.status.code}: ${obs.status.label}]` : '';
      const confPart = obs.confStatus
        ? ` [CONF_STATUS ${obs.confStatus.code}: ${obs.confStatus.label}]`
        : '';
      lines.push(`${dimParts.join(' | ')} → ${val}${statusPart}${confPart}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
