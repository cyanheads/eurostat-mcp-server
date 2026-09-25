<div align="center">
  <h1>@cyanheads/eurostat-mcp-server</h1>
  <p><b>Search and query the Eurostat catalogue — EU economy, demography, trade, health, and NUTS regional data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools (8 with the dataframe canvas) • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eurostat-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eurostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eurostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

EU statistics from the Eurostat catalogue: economy, demography, trade, health, and NUTS regional data. Search and browse the catalogue by keyword or theme, inspect dataset dimensions, then query a slice or bulk-download a whole dataset. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

The catalogue spans two Eurostat hosts. Most datasets come from the dissemination API; the `DS-*` collections — detailed trade by CN8, HS, SITC, BEC and CPA (Comext), and PRODCOM industrial production — come from the Comext dissemination host. Every tool routes a `DS-*` code there by its prefix, in any case, so the same calls work on both.

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
| `eurostat_dataframe_describe` | List the tables staged on a dataframe canvas, with row counts and column types |
| `eurostat_dataframe_query` | Run a read-only SQL SELECT across staged tables |

### Resources

| Resource | Description |
|:---|:---|
| `eurostat://dataset/{dataset_code}` | Dataset metadata (dimensions, time range, observation count, last-updated) by URI |

The same metadata is available through `eurostat_get_dataset_info` for tool-only clients.

## Capability reference

### `eurostat_search_datasets` <sub>tool</sub>

- `query` tokens are ANDed case-insensitively across each dataset's label, theme breadcrumb, and code; `limit` 1–100 (default 20), paged by passing `nextCursor` back as `cursor`
- Results carry `code`, `label`, `type` (`dataset` / `table`), period coverage, `obsCount`, `lastUpdated`, and `themePath`; `totalMatches` counts every match
- Searches the dissemination table of contents plus the Comext host's dataflow list, whose `DS-*` entries carry `lastUpdated` but no period coverage or `obsCount`. A collection on neither, such as the legacy PRODCOM `DS-056120`, is not disseminated and cannot be reached
- Fails as `no_match` — for a query naming such a `DS-*` code, saying the collection is not disseminated rather than suggesting a broader search — or `invalid_cursor` when a cursor is reused with a different query or after the catalogue refreshes

---

### `eurostat_browse_themes` <sub>tool</sub>

- Omit `theme_code` for the top-level theme folders; pass a folder code for its immediate children
- The Comext collections sit in two folders the table of contents lacks: `ext_go_detail` (detailed trade) under `ext_go`, and `prom` (PRODCOM) under `icts`
- Items carry `code`, `label`, `type` (`folder` / `dataset` / `table`), and `hasChildren`, with a `parentPath` breadcrumb; `otherPlacements` names other branches that file the same folder code
- Fails as `not_found` for an unknown code, `not_a_folder` for a dataset or table code

---

### `eurostat_get_dataset_info` <sub>tool</sub>

- One `dataset_code`; returns every dimension with `valuesCount` and up to 10 `sampleValues`, plus `timeRange`, `obsCount`, `lastUpdated`, and the ESMS `metadataUrl`
- The Comext host reports no `timeRange` or `obsCount` for a `DS-*` collection, so both read as unreported. Its structure carries a label for every code, 23 MB for `DS-045409`: parsed metadata is cached per dataset for an hour, within a 64 MiB memory budget, so only the first call pays for it
- Fails as `not_found` for an unknown dataset, or `upstream_fault` when Eurostat returns a structure or content constraint the server cannot read; a failed read is not cached, so a later call downloads it afresh

---

### `eurostat_get_dimension_values` <sub>tool</sub>

- `dataset_code` plus `dimension`; returns the dataset-available code/label pairs in `values`, with `totalCount`
- At most 2,000 values come back inline, in Eurostat's order. A longer list — the 37,069 CN8 codes of `DS-045409`, a daily `time` dimension, the largest airport-pair lists — is cut there, with `truncated`, `shown`, `cap`, and a `notice` saying where the rest is
- For `geo`, `geo_level` picks a NUTS level (`aggregate`, `country` by default, `nuts1`, `nuts2`, `nuts3`)
- `canvas_id` also stages every value, past the inline cap too, on that canvas as a `code` / `label` table (`canvasId` / `tableName` / `stagedRowCount`), to search with SQL or to label a download's code-only columns through a join; this tool never starts a canvas of its own, and ignores `canvas_id` on a deployment without one
- Fails as `not_found` for an unknown dataset or dimension, `no_results` for a NUTS level with no values, `conflicting_params` for `geo_level` on any other dimension, `upstream_fault` for a structure or content constraint the server cannot read, or `canvas_not_found` for an unknown or expired `canvas_id`

---

### `eurostat_query_dataset` <sub>tool</sub>

- `dataset_code` plus `filters` (`{dimension_code: [values]}`, codes in any case), `geo_level`, and either `since_period` / `until_period` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `YYYY-Qn`, `YYYY-Sn`, `YYYY-Tn`, `YYYY-Mnn`, `YYYY-Wnn`, `YYYY-Dnnn`; extra leading zeros after the letter are dropped, so `2020-Q01` is sent as `2020-Q1`, and `YYYY-A1` is sent as `YYYY`) or `last_n_periods`, which counts back from the dataset's latest period rather than the slice's; `preview_limit` 1–500 (default 50) sets the inline row count; `lang` is `EN`, `FR`, or `DE`
- Each observation carries code/label pairs per dimension, a nullable `value`, an OBS_FLAG `status`, and a CONF_STATUS `confStatus`; `obsCount`, `missingObsCount`, and `timeRange` cover the whole match, `truncated` is true above 5,000 observations, and `unmatchedValues` names filter values that matched nothing
- PRODCOM publishes its flag and unit indicators as text in the value itself: `:C` comes back as a null `value` with `confStatus` `C`, and anything else, such as the unit `KG`, verbatim in `valueText` with a null `value`
- Fails as `not_found`, `no_results` (naming the filter values that matched nothing and, up to the newest 24 with a full count, the selected periods that carry no value), `invalid_dimension`, `invalid_period` (a malformed or non-existent period, or a `since_period` that starts after `until_period` ends, rejected before any request), `conflicting_params` (`geo` filter with `geo_level`, or a period range with `last_n_periods`), a non-retryable `async_response` for a query too large to serve inline, or `canvas_not_found` for an unknown or expired `canvas_id`

---

### `eurostat_download_dataset` <sub>tool</sub>

- `dataset_code` plus the same `filters` map and `since_period` / `until_period` in the same period forms (no `last_n_periods`: the TSV keeps a column per period unless a range drops it); `preview_limit` 1–500 (default 50)
- Returns `rowCount` (echoed as `totalCount`), `missingCount`, `periodRange`, and `bytesRead` for the whole download; the `EUROSTAT_BULK_MAX_BYTES` budget (default 50 MiB) stops a transfer mid-stream and returns what arrived with `budgetExceeded: true`
- On a `DS-*` table, `obs_value_text` holds a value published as text (PRODCOM's `KG`), and a PRODCOM `:C` lands in `conf_status`
- Fails as `not_found`, `invalid_dimension` (including a range wholly outside the dataset's coverage), `invalid_period` (a malformed or non-existent period, or a `since_period` that starts after `until_period` ends, rejected before any request), `filter_arity`, a non-retryable `async_queued` when Eurostat queues the extraction, a non-retryable `extraction_too_big` when Eurostat refuses it as too large (past its 5,000,000-row limit, or an unfiltered download of a large Comext collection) with the dimensions left to filter, `no_results` (including a range inside the dataset's coverage that misses the filtered series), `upstream_fault`, or `canvas_not_found` for an unknown or expired `canvas_id`

---

### `eurostat_dataframe_describe` <sub>tool</sub>

- `canvas_id` from a staging response; lists each table's `name`, `rowCount`, and typed columns, plus canvas and table `expiresAt` (sliding `CANVAS_TTL_MS`, default 24h); fails as `canvas_not_found` for an unknown or expired ID, or `canvas_disabled` on a deployment without a canvas
- `eurostat_query_dataset` tables carry a code and a `_label` column per dimension; `eurostat_download_dataset` tables carry codes only, plus `time`. Both share `obs_value`, `obs_flag`, `obs_flag_label`, `conf_status`, and `conf_status_label`, so they join on dimension codes and `time`; a `DS-*` table from either adds `obs_value_text`
- `eurostat_get_dimension_values` tables carry `code` and `label`: join one to a download on its dimension column (`d.geo = g.code`) to label it

---

### `eurostat_dataframe_query` <sub>tool</sub>

- One read-only `SELECT` per call; chained statements, other verbs, and functions that read files or external data are rejected
- Returns `columns`, `rows`, `rowCount`, and `truncated`, which is true past `CANVAS_DEFAULT_ROW_LIMIT` (default 10,000) rows; 64-bit integers, `COUNT(*)` included, arrive as strings. Fails as `missing_table`, `canvas_not_found`, or `canvas_disabled`

---

### `eurostat://dataset/{dataset_code}` <sub>resource</sub>

- Same payload as `eurostat_get_dataset_info`, returned as `application/json`
- `dataset_code` comes from `eurostat_search_datasets` or `eurostat_browse_themes`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Eurostat-specific:

- The Statistics API (JSON-stat 2.0) for slices, the SDMX 2.1 TSV bulk endpoint for whole datasets at roughly half the bytes, and the catalogue TOC cached in memory for 12 hours
- The Comext host's `DS-*` collections through the same tools: detailed trade by CN8, HS, SITC, BEC and CPA, and PRODCOM. The trade flows mix annual and monthly series in one dataset, so filter `freq`; `product`, `reporter` and `partner` carry aggregates (`TOTAL`, `EU27_2020`, `EXT_EU27_2020`) that double-count when summed with their members. The Comext host serves no large collection unfiltered
- NUTS geo-level filtering (`aggregate` / `country` / `nuts1` / `nuts2` / `nuts3`) on `eurostat_query_dataset` and `eurostat_get_dimension_values`
- OBS_FLAG (provisional, estimated, and so on) and CONF_STATUS (confidentiality) decoded into separate fields, with the same codes from JSON-stat and the bulk TSV
- Eurostat's too-large-to-serve responses (HTTP-200 async warnings, HTTP 413, SOAP fault 413, SOAP queue tickets) come back as non-retryable `async_response`, `extraction_too_big`, or `async_queued` errors that name the dataset's own dimensions left to filter, not timeouts
- Inline rows are capped by `preview_limit` (at most 500). With `CANVAS_PROVIDER_TYPE=duckdb`, a query match above 5,000 observations, or any bulk download, is staged whole as a SQL table (`canvasId` / `tableName` / `stagedRowCount`) for the dataframe tools, and `canvas_id` stages the next result beside earlier ones for joins — including a dimension's code/label list from `eurostat_get_dimension_values`, which labels a bulk table's codes. An empty download fails as `no_results` without creating or touching a canvas. The `.mcpb` bundle strips the native DuckDB binding, so SQL analytics need the npm, Docker, or from-source install

Agent-friendly output:

- Typed error contracts: every declared failure carries a `reason` and a `recovery.hint` naming the next tool to call
- Next-step hints: `eurostat_search_datasets` and `eurostat_browse_themes` return a `nextStep` pointing at the follow-up call
- Unknown stays unknown: counts and period bounds Eurostat doesn't report (`obsCount`, `timeRange.start` / `end`, `lastUpdated`) are omitted rather than zeroed
- Effective-query echo: `appliedFilters` on `eurostat_query_dataset` and `appliedQuery` (with the SDMX `url`) on `eurostat_download_dataset`, plus a `notice` when the inline preview omits rows, naming the staged table when there is one; `eurostat_query_dataset`'s `notice` also names any filter value that matched nothing

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key: Eurostat's dissemination API and its Comext host are public.

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

4. **Configure environment (optional, every setting has a default):**

```sh
cp .env.example .env
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `EUROSTAT_BASE_URL` | Eurostat API base URL. | `https://ec.europa.eu/eurostat/api/dissemination` |
| `EUROSTAT_COMEXT_BASE_URL` | Comext dissemination host, which serves every `DS-*` dataset code (detailed trade and PRODCOM). | `https://ec.europa.eu/eurostat/api/comext/dissemination` |
| `EUROSTAT_REQUEST_TIMEOUT_MS` | HTTP request timeout, in ms. | `30000` |
| `EUROSTAT_METADATA_TIMEOUT_MS` | Timeout for one dataset's SDMX dataflow structure, in ms — 23 MB, uncompressed, for `DS-045409`. | `120000` (2 min) |
| `EUROSTAT_TOC_CACHE_TTL_MS` | Catalogue TOC cache lifetime, in ms; the first search or browse call past it refreshes the TOC. | `43200000` (12 h) |
| `EUROSTAT_BULK_TIMEOUT_MS` | Timeout for one `eurostat_download_dataset` transfer, in ms. | `120000` (2 min) |
| `EUROSTAT_BULK_MAX_BYTES` | Byte budget for one bulk download, counted on the decoded TSV and enforced while streaming. | `52428800` (50 MiB) |
| `CANVAS_PROVIDER_TYPE` | `duckdb` enables the dataframe canvas: lists the two dataframe tools and turns on staging. | `none` |
| `CANVAS_TTL_MS` | Sliding lifetime of a staged canvas, in ms. | `86400000` (24 h) |
| `CANVAS_DEFAULT_ROW_LIMIT` | Max rows one `eurostat_dataframe_query` returns before reporting `truncated`. | `10000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. The server declares `stateless`; a set value overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). The Docker image sets `info`. | `debug` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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
| `src/index.ts` | `createApp()` entry point — registers tools and the resource, inits services, gates the dataframe tools on the canvas. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six discovery and data tools, plus two canvas-gated dataframe tools. |
| `src/mcp-server/resources` | Resource definitions. Dataset metadata resource. |
| `src/services/eurostat-catalogue` | Catalogue service — fetches and parses the Eurostat TOC, merges the Comext dataflow list into it, with a TTL-bounded in-memory cache. |
| `src/services/eurostat-data` | Statistics API service — SDMX metadata parsing with a per-dataset cache, JSON-stat 2.0 decoding, async-response detection, canvas row source. |
| `src/services/eurostat-bulk` | SDMX 2.1 TSV bulk service — streaming download, byte budget, SOAP fault mapping, canvas row source. |
| `src/services/eurostat-codelists.ts` | OBS_FLAG and CONF_STATUS codelists, the measure column names both stagers write, and the text-value decoder. |
| `src/services/eurostat-hosts.ts` | Which host serves a dataset code: `DS-*` to the Comext host, everything else to the main one. |
| `src/services/canvas-accessor.ts` | Accessor for the optional DataCanvas and the acquire helper canvas-touching tools share. |
| `src/services/shared-load.ts` | Lets concurrent callers await one shared download, so one caller's cancellation releases only that caller. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
