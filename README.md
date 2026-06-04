<div align="center">
  <h1>@cyanheads/eurostat-mcp-server</h1>
  <p><b>Search and query 8,933 Eurostat datasets — EU economy, demography, trade, health, and NUTS regional data via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.1.11-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/eurostat-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/eurostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/eurostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

5 tools for discovering and querying Eurostat statistical datasets:

| Tool | Description |
|:---|:---|
| `eurostat_search_datasets` | Search the Eurostat catalogue (8,933 datasets) by keyword — returns codes, descriptions, period coverage, and theme breadcrumbs |
| `eurostat_browse_themes` | Navigate the Eurostat theme hierarchy — list root themes or drill into subthemes and datasets |
| `eurostat_get_dataset_info` | Fetch metadata for a dataset: dimensions with sample values, time range, observation count, and last-update date |
| `eurostat_get_dimension_values` | List all valid codes for a specific dimension (e.g., all geo codes, all unit codes); supports NUTS hierarchy filtering |
| `eurostat_query_dataset` | Fetch decoded statistical observations with dimension filters, NUTS geo-level, and time-range controls |

### `eurostat_search_datasets`

Search the Eurostat dataset catalogue by keyword.

- Case-insensitive substring match against dataset labels across 8,933 datasets
- Returns code, label, type (dataset/table), period coverage, observation count, and theme breadcrumb
- Configurable result limit (1–100, default 20); reports total matches before the limit
- Catalogue loaded once per session from the Eurostat TOC file
- Pair with `eurostat_browse_themes` for structured domain exploration when keywords are unclear

---

### `eurostat_browse_themes`

Navigate the Eurostat theme tree.

- Without `theme_code`: returns the 11 top-level themes (Economy and finance, Population, Transport, etc.)
- With `theme_code`: returns immediate children — subtheme folders and datasets in that branch
- Each entry includes code, label, type (folder/dataset/table), data period, and observation count where available
- Returns a breadcrumb path from root to the current node
- Use for structured discovery when you know the domain but not the exact dataset code

---

### `eurostat_get_dataset_info`

Fetch metadata for a Eurostat dataset before querying it.

- Returns all dimensions with their codes, labels, and up to 10 sample values each
- Reports overall time range and total observation count across all periods
- Uses a minimal Statistics API call (most recent period only) for efficiency
- For dimensions with more than 10 values, use `eurostat_get_dimension_values` for the full list
- Provides a link to the ESMS metadata page when available

---

### `eurostat_get_dimension_values`

List all valid values for a specific dataset dimension.

- Retrieves the complete set of valid codes and labels for any dimension (unit, na_item, geo, etc.)
- For the `geo` dimension, supports NUTS hierarchy filtering: `aggregate` (EU/EA totals), `country` (41 states), `nuts1` (127 major regions), `nuts2` (309 basic regions), `nuts3` (1,343 small regions)
- Prevents silent no-data returns — invalid dimension values in `eurostat_query_dataset` return nothing without error; verify codes here first

---

### `eurostat_query_dataset`

Fetch statistical data from a Eurostat dataset.

- Accepts dimension filters as a map of `{dimension_code: [value1, value2, ...]}`
- NUTS geo-level filter (`aggregate`, `country`, `nuts1`, `nuts2`, `nuts3`) — mutually exclusive with a `geo` key in filters
- Time range via `since_period`/`until_period` (e.g., `"2020"`, `"2023-Q1"`) or `last_n_periods` for the N most recent
- Returns decoded observations with dimension codes and labels, numeric values, and status flags (`p` = provisional, `e` = estimated, etc.)
- Reports total observation count, missing value count, and effective time range of the result
- Async-response detection — large unfiltered queries return an actionable error with filter guidance rather than silently timing out

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

- Session-level in-memory cache for the TOC file — loaded once, reused across all search and browse calls
- JSON-stat 2.0 stride-based decoder for the Statistics API response format
- Async-response detection — Eurostat returns a warning object rather than an error for over-limit queries; the server intercepts it and returns an actionable error with filter guidance
- NUTS hierarchy geo-level filtering across query and dimension-value tools
- Status flag decoding (provisional, estimated, definition differs, etc.)

Agent-friendly output:

- Discovery workflow: `eurostat_search_datasets` / `eurostat_browse_themes` → `eurostat_get_dataset_info` → `eurostat_get_dimension_values` → `eurostat_query_dataset`
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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Five tools for discovery and data access. |
| `src/mcp-server/resources` | Resource definitions. Dataset metadata resource. |
| `src/services/eurostat-catalogue` | Catalogue service — fetches and parses the Eurostat TOC TXT file; session-level in-memory cache. |
| `src/services/eurostat-data` | Data service — Statistics API HTTP client, JSON-stat 2.0 decoder, async-response detection. |
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
