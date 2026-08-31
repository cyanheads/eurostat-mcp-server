<div align="center">
  <h1>@cyanheads/eurostat-mcp-server</h1>
  <p><b>Search and query the Eurostat catalogue — EU economy, demography, trade, health, and NUTS regional data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools (8 with the dataframe canvas) • 1 Resource</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.6.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eurostat-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eurostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eurostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/eurostat-mcp-server/releases/latest/download/eurostat-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eurostat-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXVyb3N0YXQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22eurostat-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Feurostat-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://eurostat.caseyjhand.com/mcp](https://eurostat.caseyjhand.com/mcp)

</div>

---

## Tools

6 tools for discovering and querying Eurostat statistical datasets, plus 2 more when the optional dataframe canvas is enabled:

| Tool | Description |
|:---|:---|
| `eurostat_search_datasets` | Search the Eurostat catalogue by keyword — returns codes, descriptions, period coverage, and theme breadcrumbs |
| `eurostat_browse_themes` | Navigate the Eurostat theme hierarchy — list root themes or drill into subthemes and datasets |
| `eurostat_get_dataset_info` | Fetch metadata for a dataset: dimensions with sample values, time range, observation count, and last-update date |
| `eurostat_get_dimension_values` | List all valid codes for a specific dimension (e.g., all geo codes, all unit codes); supports NUTS hierarchy filtering |
| `eurostat_query_dataset` | Fetch a deterministic preview of decoded statistical observations with dimension filters, NUTS geo-level, and time-range controls |
| `eurostat_download_dataset` | Download a whole dataset through the SDMX 2.1 TSV bulk endpoint and stage every observation on the dataframe canvas |
| `eurostat_dataframe_describe` | List the tables staged on a dataframe canvas with their row counts and column types — canvas only |
| `eurostat_dataframe_query` | Run a read-only SQL SELECT across staged tables — canvas only |

### `eurostat_search_datasets`

Search the Eurostat dataset catalogue by keyword.

- Tokenized keyword match — whitespace-separated tokens are ANDed case-insensitively across each dataset's label, theme breadcrumb, and code, so word order and theme-named queries resolve without a verbatim label
- Returns code, label, type (dataset/table), period coverage, observation count, and theme breadcrumb
- One row per dataset code — Eurostat files some datasets under several theme branches; matches are deduplicated so `totalMatches` and page slots count unique query targets
- Cursor pagination: `limit` (1–100, default 20) sets the page size, `totalMatches` reports the full count, and passing the returned `nextCursor` back as `cursor` pages through every match over a stable order. Cursors are bound to their originating query and catalogue snapshot — reusing one with a different query, or after the catalogue refreshes, returns `invalid_cursor` instead of a silently shifted page
- `nextStep` hint on each result points at the next tool to call
- Catalogue TOC cached in memory for 12 hours (`EUROSTAT_TOC_CACHE_TTL_MS`), then refreshed on the next call
- Pair with `eurostat_browse_themes` for structured domain exploration when keywords are unclear

---

### `eurostat_browse_themes`

Navigate the Eurostat theme tree.

- Without `theme_code`: returns the top-level themes (Economy and finance, Population, Transport, etc.)
- With `theme_code`: returns immediate children — subtheme folders and datasets in that branch
- Each entry includes code, label, type (folder/dataset/table), data period, and observation count where available
- Returns a breadcrumb path from root to the current node, plus a `nextStep` hint suited to the level (drill into folders or inspect a dataset)
- One branch per folder code — Eurostat files a few folder codes under several branches; a code resolves to the first one the catalogue lists, which never has fewer children than the branches it shadows, and `otherPlacements` names those so the ambiguity is visible
- Use for structured discovery when you know the domain but not the exact dataset code

---

### `eurostat_get_dataset_info`

Fetch metadata for a Eurostat dataset before querying it.

- Returns all dimensions with their codes, labels, and up to 10 sample values each
- Reports overall time range and total observation count across all periods, each omitted when Eurostat does not report it
- Combines the dataset-scoped SDMX dataflow descendants with its content constraint, so every dimension — including `time` — is described from the full dataset-available value set rather than from a populated observation slice
- For dimensions with more than 10 values, use `eurostat_get_dimension_values` for the full list
- Provides a link to the ESMS metadata page when available

---

### `eurostat_get_dimension_values`

List all valid values for a specific dataset dimension.

- Retrieves the complete dataset-available set of codes and labels for any dimension (`unit`, `na_item`, `geo`, `time`, etc.) from the same SDMX content constraint used by dataset metadata
- For the `geo` dimension, supports NUTS hierarchy filtering: `aggregate` (EU/EA totals), `country` (the default when omitted), `nuts1`, `nuts2`, and `nuts3`. The response reports the effective level; an empty level is `no_results`, not a claim that the dataset is missing. Pairing `geo_level` with any other dimension is rejected rather than ignored
- Prevents silent no-data returns — invalid dimension values in `eurostat_query_dataset` return nothing without error; verify codes here first

---

### `eurostat_query_dataset`

Fetch statistical data from a Eurostat dataset.

- Accepts dimension filters as a map of `{dimension_code: [value1, value2, ...]}`
- NUTS geo-level filter (`aggregate`, `country`, `nuts1`, `nuts2`, `nuts3`) — mutually exclusive with a non-empty `geo` entry in filters; an empty array is treated as no filter and dropped
- Time range via `since_period`/`until_period` (e.g., `"2020"`, `"2023-Q1"`) or `last_n_periods` for the N most recent
- `preview_limit` controls the deterministic inline prefix (default 50, max 500). It does not change the match, totals, period coverage, or staged rows; filters and period controls reduce the match itself. There is deliberately no cursor or offset
- Returns decoded observations with dimension codes and labels, numeric values, an `OBS_FLAG` status (`p` = provisional, `e` = estimated, etc.) and a separate `CONF_STATUS` confidentiality marker (`C` = confidential, usually the reason a value is null)
- Reports total observation count, missing value count, and the effective time range of the result, each period bound omitted when neither the observations nor Eurostat report it
- `obsCount`, `missingObsCount`, and `timeRange` always describe the full match. `truncated` is independent of `preview_limit` and is true only when the match crosses the 5,000-observation staging threshold
- With the dataframe canvas enabled, only a match above 5,000 observations is staged whole as a SQL table and the response returns `canvasId` / `tableName` / `stagedRowCount`; matches at or below 5,000 are never staged. The rows stream into the table one at a time from the response body already in memory, so nothing extra is fetched and the match is never materialized as an array. Call `eurostat_dataframe_describe` before `eurostat_dataframe_query`. Without a canvas those fields and tool guidance are absent, and narrowing the query is the way to the rest
- Pass `canvas_id` from an earlier response to stage several results side by side and join across them
- Async-response detection — large unfiltered queries return an actionable, non-retryable error with filter guidance rather than silently timing out
- Fetches a *slice*. When the target is a whole dataset, `eurostat_download_dataset` reads the SDMX bulk endpoint instead, at roughly half the bytes

---

### `eurostat_download_dataset`

Download a whole dataset through the SDMX 2.1 TSV bulk endpoint (`/sdmx/2.1/data/{dataset}?format=TSV`).

- The TSV wire format runs 48–63% of the JSON-stat body `eurostat_query_dataset` reads for the same data, because the wide layout writes each dimension key once per row instead of once per observation. Measured across four datasets from 1.1M to 12.8M observations
- Filters take the same `{dimension_code: [value, ...]}` map as `eurostat_query_dataset` and are applied by Eurostat before the body is sent. They become a positional key on the request path, which must carry one position per dimension — the server builds it from the dataset's own dimension order, so a filter naming a dimension the dataset does not have is rejected with the real list rather than sent as a malformed key
- Narrow periods with `since_period` / `until_period`. There is deliberately no "last N periods": the TSV layout keeps a column for every period whichever selector is used, and `lastNObservations` merely blanks the unselected cells — measured at ~3× the equivalent JSON-stat body. `startPeriod` removes the columns
- **Byte budget enforced while streaming.** Eurostat sends the body chunked with no `Content-Length`, so the limit is applied as bytes arrive and the transfer is aborted the moment it is spent — not measured after the fact. A truncated download returns its rows with `budgetExceeded: true` rather than an error, so the work already paid for is not discarded. `EUROSTAT_BULK_MAX_BYTES` sets the ceiling
- **gzip is sniffed off the stream, not read from headers.** Eurostat compresses large bodies with no `Content-Encoding` header; the only header-level tell is a `.tsv.gz` filename on `Content-Disposition`, and the switch does not track dataset size, so the magic bytes are what decide
- **The asynchronous queue envelope is detected explicitly.** When an extraction is too costly to serve inline Eurostat answers HTTP 200 with a SOAP `syncResponse` ticket instead of data; read as TSV that yields a header row of XML and no observations, so it is classified up front as a non-retryable error naming what to narrow
- Errors arrive as XML SOAP faults, not JSON: faultcode 100 → `not_found`, 140 → `filter_arity`, 150 → `invalid_dimension` (which also covers a period range outside the dataset's coverage). Each maps to a typed reason with a recovery hint naming the tool to call next
- With the dataframe canvas enabled, every observation is staged as a SQL table and the response returns `canvasId` / `tableName` / `stagedRowCount`; rows stream into the table one at a time, so a multi-million-row download never materializes as an array. Only `preview_limit` rows (default 50, max 500) come back inline, and they are the leading rows of the staged table. Call `eurostat_dataframe_describe` before `eurostat_dataframe_query`
- Without a canvas the download still runs so `rowCount`, `missingCount` and `periodRange` describe it, but only the preview is retained — the response says so plainly instead of implying the rest is reachable

---

### `eurostat_dataframe_describe` / `eurostat_dataframe_query`

SQL over the results `eurostat_query_dataset` and `eurostat_download_dataset` stage. **Listed only when the dataframe canvas is enabled** (`CANVAS_PROVIDER_TYPE=duckdb`); the server is fully functional without it, and clients never see tools they cannot call.

- `eurostat_dataframe_describe` lists the staged tables with row counts and column names and types — call it before writing SQL
- `eurostat_dataframe_query` runs a single read-only `SELECT`. Statement chaining, non-`SELECT` verbs, and functions that read files or external data are rejected with a typed error
- Staged columns are flat, and the two stagers write different dimension columns — call `eurostat_dataframe_describe` rather than assuming. `eurostat_query_dataset` gives each dimension a code column named after the dimension (`geo`) plus a label companion (`geo_label`); `eurostat_download_dataset` gives code columns only, since the bulk endpoint carries no labels, plus a `time` column. Both write the same five measure columns: `obs_value`, `obs_flag`, `obs_flag_label`, `conf_status`, `conf_status_label`
- Tables from the two stagers join on their dimension code columns and `time` — same names, same `VARCHAR` type, `obs_value` `DOUBLE` on both — and their measure columns carry the same codes for the same observation. JSON-stat has no `CONF_STATUS` field and folds the marker into the observation status as `|C`; `eurostat_query_dataset` splits it back out before staging, so a confidential cell reads `obs_flag = NULL` with `conf_status = 'C'` on either table
- The DuckDB binding ships with the server, so `CANVAS_PROVIDER_TYPE=duckdb` is the only switch. The exception is the one-click `.mcpb` bundle, which strips platform-specific native bindings to stay portable — a bundle install cannot run the canvas, so reach for the npm, Docker, or from-source install for SQL analytics

## Resource

| Type | Name | Description |
|:---|:---|:---|
| Resource | `eurostat://dataset/{dataset_code}` | Dataset metadata (dimensions, time range, obs count, last-updated) accessible by URI for cache-injectable context |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

Eurostat-specific:

- TTL-bounded in-memory cache for the TOC file — reused across all search and browse calls, refreshed on the first call past its 12-hour lifetime, with the last loaded copy served if a refresh fails
- JSON-stat 2.0 stride-based decoder for the Statistics API response format
- Dataset-scoped SDMX metadata parsing — dataflow descendants supply labels, annotations, concepts, and partial codelists; the content constraint supplies the actual available positions, including every period
- Async-response detection — Eurostat returns over-limit queries as either an HTTP-200 warning object or an HTTP-413 error array; both fail once with actionable filter guidance
- NUTS hierarchy geo-level filtering across query and dimension-value tools
- Status decoding against both published codelists — the `OBS_FLAG` observation flag (provisional, estimated, definition differs) and the `CONF_STATUS` confidentiality marker, each in its own field. JSON-stat folds the two into one string and SDMX TSV into one cell; both are split on their separator, so a given observation reads the same whichever endpoint served it
- Optional DuckDB dataframe canvas — a query matching more than 5,000 observations is streamed row by row into a SQL table, reaching the rows outside the inline preview without a second request to Eurostat
- SDMX 2.1 TSV bulk downloads with streaming gzip detection, a mid-transfer byte budget, wide-to-long expansion, and SOAP fault classification — the whole-dataset counterpart to the per-query path

Agent-friendly output:

- Discovery workflow: `eurostat_search_datasets` / `eurostat_browse_themes` → `eurostat_get_dataset_info` → `eurostat_get_dimension_values` → `eurostat_query_dataset` for a slice, or `eurostat_download_dataset` for the whole dataset
- Invalid dimension codes in query filters silently return no data from Eurostat — the `eurostat_get_dimension_values` tool prevents this by letting agents verify codes first
- Structured error contracts with typed reasons and recovery hints on all tools

## Getting started

### Public Hosted Instance

A public instance is available at `https://eurostat.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "eurostat-mcp-server": {
      "type": "streamable-http",
      "url": "https://eurostat.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "eurostat-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/eurostat-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "eurostat-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/eurostat-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "eurostat-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/eurostat-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.2](https://bun.sh/) or higher. No API key required — Eurostat's dissemination API is public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/eurostat-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd eurostat-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Recommended starting point if heap growth is observed: `60000`. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `EUROSTAT_BASE_URL` | Eurostat API base URL | `https://ec.europa.eu/eurostat/api/dissemination` |
| `EUROSTAT_REQUEST_TIMEOUT_MS` | HTTP request timeout in ms | `30000` |
| `EUROSTAT_TOC_CACHE_TTL_MS` | Catalogue TOC cache lifetime in ms — the first search or browse call past this age refreshes it | `43200000` (12 hours) |
| `EUROSTAT_BULK_TIMEOUT_MS` | HTTP timeout for one `eurostat_download_dataset` transfer in ms — held separate because a bulk body streams for minutes | `120000` (2 minutes) |
| `EUROSTAT_BULK_MAX_BYTES` | Byte budget for one bulk download, counted on the decoded TSV and enforced while streaming | `52428800` (50 MiB) |
| `CANVAS_PROVIDER_TYPE` | `duckdb` enables the dataframe canvas: lists the two dataframe tools, lets `eurostat_query_dataset` stage a match above 5,000 observations, and lets `eurostat_download_dataset` retain a bulk download | `none` |
| `CANVAS_TEMP_PATH` | Directory DuckDB writes canvas spill files to. Must be writable by the server process | `<os tmpdir>/mcp-canvas` |
| `CANVAS_TTL_MS` | Sliding lifetime of a staged canvas in ms; every call against it extends the window | `86400000` (24 hours) |
| `CANVAS_DEFAULT_ROW_LIMIT` | Max rows one `eurostat_dataframe_query` returns before reporting `truncated` | `10000` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six tools for discovery and data access, plus two canvas-gated dataframe tools. |
| `src/mcp-server/resources` | Resource definitions. Dataset metadata resource. |
| `src/services/eurostat-catalogue` | Catalogue service — fetches and parses the Eurostat TOC TXT file; TTL-bounded in-memory cache. |
| `src/services/eurostat-data` | Data service — dataset-scoped SDMX metadata parser plus Statistics API querying, JSON-stat 2.0 decoding, async-response detection, and dataframe row source. |
| `src/services/canvas-accessor.ts` | Module-level accessor for the optional DataCanvas, plus the acquire helper that names the misconfigured path on a permission failure. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
