#!/usr/bin/env node
/**
 * @fileoverview eurostat-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { eurostatDatasetResource } from './mcp-server/resources/definitions/eurostat-dataset.resource.js';
import { eurostatBrowseThemes } from './mcp-server/tools/definitions/eurostat-browse-themes.tool.js';
import { eurostatGetDatasetInfo } from './mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { eurostatGetDimensionValues } from './mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { eurostatQueryDataset } from './mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { eurostatSearchDatasets } from './mcp-server/tools/definitions/eurostat-search-datasets.tool.js';
import { initEurostatCatalogueService } from './services/eurostat-catalogue/eurostat-catalogue-service.js';
import { initEurostatDataService } from './services/eurostat-data/eurostat-data-service.js';

await createApp({
  tools: [
    eurostatSearchDatasets,
    eurostatBrowseThemes,
    eurostatGetDatasetInfo,
    eurostatGetDimensionValues,
    eurostatQueryDataset,
  ],
  resources: [eurostatDatasetResource],
  prompts: [],
  instructions:
    'Eurostat MCP server — EU statistical data across 8,933 datasets.\n' +
    'Workflow: eurostat_search_datasets or eurostat_browse_themes to find a dataset code → ' +
    'eurostat_get_dataset_info to see dimensions → ' +
    'eurostat_get_dimension_values to list valid filter values → ' +
    'eurostat_query_dataset to fetch observations.\n' +
    'Apply dimension filters to avoid async response errors on large datasets.',
  setup(core) {
    initEurostatCatalogueService(core.config, core.storage);
    initEurostatDataService(core.config, core.storage);
  },
});
