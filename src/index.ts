#!/usr/bin/env node
/**
 * @fileoverview eurostat-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { config, parseConfig, resetConfig } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from './config/server-config.js';
import { eurostatDatasetResource } from './mcp-server/resources/definitions/eurostat-dataset.resource.js';
import { eurostatBrowseThemes } from './mcp-server/tools/definitions/eurostat-browse-themes.tool.js';
import { eurostatDataframeDescribe } from './mcp-server/tools/definitions/eurostat-dataframe-describe.tool.js';
import { eurostatDataframeDrop } from './mcp-server/tools/definitions/eurostat-dataframe-drop.tool.js';
import { eurostatDataframeQuery } from './mcp-server/tools/definitions/eurostat-dataframe-query.tool.js';
import { createEurostatDownloadDataset } from './mcp-server/tools/definitions/eurostat-download-dataset.tool.js';
import { eurostatGetDatasetInfo } from './mcp-server/tools/definitions/eurostat-get-dataset-info.tool.js';
import { createEurostatGetDimensionValues } from './mcp-server/tools/definitions/eurostat-get-dimension-values.tool.js';
import { createEurostatQueryDataset } from './mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { createEurostatSearchDatasets } from './mcp-server/tools/definitions/eurostat-search-datasets.tool.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initEurostatBulkService } from './services/eurostat-bulk/eurostat-bulk-service.js';
import { initEurostatCatalogueService } from './services/eurostat-catalogue/eurostat-catalogue-service.js';
import { initEurostatDataService } from './services/eurostat-data/eurostat-data-service.js';

parseConfig();
// DataCanvas defaults on; set CANVAS_PROVIDER_TYPE=none to disable it.
process.env.CANVAS_PROVIDER_TYPE ||= 'duckdb';
resetConfig();

/**
 * The dataframe tools address tables on a canvas, so without one they have
 * nothing to talk to. `disabledTool` keeps a gated tool off `tools/list` —
 * clients cannot call it — while the landing page still renders it with the
 * reason it is off and the setting that turns it on, so an operator can see the
 * capability exists rather than wondering why the README documents a tool the
 * server does not advertise. The drop tool carries a second gate: a drop cannot
 * be undone, so it stays off until EUROSTAT_DATAFRAME_DROP_ENABLED opts in, and
 * its hint names every setting still missing.
 */
const canvasEnabled = config.canvas.providerType !== 'none';
const CANVAS_OFF = {
  reason: 'This deployment runs without a dataframe canvas, so there are no tables to address.',
  hint: 'CANVAS_PROVIDER_TYPE=duckdb',
} as const;
const DROP_OFF_HINT = 'EUROSTAT_DATAFRAME_DROP_ENABLED=true';

/**
 * Read before `createApp()` because the drop tool's registration depends on it.
 * A value that fails to parse is not reported here: `setup()` reads the server
 * config again inside `createApp()`, which prints the configuration banner and
 * exits 1 — thrown at this point, the same error would escape as an uncaught
 * stack trace.
 */
function dataframeDropEnabled(): boolean {
  try {
    return getServerConfig().dataframeDropEnabled;
  } catch {
    return false;
  }
}

/** The drop tool, or its disabled card naming every setting it still needs. */
function dataframeDropTool() {
  const dropEnabled = dataframeDropEnabled();
  if (!canvasEnabled) {
    return disabledTool(eurostatDataframeDrop, {
      reason: CANVAS_OFF.reason,
      hint: dropEnabled ? CANVAS_OFF.hint : `${CANVAS_OFF.hint}\n${DROP_OFF_HINT}`,
    });
  }
  return dropEnabled
    ? eurostatDataframeDrop
    : disabledTool(eurostatDataframeDrop, {
        reason:
          'Table cleanup is disabled in this deployment, so a staged table leaves only when its canvas expires.',
        hint: DROP_OFF_HINT,
      });
}

/**
 * Registration is provisional until setup validates this same memoized config.
 * Invalid parses are never cached: setup repeats the failure inside createApp's
 * configuration boundary, prints its banner and exits before serving a call.
 */
function readClampLimits(): boolean {
  try {
    return getServerConfig().clampLimits;
  } catch {
    return true;
  }
}
const clampLimits = readClampLimits();

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
    createEurostatSearchDatasets(clampLimits),
    eurostatBrowseThemes,
    eurostatGetDatasetInfo,
    createEurostatGetDimensionValues(clampLimits),
    createEurostatQueryDataset(clampLimits),
    createEurostatDownloadDataset(clampLimits),
    canvasEnabled ? eurostatDataframeDescribe : disabledTool(eurostatDataframeDescribe, CANVAS_OFF),
    canvasEnabled ? eurostatDataframeQuery : disabledTool(eurostatDataframeQuery, CANVAS_OFF),
    dataframeDropTool(),
  ],
  resources: [eurostatDatasetResource],
  prompts: [],
  skills: 'skills',
  instructions:
    'Eurostat statistical data, including Comext DS-* collections; no API key required. Resolve dataset codes with eurostat_search_datasets or eurostat_browse_themes, inspect dimensions with eurostat_get_dataset_info, and resolve their values with eurostat_get_dimension_values before fetching observations. Filter large requests, including frequency on Comext, and keep units and aggregation levels comparable. Previews and incomplete bulk transfers cannot support complete totals; inspect notices and flags before concluding data is absent. When a response includes tableName, pass its canvasId as canvas_id to eurostat_dataframe_describe before eurostat_dataframe_query; reuse that canvas for joins. Staging and dataframe tools depend on the deployment canvas. Read eurostat-guide for statistical interpretation and SQL workflows.',
  landing: { requireAuth: false },
  setup(core) {
    // Parsed here so a bad value fails startup with the configuration banner, not every call.
    getServerConfig();
    initEurostatCatalogueService(core.config, core.storage);
    initEurostatDataService(core.config, core.storage);
    initEurostatBulkService(core.config, core.storage);
    setCanvas(core.canvas);
  },
});
