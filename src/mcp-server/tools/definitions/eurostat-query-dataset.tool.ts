/**
 * @fileoverview Tool for querying statistical data from a Eurostat dataset.
 * @module mcp-server/tools/definitions/eurostat-query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import { GEO_LEVEL_VALUES } from '@/services/eurostat-data/types.js';

export const eurostatQueryDataset = tool('eurostat_query_dataset', {
  title: 'Query Eurostat Dataset',
  description:
    'Fetch statistical data from a Eurostat dataset with dimension filters. Returns decoded observations with dimension codes and labels, numeric values, and status flags (e.g., "p" = provisional, "e" = estimated). Call eurostat_get_dataset_info first to discover valid dimension codes and values. Apply filters to keep the result set manageable — large unfiltered queries may trigger an async response error. Use filters.geo for specific country/region codes, or geo_level for NUTS hierarchy filtering (mutually exclusive). Use last_n_periods for the N most recent periods without knowing the end date.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    dataset_code: z.string().min(1).describe('Dataset code (e.g., "nama_10_gdp"). Required.'),
    filters: z
      .record(z.string(), z.array(z.string()))
      .default({})
      .describe(
        'Dimension filters as a map of dimension code → array of valid values. Example: {"unit": ["CP_MEUR"], "na_item": ["B1GQ"], "geo": ["DE", "FR"]}. Do not include "geo" here if using geo_level. Invalid dimension values silently return no data — verify with eurostat_get_dimension_values first.',
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
    lang: z
      .enum(['EN', 'FR', 'DE'])
      .default('EN')
      .describe('Language for labels in the response. Default is "EN". Options: "EN", "FR", "DE".'),
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
                'Numeric observation value, or null when missing (flagged as unavailable in the source data).',
              ),
            status: z
              .object({
                code: z.string().describe('Status flag code (e.g., "p", "e", "d").'),
                label: z
                  .string()
                  .describe(
                    'Status description (e.g., "provisional", "estimated", "definition differs").',
                  ),
              })
              .optional()
              .describe('Status flag for this observation. Omitted for normal observations.'),
          })
          .describe(
            'A single decoded observation with dimension values, numeric value, and optional status.',
          ),
      )
      .describe(
        'Decoded observations, capped at 5,000 rows. When truncated is true, apply dimension filters to narrow the result.',
      ),
    obsCount: z.number().describe('Total number of observations matched (before any cap).'),
    truncated: z
      .boolean()
      .describe(
        'True when the result exceeded 5,000 observations and was capped. Apply dimension filters to get the full result.',
      ),
    timeRange: z
      .object({
        start: z.string().describe('Earliest period in this result.'),
        end: z.string().describe('Most recent period in this result.'),
      })
      .describe('Time coverage of the returned observations.'),
    missingObsCount: z
      .number()
      .describe('Number of observations with null value (missing data points in the source).'),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        filters: z
          .record(z.string(), z.array(z.string()))
          .describe('Dimension filters that were applied.'),
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
        'Guidance when the result was truncated at 5,000 rows. Omitted for normal results.',
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
      when: 'The dataset code does not exist (HTTP 404, Eurostat error id 100).',
      recovery:
        'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query returned no observations — valid dataset but the filter combination matched no data.',
      recovery:
        'Verify dimension values with eurostat_get_dimension_values; invalid dimension values silently return no data.',
    },
    {
      reason: 'async_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Eurostat returned an async warning — the query matched too many observations.',
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
  ],

  async handler(input, ctx) {
    const svc = getEurostatDataService();

    const sinceP = input.since_period?.trim() || undefined;
    const untilP = input.until_period?.trim() || undefined;

    const result = await svc.queryDataset(
      input.dataset_code,
      input.filters,
      input.geo_level,
      sinceP,
      untilP,
      input.last_n_periods,
      input.lang,
      ctx,
    );

    const OBS_CAP = 5_000;
    const totalObs = result.observations.length;
    const truncated = totalObs > OBS_CAP;
    const observations = truncated ? result.observations.slice(0, OBS_CAP) : result.observations;

    ctx.log.info('Dataset query complete', {
      datasetCode: input.dataset_code,
      obsCount: totalObs,
      truncated,
      missingObsCount: result.missingObsCount,
    });

    ctx.enrich({
      appliedFilters: {
        filters: input.filters,
        ...(input.geo_level && { geoLevel: input.geo_level }),
        ...(sinceP && { sincePeriod: sinceP }),
        ...(untilP && { untilPeriod: untilP }),
        ...(input.last_n_periods && { lastNPeriods: input.last_n_periods }),
      },
    });
    if (truncated) {
      ctx.enrich.notice(
        `Result capped at ${OBS_CAP.toLocaleString()} rows. Add dimension filters (geo, unit, na_item) to reduce the result set.`,
      );
    }

    return { ...result, observations, obsCount: totalObs, truncated };
  },

  format: (result) => {
    const lines: string[] = [
      `# ${result.datasetLabel} (\`${result.datasetCode}\`)`,
      `**Observations:** ${result.obsCount} (${result.missingObsCount} missing) | **Period:** ${result.timeRange.start} – ${result.timeRange.end}`,
      `**Truncated:** ${result.truncated}${result.truncated ? ' — result capped at 5,000 rows. Add dimension filters to get the full result.' : ''}`,
      `**Dimensions:** ${result.dimensionsUsed.join(', ')}\n`,
    ];

    const maxRows = 200;
    const shown = result.observations.slice(0, maxRows);
    for (const obs of shown) {
      // dimensions is typed as {} from passthrough() — cast to the runtime shape for rendering
      const dims = obs.dimensions as Record<string, { code: string; label: string } | undefined>;
      const dimParts = result.dimensionsUsed.map(
        (dim) => `${dim}=${dims[dim]?.code ?? '?'} (${dims[dim]?.label ?? '?'})`,
      );
      const val = obs.value != null ? String(obs.value) : 'N/A';
      const statusPart = obs.status ? ` [${obs.status.code}: ${obs.status.label}]` : '';
      lines.push(`${dimParts.join(' | ')} → ${val}${statusPart}`);
    }
    if (result.observations.length > maxRows) {
      lines.push(
        `\n_(${result.observations.length - maxRows} more observations not shown in text)_`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
