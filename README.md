<div align="center">
  <h1>@cyanheads/eurostat-mcp-server</h1>
  <p><b>Search and query the Eurostat catalogue — EU economy, demography, trade, health, and NUTS regional data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools (8 with the dataframe canvas) • 1 Resource</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.6.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eurostat-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eurostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eurostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/eurostat-mcp-server/releases/latest/download/eurostat-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eurostat-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXVyb3N0YXQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22eurostat-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Feurostat-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://eurostat.caseyjhand.com/mcp](https://eurostat.caseyjhand.com/mcp)

</div>

---

## Overview

EU statistics from the Eurostat catalogue — economy, demography, trade, health, and NUTS regional data. Search and browse the catalogue by keyword or theme, inspect dataset dimensions, and query a slice or bulk-download a whole dataset from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

Two of the eight are listed only when the dataframe canvas is enabled (`CANVAS_PROVIDER_TYPE=duckdb`).

| Tool | Description |
|:---|:---|
| `eurostat_search_datasets` | Search the Eurostat catalogue by keyword — returns codes, descriptions, period coverage, and theme breadcrumbs |
| `eurostat_browse_themes` | Navigate the Eurostat theme hierarchy — list root themes or drill into subthemes and datasets |
| `eurostat_get_dataset_info` | Fetch dataset metadata: dimensions with sample values, time range, observation count, and last-update date |
| `eurostat_get_dimension_values` | List all valid codes for one dataset dimension, with NUTS hierarchy filtering for `geo` |
| `eurostat_query_dataset` | Fetch a bounded preview of decoded observations with dimension filters, NUTS geo-level, and time-range controls |
| `eurostat_download_dataset` | Download a whole dataset via the SDMX bulk endpoint and stage every observation on the dataframe canvas |
| `eurostat_dataframe_describe` | List the tables staged on a dataframe canvas, with row counts and column types — canvas only |
| `eurostat_dataframe_query` | Run a read-only SQL SELECT across staged tables — canvas only |

### Resources

| Resource | Description |
|:---|:---|
| `eurostat://dataset/{dataset_code}` | Dataset metadata (dimensions, time range, observation count, last-updated) by URI, for cache-injectable context |

## Capability reference

### `eurostat_search_datasets` <sub>tool</sub>

- Tokenized keyword match — whitespace-separated tokens are ANDed case-insensitively across each dataset's label, theme breadcrumb, and code, so word order and theme-named queries resolve without a verbatim label match
- Returns `code`, `label`, `type` (dataset/table), period coverage, observation count, and theme breadcrumb per result
- One row per dataset code — Eurostat files some datasets under multiple theme branches; matches are deduplicated so `totalMatches` and page slots count unique targets
- Cursor pagination: `limit` (1–100, default 20) sets page size, `totalMatches` reports the full count, and passing `nextCursor` back as `cursor` pages through every match. A cursor is bound to its originating query and catalogue snapshot — reusing one with a different query, or after the catalogue refreshes, returns `invalid_cursor` instead of a silently shifted page
- `nextStep` on each result names the next tool to call
- Catalogue TOC is cached in memory for 12 hours (`EUROSTAT_TOC_CACHE_TTL_MS`), refreshed on the next call past that age

---

### `eurostat_browse_themes` <sub>tool</sub>

- Without `theme_code`: returns the top-level theme folders (Economy, Population, Transport, etc.)
- With `theme_code`: returns immediate children — subtheme folders and datasets in that branch
- Each entry carries `code`, `label`, `type` (folder/dataset/table), data period, and observation count where available
- Returns a breadcrumb `parentPath` from root to the current node, plus a `nextStep` hint suited to the level
- One branch per folder code — Eurostat files a few folder codes under several branches; a code resolves to the branch listed first in the catalogue (never fewer children than the ones it shadows), and `otherPlacements` names those so the ambiguity is visible

---

### `eurostat_get_dataset_info` <sub>tool</sub>

- Returns all dimensions with their codes, labels, and up to 10 sample values each
- Dimension values reflect the full dataset-available set (including every period for `time`), not just what appears in populated observations
- Reports overall time range and total observation count, each omitted — not zeroed — when Eurostat does not report it
- For a dimension with more than 10 values, call `eurostat_get_dimension_values` for the full list
- `metadataUrl` links to the ESMS metadata page when Eurostat provides one

---

### `eurostat_get_dimension_values` <sub>tool</sub>

- Returns the complete dataset-available set of codes and labels for any dimension, from the same content constraint `eurostat_get_dataset_info` uses
- For `geo`, NUTS hierarchy filtering via `geo_level`: `aggregate`, `country` (default), `nuts1`, `nuts2`, `nuts3` — an empty level reports `no_results` rather than implying the dataset lacks data, and pairing `geo_level` with any other dimension is rejected
- Verify codes here before `eurostat_query_dataset` or `eurostat_download_dataset` — an invalid dimension value returns no data silently from the former and a rejected fault from the latter

---

### `eurostat_query_dataset` <sub>tool</sub>

- Dimension filters as `{dimension_code: [values]}`; a `geo` filter and `geo_level` (NUTS: `aggregate`/`country`/`nuts1`/`nuts2`/`nuts3`) are mutually exclusive, as are `since_period`/`until_period` and `last_n_periods`; an empty filter array is dropped rather than applied
- `preview_limit` (1–500, default 50) bounds only the inline prefix of decoded observations — it never changes `obsCount`, `missingObsCount`, `timeRange`, or what gets staged. There is deliberately no cursor or offset; filters and period controls are the only way to shrink the match itself
- Each observation carries dimension code/label pairs, a nullable `value`, an optional OBS_FLAG `status` (e.g. `p`=provisional, `e`=estimated), and a separate optional `CONF_STATUS` `confStatus` marker — usually why a value is null
- `truncated` is true only when the match exceeds the 5,000-observation staging threshold, independent of `preview_limit`. With the dataframe canvas enabled, a match above that threshold is staged whole as a SQL table (`canvasId` / `tableName` / `stagedRowCount`) — call `eurostat_dataframe_describe` before `eurostat_dataframe_query`; without a canvas those fields are absent and narrowing the query is the only way to reach the rest
- `canvas_id` reuses an existing canvas so a result can be joined against earlier ones; an oversized unfiltered query is caught by async-response detection and returned as an actionable, non-retryable error instead of timing out
- Fetches a slice — for a whole dataset, `eurostat_download_dataset` reads the SDMX bulk endpoint instead, at roughly half the bytes

---

### `eurostat_download_dataset` <sub>tool</sub>

- TSV bulk body runs 48–63% of the JSON-stat bytes `eurostat_query_dataset` reads for the same data — measured across four datasets from 1.1M to 12.8M observations
- Filters take the same `{dimension_code: [values]}` map, applied server-side; the positional key needs every dimension in the dataset's own order, so a filter naming one the dataset lacks is rejected with the real dimension list rather than sent malformed
- No `last_n_periods` here — only `since_period` / `until_period` actually shrink the response, since the TSV layout keeps a column per period regardless of selector
- Byte budget (`EUROSTAT_BULK_MAX_BYTES`, default 50 MiB) is enforced while streaming — Eurostat sends no `Content-Length`, so a transfer stopped mid-flight returns its rows with `budgetExceeded: true` instead of an error
- Failure modes are typed: an async queue ticket (Eurostat's too-costly-to-serve-inline response) is a non-retryable error; XML SOAP faults map to `not_found` (100), `filter_arity` (140), and `invalid_dimension` (150 — also covers an out-of-coverage period range), each with a recovery hint naming the next tool
- With the dataframe canvas enabled, every observation is staged as a SQL table (`canvasId` / `tableName` / `stagedRowCount`), streamed row by row — call `eurostat_dataframe_describe` before `eurostat_dataframe_query`. Without a canvas, only `preview_limit` rows (default 50, max 500) survive the call; `rowCount` / `missingCount` / `periodRange` still describe the whole download

---

### `eurostat_dataframe_describe` <sub>tool</sub>

- Lists tables staged on the canvas (from `canvas_id`, returned by `eurostat_query_dataset` or `eurostat_download_dataset`) with row counts, column names, types, and nullability — call before writing SQL, since the two stagers write different dimension columns
- Also reports the canvas's and each table's `expiresAt`; every call against a canvas slides its lifetime forward (`CANVAS_TTL_MS`, default 24h)
- Errors `canvas_disabled` when this deployment runs without a canvas, `canvas_not_found` when the ID is unknown or expired

---

### `eurostat_dataframe_query` <sub>tool</sub>

- Runs a single read-only `SELECT` against staged tables; statement chaining, non-`SELECT` verbs, and functions that read files or external data are rejected with a typed error
- `eurostat_query_dataset` tables carry a code column per dimension plus a `_label` companion; `eurostat_download_dataset` tables carry code columns only (no labels) plus a `time` column — both write the same five measure columns (`obs_value`, `obs_flag`, `obs_flag_label`, `conf_status`, `conf_status_label`) with matching codes, so tables from either stager join on dimension codes and `time`
- A confidential cell reads `obs_flag = NULL` with `conf_status = 'C'` on either table — JSON-stat folds the two into one string (`|C`) that `eurostat_query_dataset` splits before staging
- Results are bounded by `CANVAS_DEFAULT_ROW_LIMIT` (default 10,000); `truncated: true` means add a `LIMIT`, an aggregate, or a narrower `WHERE`. 64-bit integer results — `COUNT(*)` included — arrive as strings so values outside the JSON number range survive intact
- The DuckDB binding ships with the server — `CANVAS_PROVIDER_TYPE=duckdb` is the only switch — except the one-click `.mcpb` bundle, which strips native bindings to stay portable; use the npm, Docker, or from-source install for SQL analytics

---

### `eurostat://dataset/{dataset_code}` <sub>resource</sub>

- Same payload as `eurostat_get_dataset_info`, addressable as a resource URI for cache-injectable context
- `dataset_code` comes from `eurostat_search_datasets` or `eurostat_browse_themes`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Eurostat-specific:

- NUTS hierarchy geo-level filtering (`aggregate` / `country` / `nuts1` / `nuts2` / `nuts3`) across `eurostat_query_dataset` and `eurostat_get_dimension_values`
- OBS_FLAG (provisional, estimated, etc.) and CONF_STATUS (confidentiality) decoded into separate fields from Eurostat's combined encoding, consistent whether the observation came from JSON-stat or the bulk TSV
- Async-response detection across every data-fetching tool — Eurostat's over-limit HTTP-200 warnings and HTTP-413/SOAP faults are classified into one typed, non-retryable error with filter guidance instead of surfacing as a timeout
- SDMX 2.1 TSV bulk downloads at roughly half the JSON-stat byte cost, with a mid-transfer byte budget
- Optional DuckDB dataframe canvas stages a query match above 5,000 observations, or a whole bulk download, as a queryable SQL table

Agent-friendly output:

- Structured error contracts — every declared failure carries a typed `reason` and a `recovery.hint` naming the exact next tool to call, not just an error string
- Next-step hints — `eurostat_search_datasets` and `eurostat_browse_themes` responses carry a `nextStep` field pointing at the right follow-up call
- Omitted-vs-unknown fields — counts and period bounds Eurostat doesn't report (`obsCount`, `timeRange.start`/`end`, `lastUpdated`) are omitted from the response rather than defaulted to zero or blank
- Truncation and staging notices — a response that exceeds an inline cap carries an enrichment notice naming the exact `eurostat_dataframe_describe` → `eurostat_dataframe_query` follow-up

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

- [Bun v1.4.0](https://bun.sh/) or higher. No API key required — Eurostat's dissemination API is public.

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
| `MCP_SESSION_MODE` | HTTP session posture: `auto`, `stateful`, or `stateless` (`auto` resolves to `stateful`). The server declares `stateless` in `createApp()`; an explicitly set value overrides that default. | `stateless` |
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

See [`.env.example`](./.env.example) for the full list of optional overrides.

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
  bun run lint:mcp  # Validates MCP definitions against spec
  ```

### Docker

```sh
docker build -t eurostat-mcp-server .
docker run --rm -p 3010:3010 eurostat-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/eurostat-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources and inits services. |
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
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
