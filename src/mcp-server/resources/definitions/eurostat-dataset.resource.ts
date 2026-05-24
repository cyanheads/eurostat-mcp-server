/**
 * @fileoverview Resource for fetching Eurostat dataset metadata by URI.
 * @module mcp-server/resources/definitions/eurostat-dataset.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

export const eurostatDatasetResource = resource('eurostat://dataset/{dataset_code}', {
  name: 'eurostat-dataset-info',
  description:
    'Dataset metadata for a Eurostat dataset — dimensions, time range, observation count, and last-updated date. Equivalent to eurostat_get_dataset_info but accessible as a resource URI for cache-injectable context.',
  mimeType: 'application/json',
  params: z.object({
    dataset_code: z.string().describe('Dataset code (e.g., "nama_10_gdp").'),
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
            valuesCount: z.number().describe('Number of distinct values.'),
            sampleValues: z
              .array(
                z
                  .object({
                    code: z.string().describe('Value code.'),
                    label: z.string().describe('Value label.'),
                  })
                  .describe('A dimension value code and label pair.'),
              )
              .describe('First 10 values for orientation.'),
          })
          .describe('A dataset dimension with its valid values.'),
      )
      .describe('Dataset dimensions.'),
    timeRange: z
      .object({
        start: z.string().describe('Earliest available period.'),
        end: z.string().describe('Most recent available period.'),
      })
      .describe('Overall data coverage period.'),
    obsCount: z.number().describe('Total number of observations.'),
    lastUpdated: z.string().describe('ISO 8601 timestamp of last data update.'),
    metadataUrl: z.string().optional().describe('Link to ESMS metadata page, when available.'),
  }),

  handler(params, ctx) {
    const svc = getEurostatDataService();
    return svc.getDatasetInfo(params.dataset_code, ctx);
  },
});
