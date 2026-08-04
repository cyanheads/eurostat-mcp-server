#!/usr/bin/env node
/**
 * @fileoverview eurostat-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { eurostatDatasetResource } from './mcp-server/resources/definitions/eurostat-dataset.resource.js';
import { eurostatBrowseThemes } from './mcp-server/tools/definitions/eurostat-browse-themes.tool.js';
import { eurostatDataframeDescribe } from './mcp-server/tools/definitions/eurostat-dataframe-describe.tool.js';
import { eurostatDataframeQuery } from './mcp-server/tools/definitions/eurostat-dataframe-query.tool.js';
import { eurostatGetDatasetInfo } from './mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { eurostatGetDimensionValues } from './mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { eurostatQueryDataset } from './mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { eurostatSearchDatasets } from './mcp-server/tools/definitions/eurostat-search-datasets.tool.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initEurostatCatalogueService } from './services/eurostat-catalogue/eurostat-catalogue-service.js';
import { initEurostatDataService } from './services/eurostat-data/eurostat-data-service.js';

/**
 * The dataframe tools address tables on a canvas, so without one they have
 * nothing to talk to. `disabledTool` keeps them off `tools/list` — clients
 * cannot call them — while leaving them visible on the landing page and the
 * server card with the variable that turns them on, so an operator can see the
 * capability exists rather than wondering why the README documents a tool the
 * server does not advertise.
 */
const canvasEnabled = config.canvas.providerType !== 'none';
const CANVAS_OFF = {
  reason: 'This deployment runs without a dataframe canvas, so there are no tables to address.',
  hint: 'CANVAS_PROVIDER_TYPE=duckdb',
} as const;

await createApp({
  name: 'eurostat-mcp-server',
  title: 'eurostat-mcp-server',
  tools: [
    eurostatSearchDatasets,
    eurostatBrowseThemes,
    eurostatGetDatasetInfo,
    eurostatGetDimensionValues,
    eurostatQueryDataset,
    canvasEnabled ? eurostatDataframeDescribe : disabledTool(eurostatDataframeDescribe, CANVAS_OFF),
    canvasEnabled ? eurostatDataframeQuery : disabledTool(eurostatDataframeQuery, CANVAS_OFF),
  ],
  resources: [eurostatDatasetResource],
  prompts: [],
  instructions: `Eurostat MCP server — EU statistical data across the Eurostat catalogue.
Workflow: eurostat_search_datasets or eurostat_browse_themes to find a dataset code → eurostat_get_dataset_info to see dimensions → eurostat_get_dimension_values to list valid filter values → eurostat_query_dataset to fetch observations.
Apply dimension filters to keep queries small: an unfiltered query on a large dataset is slow and can return an async response error instead of data.
eurostat_query_dataset returns at most 5,000 observations inline. When the match is larger and this deployment runs a dataframe canvas, the whole match is also staged as a SQL table named in the response — read it with eurostat_dataframe_query (eurostat_dataframe_describe lists the table and column names). The dataframe tools are not listed when the canvas is off; there, narrowing the filters is what brings the rest of a capped match into reach.`,
  landing: { requireAuth: false },
  setup(core) {
    initEurostatCatalogueService(core.config, core.storage);
    initEurostatDataService(core.config, core.storage);
    setCanvas(core.canvas);
  },
});
