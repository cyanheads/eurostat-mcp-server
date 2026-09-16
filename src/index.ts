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
import { eurostatDownloadDataset } from './mcp-server/tools/definitions/eurostat-download-dataset.tool.js';
import { eurostatGetDatasetInfo } from './mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { eurostatGetDimensionValues } from './mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { eurostatQueryDataset } from './mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { eurostatSearchDatasets } from './mcp-server/tools/definitions/eurostat-search-datasets.tool.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initEurostatBulkService } from './services/eurostat-bulk/eurostat-bulk-service.js';
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
  /**
   * No tool gates on `ctx.requestInput`, so nothing here needs a durable
   * session. Declaring it in source keeps the posture with the code rather than
   * the deployment; `MCP_SESSION_MODE` still wins when it is set.
   */
  sessionMode: 'stateless',
  tools: [
    eurostatSearchDatasets,
    eurostatBrowseThemes,
    eurostatGetDatasetInfo,
    eurostatGetDimensionValues,
    eurostatQueryDataset,
    eurostatDownloadDataset,
    canvasEnabled ? eurostatDataframeDescribe : disabledTool(eurostatDataframeDescribe, CANVAS_OFF),
    canvasEnabled ? eurostatDataframeQuery : disabledTool(eurostatDataframeQuery, CANVAS_OFF),
  ],
  resources: [eurostatDatasetResource],
  prompts: [],
  instructions: `Eurostat MCP server — EU statistical data across the Eurostat catalogue.
Workflow: eurostat_search_datasets or eurostat_browse_themes to find a dataset code → eurostat_get_dataset_info to see dimensions → eurostat_get_dimension_values to list valid filter values → eurostat_query_dataset to fetch observations.
Apply dimension filters to keep queries small: an unfiltered query on a large dataset is slow and can return an async response error instead of data.
Two paths past eurostat_query_dataset's 5,000-observation inline cap. For a slice of a dataset, keep using eurostat_query_dataset: when the match is larger than the cap and this deployment runs a dataframe canvas, the whole match is also staged as a SQL table named in the response. For a whole dataset, use eurostat_download_dataset, which reads the SDMX bulk endpoint instead — about half the bytes — and stages every observation the same way, bounded by a byte budget it reports back. Read either staged table with eurostat_dataframe_query (eurostat_dataframe_describe lists the table and column names); the two stage different column sets, since the bulk endpoint carries dimension codes with no labels.
The dataframe tools are not listed when the canvas is off. There, narrowing the filters is what brings a capped match into reach, and eurostat_download_dataset retains only its inline preview.`,
  landing: { requireAuth: false },
  setup(core) {
    initEurostatCatalogueService(core.config, core.storage);
    initEurostatDataService(core.config, core.storage);
    initEurostatBulkService(core.config, core.storage);
    setCanvas(core.canvas);
  },
});
