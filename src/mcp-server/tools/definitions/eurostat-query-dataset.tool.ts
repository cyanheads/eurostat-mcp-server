/**
 * @fileoverview Tool for querying statistical data from a Eurostat dataset.
 * @module mcp-server/tools/definitions/eurostat-query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import type { GeoLevel } from '@/services/eurostat-data/types.js';

const GEO_LEVEL_VALUES = ['aggregate', 'country', 'nuts1', 'nuts2', 'nuts3'] as const;

export const eurostatQueryDataset = tool('eurostat_query_dataset', {
  title: 'Query Eurostat Dataset',
  description:
    'Fetch statistical data from a Eurostat dataset with dimension filters. Returns decoded observations with dimension codes and labels, numeric values, and status flags (e.g., "p" = provisional, "e" = estimated). Call eurostat_get_dataset_info first to discover valid dimension codes and values. Apply filters to keep the result set manageable — large unfiltered queries may trigger an async response error. Use filters.geo for specific country/region codes, or geo_level for NUTS hierarchy filtering (mutually exclusive). Use last_n_periods for the N most recent periods without knowing the end date.',
  annotations: { readOnlyHint: true },
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
        'Decoded observations. Each entry has one dimension entry per dimension in dimensionsUsed, plus value and optional status.',
      ),
    obsCount: z.number().describe('Number of observations returned.'),
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
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A dimension code in filters does not exist in this dataset (HTTP 400, Eurostat error id 150).',
      recovery: 'Use eurostat_get_dataset_info to see valid dimension codes for this dataset.',
    },
    {
      reason: 'conflicting_params',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Both "geo" filter and geo_level were provided simultaneously.',
      recovery: 'Use either a "geo" key in filters or the geo_level parameter — not both.',
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatDataService();

    const geoLevel =
      input.geo_level && input.geo_level.trim() ? (input.geo_level as GeoLevel) : undefined;
    const sinceP =
      input.since_period && input.since_period.trim() ? input.since_period.trim() : undefined;
    const untilP =
      input.until_period && input.until_period.trim() ? input.until_period.trim() : undefined;

    const result = await svc.queryDataset(
      input.dataset_code,
      input.filters,
      geoLevel,
      sinceP,
      untilP,
      input.last_n_periods,
      input.lang,
      ctx,
    );

    ctx.log.info('Dataset query complete', {
      datasetCode: input.dataset_code,
      obsCount: result.obsCount,
      missingObsCount: result.missingObsCount,
    });

    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `# ${result.datasetLabel} (\`${result.datasetCode}\`)`,
      `**Observations:** ${result.obsCount} (${result.missingObsCount} missing) | **Period:** ${result.timeRange.start} – ${result.timeRange.end}`,
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
      lines.push(`\n_(${result.observations.length - maxRows} more observations not shown)_`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
