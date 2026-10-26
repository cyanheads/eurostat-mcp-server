<div align="center">
  <h1>@cyanheads/eurostat-mcp-server</h1>
  <p><b>Search and query the Eurostat catalogue — EU economy, demography, trade, health, and NUTS regional data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools (up to 9 with the dataframe canvas) • 2 Resources • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.11.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eurostat-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eurostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eurostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

EU statistics from Eurostat: economy, demography, trade, health, and NUTS regional data, including detailed Comext trade and PRODCOM industrial production. Search or browse the catalogue, inspect a dataset's dimensions, then query a slice or bulk-download the whole thing.

### Tools

The three `eurostat_dataframe_*` tools need the dataframe canvas, which is on by default and off with `CANVAS_PROVIDER_TYPE=none`; `eurostat_dataframe_drop` also needs `EUROSTAT_DATAFRAME_DROP_ENABLED=true`.

| Tool | Description |
|:---|:---|
| `eurostat_search_datasets` | Search the Eurostat catalogue by keyword — returns codes, descriptions, period coverage, and theme breadcrumbs |
| `eurostat_browse_themes` | Navigate the Eurostat theme hierarchy — list root themes or drill into subthemes and datasets |
| `eurostat_get_dataset_info` | Fetch dataset metadata: dimensions with sample values, time range, observation count, and last-update date |
| `eurostat_get_dimension_values` | List all valid codes for one dataset dimension, paged, with a code/label word filter and NUTS hierarchy filtering for `geo` |
| `eurostat_query_dataset` | Fetch a bounded preview of decoded observations with dimension filters, NUTS geo-level, and time-range controls |
| `eurostat_download_dataset` | Download a whole dataset via the SDMX bulk endpoint and stage every observation on the dataframe canvas |
| `eurostat_dataframe_describe` | List the tables staged on a dataframe canvas, with row counts and column types |
| `eurostat_dataframe_query` | Run a read-only SQL SELECT across staged tables |
| `eurostat_dataframe_drop` | Remove one staged table from a dataframe canvas, leaving its other tables in place (opt-in) |

### Resources

| Resource | Description |
|:---|:---|
| `eurostat://dataset/{dataset_code}` | Dataset metadata (dimensions, time range, observation count, last-updated) by URI |
| `skill://eurostat-guide/SKILL.md` | Statistical comparison gates, identifier provenance, and SQL analysis workflows |

The same metadata is available through `eurostat_get_dataset_info` for tool-only clients.

### Agent skill

[eurostat-guide](skills/eurostat-guide/SKILL.md) covers country and regional comparisons, Comext aggregation, missing-data interpretation, and SQL joins over staged observations. It ships with plugin, npm, Docker, and MCPB installs and is served over MCP at `skill://eurostat-guide/SKILL.md`; supporting SQL examples are included under the skill's `references/` directory.

## Capability reference

### `eurostat_search_datasets` <sub>tool</sub>

- `query` words are ANDed case-insensitively across each dataset's label, theme breadcrumb, and code, ignoring spacing beside punctuation (`Rev.2` finds `Rev. 2`); `limit` is a positive integer (default 20), clamped to 100 with a notice. Page by passing `nextCursor` back as `cursor`; cursor calls ignore `limit`
- Results carry `code`, `label`, `type` (`dataset` / `table`), period coverage, `obsCount`, `lastUpdated`, and `themePath`, with `totalMatches` across every page; fails as `no_match` (naming the words whose removal finds matches), `invalid_cursor`, or a retryable `upstream_fault` when no catalogue is loaded and Eurostat's table of contents is unreachable
- If the Comext dataflow list cannot be loaded, results carry `comextListMissing` and a `notice`; a catalogue that could not be refreshed carries `catalogueLoadedAt`

---

### `eurostat_browse_themes` <sub>tool</sub>

- Omit `theme_code` for the top-level theme folders; pass a folder code for its immediate children. Codes resolve exact-first, then case-insensitively. The Comext collections sit under `ext_go_detail` (detailed trade, in `ext_go`) and `prom` (PRODCOM, in `icts`)
- Items carry `code`, `label`, `type` (`folder` / `dataset` / `table`), and `hasChildren`, with a `parentPath` breadcrumb and `otherPlacements` for a folder filed in several branches; fails as `not_found` for an unknown code, `not_a_folder` for a dataset or table code, or a retryable `upstream_fault` when no catalogue is loaded and Eurostat's table of contents is unreachable
- If the Comext dataflow list cannot be loaded, `ext_go` and `icts` carry `comextListMissing` and a `notice`; a catalogue that could not be refreshed carries `catalogueLoadedAt`

---

### `eurostat_get_dataset_info` <sub>tool</sub>

- One `dataset_code`; returns every dimension with `valuesCount` and up to 10 `sampleValues`, plus `timeRange`, `obsCount`, `lastUpdated`, and the ESMS `metadataUrl`
- Fails as `not_found` for an unknown dataset, or `upstream_fault` when Eurostat returns a structure the server cannot read (retryable when the endpoint is down)

---

### `eurostat_get_dimension_values` <sub>tool</sub>

- `dataset_code` plus `dimension`, resolved exact-first then case-insensitively (`TIME_PERIOD` aliases `time`); returned value codes and labels stay unchanged. For `geo`, `geo_level` picks a NUTS level (`aggregate`, `country` by default, `nuts1`, `nuts2`, `nuts3`). `filter` keeps values whose code and label contain every word given, ignoring case and accents (`palma frankfurt` finds `DE_EDDF_ES_LEPA`), counted in `matchCount`
- `limit` defaults to 25 and clamps to 1,000 with a notice. Pages contain that many values, fewer at the end, with `totalCount` for the full list; a page with more after it carries `truncated`, `nextCursor` (pass back as `cursor`), and a `notice`. Continuations retain the effective count and ignore a new `limit`; older cursors above 1,000 normalize to 1,000 with disclosure. Fails as `not_found`, `no_results`, `conflicting_params`, `invalid_cursor`, `upstream_fault` (retryable when the endpoint is down), or `canvas_not_found`
- `canvas_id` stages every value on that canvas as a `code` / `label` table (`canvasId` / `tableName` / `stagedRowCount`) that labels a download's code columns through a join; it never starts a canvas of its own

---

### `eurostat_query_dataset` <sub>tool</sub>

- `dataset_code` plus `filters` (`{dimension_code: [values]}`), `geo_level`, and either `since_period` / `until_period` (`2020`, `2020-Q1`, `2020-01`, down to `YYYY-Wnn` and `YYYY-Dnnn`) or `last_n_periods`; `preview_limit` is a positive integer (default 25), clamped to 500 with a notice; `lang` is `EN`, `FR`, or `DE`
- `stage: true` stages the whole match on an available canvas, regardless of size; reuse `canvas_id` or omit it to create one. Without it, automatic staging starts above 5,000 observations. `truncated` still describes that threshold; `tableName` identifies a staged result. Canvas-disabled deployments disclose an explicit staging request as unavailable
- `last_n_periods` counts dataset time positions, which can include periods with no populated cells. A notice names gaps across the full match (up to the newest 24, with an omitted count); increase N or replace it with `until_period` to reach earlier observations
- Each observation carries code/label pairs per dimension, a nullable `value`, `status` (OBS_FLAG), and `confStatus` (CONF_STATUS); `obsCount`, `missingObsCount`, and `timeRange` cover the whole match, `truncated` is true above 5,000 observations, and `unmatchedValues` names filter values that matched nothing
- Fails as `not_found`, `no_results` (naming the unmatched values and the periods with no value), `invalid_dimension`, `invalid_period`, `conflicting_params`, a non-retryable `async_response` for a query too large to serve, `canvas_not_found`, or a retryable `upstream_fault` when the Statistics API is down

---

### `eurostat_download_dataset` <sub>tool</sub>

- `dataset_code` plus the same `filters` map and `since_period` / `until_period` (no `last_n_periods`: the TSV keeps a column per period unless a range drops it); `preview_limit` is a positive integer (default 25), clamped to 500 with a notice
- Returns `rowCount` (echoed as `totalCount`), `missingCount`, `periodRange`, and `bytesRead` for the whole download; fails as `not_found`, `invalid_dimension`, `invalid_period`, `filter_arity`, a non-retryable `async_queued` or `extraction_too_big`, `no_results`, `upstream_fault` (retryable when the SDMX endpoint is down), or `canvas_not_found`
- The `EUROSTAT_BULK_MAX_BYTES` budget (default 50 MiB decoded) retains complete observations within the permitted prefix and returns `budgetExceeded: true`. A budget too small for a complete header and usable observation fails as `byte_budget_exceeded`, with the configured limit and narrowing guidance. `bytesRead` counts accepted decoded bytes, never more than the budget; incomplete trailing rows are discarded.

---

### `eurostat_dataframe_describe` <sub>tool</sub>

- `canvas_id` from a staging response; lists each table's `name`, `rowCount`, typed columns, and `expiresAt` (sliding `CANVAS_TTL_MS`, default 24h); fails as `canvas_not_found` or `canvas_disabled`
- Columns depend on the staging tool: `eurostat_query_dataset` writes a code and a `_label` column per dimension, `eurostat_download_dataset` codes only plus `time` (both share the `obs_*` and `conf_status*` measures), and `eurostat_get_dimension_values` writes `code` and `label`

---

### `eurostat_dataframe_query` <sub>tool</sub>

- One read-only `SELECT` per call; chained statements, other verbs, and functions that read files or external data are rejected
- Returns `columns`, `rows`, `rowCount`, and required boolean `truncated`. Every row supplied by the canvas is returned intact, up to `CANVAS_DEFAULT_ROW_LIMIT` (default 10,000). Cells render as lossless JSON, including nesting and quoted strings; 64-bit integers arrive as strings. Fails as `missing_table`, `canvas_not_found`, or `canvas_disabled`
- A cut sets `truncated: true` and adds a notice. Page an unchanged deterministic SELECT with a total `ORDER BY` (tie-breakers required), `LIMIT` and `OFFSET`; advance by actual `rowCount`. Restart an initially unordered result sorted at offset zero. Volatile SQL and changing or expired tables cannot provide stable paging

---

### `eurostat_dataframe_drop` <sub>tool</sub>

- `canvas_id` plus `table_name`, exactly as `eurostat_dataframe_describe` lists it; removes that one table and leaves the canvas and its other tables in place. Listed only when `EUROSTAT_DATAFRAME_DROP_ENABLED=true` is set beside the canvas
- Returns `canvasId`, `tableName`, `dropped`, and `expiresAt`; `dropped` is `false`, with a `notice`, when nothing by that name was staged, so repeating a drop is safe. Fails as `canvas_not_found`, `identifier_reserved`, or `canvas_disabled`

---

### `eurostat://dataset/{dataset_code}` <sub>resource</sub>

- Same payload as `eurostat_get_dataset_info`, returned as `application/json`; a failed read carries the same `reason`, and `retryable` on an outage
- `dataset_code` comes from `eurostat_search_datasets` or `eurostat_browse_themes`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Eurostat-specific:

- The Statistics API (JSON-stat 2.0) for slices, the SDMX 2.1 TSV bulk endpoint for whole datasets at roughly half the bytes, and the catalogue TOC cached in memory for 12 hours
- The Comext host's `DS-*` collections (detailed trade by CN8, HS, SITC, BEC and CPA, and PRODCOM) through the same tools. Filter every request, `freq` included, since trade flows mix annual and monthly series; aggregates such as `TOTAL`, `EU27_2020`, and `EXT_EU27_2020` double-count when summed with their members. PRODCOM text values arrive in `valueText` / `obs_value_text`
- NUTS geo-level filtering (`aggregate` / `country` / `nuts1` / `nuts2` / `nuts3`), and OBS_FLAG and CONF_STATUS decoded into separate fields
- Too-large-to-serve responses come back as non-retryable `async_response`, `extraction_too_big`, or `async_queued` errors that name the dimensions left to filter
- A query with `stage: true`, a match above 5,000 observations, or any bulk download is staged as a SQL table (`canvasId` / `tableName` / `stagedRowCount`) on the DuckDB dataframe canvas, which is on by default. The `.mcpb` bundle strips the native DuckDB binding and runs with `CANVAS_PROVIDER_TYPE=none`, so SQL analytics need the npm, Docker, or from-source install

Agent-friendly output:

- Typed error contracts: every declared failure carries a `reason` and a `recovery.hint` naming the next tool to call
- Next-step hints: `eurostat_search_datasets` and `eurostat_browse_themes` return a `nextStep` pointing at the follow-up call
- Unknown stays unknown: counts and period bounds Eurostat doesn't report (`obsCount`, `timeRange.start` / `end`, `lastUpdated`) are omitted rather than zeroed
- Effective-query echo: `appliedFilters` on `eurostat_query_dataset` and `appliedQuery` (with the SDMX `url`) on `eurostat_download_dataset`, plus a `notice` when the preview omits rows

## Getting started

Connect to the hosted instance:

```sh
claude mcp add --transport http eurostat-mcp-server https://eurostat.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add eurostat-mcp-server -- npx -y @cyanheads/eurostat-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "eurostat-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/eurostat-mcp-server"]
    }
  }
}
```

No API key is required. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `EUROSTAT_BASE_URL` | Eurostat API base URL. | `https://ec.europa.eu/eurostat/api/dissemination` |
| `EUROSTAT_COMEXT_BASE_URL` | Comext dissemination host, which serves every `DS-*` dataset code (detailed trade and PRODCOM). | `https://ec.europa.eu/eurostat/api/comext/dissemination` |
| `EUROSTAT_REQUEST_TIMEOUT_MS` | Total allowance for one request, including retries, backoff and body reads, in ms. | `30000` |
| `EUROSTAT_METADATA_TIMEOUT_MS` | Total allowance for one dataset's SDMX dataflow structure, including retries, backoff and body reads, in ms. | `120000` (2 min) |
| `EUROSTAT_TOC_CACHE_TTL_MS` | Catalogue TOC cache lifetime, in ms. | `43200000` (12 h) |
| `EUROSTAT_BULK_TIMEOUT_MS` | Total allowance for one bulk transfer, including request retries, backoff and streaming, in ms. | `120000` (2 min) |
| `EUROSTAT_BULK_MAX_BYTES` | Byte budget for one bulk download. | `52428800` (50 MiB) |
| `CANVAS_PROVIDER_TYPE` | Dataframe canvas backend; `none` disables the canvas and its tools. The `.mcpb` bundle sets `none`. | `duckdb` |
| `CANVAS_TTL_MS` | Sliding lifetime of a staged canvas, in ms. | `86400000` (24 h) |
| `CANVAS_DEFAULT_ROW_LIMIT` | Max complete rows one `eurostat_dataframe_query` returns before reporting `truncated`. | `10000` |
| `EUROSTAT_CLAMP_LIMITS` | Clamp positive integer preview/search/dimension limits to 500/100/1,000 with a notice. `false` restores schemas rejecting over-cap inputs; zero, negatives, fractions and nonnumeric inputs are always rejected. Each clamp logs once and increments `eurostat.limit_clamps`, labelled by tool. | `true` |
| `EUROSTAT_DATAFRAME_DROP_ENABLED` | `true` lists `eurostat_dataframe_drop`; no effect with `CANVAS_PROVIDER_TYPE=none`. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. The server declares `stateless`; a set value overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). The Docker image sets `info`. | `debug` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

```sh
git clone https://github.com/cyanheads/eurostat-mcp-server.git
cd eurostat-mcp-server && bun install
cp .env.example .env # optional; every setting has a default
```

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
docker run --rm -p 3010:3010 ghcr.io/cyanheads/eurostat-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/eurostat-mcp-server`. For stdio, use `docker run -i --rm -e MCP_TRANSPORT_TYPE=stdio ghcr.io/cyanheads/eurostat-mcp-server:latest`. Build locally with `docker build -t eurostat-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and the resource, inits services, gates the dataframe tools on the canvas and the drop tool on its own flag. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six discovery and data tools, plus three canvas-gated dataframe tools, one of them opt-in. |
| `src/mcp-server/resources` | Resource definitions. Dataset metadata resource. |
| `src/services/eurostat-catalogue` | Catalogue service — fetches and parses the Eurostat TOC, merges the Comext dataflow list into it, with a TTL-bounded in-memory cache. |
| `src/services/eurostat-data` | Statistics API service — SDMX metadata parsing with a per-dataset cache, JSON-stat 2.0 decoding, async-response detection, canvas row source. |
| `src/services/eurostat-bulk` | SDMX 2.1 TSV bulk service — streaming download, byte budget, SOAP fault mapping, canvas row source. |
| `src/services/eurostat-codelists.ts` | OBS_FLAG and CONF_STATUS codelists, the measure column names both stagers write, and the text-value decoder. |
| `src/services/eurostat-hosts.ts` | Which host serves a dataset code: `DS-*` to the Comext host, everything else to the main one. |
| `src/services/canvas-accessor.ts` | Accessor for the optional DataCanvas and the acquire helper canvas-touching tools share. |
| `src/services/shared-load.ts` | Lets concurrent callers await one shared download, so one caller's cancellation releases only that caller. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `skills/` | Published eurostat-guide and SQL reference, served over MCP and included in installation packages. |
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
