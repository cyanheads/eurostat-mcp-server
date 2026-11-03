/**
 * @fileoverview Resource for fetching Eurostat dataset metadata by URI.
 * @module mcp-server/resources/definitions/eurostat-dataset.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

export const eurostatDatasetResource = resource('eurostat://dataset/{dataset_code}', {
  name: 'eurostat-dataset-info',
  description:
    'Dataset metadata for a Eurostat dataset — dimensions, time range, observation count, and last-updated date. Equivalent to eurostat_get_dataset_info but accessible as a resource URI for cache-injectable context. A DS-* code (detailed trade and PRODCOM) is read from the Comext dissemination host, which reports no time range or observation count.',
  mimeType: 'application/json',
  params: z.object({
    dataset_code: z
      .string()
      .describe('Dataset code (e.g., "nama_10_gdp", or "DS-045409" for a Comext collection).'),
  }),
  output: z.object({
    code: z.string().describe('Dataset code.'),
    label: z.string().describe('Human-readable dataset title.'),
    dimensions: z
      .array(
        z
          .object({
            code: z.string().describe('Dimension code.'),
            label: z.string().describe('Dimension name.'),
            valuesCount: z
              .number()
              .optional()
              .describe(
                'Number of dataset-available values from the content constraint, including the full period count for "time". Omitted only when Eurostat does not supply a measurable value set.',
              ),
            sampleValues: z
              .array(
                z
                  .object({
                    code: z.string().describe('Value code.'),
                    label: z.string().describe('Value label.'),
                  })
                  .describe('A dimension value code and label pair.'),
              )
              .optional()
              .describe(
                'First 10 dataset-available values for orientation. Omitted alongside valuesCount when Eurostat does not supply a measurable value set.',
              ),
          })
          .describe('A dataset dimension with its valid values.'),
      )
      .describe('Dataset dimensions.'),
    timeRange: z
      .object({
        start: z
          .string()
          .optional()
          .describe('Earliest available period. Omitted when Eurostat does not report it.'),
        end: z
          .string()
          .optional()
          .describe('Most recent available period. Omitted when Eurostat does not report it.'),
      })
      .describe(
        'Overall data coverage period. Each bound is omitted when Eurostat does not report it — an omitted bound is unknown, not empty.',
      ),
    obsCount: z
      .number()
      .optional()
      .describe(
        'Total number of observations. Omitted when Eurostat does not report it — an omitted count is unknown, not zero.',
      ),
    lastUpdated: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp of last data update. Omitted when Eurostat does not report it.',
      ),
    metadataUrl: z.string().optional().describe('Link to ESMS metadata page, when available.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset code does not exist or is not available for dissemination.',
      recovery:
        'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_fault',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Eurostat returned a dataset structure or content constraint this server cannot read — malformed, truncated, not XML, or missing the requested dataset's dataflow; the structure endpoint answered HTTP 501, which is not retried; or it answered another HTTP 5xx or could not be reached on every retry, which the error marks retryable.",
      recovery:
        'Retry in a few minutes, since a failed structure read is not cached. If it fails the same way, eurostat_query_dataset reads the observations, with dimension codes and labels, from a separate endpoint.',
      thrownBy: 'service',
    },
  ],

  handler(params, ctx) {
    const svc = getEurostatDataService();
    return svc.getDatasetInfo(params.dataset_code, ctx);
  },
});
