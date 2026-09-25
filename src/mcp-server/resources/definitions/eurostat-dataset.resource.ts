/**
 * @fileoverview Resource for fetching Eurostat dataset metadata by URI.
 * @module mcp-server/resources/definitions/eurostat-dataset.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
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

  handler(params, ctx) {
    const svc = getEurostatDataService();
    return svc.getDatasetInfo(params.dataset_code, ctx);
  },
});
