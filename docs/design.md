# eurostat-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `eurostat_search_datasets` | Search the Eurostat catalogue by keyword (whitespace tokens ANDed across label, theme breadcrumb, and code, ignoring spacing beside punctuation in the catalogue). Returns matching datasets with codes, descriptions, and period coverage; cursor-paginated. A zero match names each word whose removal alone finds matches. | `query`, `limit`, `cursor?` | `readOnlyHint: true` |
| `eurostat_browse_themes` | List the Eurostat theme hierarchy. At root returns the second-level theme folders (Economy, Population, Transport, etc.) — the practical entry points for navigation. With a `theme_code` returns its immediate children (subthemes and datasets). Enables tree-navigation for dataset discovery without text search. | `theme_code?` | `readOnlyHint: true, openWorldHint: true` |
| `eurostat_get_dataset_info` | Fetch metadata for a dataset: dimensions, their codes and descriptions, time range, obs count, and last-updated date. The prerequisite call before querying data — reveals what `unit`, `na_item`, and other dimension values are valid. | `dataset_code` | `readOnlyHint: true` |
| `eurostat_get_dimension_values` | List valid values for a dataset dimension, with code/label word filtering and count-based cursor pages (default 25, cap 1,000). With `canvas_id`, also stage the full list as a `code`/`label` table to label a code-only bulk table through a join. | `dataset_code`, `dimension`, `geo_level?`, `filter?`, `limit?`, `cursor?`, `canvas_id?` | `readOnlyHint: true` |
| `eurostat_query_dataset` | Fetch a deterministic preview of decoded observations plus full-match metadata. Supports NUTS hierarchy filtering and stages the whole match with `stage: true` or above 5,000 observations when a canvas is configured. | `dataset_code`, `filters{}`, `geo_level?`, `since_period?`, `until_period?`, `last_n_periods?`, `preview_limit?`, `lang?`, `canvas_id?`, `stage?` | `readOnlyHint: true` |
| `eurostat_download_dataset` | Download a whole dataset through the SDMX 2.1 TSV bulk endpoint, expand the wide layout into one row per observation, and stage them on the dataframe canvas when one is configured. Server-side filtering via the positional dimension key; a streaming byte budget bounds the transfer. | `dataset_code`, `filters{}`, `since_period?`, `until_period?`, `preview_limit?`, `canvas_id?` | `readOnlyHint: true` |
| `eurostat_dataframe_describe` | List the tables staged on a dataframe canvas with their row counts and column names and types. Registered only when the canvas is enabled. | `canvas_id` | `readOnlyHint: true` |
| `eurostat_dataframe_query` | Run a single read-only SQL `SELECT` across the staged tables. Registered only when the canvas is enabled. | `canvas_id`, `sql` | `readOnlyHint: true` |
| `eurostat_dataframe_drop` | Remove one staged table from a canvas, leaving the canvas and its other tables in place; `dropped: false` when nothing by that name is staged. Registered only when the canvas is enabled and `EUROSTAT_DATAFRAME_DROP_ENABLED` opts in. | `canvas_id`, `table_name` | `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `eurostat://dataset/{dataset_code}` | Dataset metadata — dimensions, time range, obs count, last updated. Same data as `eurostat_get_dataset_info`. | No |
| `skill://eurostat-guide/SKILL.md` | Published statistical interpretation and SQL workflow guide; its relative SQL reference is readable under the same skill URI. | No |

The guide lives under `skills/eurostat-guide/`, ships in npm, Docker and the desktop bundle, and is registered through `createApp({ skills: 'skills' })`. Short server instructions retain discovery and staging gates; the guide carries comparability, missingness and query-grain guidance without duplicating tool schemas.

### Prompts

None. The domain is data retrieval; the workflow is well-served by the tools themselves.

---

## Overview

eurostat-mcp-server exposes Eurostat — the European Union's central statistical office — as an MCP server. It covers EU-wide and member-state-level statistics across economy, demography, trade, labour, environment, and science, plus NUTS sub-national regional data at levels 1–3 (major regions down to local areas). The server wraps three Eurostat interfaces: the Statistics API (JSON-stat 2.0) for data queries, SDMX 2.1 structure and data endpoints for dataset metadata and whole-dataset TSV downloads, and the Catalogue API (TOC TXT) for dataset discovery. They are served from two hosts: the main dissemination host, and the Comext dissemination host for the `DS-*` detailed-trade (CN8, HS, SITC, BEC, CPA) and PRODCOM collections the main host does not carry. No authentication is required.

Target users: economic researchers comparing EU countries or regions, journalists covering EU policy and economics, business analysts evaluating European markets, and policy researchers — particularly those pairing this server with BLS (US) or World Bank (global) for multi-region analysis.

---

## Requirements

- Read-only; no writes to Eurostat. The one mutation is the opt-in drop of a table this server staged on its own canvas
- Dataset discovery by keyword search across the Eurostat catalogue
- Theme tree navigation (second-level theme folders as practical root, hierarchical subthemes)
- Dataset metadata: dimensions, valid dimension values, time range, obs count
- Data queries filtered by any combination of dimensions (geo, time, unit, na_item, etc.)
- `geoLevel` support: `aggregate`, `country`, `nuts1`, `nuts2`, `nuts3`
- NUTS region granularity for sub-national analysis (127 NUTS1, 309 NUTS2, 1343 NUTS3 regions)
- JSON-stat 2.0 response parsing — flat numeric index decoded to labeled observations
- Observation `OBS_FLAG` status preserved (e.g., `p` = provisional, `e` = estimated), and the `CONF_STATUS` confidentiality marker (`C`, `N`, `P`) kept in its own field rather than folded into the status
- Async response handling: Eurostat returns `{"warning": {"status": 413, "label": "ASYNCHRONOUS_RESPONSE..."}}` for very large queries; the server surfaces this as a recoverable error with guidance to filter more tightly
- No rate limit headers observed; generous public API — standard retry with backoff on 5xx, and an outage that outlasts it reported as one, distinct from a fault in the request (see **Outage handling**)

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `EurostatCatalogueService` | Catalogue API: TOC TXT (`/catalogue/toc/txt`), plus the Comext host's dataflow list (`/sdmx/2.1/dataflow/ESTAT`) merged into it | `search_datasets`, `browse_themes` |
| `EurostatDataService` | Dataset-scoped SDMX structure (`/sdmx/2.1/dataflow` + `/contentconstraint`, and `/datastructure` for key order) and Statistics API (`/statistics/1.0/data/{code}`) | `get_dataset_info`, `get_dimension_values`, `query_dataset`, and `download_dataset` for the dimension order its positional key needs |
| `EurostatBulkService` | SDMX 2.1 dissemination API (`/sdmx/2.1/data/{code}[/{key}]?format=TSV`) | `download_dataset` |

`EurostatCatalogueService` fetches and parses the full TOC on first use — a ~2 MB TSV file, updated twice daily at 11:00 and 23:00 Europe/Brussels time. The parsed index is held in memory for `EUROSTAT_TOC_CACHE_TTL_MS` (default 12 hours) and reused by every search and browse call in that window, so neither tool pays per-query network overhead. The first call past the TTL refreshes it; concurrent callers share that one refresh, and a failed refresh keeps serving the last loaded TOC.

`EurostatDataService` combines a dataset's SDMX dataflow descendants with its content constraint for metadata and dimension values. Observation queries still use the Statistics API; JSON-stat 2.0 responses are decoded via stride-based indexing into labeled `{dimCode, dimLabel, value, status?, confStatus?, valueText?}` observations.

**Host routing.** One predicate, `isComextDataset` in `services/eurostat-hosts.ts`, sends every dataset code starting `DS-` (in any case) to `EUROSTAT_COMEXT_BASE_URL` and everything else to `EUROSTAT_BASE_URL`; every dataset-scoped URL builder — the Statistics URL, the three SDMX structure URLs, the TSV URL — asks it. The split is clean: all 11 Comext dataflows are `DS-\d{6}`, and none of the main host's 8,149 dataflow ids starts with `DS-`. Each host answers the other's codes with the same `not_found` shapes it gives an unknown code.

**Metadata cache.** Parsed dataflow-plus-constraint metadata is held per dataset for an hour, keyed by host and lowercased code, within a 64 MiB budget on the estimated size of the held values, least recently used evicted first; a dataset estimated past the whole budget is answered but not kept. The bound is on size because entries span three orders of magnitude: a main-host dataset holds a few KB, `DS-045409` 13.5 MB of retained heap (measured). The parse is copied out of the response bodies before it is cached — its strings are slices of them, and a slice keeps its source alive, so a `DS-045409` entry otherwise pins the 23 MB dataflow body and retains 52 MB. The map holds the in-flight promise, so concurrent first calls share one download; a failed load is dropped, not cached. That shared load runs without any caller's abort signal, bounded by its timeouts: a caller that cancels stops waiting at once, while the others and the cache still get the result. The catalogue's TOC refresh and Comext merge are shared the same way. Entries are deep-frozen, and `getDatasetInfo` returns a copy stamped with the caller's own spelling of the code, so no caller can change what the next one reads.

Parsing is DOM-style: the first load of `DS-045409` builds its 23 MB body into a node tree, and resident memory grows by about 210 MB while it does. The tree is garbage once the parse is copied out, but the process keeps the resident memory it grew.

`EurostatBulkService` streams the SDMX endpoint rather than buffering it: the response body is sniffed for gzip, bounded by a byte budget applied to decoded bytes as they arrive, classified as data or as an XML fault/queue envelope, and then expanded from the wide TSV layout into one row per populated cell by a generator the caller hands straight to the canvas.

**Outage handling.** Every request to Eurostat goes through the framework's `withRetry`: four attempts, with backoff of 1 s, 2 s and 4 s between them, each up to 25% longer or shorter with jitter. An outage is an HTTP 5xx answer or a host that could not be reached; one that outlasts the retries is classified once, in `services/eurostat-outage.ts`, as `upstream_fault` (ServiceUnavailable) marked `retryable: true`, with `status` when Eurostat answered and a message naming the endpoint, the request, and the attempt count. HTTP 501 is the exception: the fetch layer marks it deterministic, so it fails on its first attempt marked `retryable: false`. Each tool turns a retryable `upstream_fault` into a hint that names the endpoint and the status (or the unreachable host), says the outage is on Eurostat's side rather than in the request, and says to retry in a few minutes. Several things are deliberately not outages:

- A body naming a failure this server models wins over the status it arrived on: a Statistics API error array or a bulk SOAP fault on a 5xx keeps its own reason, on one attempt. An unmodelled body on a 5xx — an HTML or XML error page, a JSON error naming nothing modelled — is the outage itself.
- A body that cannot be read on a 2xx (a truncated structure, an HTML page answered with HTTP 200) keeps its existing handling, with no `retryable` flag. On `get_dataset_info`, `get_dimension_values` and `download_dataset` that is the `upstream_fault` hint about an unreadable body; on `query_dataset` and the catalogue it stays a reasonless `ServiceUnavailable` after the retries.
- A timeout, a 404, and a caller cancellation keep their own outcomes. A call whose signal aborted is never reported as an outage, whatever its last attempt saw.

| Path | Endpoint | Attempts on an outage | Backoff |
|:-----|:---------|:----------------------|:--------|
| `get_dataset_info`, `get_dimension_values`, the resource | SDMX structure: dataflow and content constraint, read in parallel | 4 each | 5.25–8.75 s |
| `download_dataset` with filters, the too-large hint's dimension read | SDMX structure: data structure definition | 4 | 5.25–8.75 s |
| `query_dataset` | Statistics API | 4 | 5.25–8.75 s |
| `download_dataset` | SDMX data (TSV) | 4, the request only | 5.25–8.75 s |
| `search_datasets`, `browse_themes`, cold start only | Catalogue table of contents | 4 | 5.25–8.75 s |

Each request's configured allowance bounds its whole retry ladder, including attempts, backoff, Retry-After and body consumption: 30 s by default for Statistics, structure definitions, content constraints and catalogue loads; 120 s for the metadata dataflow and bulk transfer. Deadline expiry remains Timeout with `retry_deadline_exceeded`; caller cancellation keeps precedence. Shared metadata and catalogue loads own detached deadlines, so cancelling a waiter leaves the cache fill and other waiters running. The Comext list retains its single-attempt policy. A filtered bulk call first reads the structure under its own request allowance, then starts the separately budgeted bulk transfer. The successful bulk request's body timer receives only the allowance left after retries; a timeout or streaming failure never restarts the transfer. Once a catalogue is loaded, a failed refresh serves that copy instead, and a failed Comext merge never fails a call. The dataset resource carries service error data without a tool recovery hint.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `EUROSTAT_BASE_URL` | No | Override API base URL (default: `https://ec.europa.eu/eurostat/api/dissemination`) |
| `EUROSTAT_COMEXT_BASE_URL` | No | Comext dissemination host, serving every `DS-*` dataset code (default: `https://ec.europa.eu/eurostat/api/comext/dissemination`) |
| `EUROSTAT_REQUEST_TIMEOUT_MS` | No | Total request allowance across retries, backoff and body reads in ms (default: `30000`) |
| `EUROSTAT_METADATA_TIMEOUT_MS` | No | Total SDMX dataflow allowance across retries, backoff and body reads in ms, held separate because it carries every code's label — 23 MB for `DS-045409` (default: `120000` — 2 minutes) |
| `EUROSTAT_TOC_CACHE_TTL_MS` | No | How long a fetched catalogue TOC stays usable before the next catalogue call refreshes it, in ms (default: `43200000` — 12 hours) |
| `EUROSTAT_BULK_TIMEOUT_MS` | No | Total bulk allowance across request retries, backoff and streaming in ms (default: `120000` — 2 minutes) |
| `EUROSTAT_BULK_MAX_BYTES` | No | Byte budget for one `download_dataset` transfer, counted on the decoded TSV and enforced while streaming (default: `52428800` — 50 MiB) |
| `CANVAS_PROVIDER_TYPE` | No | Dataframe canvas backend. With `duckdb`, `dataframe_describe` and `dataframe_query` are callable, `query_dataset` stages with `stage: true` or above 5,000 observations, and `download_dataset` retains a bulk download beyond its preview; `none` disables all of that. The `.mcpb` manifest sets `none` (default: `duckdb`) |
| `CANVAS_TEMP_PATH` | No | Parent directory for DuckDB spill files; the provider creates a private `mcp-canvas-XXXXXX` directory inside it, so it must be writable by the server process (default: the OS temp directory) |
| `CANVAS_TTL_MS` | No | Sliding lifetime of a staged canvas in ms (default: `86400000` — 24 hours) |
| `CANVAS_DEFAULT_ROW_LIMIT` | No | Max complete rows one `dataframe_query` response carries (default: `10000`) |
| `EUROSTAT_CLAMP_LIMITS` | No | Clamp positive integer preview/search/dimension limits to 500/100/1,000 with a notice. `false` restores rejecting maximum schemas; parsed with `z.stringbool()` (default: `true`) |
| `EUROSTAT_DATAFRAME_DROP_ENABLED` | No | `true` makes `dataframe_drop` callable; has no effect with `CANVAS_PROVIDER_TYPE=none`. Parsed with `z.stringbool()`, so `false` disables and an unrecognised value fails startup (default: `false`) |

No API keys required. The canvas variables are framework-owned (`@cyanheads/mcp-ts-core`), not part of this server's own Zod config schema; the framework defaults `CANVAS_PROVIDER_TYPE` to `none`, and `src/index.ts` sets `duckdb` when it is unset or empty. `@duckdb/node-api` is a runtime dependency, so every install and the published image already carry the binding and `CANVAS_PROVIDER_TYPE` is the only switch.

---

The limit policy is selected before tool registration. Previews default to 25 and clamp to 500; searches default to 20 and clamp to 100; dimension pages default to 25 and clamp to 1,000. `EUROSTAT_CLAMP_LIMITS=false` restores rejecting maximum schemas. Zero, negative, fractional, non-finite and nonnumeric limits remain invalid. One log and one `eurostat.limit_clamps` counter increment, labelled by tool, record each clamp. Requested and applied values join existing notices. Cursor calls ignore a supplied limit without recording a clamp; legacy dimension cursors above 1,000 normalize once to 1,000 with disclosure. Integer validation uses `multipleOf(1)` for default-on count inputs and `last_n_periods`, avoiding an advertised safe-integer maximum.

## Implementation Order

1. Config and server setup (`server-config.ts` with the two optional env vars)
2. `EurostatCatalogueService` — fetch/parse/cache TOC, implement search + tree traversal
3. `eurostat_search_datasets` + `eurostat_browse_themes` tools (catalogue layer)
4. `EurostatDataService` — HTTP client, JSON-stat parser, retry logic
5. `eurostat_get_dataset_info` tool (combine dataset-scoped SDMX dataflow descendants with the dataset content constraint)
6. `eurostat_get_dimension_values` tool
7. `eurostat_query_dataset` tool
8. `eurostat://dataset/{code}` resource

Each step is independently testable.

---

## Domain Mapping

### Eurostat Data Model

Every Eurostat dataset is identified by a **dataset code** (e.g., `nama_10_gdp`). Data lives in a multi-dimensional hypercube. The **dimensions** describe how values are indexed:

| Dimension concept | Typical dimension code | Example values |
|:-----------------|:----------------------|:---------------|
| Time frequency | `freq` | `A` (annual), `Q` (quarterly), `M` (monthly) |
| Geographic entity | `geo` | `DE`, `FR`, `BE10` (NUTS2), `DE1` (NUTS1) |
| Time period | `time` | `2023`, `2024-Q1`, `2024-01` |
| Unit of measure | `unit` | `CP_MEUR`, `PPS_HAB`, `PC_GDP` |
| National accounts item | `na_item` | `B1GQ` (GDP), `P3` (final consumption) |
| Subject dimension | varies | dataset-specific (e.g., `sex`, `age`, `nace_r2`) |

Dimension codes differ across datasets. `get_dataset_info` is the required first step before querying.

### NUTS Hierarchy

NUTS (Nomenclature of Territorial Units for Statistics) defines the regional geographic hierarchy:

| Level | `geoLevel` param | Code length | Example | Count |
|:------|:----------------|:------------|:--------|:------|
| EU aggregates | `aggregate` | varies | `EU27_2020`, `EA` | ~50 |
| Country | `country` | 2 | `DE`, `FR` | ~41 |
| Major regions | `nuts1` | 3 | `DE1` (Baden-Württemberg) | 127 |
| Basic regions | `nuts2` | 4 | `DE11` (Stuttgart) | 309 |
| Small regions | `nuts3` | 5 | `DE111` (Stuttgart, Stadt) | 1,343 |

Not every dataset has sub-national data. NUTS data is concentrated in the `reg` theme branch.

### Nouns and Operations

| Noun | Operations |
|:-----|:-----------|
| Theme / folder | browse (tree navigation by code), list children |
| Dataset | search by text, get metadata, browse by theme |
| Dimension | list values (for a dataset-specific dimension) |
| Observation | query (filter by dimension values, time range, geo level) |

---

## API Reference

### Statistics API

Base: `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{datasetCode}`

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `format` | string | Must be `JSON` |
| `lang` | string | `EN`, `FR`, `DE` (default: `EN`) |
| `{dim}={value}` | string | Dimension filter; repeat param name for multiple values (e.g., `geo=DE&geo=FR`) |
| `geoLevel` | string | `aggregate`, `country`, `nuts1`, `nuts2`, `nuts3`. Mutually exclusive with `geo` |
| `sinceTimePeriod` | string | Start of time range |
| `untilTimePeriod` | string | End of time range |
| `lastTimePeriod` | integer | N most recent periods |

**Response:** JSON-stat 2.0. Key fields:
- `id`: ordered list of dimension names (e.g., `["freq","unit","na_item","geo","time"]`)
- `size`: element count per dimension (same order as `id`)
- `value`: flat dict `{linear_index: numeric_value}`. Index computed via stride-based addressing: `Σ(pos[i] × stride[i])` where `stride[i] = Π(size[j])` for all `j > i`
- `dimension[name].category.index`: maps `code → position_in_dimension`
- `dimension[name].category.label`: maps `code → human_label`
- `status`: maps `linear_index (as string key) → status_code` (only for non-normal observations; absent from the response entirely when all observations are normal)
- `extension.status.label`: maps `status_code → status_description` (e.g., `{"p": "provisional", "d": "definition differs (see metadata)"}`)
- `extension.annotation`: array of `{type, title?, date?, href?}` objects with dataset-level metadata. Key types and their field: `OBS_COUNT` → `title` (string, parse to integer); `OBS_PERIOD_OVERALL_OLDEST/LATEST` → `title` (string); `UPDATE_DATA` → `date` (ISO 8601 string); `ESMS_HTML` → `href` (metadata URL); `DISSEMINATION_TIMESTAMP_DATA` → `date`

**Async responses** (very large queries): either HTTP 200 with `{"warning":{"status":413,"label":"ASYNCHRONOUS_RESPONSE..."}}`, or HTTP 413 with the same condition in `error[]`. Both are normalized to non-retryable `async_response` before retry logic can repeat the request. Add dimension filters to reduce the result size.

**Error format:** `{"error":[{"status":404,"id":100,"label":"ERR_NOT_FOUND_4: ..."}]}`. Status determines id-100 semantics: HTTP/status 404 is `not_found`; status 200 with id 100 and label `NO_RESULTS` is a valid dataset/query with no matching observations and maps to `no_results`. Error id 150 under status 400 remains `invalid_dimension`. A status-400 label saying time parameters (`TIME`, `TIME_PERIOD`, `*TimePeriod`) "cannot be set at the same time" — two time selections, such as `time` beside `time_period` — maps to `conflicting_params` with a one-time-selection hint, checked first because it also names `sinceTimePeriod`/`untilTimePeriod`; the same wording about `geo` and `geoLevel` takes the generic `conflicting_params` below. A message quoting a label closes it with one period, whether or not Eurostat sent one. A status-400 error with id 140 (`TIME_PERIOD_FILTER_SPEC_INVALID`) or a label naming `sinceTimePeriod`/`untilTimePeriod` is a period the API refused and maps to `invalid_period`; any other status-400 error maps to `conflicting_params`.

### SDMX 2.1 Dataset Structure API

Metadata uses two dataset-scoped XML responses:

- `GET /sdmx/2.1/dataflow/ESTAT/{dataset}/1.0?references=descendants&detail=referencepartial` — dataflow label and annotations, ordered DSD dimensions, concepts, and partial codelists with labels
- `GET /sdmx/2.1/contentconstraint/ESTAT/{dataset}/1.0` — the actual dataset-available positions for every dimension, including `TIME_PERIOD`

The service joins the DSD's codelist references to the constraint codes, normalizes `TIME_PERIOD` to the public `time` dimension code, and keeps constraint order. `get_dataset_info` samples the first 10 constrained values per dimension; `get_dimension_values` returns the full constrained set. This is deliberately dataset-scoped: there is no fallback to the global codelists, whose value sets are broader than a specific dataset.

A third structure read serves `download_dataset`'s positional key alone: `GET /sdmx/2.1/datastructure/ESTAT/{dataset}`, the dataset's structure definition with no codelists — 8 KB for `earn_ses_annual`. Its `DimensionList` gives the key dimensions by `position`, `TimeDimension` excluded. It is requested **unversioned**, which Eurostat answers with the current definition: the version moves with the dataset (`earn_ses_annual` is at 22.0), and a pinned `/1.0` returns the dataset's first structure from 2021. Every structure URL is built in one place, `buildSdmxUrl`, so the host a structure read goes to is decided there.

### SDMX 2.1 Bulk Data API (TSV)

Base: `https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data/{datasetCode}[/{key}]`

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `format` | string | `TSV` for the wide tab-separated layout. Omitted, the endpoint returns SDMX-ML. |
| `{key}` (path) | string | Positional dimension filter, dot-separated, **one position per dimension in dataset order excluding `time`**. Empty means wildcard, `+` means OR: `A..B1G.AT+DE`. The count must match exactly — one position too few or too many is faultcode 140, and an all-wildcard key of the right arity (`...`) is accepted. |
| `startPeriod` / `endPeriod` | string | Period range. These remove period **columns** from the response. |
| `lastNObservations` / `firstNObservations` | integer | Accepted, but they keep the full period header and blank the unselected cells — measured at ~3× the equivalent JSON-stat body. Not used by this server. |
| `geoLevel`, `detail` | — | Silently ignored; there is no SDMX equivalent of the NUTS-level filter. |

**Dimension order** for the key comes from the dataset's structure definition (`datastructure/ESTAT/{dataset}`, above): its key dimensions sorted by `position`, `TIME_PERIOD` excluded. Verified against live TSV headers (`nama_10_gdp`, `sts_inpr_m`, the 8-dimension `earn_ses_annual`) and against the JSON-stat `id` array on nine datasets: the header's comma-joined key field is exactly that order.

**Response body** — wide TSV, CRLF line endings:

```text
freq,unit,na_item,geo\TIME_PERIOD⇥2022 ⇥2023 ⇥2024 ␍␊
A,CP_MEUR,B1G,AT⇥402767.1 ⇥429634.3 ⇥443546.0 ␍␊
A,CP_MEUR,B1G,DE⇥3591874.0 p⇥3853937.0 p⇥3921311.0 p␍␊
```

- The header's first field is the comma-joined dimension list with `\TIME_PERIOD` appended; the remaining tab-separated fields are period codes, each padded with a trailing space.
- A cell is `<value>` `SPACE` `<obs_flag>[@<conf_status>]`, with either flag part possibly empty. `:` is a value Eurostat reports as unavailable; a wholly empty cell is not an observation at all. `: @C` is a missing value carrying `CONF_STATUS=C` and no observation flag — confirmed by requesting the same slice as SDMX-CSV, where those rows come back as `,,C` in `OBS_VALUE,OBS_FLAG,CONF_STATUS`.
- `OBS_FLAG` codes are composite, not decomposable: `bdep` is one code meaning "break in time series, definition differs, estimated, provisional". The static dictionary is `sdmx/2.1/codelist/ESTAT/OBS_FLAG`, all 42 codes, labels verbatim. `CONF_STATUS` is `sdmx/2.1/codelist/ESTAT/CONF_STATUS` — `C` (confidential), `N`, `P`. JSON-stat publishes no `CONF_STATUS` field and folds the same marker into the observation status behind a `|`: a confidential cell arrives as `|C`, labelled `|confidential`. No `OBS_FLAG` code contains a `|` or an `@`, so both wire formats are split on their separator and the code lands in `conf_status` on either path.

**Transport behaviour:**
- Large bodies arrive **gzip-compressed with no `Content-Encoding` header**; `Content-Type` stays `text/tab-separated-values` and the only header-level tell is a `.tsv.gz` filename on `Content-Disposition`. Confirmed on `migr_asyrescra` and `hlth_cd_yro`; absent on `sts_inpr_m`. The switch does not track observation count, so detection sniffs the gzip magic bytes off the stream.
- Bodies are `Transfer-Encoding: chunked` with no `Content-Length`, so a size bound must be applied while streaming.
- **Errors are XML SOAP faults, not JSON:** `<S:Fault><faultcode>N</faultcode><faultstring>…</faultstring></S:Fault>`. `100` / HTTP 404 unknown dataset, `140` / HTTP 400 wrong key arity, `150` / HTTP 400 rejected filter value **or a period range outside the dataset's coverage**, `413` / HTTP 413 an extraction Eurostat refuses as too large — on either host, and deterministic, so it maps to non-retryable `extraction_too_big`. Bodies run under 400 bytes, so they survive the framework's 500-byte error-body excerpt intact.
- **Asynchronous queue envelope**, on HTTP 200: `<env:Envelope>…<ns0:syncResponse>…<queued><id>UUID</id><status>SUBMITTED</status></queued>…`, with `Content-Type: application/xml` and `Content-Disposition: attachment;filename=<uuid>.xml`. Triggered by server-side cost rather than response size, and not deterministic per dataset.

### Catalogue API

- TOC TXT: `GET /catalogue/toc/txt?lang=en` — tab-separated, quoted fields. Header row: `title`, `code`, `type`, `last update of data`, `last table structure change`, `data start`, `data end`, `values`. **Folder rows have 7 columns** (no `values`); **dataset/table rows have 8 columns** (`values` = obs count as unquoted integer). The parser must handle both row lengths. Title column uses leading spaces (4 spaces per depth level) to encode hierarchy depth. All other string fields are double-quoted; the `values` integer is unquoted.
- SDMX 2.1 dataflow catalog: `GET /sdmx/2.1/dataflow/ESTAT/all?format=json` — returns 8,220+ entries with dataset IDs, labels, and annotation metadata (obs count, period range, update times)

### Comext dissemination host

Base: `https://ec.europa.eu/eurostat/api/comext/dissemination`. Serves the 11 `DS-*` dataflows — 7 detailed-trade collections and 4 PRODCOM — through the same routes as the main host, with these differences (measured 2026-09-25):

| Route | Comext host |
|:---|:---|
| `catalogue/toc/txt` | HTTP 404. Discovery reads `sdmx/2.1/dataflow/ESTAT` with no `detail`: 23 KB, every dataflow's names plus `UPDATE_DATA` and `ESMS_HTML` annotations, but no `OBS_COUNT` or period annotations (`detail=allstubs` carries names only; `allcompletestubs` is fault 140) |
| `sdmx/2.1/dataflow/ESTAT/{code}/1.0?references=descendants&detail=referencepartial` | Labels every code the dataset uses: 23,154,460 B uncompressed for `DS-045409` (37,069 `product` codes), 2.2–5.5 MB for five others |
| `sdmx/2.1/datastructure/ESTAT/{code}` | 5 KB — the dimension order, as on the main host |
| `statistics/1.0/data/{code}` | JSON-stat 2.0. PRODCOM's flag and unit indicators carry text values (`":C"`, `"KG"`) in the `value` map. An extraction over 5,000,000 rows is HTTP 413 `EXTRACTION_TOO_BIG` with the estimated row count, and the estimate ignores the time dimension |
| `sdmx/2.1/data/{code}[/{key}]?format=TSV` | Unfiltered, the large collections are HTTP 413 fault 413 (`EXTRACTION_TOO_BIG_COMEXT: … Full extraction of COMEXT datasets is forbidden`); a key past the row limit is fault 413 `EXTRACTION_TOO_BIG`; a filtered slice past a much lower cost threshold is queued (`syncResponse`). PRODCOM text cells arrive as `:C` / `KG` with no space |

The seven trade flows carry `freq` A and M in one dataflow; the PRODCOM flows are annual. Every constraint's `TIME_PERIOD` runs to 2026-12, months past the published data, so no period coverage is derived from it.

### Codelist API (SDMX 2.1)

`GET /sdmx/2.1/codelist/ESTAT/{CODELIST_ID}?format=json`

Returns all valid values for a named codelist (e.g., `GEO`, `FREQ`, `UNIT`, `NA_ITEM`). Codelists are global across datasets; dataset-specific constraints may be narrower than the full codelist. This server does not expose the global endpoint: dataset-specific values come from each dataflow's partial codelists joined to its content constraint.

---

## Tool Design Details

### `eurostat_search_datasets`

Searches the in-memory TOC index (loaded from the catalogue TXT file). The query is tokenized on whitespace and every token must match (AND), case-insensitively, somewhere in a combined `label + theme_path + code` haystack — so concept-order and theme-named queries resolve even when no single label contains the phrase verbatim. A query carrying no non-whitespace token is rejected by the input schema, and the service treats an empty token list as zero matches rather than a match against everything.

**Spacing beside punctuation.** The haystack has whitespace beside any punctuation other than `_` removed, so `NACE Rev. 2 activity` reads `nace rev.2 activity` and `Rev.2`, `Rev.1.1`, or `2015=100` find their spaced spellings. Query tokens are never folded or split: `R&D`, `non-EU`, `une_rt_a`, and `DS-045409` keep their punctuation. A token holds no whitespace, so the region it matched before the fold is still intact after it, and no query matches less than it did (checked across all 1,655 punctuated tokens of the 2026-10-14 catalogue: 0 narrowed, 29 widened). The fold is one linear regex — a blank run is taken whole after a punctuation mark, or from its first blank when one follows — because the obvious `\s*(P)\s*` form is quadratic on a long blank run (80,000 spaces: 3.7 s). The folded text is built once per catalogue snapshot, on its first search, and reused by every later one.

**The words that block a match.** On zero matches with two or more distinct words, one extra pass over the catalogue counts, per word, the codes with a placement missing that word alone — the `totalMatches` the same search would return without it — and `no_match` names each such word with its count (`Without "rates": 7 matches.`). A word repeated in the query is one word; a query no single removal rescues keeps the broaden hint.

**The Comext merge.** The TOC carries none of the `DS-*` collections, so the Comext host's dataflow list is fetched beside it and appended as synthetic entries: a folder per collection, placed by the stem of the dataflows' `ESMS_HTML` page — `ext_go_detail` ("International trade in goods - detailed data (Comext)") under `ext_go`, `prom` ("Statistics on the production of manufactured goods (PRODCOM)") under `icts` — and one dataset entry per dataflow under it. A stem this server does not know lands in an "other collections" folder under the first root rather than disappearing. Merged entries report `lastUpdated` rewritten to the TOC's `dd.mm.yyyy` and no period coverage or observation count. Only the TOC is required: a failed Comext fetch — an error, a non-XML body, or a list naming no dataflows — is logged and the catalogue answers from the TOC alone, retrying the merge on the first catalogue call a minute later without re-fetching the TOC. Until the merge lands, every search success, and a browse of `ext_go` or `icts`, carries `comextListMissing: true` and a `notice` that the `DS-*` collections were not searched or listed; every `no_match` hint leads with the same disclosure; and `not_found` on `ext_go_detail`, `prom`, `comext`, or a `DS-*` code says the folder comes from the Comext list rather than sending the caller back to the root themes. The merge only appends, so a cursor paged before it still addresses the same leading matches.

**Undisseminated `DS-*` codes.** When nothing matches and the query names a `DS-*` code neither source lists, the service reports it, and `no_match` says the collection is not disseminated (legacy `DS-056120` and `DS-018995` answer 404 on both hosts) instead of suggesting a broader search. While the Comext list is unmerged, absence from it proves nothing, so the hint sends the caller to `get_dataset_info` to check the code directly. The `no_match` hint is composed in order: the Comext disclosure or this not-disseminated sentence, then the word counts, then "Try a broader term" only when neither a count nor a code applies.

Returns datasets only (not folders), in TOC order, one row per code — Eurostat files some datasets under several TOC branches, so matches are deduplicated by code (first matching placement wins as the canonical `theme_path`) before any offset math, keeping `total_matches` and page slots counted in unique query targets.

Paginated with the framework's opaque-cursor primitives (`encodeCursor` / `decodeCursor`): `limit` is the page size and the returned `next_cursor` fetches the next page over a stable order. The cursor payload carries the normalized query and the load timestamp of the TOC snapshot it was paged over alongside `offset`/`limit`. A cursor that is malformed, presented with a different query, or presented after the catalogue has refreshed underneath it is rejected as `invalid_cursor` rather than silently applied to a different result set — one message and one recovery cover all three, since the cursor is opaque and the caller's next move is the same in each case.

**Input:**
- `query: string` — search terms (tokenized, AND-matched across label + theme_path + code, with spacing beside punctuation ignored in that text)
- `limit: number` (positive integer, default 20) — first-page size, clamped to 100 with a notice by default; ignored on cursor calls, whose page size is fixed by their cursor
- `cursor: string?` — opaque pagination cursor from a prior call's `next_cursor`; omit for the first page

**Output:**
```
datasets: [{
  code: string           // e.g., "nama_10_gdp"
  label: string          // human-readable title
  type: "dataset"|"table"
  data_start: string?    // e.g., "1975"
  data_end: string?      // e.g., "2025"
  last_updated: string?  // e.g., "22.05.2026"
  obs_count: number?
  theme_path: string[]   // breadcrumb: ["Database by themes", "Economy and finance", ...]
}]
next_step: string?       // suggested follow-up tool call
```
Enrichment (both surfaces): `total_matches` (full count across all pages), `truncated` (true when more matches remain beyond this page), `next_cursor?` (opaque cursor for the next page; omitted on the last page — pass back as `cursor`), `comext_list_missing?` and `catalogue_loaded_at?` (the partial-catalogue disclosures above and in the TOC-cache decision), and a `notice` carrying a sentence for each.

**Errors:**
- `no_match` (NotFound): no datasets matched the query
- `invalid_cursor` (InvalidParams): the cursor is malformed, or was issued for a different query or for a catalogue snapshot that has since refreshed
- `upstream_fault` (ServiceUnavailable, retryable): no catalogue is loaded yet and the table of contents answered HTTP 5xx or could not be reached on every attempt; the hint says the load runs again on the next call (see **Outage handling**)

### `eurostat_browse_themes`

Navigation tool for the TOC tree. Without `theme_code` returns the second-level theme folders. The TOC may contain more than one depth-0 root folder — historically a single "Database by themes" wrapper, but the live TOC also carries a separate "Cross cutting topics" root — so this tool skips every depth-0 wrapper and unions their depth-1 children, in root order, ensuring all top-level themes are reachable from a root-level browse. With `theme_code` returns its immediate children (subthemes and datasets in that branch).

Eurostat files some folder codes under more than one branch — the "Cross cutting topics" tree re-files part of the primary catalogue under different groupings, and a few survey folders are relisted per wave inside the primary tree itself. Of the ~1,900 folder codes in the live TOC (12,235 entries in total, most of them datasets), 43 carry more than one placement and 10 of those have differing child sets. A code lookup resolves to its **first** placement in TOC order, the same canonical-placement rule `eurostat_search_datasets` applies to duplicate dataset codes. In all 10 differing cases the first placement lists at least as many children as the ones it shadows — a superset in nine; the tenth is the root code `data`, whose two branches list entirely different children, both of which a root-level browse already unions. The breadcrumbs of the branches not taken are returned as `other_placements` so an ambiguous code is visible as such rather than silently resolved.

**Input:**
- `theme_code: string?` — folder code to expand; omit for root. Exact matches win, then case-insensitive lookup; canonical code drives placement, folder checks and the response echo

**Output:**
```
items: [{
  code: string
  label: string
  type: "folder"|"dataset"|"table"
  has_children: boolean  // true for folders
  // Only for dataset/table items:
  data_start?: string
  data_end?: string
  obs_count?: number
}]
parent_path: string[]   // breadcrumb from root to current
other_placements: string[][]?  // breadcrumbs of the other branches filing this code; omitted when the code has a single placement
next_step: string?      // suggested follow-up (drill into folders or inspect a dataset); omitted for empty results
```
Enrichment (both surfaces): `item_count`, `theme_code?`, and the partial-catalogue disclosures — `comext_list_missing?` on `ext_go` and `icts` while the Comext list is unmerged, `catalogue_loaded_at?` while a failed refresh keeps an expired catalogue in service — with a `notice` carrying a sentence for each.

**Errors:**
- `not_found` (NotFound): `theme_code` does not exist in the TOC; recover by browsing from the root. While the Comext list is unmerged, a Comext folder or `DS-*` code instead says it comes from that list and that the merge is retried about once a minute
- `not_a_folder` (ValidationError): `theme_code` resolves to a known dataset or table rather than an expandable folder; the error identifies the entry type and directs the code to `eurostat_get_dataset_info`, then `eurostat_query_dataset`
- `upstream_fault` (ServiceUnavailable, retryable): no catalogue is loaded yet and the table of contents answered HTTP 5xx or could not be reached on every attempt, as for `eurostat_search_datasets`

### `eurostat_get_dataset_info`

Fetches the dataset-scoped SDMX dataflow with partial descendants and its content constraint in parallel. The dataflow supplies the human label; `OBS_COUNT`, period bounds, `UPDATE_DATA`, and `ESMS_HTML` annotations; ordered DSD dimensions; concept labels; and constrained codelist labels. The content constraint supplies the actual available codes for every dimension, including the complete time set. Annotation-derived fields remain optional: absent or unparseable annotations stay absent rather than becoming zero or an empty string.

**Input:**
- `dataset_code: string` — e.g., `nama_10_gdp`

**Output:**
```
code: string
label: string
dimensions: [{
  code: string            // e.g., "unit"
  label: string           // e.g., "Unit of measure"
  values_count: number?   // dataset-scoped constraint count, falling back to the referenced codelist. Omitted when neither source measures the value set
  sample_values: [{code, label}]?  // first 10 values as orientation; omitted alongside values_count
}]
time_range: { start: string?, end: string? }  // each bound omitted when not reported
obs_count: number?       // omitted when not reported — an absent count is unknown, not zero
last_updated: string?    // ISO timestamp; omitted when not reported
metadata_url: string?    // link to ESMS metadata HTML
```

**Errors:**
- `not_found` (NotFound): dataset code does not exist or is not available for dissemination
- `upstream_fault` (ServiceUnavailable): the dataflow or content constraint could not be parsed — malformed, truncated, not XML (an HTML page on HTTP 200, or a DOCTYPE, which the parser refuses), or missing the requested dataset's dataflow. A failed load is dropped from the metadata cache, so the hint says to retry in a few minutes, then to read observations through `eurostat_query_dataset`, whose Statistics API request does not depend on the structure. The tool makes no Statistics API request, so the `async_response` refusal cannot reach it, and neither structure read has been seen refused for size: `DS-045409`'s 23 MB dataflow and `earn_ses_annual`'s structure pair are served on HTTP 200. The same reason, marked `retryable: true`, covers a structure endpoint that answered HTTP 5xx or could not be reached on every attempt (see **Outage handling**); its hint names the status (or the unreachable host) as an upstream outage and says to retry in a few minutes

### `eurostat_get_dimension_values`

Returns all dataset-available values for a single dimension from the same SDMX metadata pair. Because the content constraint enumerates `TIME_PERIOD`, `time` is complete without probing populated observations. For `geo`, the service filters the constrained codes locally by NUTS level, defaults an omitted level to `country`, and returns that effective level in the result.

**Input:**
- `dataset_code: string`
- `dimension: string` — dimension code (e.g., `unit`, `na_item`, `geo`), resolved exact-first then case-insensitively; `TIME_PERIOD` aliases `time`. The canonical code drives geo validation and cursor binding; value codes and labels stay verbatim
- `geo_level: "aggregate"|"country"|"nuts1"|"nuts2"|"nuts3"?` — applies only when `dimension === "geo"` (default: `country`; use `nuts1`/`nuts2`/`nuts3` to retrieve regional codes for datasets that carry NUTS data). Pairing it with any other dimension is rejected as `conflicting_params` rather than accepted and ignored
- `filter?: string` — up to 500 characters; whitespace-separated words, each of which must appear as a substring of the code and label joined by a space, after lowercasing and NFKD folding with combining marks dropped on both sides (`palma frankfurt` finds `DE_EDDF_ES_LEPA`, `zurich` finds `Zürich`). Punctuation is part of a word and nothing is transliterated (`münchen` does not find `MUENCHEN`). Runs over the whole list at the effective `geo_level` before paging, in constraint order, with no ranking. A blank or whitespace-only filter is unset
- `limit?: integer ≥ 1` — default 25, clamped to 1,000 with a notice; the off policy rejects values above 1,000
- `cursor?: string` — the previous page's `nextCursor`
- `canvas_id?: string` — `CanvasIdSchema`. Also stages every value at `geo_level` on that canvas, whatever `filter` and `limit` are. Only on a call without `cursor`; ignored, `cursor` or not, on a deployment without a canvas

**Paging.** A page holds the effective count of complete values, fewer only at list end; label width does not affect page boundaries. A page with more after it carries `truncated: true`, `nextCursor`, and a notice naming `nextCursor`, `filter`, and — where a canvas is configured — `canvas_id` as routes to the rest. Both response surfaces carry every value and disclosure.

**Cursor.** Opaque (the framework's base64url pagination codec), keyset on code: it resumes after the last code wherever it now sits, so a time list growing at the end still pages correctly. It binds the case-insensitive dataset code, canonical dimension, effective geo level and folded filter words, and carries the first call's effective limit. Dataset/filter mismatches fail before loading metadata; dimension/geo checks follow canonical resolution. Alias spellings resume the same list. Existing cursors remain accepted: in-cap counts survive, larger legacy counts normalize to 1,000 with notice/log/counter and the next cursor carries 1,000. A new limit beside a cursor is ignored. Malformed cursors, changed bindings and missing anchors fail as `invalid_cursor`; a final anchor answers an empty page with a notice. With a canvas, `canvas_id` plus `cursor` fails as `conflicting_params` because the first staging call already wrote the whole list. Without a canvas, `canvas_id` is ignored.

**Staging.** With `canvas_id`, the whole value list at the effective geo level is registered as `code VARCHAR` and `label VARCHAR` on a declared schema, regardless of inline filter and limit. It can label a bulk table's code columns through joins. Staging only onto a supplied canvas keeps plain lookups from taking a canvas slot; the tool never mints one. A well-formed `canvas_id` is ignored without a canvas, and an empty dimension stages nothing.

**Output:**
```
dimensionCode: string
dimensionLabel: string
geoLevel?: "aggregate"|"country"|"nuts1"|"nuts2"|"nuts3" // geo only; effective level
values: [{               // this page; with filter, only the matches
  code: string
  label: string
}]
totalCount: number       // every value at geoLevel, whatever filter and paging apply
matchCount?: number      // filter matches across the whole list; only with filter
canvasId?: string        // the canvas_id supplied; omitted when nothing was staged
tableName?: string       // the code/label table
stagedRowCount?: number  // equals totalCount
```
Enrichment, only on a page with more after it: `truncated: true`, `nextCursor`, `notice`. A `notice` alone also explains an empty page: a filter that matched nothing (success, `matchCount: 0`, the filter echoed, and — when `canvas_id` staged the list — the staged table named as the place to search it with SQL), or a cursor with nothing after its code.

**Errors:**
- `not_found` (NotFound): dataset or dimension code does not exist
- `no_results` (NotFound): the dataset has no `geo` values at the effective level; choose another `geo_level` (omitted means `country`)
- `conflicting_params` (ValidationError): `geo_level` was sent with a dimension other than `geo`, where it has no effect; or, on a deployment with a canvas, `canvas_id` was sent with `cursor`
- `invalid_cursor` (InvalidParams): the cursor is malformed, was issued for a different `dataset_code`, `dimension`, `geo_level` or `filter`, or resumes after a code the list no longer holds; call again without it
- `upstream_fault` (ServiceUnavailable): the dataflow or content constraint could not be parsed, as for `eurostat_get_dataset_info`; the hint says to retry in a few minutes, then to check a code by filtering `eurostat_query_dataset` on it, since a code the dataset lacks comes back in `unmatchedValues`. Marked `retryable: true`, the structure endpoint answered HTTP 5xx or could not be reached on every attempt, and the hint names the outage and says to retry in a few minutes
- `canvas_not_found` (NotFound): a well-formed `canvas_id` is unknown or expired, looked up only when the dimension lists at least one value; the recovery offers omitting `canvas_id` for the inline list. A malformed one fails argument validation

### `eurostat_query_dataset`

The primary data-fetching tool. Accepts dimension filters as a map and returns decoded observations.

**Implementation note:** the response carries the first `preview_limit` observations (default 25, max 500) in ascending linear-index order. The decoder receives that bound directly and never materializes the remaining observations as an array. `OBS_CAP` remains the independent 5,000-observation decode safety limit and automatic staging threshold: `truncated` is true only above it; `stage: true` also stages smaller matches. Totals and time bounds come from the full response's `value`/`status` membership, independent of the preview. `rows()` stays uncapped for staging. These bounds affect local decoding, not the upstream request; filters and period controls reduce the body. There is no observation cursor or offset.

**Input:**
- `dataset_code: string`
- `filters: Record<string, string[]>` — dimension filters; key = dimension code, value = array of codes. Example: `{"unit": ["CP_MEUR"], "na_item": ["B1GQ"], "geo": ["DE", "FR"]}`. An empty array means "no filter for this dimension", not an error, and a blank or whitespace-only value is unset the same way: blank values are removed, then any dimension left with no value is dropped, before the request is built, before the checks below, and from the applied filters echoed back — so `{"geo": []}` and `{"geo": [""]}` neither restrict the query nor conflict with `geo_level`, and `["", "DE"]` is `["DE"]`. Non-blank values are sent as given. Keys match dimension codes in any case, as Eurostat reads them (`GEO=DE` is answered under `geo`); keys are sent as given, and every server-side check — the control-key rejection, the `geo_level` and time conflicts, the unmatched-value comparison — matches them case-insensitively. Keys are dimensions only: one naming a Statistics API control (`lang`, `format`, `geoLevel`, `sinceTimePeriod`, `untilTimePeriod`, `lastTimePeriod`) is rejected as `invalid_dimension` before any request, since it would otherwise bypass or override the dedicated input. `time` and `time_period` are the time dimension, not controls, and still filter. Do not include `"geo"` here when using `geo_level`, nor `"time"`/`"time_period"` when using a period input. A value that matches nothing is not an error: Eurostat drops it from the reply, and the response names it in `unmatched_values` (or, when nothing matched at all, in the `no_results` error) — `eurostat_get_dimension_values` lists the valid codes.
- `geo_level: "aggregate"|"country"|"nuts1"|"nuts2"|"nuts3"?` — filter by NUTS hierarchy level. Mutually exclusive with a non-empty `"geo"` entry in `filters`; sending both is rejected as `conflicting_params` before the request reaches Eurostat.
- `since_period: string?` — e.g., `"2020"`, `"2023-Q1"`, `"2024-01"`. Use `last_n_periods` instead for the N most recent periods without knowing the end date. See **Period literals** below.
- `until_period: string?` — e.g., `"2024"`. Omit for data through the latest available period.
- `last_n_periods: number?` — positive integer N counting the latest dataset time positions; mutually exclusive with `since_period`/`until_period`. A filtered slice may populate only some selected positions or none
- `preview_limit: number?` (positive integer, default 25, clamped to 500 with a notice) — deterministic inline prefix only; does not reduce the match or alter the staging threshold
- `stage: boolean?` (default false) — stage every matched row on an available canvas, even below the automatic threshold; reuse `canvas_id` or create a canvas when omitted
- `lang: "EN"|"FR"|"DE"?` (default: `EN`)

**Output:**
```
dataset_code: string
dataset_label: string
dimensions_used: string[]        // ordered list of dimensions in this query
observations: [{
  // One entry per dimension in dimensions_used:
  [dimension_code: string]: { code: string, label: string }
  value: number | null
  value_text?: string                           // a value published as text (PRODCOM "KG"); value is null
  status?: { code: string, label: string }      // OBS_FLAG, e.g. {code:"p", label:"provisional"}
  conf_status?: { code: string, label: string } // CONF_STATUS, e.g. {code:"C", label:"confidential"}
}]
obs_count: number                 // observations matched, independent of preview_limit
truncated: boolean                // true only when obs_count exceeds the 5,000-row staging threshold
time_range: { start: string?, end: string? }  // bounds of the whole match, not of the returned rows; each omitted when neither the match nor Eurostat report it
missing_obs_count: number         // observations with null value, across the whole match
canvas_id: string?                // dataframe canvas holding the staged match; omitted when nothing was staged
table_name: string?               // canvas table holding every matched observation, flat; omitted when nothing was staged
staged_row_count: number?         // rows written to that table (equals obs_count); omitted alongside table_name
unmatched_values: Record<string, string[]>?  // filter values that matched nothing, as sent; omitted when every value matched
```
`observations` carries at most `preview_limit` rows; every other field above describes the full match. `obs_count` and `observations.length` can therefore diverge while `truncated` remains false.

**Text values.** PRODCOM's flag and unit indicators put text in the JSON-stat `value` map, which the output schema's numeric `value` refused — one such cell failed the whole call. A text value is decoded, never coerced: `:` followed by a `CONF_STATUS` code is a withheld value (`:C` → null `value`, `confStatus` C), bare `:` is missing, and anything else is kept verbatim in `valueText` with a null `value`. Text cells count toward `missing_obs_count`. The bulk path decodes the same cells the same way, from one shared decoder.

**Unmatched filter values.** Eurostat drops a filter value that matches nothing from the reply's `category.index` instead of failing, and a dimension keeps `size ≥ 1` as long as one value beside it matched — so `geo=DE,XX` returns Germany's rows with no sign that `XX` was ignored. Each filtered dimension's sent values are compared, case-insensitively (Eurostat accepts `geo=de` and returns `DE`), against that index. The same comparison serves the success path (`unmatched_values` plus a notice sentence) and the `no_results` diagnosis below, so a caller reads one shape on both.

**Selected periods without cells.** On successful `last_n_periods` calls, the same full-match scan compares selected time-index positions with in-range `value`/`status` membership. Status-only, confidential and text-valued cells count as populated. A notice names the full gap count and newest 24 missing positions, with an omitted count, and recommends increasing N or replacing `last_n_periods` with `until_period`. This does not infer gaps from the preview, change totals or add a request. Ranged queries and the existing empty-result diagnosis keep their own guidance.

**Staging.** With a canvas configured, `stage: true` or more than 5,000 matched observations registers the whole match and returns the three table fields above. Rows come from the uncapped lazy generator over the already-fetched body, preserving the preview's prefix without another request or full materialization. Omitted/false stage preserves automatic staging only above 5,000. Every staged response directs the caller to `eurostat_dataframe_describe` before `eurostat_dataframe_query`. An unstaged short preview recommends `stage: true` only when a canvas is available; an explicit request without one discloses unavailability.

Canvas columns are flat, because a dataframe column holds a scalar. Each dimension becomes two columns — `<dim>` for the code, `<dim>_label` for the label — followed by the five measure columns `obs_value`, `obs_flag`, `obs_flag_label`, `conf_status`, `conf_status_label` (the `obs_` prefix is Eurostat's own SDMX-CSV vocabulary, and keeps the measure columns clear of any dimension code). Those five are exactly what `download_dataset` stages, under the same names and with the same codes. A table staged from a `DS-*` dataset, on either tool, adds `obs_value_text` after `obs_value`; a main-host table keeps the five. The column schema is declared rather than sniffed: inference reads only the leading rows, so an all-integer prefix would type the measure as `BIGINT`, which the canvas then serializes as a string.

Without a canvas the three fields are absent — not null, not empty — and both response surfaces point at filters or period controls rather than advertising dataframe tools the deployment does not list, or `download_dataset`, which keeps only its inline preview there.

**Errors:**
- `not_found` (NotFound): dataset code not found (HTTP 404, Eurostat error id 100)
- `no_results` (NotFound): the query matched no observation cell — an otherwise successful response whose `value` and `status` maps are both empty; occurs when dimension value filters match no data (e.g., invalid geo code, valid-but-absent combination) or the period range falls outside the dataset's coverage. Decided from the same cell count `obs_count` reports, not from `value` alone: a slice whose every cell is confidential arrives as `value: {}` alongside a populated `status`, and is data. The empty reply is read for why, with no extra request, and the signals co-occur: `data.unmatchedValues` for filter values absent from their dimension's index; a `time` dimension of size 0, meaning the range selected no period, which the hint answers with the dataset's `OBS_PERIOD_OVERALL_OLDEST`/`_LATEST`; and, when every dimension matched at least one value, `data.matchedPeriods` — the selected periods, none carrying a value, bounded to the newest 24 in index order, with `data.matchedPeriodCount` carrying the full count and the message the full span (a daily dataset's index runs to ~14,000 periods when no period control narrows it). That last case is explained by how the periods were chosen: with `last_n_periods` the counting rule above, with `since_period`/`until_period` a slice whose coverage is narrower than the dataset's, with neither a combination that carries no data. The HTTP-200 error id 100 (`NO_RESULTS`) carries no envelope and keeps the generic hint.
- `async_response` (ServiceUnavailable, non-retryable): query too large — the HTTP-200 warning, or an HTTP-413 error whose `EXTRACTION_TOO_BIG` label and row estimate the message carries. The refusal names no dimensions, so the handler reads the structure definition (a few KB) and the hint names the dataset's own dimensions the query left unfiltered, `geo_level` counting as a `geo` filter; if that read fails the hint stays generic rather than replacing the refusal
- `invalid_dimension` (ValidationError): dimension *code* is not defined in this dataset's structure (HTTP 400, Eurostat error id 150), or a filter key names a Statistics API control. The control case is rejected locally, before the request, and its hint names each key and the input that sets it (`lang`, `geo_level`, `since_period`, `until_period`, `last_n_periods`; none for `format`, which is fixed); every other unknown key is left to Eurostat's id 150. Invalid dimension *values* do not produce an error — see `no_results` and `unmatched_values`.
- `invalid_period` (ValidationError): `since_period` or `until_period` is not a period literal, names a component that does not exist, or the pair holds no period (see **Period literals**). Rejected locally, before the request; a Statistics API 400 naming `sinceTimePeriod`/`untilTimePeriod`, or its error id 140, maps here as a backstop.
- `conflicting_params` (ValidationError): mutually exclusive parameters combined — a non-empty `geo` filter with `geo_level`, `since_period`/`until_period` with `last_n_periods`, or a non-empty `time`/`time_period` filter with any period input. All three are rejected locally, before the request reaches Eurostat, each with a hint naming only its own pair. Eurostat's "cannot be set at the same time" refusal (e.g. `time` beside `time_period`) maps here as a backstop.
- `canvas_not_found` (NotFound): a well-formed `canvas_id` was supplied for staging but is unknown or expired; the recovery says to omit it and start a fresh canvas. Reachable only with a canvas and a nonempty match when `stage: true` or the automatic threshold applies; otherwise a well-formed id is ignored. `CanvasIdSchema` rejects malformed ids at argument validation on every deployment.
- `upstream_fault` (ServiceUnavailable): the Statistics API answered HTTP 5xx or could not be reached on every attempt, marked `retryable: true` with a hint naming the outage; HTTP 501 fails on its first attempt marked `retryable: false` and carries the contract's recovery. An error array a 5xx carries keeps its modelled reason when it names one (see **Outage handling**)

**Period literals** (both data tools). Accepted, after trimming: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `YYYY-Qn`, `YYYY-Sn`, `YYYY-Tn` (trimester), `YYYY-Wn`/`YYYY-Wnn`, `YYYY-Mn`/`YYYY-Mnn`, `YYYY-Dnnn` (day of the year), and the SDMX annual form `YYYY-A1`, the letter in either case, with every component real — month 01–12, quarter 1–4, semester 1–2, trimester 1–3, a week the ISO year has (53 only in a 53-week year), a day the year has (366 only in a leap year), and a calendar day that exists. These are the shapes both endpoints read the same way once in the form sent. The number after the letter may carry extra leading zeros: the bulk endpoint reads `2020-Q01`, `2020-T01`, `2020-W001` and `2020-M001` correctly and the Statistics API refuses them, so both tools rewrite such a literal to the canonical width (`2020-Q1`, `2020-T1`, `2020-W01`, `2020-M01`), range-check the result, and send and echo the canonical form. Two more rewrites follow the same rule of sending what both endpoints read: a day of the year always goes out as three digits (`2026-D1` → `2026-D001`, the only width the Statistics API reads), and `YYYY-A1`, which only the bulk endpoint reads, goes out as `YYYY`. The letter's case is passed through as sent, as both endpoints accept either. Month and day in `YYYY-MM`/`YYYY-MM-DD` stay exactly two digits — both endpoints refuse `2020-1`. Out-of-range components are the reason for the check: the Statistics API refuses most of them, but the SDMX bulk endpoint, and the Statistics API for `2021-W53`, `2021-02-29`, `2021-D366` and `2020-T4`, silently roll them into a neighbouring period (`2020-13` becomes 2021-01) and answer for a range the caller never asked for. Frequency is not checked — both endpoints map a literal of another frequency onto the dataset's own. With both bounds set, the pair must hold at least one day: each literal covers a span of days (a year, a month, an ISO week, a single day, …), and the range is empty when `since_period`'s span starts after `until_period`'s ends. Comparing start against end keeps cross-frequency pairs such as `2020-06` to `2020` valid with no per-frequency rule, and rejects `2020-Q3` to `2020-06`. Neither endpoint refuses an inverted range: the Statistics API answers with every period outside the gap and the bulk endpoint with the whole series. The check is a handler step through one shared helper rather than a schema `pattern`, because blank and padded bounds must keep meaning "no bound" and the trimmed value, and a schema rejection would arrive as `invalid_arguments` without the declared recovery hint.

### `eurostat_download_dataset`

The whole-dataset counterpart to `query_dataset`'s slice. It reads the SDMX 2.1 TSV endpoint, which is 48–63% of the JSON-stat bytes for the same data, and streams the body into canvas rows rather than parsing it into memory first.

**Filters are a dimension map, not a raw key.** The endpoint takes a positional path segment that must carry one position per dimension in dataset order — a count mismatch is faultcode 140, not a partial match. Asking a caller to build that string would make arity the caller's problem; taking the same `{dimension_code: [value, ...]}` map `query_dataset` takes and emitting a position for every dimension makes correct arity structural. A filter naming a dimension the dataset does not have is rejected locally, before the request, with the real dimension list — that is the failure the map form can still produce, and it is the one worth a good message. Keys match the dimension order case-insensitively, as on `query_dataset` (`GEO` places at `geo`; keys differing only in case pool their values), since the key name never travels upstream.

The dimension order costs one structure-definition request, a few KB whatever the dataset's size, and only when a filter is actually present: an unfiltered download needs no key, and the TSV header names the dimensions anyway. An observation request — even a one-period `lastTimePeriod=1` slice — is the wrong source: it is refused with HTTP 413 `EXTRACTION_TOO_BIG` once the latest period alone exceeds Eurostat's 5,000,000-row extraction limit (`earn_ses_annual`'s is estimated at 5,821,200), which failed a filtered download before its own, much smaller request was sent. An all-wildcard key of the right arity is accepted upstream, but omitting the segment asks the same question without staking the request on this server's copy of the dimension order being current.

**No `last_n_periods`.** `lastNObservations` keeps every period column in the TSV header and blanks the unselected cells, producing a body measured at ~3× the JSON-stat equivalent for the same selection — slower and larger than the endpoint it is meant to beat. `startPeriod` removes the columns, so `since_period` / `until_period` are the only period controls offered and the description says why.

**Three response shapes have to be told apart before any row is parsed:**

1. A **SOAP fault** on 4xx. `fetchWithTimeout` throws before the caller sees a body, so the fault is read from the truncated excerpt on `err.data.body`; faults run under 400 bytes and survive the framework's 500-byte cap whole. On a 5xx the excerpt is read the same way, but only a modelled fault replaces the HTTP error: an unmodelled body there is an outage page, retried and reported as an outage (see **Outage handling**).
2. The **queue envelope** on HTTP 200. A `syncResponse` ticket parsed as TSV yields a header row of XML and no observations — a successful-looking empty download. The body is classified as XML before the header parse rather than after.
3. **Data**, possibly gzipped with no `Content-Encoding`.

**Byte budget, enforced mid-transfer.** The body is chunked with no `Content-Length`, so a limit checked after the fact would already have paid for the whole transfer. The budget admits only the allowed decoded-byte prefix, independent of plain or gzip chunk boundaries, and cancels the stream when more bytes arrive. `bytesRead` counts bytes accepted for parsing, never more than the configured budget.

**No canvas until the first row.** The handler pulls one row off the stream before it acquires a canvas. A download with no populated cells — Eurostat answers a filter combination or range that misses the series with a header-only TSV — fails as `no_results` there, exactly as on a deployment without a canvas: no canvas is minted, and a caller-supplied `canvas_id` gains no 0-row table and is not even looked up. The row stream is closed on every exit, so a canvas that cannot be acquired still cancels the response body.

When the prefix carries observations, overspend returns `budgetExceeded: true`, `bytesRead`, and a notice naming `EUROSTAT_BULK_MAX_BYTES` and narrowing controls. The line or UTF-8 character cut by the budget is discarded. A prefix too short for a complete header or usable observation fails locally as `byte_budget_exceeded` (ValidationError), with `maxBytes`, `bytesRead`, `rowCount` and narrowing guidance. A genuinely empty body remains an upstream failure, while a complete table without observations remains `no_results`.

**Input:**
- `dataset_code: string`
- `filters: Record<string, string[]>` (default `{}`) — blank and whitespace-only values are dropped, and a dimension left with none is unfiltered, as an empty array is, so `{"geo": [""]}` builds no key and `["", "DE"]` is `["DE"]`. The normalized set feeds the dimension-order read, the key, `appliedQuery`, and the `extraction_too_big` hint
- `since_period?` / `until_period?: string` → `startPeriod` / `endPeriod`, checked as **Period literals** above before any request
- `preview_limit: number` (positive integer, default 25, clamped to 500 with a notice) — inline rows
- `canvas_id?: string` — `CanvasIdSchema`, the minted 10-character id

**Output:** `datasetCode`, `dimensionsUsed` (read from the TSV header), `rowCount`, `missingCount`, `periodRange`, `bytesRead`, `compressed`, `budgetExceeded`, `observations[]` (the preview), and `canvasId` / `tableName` / `stagedRowCount` when something was staged. Enrichment adds `appliedQuery`, `totalCount` (equal to `rowCount`), and a `notice` composed of the byte-budget sentence when it applies, a preview sentence when `preview_limit` returns fewer rows than were downloaded, and the staged or no-canvas sentence. The no-canvas sentence suggests a narrower `query_dataset` only when the download holds more rows than `preview_limit` can ever return (500); below that it says every row came back, or names the `preview_limit` that returns them all. A short preview is not `truncated`: the download is complete, and `budgetExceeded` is the completeness signal.

**Errors:** `not_found` (fault 100), `invalid_dimension` (fault 150 — including a range wholly outside the dataset's coverage, a `startPeriod` after it ends or an `endPeriod` before it starts — or a local unknown-dimension rejection), `invalid_period` (the local period check, or fault 140 `TIME_PERIOD_FILTER_SPEC_INVALID`), `filter_arity` (fault 140 `INVALID_QUERY_NB_FILTERS`; fault 140 is split on its fault string), `async_queued` (queue envelope, non-retryable), `extraction_too_big` (fault 413 on either host, non-retryable; the hint names the dataset's dimensions the request left unfiltered, reusing the key's structure read or reading it now for an unfiltered download), `no_results` (a table with no populated cells — including a range inside the dataset's coverage that misses the filtered series, which the hint names; nothing is staged and no canvas is touched), `upstream_fault` (an unmodelled fault or a non-TSV body; or, marked `retryable: true`, the data endpoint, or the structure endpoint while a filtered download read its dimension order, answering HTTP 5xx or unreachable on every attempt, with a hint naming which), `canvas_not_found` (a supplied `canvas_id` that is unknown or expired, looked up only once the download yields a row; the recovery says to omit it and start a fresh canvas).

---

### `eurostat_dataframe_describe` / `eurostat_dataframe_query`

The SQL surface over what `query_dataset`, `download_dataset`, and `get_dimension_values` stage. Both are wrapped in `disabledTool()` when `CANVAS_PROVIDER_TYPE` is `none`: they stay visible on the landing page — with the variable that turns them on — but are skipped at MCP registration, so clients never see a tool they cannot call, and an operator reading the README does not have to guess why it is missing.

`dataframe_query` passes caller SQL straight to the canvas. It is not pre-filtered here: the framework's gate rejects anything that is not a single `SELECT` (statement count, statement type, an EXPLAIN-plan operator allowlist, a table-function deny-list covering file and external-data readers, and a parse-tree check that refuses setting readers, string-built SQL, and table references naming a file), and each rejection carries a typed reason. Beneath the gate, each canvas's DuckDB instance runs with external access off, its file reach limited to `CANVAS_EXPORT_PATH` and its scratch directory, and its configuration locked. A second, weaker string filter in front of that would only shadow those reasons with a vaguer message. `denySystemCatalogs` is left off because `dataframe_describe` already exposes the catalog deliberately.

**Input:**
- `canvas_id: string` — the `canvasId` from a `query_dataset`, `download_dataset`, or `get_dimension_values` response, declared with `CanvasIdSchema`
- `sql: string` (query only) — a single read-only `SELECT`

**Output:** `describe` returns `canvasId`, `expiresAt`, and `tables[]` (`name`, `kind`, `rowCount`, `expiresAt?`, `columns[]`). `query` returns `canvasId`, `columns[]`, `rows[]`, `rowCount`, `truncated`. 64-bit integer results come back as strings — the framework's JSON-safe row shape — so `COUNT(*)` is a string unless cast.

SQL cells render as JSON on the text surface, preserving nested LIST/STRUCT values, nulls, quoted strings and escaped line breaks. Every row supplied by the canvas is returned intact; `CANVAS_DEFAULT_ROW_LIMIT` bounds the row count. `rowCount` is the returned count and required boolean `truncated` preserves the canvas's row-limit signal, with continuation guidance only when rows were omitted.

Continuation keeps the same deterministic SELECT over unchanged staged tables, a total `ORDER BY` with tie-breakers, and `LIMIT`/`OFFSET` advancing by actual returned `rowCount`. An initially unordered result restarts sorted at offset zero. Volatile expressions and changing or expired tables do not support stable paging. SQL retrieval creates no cursor or materialized snapshot.

**Errors:**
- `canvas_disabled` (ServiceUnavailable, non-retryable): the deployment runs without a canvas. Recovery is `query_dataset` with narrower filters
- `canvas_not_found` (NotFound): unknown or expired `canvas_id`; also what a canvas belonging to another tenant returns, so existence does not leak across tenants. The recovery names the two staging tools to re-run without `canvas_id`, since `get_dimension_values` never starts a canvas
- `missing_table` (NotFound, query only): the SQL names a table that is not staged or has expired; the message names the table, and the recovery points at `dataframe_describe`
- SQL gate rejections surface as `ValidationError` with the framework's reason (`multi_statement`, `non_select_statement`, `denied_function`, `sql_read_only`, `invalid_sql`, …) and the framework's own hint

The canvas words its `canvas_not_found` and `missing_table` hints for no tool in particular, and a hint set where an error is thrown outranks the one a tool declares. Every canvas tool therefore re-throws whichever of the two it declares through `ctx.fail`, from the acquire and from the describe or query that follows it, since a canvas can expire between the two, so the caller gets that tool's declared recovery; every other canvas failure passes through untouched.

---

### `eurostat_dataframe_drop`

Removes one staged table through the canvas's own `drop()`, which looks the name up and issues `DROP TABLE` or `DROP VIEW` to match; the canvas and its other tables are untouched. It has two gates. Without a canvas it is wrapped in `disabledTool()` like the other two, and its hint names `EUROSTAT_DATAFRAME_DROP_ENABLED=true` beside `CANVAS_PROVIDER_TYPE=duckdb` when the flag is off too, so turning the canvas on alone is not a dead end. With a canvas it is still disabled until that flag is `true`, with a reason saying table cleanup is off in this deployment.

**Input:**
- `canvas_id: string` — declared with `CanvasIdSchema`, as on the other two
- `table_name: string` — the name exactly as `dataframe_describe` lists it, declared with the framework's `CANVAS_IDENTIFIER_REGEX`, so a value no staged table could carry fails argument validation with a message pointing at `dataframe_describe`

**Output:** `canvasId`, `tableName` (as sent), `dropped`, and `expiresAt` (the canvas's, slid forward by the call). `dropped: false` means nothing by that name was staged at call time — never staged, already dropped, expired, or a different case, since the lookup is exact — and an enrichment `notice` says so and points at `dataframe_describe`. A repeated drop is therefore a no-op rather than a failure, which is what makes `idempotentHint: true` honest.

**Errors:**
- `canvas_disabled` (ServiceUnavailable, non-retryable): the deployment runs without a canvas
- `canvas_not_found` (NotFound): unknown or expired `canvas_id`; an expired canvas has already released every table it held
- `identifier_reserved` (ValidationError): a bare SQL keyword such as `select`, which passes the identifier pattern but which no staged table can carry

Both come from the canvas, which words them for staging — re-run the tool that staged the data, choose another table name. For a drop that advice restores what was meant to go, so the handler re-throws each through `ctx.fail` and the caller gets this tool's message and declared recovery.

---

## Workflow Analysis

### Common agent workflow: compare GDP across EU countries

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | Search for GDP datasets | `eurostat_search_datasets` (`"GDP annual"`) |
| 2 | Get metadata for `nama_10_gdp` — confirm dims: unit, na_item, geo, time | `eurostat_get_dataset_info` |
| 3 | List unit values to pick correct one | `eurostat_get_dimension_values` (`unit`) |
| 4 | Query GDP at market prices for all EU countries, last 5 years | `eurostat_query_dataset` |

### Common workflow: sub-national regional analysis

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | Browse regional theme | `eurostat_browse_themes` (`"reg"`) |
| 2 | Find NUTS2 GDP dataset | `eurostat_browse_themes` (`"reg_eco10"`) |
| 3 | Get dataset metadata | `eurostat_get_dataset_info` (`"nama_10r_2gdp"`) |
| 4 | Query GDP for all NUTS2 regions | `eurostat_query_dataset` (`geo_level: "nuts2"`) |

### Common workflow: analyse a match above the staging threshold (canvas enabled)

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | Query the dataset; a match above 5,000 returns its `preview_limit` prefix plus `canvasId` + `tableName` | `eurostat_query_dataset` |
| 2 | Confirm the staged table and column names | `eurostat_dataframe_describe` |
| 3 | Aggregate or filter across the whole match — `SELECT geo, AVG(obs_value) … GROUP BY geo` | `eurostat_dataframe_query` |
| 4 | Stage a second dataset onto the same canvas by passing `canvas_id`, then join across both | `eurostat_query_dataset` → `eurostat_dataframe_query` |

### Common workflow: pull a whole dataset for analysis (canvas enabled)

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | Confirm the dimension codes to filter on | `eurostat_get_dataset_info` |
| 2 | Download the dataset; the response returns a 50-row preview plus `canvasId` + `tableName`, and reports `bytesRead` / `compressed` / `budgetExceeded` | `eurostat_download_dataset` |
| 3 | If `budgetExceeded` is true, re-run with `since_period` or tighter filters | `eurostat_download_dataset` |
| 4 | Read the staged column names — the bulk table carries codes and no `_label` companions | `eurostat_dataframe_describe` |
| 5 | Stage a dimension's labels beside it by passing the download's `canvasId` as `canvas_id` — a `code`/`label` table, at the same `geo_level` as the download for `geo` | `eurostat_get_dimension_values` |
| 6 | Aggregate across every observation, joining the label table on the dimension column (`JOIN df_labels g ON d.geo = g.code`) | `eurostat_dataframe_query` |

### Common workflow: explore unknown topic domain

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | List top-level themes | `eurostat_browse_themes` |
| 2 | Drill into a theme | `eurostat_browse_themes` (`theme_code`) |
| 3 | Find dataset by keyword | `eurostat_search_datasets` |
| 4 | Get metadata → query | `eurostat_get_dataset_info` → `eurostat_query_dataset` |

---

## Design Decisions

**Why the TOC is cached in memory, not fetched per call:** The TOC TXT file is ~2 MB and parsed to ~10,000 entries. A per-call fetch would add 1–2s latency to every browse/search operation, and the catalogue changes at most twice daily. Fetch-on-first-use with a 12-hour TTL (`EUROSTAT_TOC_CACHE_TTL_MS`) matched to that upstream cadence is the right tradeoff: zero per-call cost inside the window, bounded staleness for a process that stays up for weeks. The first call past the TTL triggers one refresh and concurrent callers share it; a refresh that fails logs and keeps serving the last loaded TOC, so an upstream outage does not take discovery down once the server holds valid data. A failed refresh also holds the next attempt off for a minute: `withRetry` bounds a single attempt, and without a rate bound every call for the duration of an outage would pay a full retry-and-backoff cycle before falling back to the same cache. A successful refresh clears the hold; a cold-start failure is not subject to it, since there is no cache to serve instead. While a failed refresh keeps the expired catalogue in service — on the failing call and through the hold — every search and browse success carries `catalogueLoadedAt` (that copy's load time) and a `notice` that the catalogue could not be refreshed, and a search `no_match` or browse `not_found` says the same, with the load time, in its recovery hint. The predicate is the hold itself, set by a failed refresh and cleared by a successful one, rather than the copy's age, which a call crossing the TTL mid-flight would also satisfy.

**Why metadata uses dataset-scoped SDMX structure and constraint responses:** observation slices describe the positions populated in that slice, not the dataset's full allowed surface. That made sparse or wide datasets fail metadata discovery, truncated `time`, and tied a structure call to observation volume. The dataflow `references=descendants&detail=referencepartial` response carries the DSD, concepts, labels, and annotations; the matching content constraint carries the actual dataset-available positions. Joining the two preserves the existing `DatasetMeta` shape without using the rejected global datastructure/codelist fallback.

**Why `geo` filter and `geoLevel` are mutually exclusive at the tool layer:** This mirrors the Eurostat API constraint — sending both causes a 400 error with `"'geo' parameter and 'geoLevel' parameter cannot be set at the same time."` The server validates and rejects early with a clear message rather than passing through to Eurostat.

**Why dataset search runs against the TOC (not the SDMX catalog):** The TOC carries more entries than the SDMX `dataflow` endpoint — it includes predefined tables the dataflow list omits (at the 2026-05 design pass the counts were ~8,220 SDMX dataflows vs ~8,933 TOC entries; both drift upstream over time, so treat these figures as historical). The TOC also includes theme hierarchy which powers `browse_themes`. Using one source for both tools keeps the implementation simpler and avoids two large fetch operations.

**Why no `eurostat_get_codelist` tool:** The SDMX codelist endpoint (e.g., `/codelist/ESTAT/GEO`) returns global codelists with 4,292+ geo entries — the vast majority are irrelevant to any specific dataset. The `get_dimension_values` tool is dataset-scoped and returns only the values that actually appear in the data, which is what agents need.

**Why `query_dataset` returns decoded observations instead of raw JSON-stat:** JSON-stat's flat numeric index (`{"0": 4219310.0}`) with separate dimension index maps requires non-trivial decoding math. Every caller would need to re-implement it. The service layer does the stride-based decoding once and returns human-usable `{dimension_code: {code, label}, value, status}` objects. The raw format details are an implementation concern, not a public API surface.

**Why no async polling:** Eurostat's async response is a soft error with guidance to narrow the query. Implementing polling (retry-after semantics) would require state management between tool calls. The better UX is to detect the async response immediately and return a non-retryable `ServiceUnavailable` error whose recovery hint names a narrower call to make instead.

**Why no DataCanvas:** ~~The query tool returns decoded observations that are human-readable in format(). Tabular analysis can be done by the agent in subsequent steps. DataCanvas would add complexity; the domain's natural unit is a result set per filtered query, not a persistent analytical workspace.~~

> **Superseded 2026-08-04 — see "Why the canvas earns its keep now" below.** The reasoning above holds only while a result set fits in the response. It does not: `query_dataset` caps the observations it returns at 5,000, and a filtered query on a mid-sized dataset routinely matches more (`nama_10_gdp` filtered to one unit, last four periods, matches ~6.6k). "The agent can analyse it in subsequent steps" was true of the rows it received and false of the rows it never saw, which no follow-up call could reach — there is no cursor, and the only recovery was to hand-partition the query across dimension values.

**Why the canvas earns its keep now:** the rows past the cap are already in memory. `query_dataset` downloads and parses the entire upstream body before decoding starts — the cap bounds object construction, not the transfer — so staging the full match costs no additional request to Eurostat and no re-fetch. That makes this the cheapest possible way to close the gap. It also passes both gates the framework's canvas guidance sets: the data is analytical rather than a discovery surface (an agent writes `GROUP BY geo` over observations, which is exactly the workload), and it is too large to inline (that is the premise). The canvas is on by default; a deployment that does not want it sets `CANVAS_PROVIDER_TYPE=none` and keeps the inline-only behaviour.

---

## Known Limitations

**No upstream search on dimension values:** The dataset-scoped SDMX metadata surface has no label-search operation (e.g., "find the code for 'purchasing power standard per inhabitant'"). `get_dimension_values` fills the gap locally with `filter`, a case- and accent-blind word match over each value's code and label; it neither ranks, fuzzes, nor transliterates, so `münchen` does not find the `MUENCHEN` of the airport-pair labels — `muenchen` does.

**Async responses for large unfiltered queries:** Eurostat's API may return a `{"warning":{"status":413,...}}` async response for very large queries — documented API behavior, though it appears to depend on server load and is not guaranteed for any specific query size. The server detects and surfaces this as a non-retryable `ServiceUnavailable` error with guidance to filter more tightly — repeating the identical request cannot change the outcome. Very large datasets like `nama_10_gdp` (1.1M observations) should be queried with at least geo + time filters as a best practice regardless.

**TOC metadata lag:** The cached TOC is at most `EUROSTAT_TOC_CACHE_TTL_MS` old (default 12 hours). A dataset Eurostat adds in one of its twice-daily updates will not appear in search or browse results until the next catalogue call past the TTL refreshes the cache. Acceptable for a statistical data server; lower the TTL to shorten the window.

**Comext collections carry no coverage and double-count when summed:** the Comext host publishes no period coverage or observation count, so search, browse, `get_dataset_info` and the resource leave them unreported for `DS-*` codes. The trade flows mix `freq` A and M in one dataset, and `product`, `reporter` and `partner` mix aggregates (`TOTAL`, `EU27_2020`, HS2 over HS4 over CN8) with their members, so an unfiltered `SUM` over a staged table counts values more than once. Both are domain properties, stated in the descriptions and the README rather than corrected.

**The first metadata call on a large Comext collection is slow:** `DS-045409`'s structure is a 23 MB uncompressed body, measured at about 28 s. The per-dataset cache spares every later call inside the hour; `EUROSTAT_METADATA_TIMEOUT_MS` (2 minutes) bounds the first.

**NUTS version differences:** Eurostat NUTS classifications change periodically (NUTS 2013, 2016, 2021). Codes may refer to different geographies across versions. Dataset metadata notes the NUTS version, but the server does not expose NUTS version comparison tooling.

**Shadowed folder placements are not addressable:** `theme_code` takes a bare code, not a path, so a code filed under several branches always resolves to the first one — including when the caller has just browsed a different placement and drills into a folder code it listed. `other_placements` makes the ambiguity visible, but reaching a shadowed branch would need path-qualified addressing. Affects 43 of the ~1,900 folder codes, 10 with differing child sets.

**The canvas does not raise the transfer ceiling for `query_dataset`:** staging reaches rows outside the inline preview from a response the server already received; it does nothing for a dataset too large to download inside `EUROSTAT_REQUEST_TIMEOUT_MS`. That bound stays where it was — measured, an unfiltered `nama_10_gdp` is ~18.7 MB over ~23 s and `hlth_cd_asdr2` ~73 MB over ~87 s, past the 30 s default. `eurostat_download_dataset` is the route past it: a cheaper wire format, its own longer timeout, and a byte budget that truncates loudly instead of timing out.

**A bulk download is bounded by bytes, not by completeness:** `EUROSTAT_BULK_MAX_BYTES` (50 MiB decoded by default) will truncate a dataset that exceeds it, and the truncation point is wherever the budget lands — the leading rows in Eurostat's own key order, not a sample and not the most recent periods. `budgetExceeded` says so, but the only way to a complete large dataset is filters or a period range that fit it inside the budget. Raising the budget trades against `EUROSTAT_BULK_TIMEOUT_MS`: measured throughput on the TSV endpoint is roughly 0.86 MB/s, so 50 MiB is about a minute of the 2-minute default.

**The bulk endpoint carries codes, not labels:** the TSV layout has no room for them, so a staged bulk table has no `<dim>_label` columns and its `obs_flag_label` / `conf_status_label` come from a static dictionary rather than from the response. A code absent from that dictionary stages with a null label rather than an invented one. Labels for dimension values need `eurostat_get_dimension_values`, which stages them as a `code`/`label` table beside the download when given its `canvas_id`, so the join happens in SQL. Labels on the bulk table itself were rejected: they would add a metadata round-trip per dimension to every download, and the join covers them on demand.

**The two staged shapes differ only in their dimension columns:** a table from `query_dataset` and a table from `download_dataset` join cleanly on their dimension code columns and `time` — same names, same `VARCHAR` type, `obs_value` `DOUBLE` on both — and carry the same five measure columns with the same codes, so a caller can compare `obs_flag` or `conf_status` across them directly. What diverges is the `<dim>_label` companions, which only a query table has, and that divergence is additive in both directions. `dataframe_describe` reports the names and types, which is enough to see it.

**The bulk queue envelope is not collectable:** when Eurostat answers with a `SUBMITTED` ticket the extraction is genuinely queued upstream, but there is no supported way to poll for it here — same reasoning as the Statistics API's async response. The server detects it and names what to narrow.

**A bulk download without a canvas is counted and discarded:** the transfer still runs so `rowCount`, `missingCount` and `periodRange` describe the dataset, but only `preview_limit` rows survive the call. Reporting the preview length as the dataset count would be false; the tradeoff is bandwidth spent on a deployment that cannot keep the data.

**Canvas tables are in-memory and per-process:** a restart drops every staged table, and a `canvas_id` issued by one process is meaningless to another. Behind a load balancer, a follow-up `dataframe_query` must reach the same instance that staged the table. Both are properties of the framework's canvas, not of this server; a `canvas_id` that no longer resolves fails as `canvas_not_found` with a recovery hint to re-run the query.

**No canvas from a `.mcpb` bundle:** the bundle strips platform-specific native bindings so it stays portable and inside the registry size cap, which removes DuckDB. Its manifest sets `CANVAS_PROVIDER_TYPE=none`, so a bundle install runs the six core tools rather than starting with a canvas that fails on its first staging call; SQL analytics needs the npm, Docker, or from-source install.

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-10-26 | Page dimensions by count and return every canvas SQL row intact | Predictable counts keep page boundaries independent of label width and stop a second cut from dropping SQL rows the canvas allowed. Dimension pages default to 25 and cap at 1,000; keyset cursors keep every code reachable and tolerate a list growing between calls. Existing oversized cursor counts normalize with disclosure. The code/label filter remains local; bulk-transfer and metadata-cache byte limits serve separate purposes and remain. |
| 2026-10-26 | Add explicit query staging while retaining the automatic 5,000 threshold | Smaller matches can exceed the preview too. `stage: true` makes those rows reachable without making an ordinary lookup consume canvas state; the existing lazy row source stages them without another request. |
| 2026-10-26 | Report unpopulated selected periods from full-match membership | `last_n_periods` counts time positions, including future or sparse positions. Checking the existing full scan prevents preview truncation, confidentiality and text values from creating false gaps. |
| 2026-10-26 | Resolve identifiers exact-first, then case-insensitively | Canonical dimension/theme codes drive geo checks, cursor identity and folder placement, while preserving exact matches and every returned value code and label. |
| 2026-09-25 | Route `DS-*` codes to the Comext host by prefix, inside the existing tools | The Comext host serves the same route families, so one predicate in the URL builders reaches it with no new tool. A separate tool family would double the surface and make the caller choose the host; an output field echoing the host adds nothing the prefix and `appliedQuery.url` do not already say. |
| 2026-09-25 | Merge the Comext dataflow list into the catalogue at runtime, with its own failure isolation | A static list of 11 codes would drift silently; the runtime list is 23 KB per catalogue load. A Comext outage must not become a search outage, so the TOC alone answers until a retried merge succeeds. |
| 2026-09-25 | Cap `get_dimension_values` at 2,000 values inline | `DS-045409`'s 37,069 product codes were an 11 MB response. 2,000 keeps every NUTS level and classification list measured on the main host whole, NUTS-3's 1,621 being the largest, and the staged table holds the rest. This changes the contract for seven main-host lists above it: three daily `time` dimensions and four airport-pair lists. |
| 2026-09-25 | Cache parsed metadata per dataset for an hour, frozen, keyed by host and lowercased code | Every metadata call on `DS-045409` re-downloaded 23 MB. An hour bounds staleness against Eurostat's twice-daily publication, the promise map shares concurrent loads, and freezing makes the shared entry safe on a hosted instance that serves every caller from one process. |
| 2026-09-25 | Bound the metadata cache by estimated bytes (64 MiB), not entry count, and copy the parse out of its response bodies | One entry ranges from a few KB to 13.5 MB, so a count bound says nothing about memory; as parsed, each entry also pinned its 23 MB source body, 52 MB per `DS-045409` entry. |
| 2026-09-25 | Run shared loads (dataset metadata, TOC, Comext merge) without a caller's abort signal; each caller races its own | The first caller's signal cancelled a load every concurrent caller was waiting on, failing them or silently postponing the Comext merge. The timeouts bound a load no caller waits for any more, and its result fills the cache for the next one. |
| 2026-09-25 | Decode text-valued cells instead of coercing or dropping them, and add `obs_value_text` only to `DS-*` tables | PRODCOM publishes `:C` and units in the value position; a string failed `query_dataset`'s output validation and was silently nulled by the TSV parser. `:C` maps onto the existing `confStatus` / `conf_status`; other text is kept verbatim. The column is declared only on `DS-*` tables, the only collections observed publishing text, so main-host staged tables keep their five measure columns. |
| 2026-09-25 | Classify SOAP fault 413 as non-retryable `extraction_too_big` on every host | It surfaced as `upstream_fault` with "retry in a few minutes", though the same request fails the same way every time. The fault is host-agnostic — the main host's extraction limit produces it too — so the branch keys on the code, not the dataset. |
| 2026-09-25 | Read `download_dataset`'s key order from the unversioned structure definition, superseding the `lastTimePeriod=1` JSON-stat slice | The slice is an observation request, so a dataset whose latest period alone exceeds the 5,000,000-row extraction limit (`earn_ses_annual`) answered it with HTTP 413 and failed a filtered download before its own request was sent. The structure definition is a few KB whatever the dataset's size. It is read unversioned because a pinned `/1.0` returns the dataset's first structure, not its current one. |
| 2026-09-25 | Acquire a canvas only after the download stream yields its first row | An empty download minted a canvas the `no_results` error never named, or added a 0-row table to the caller's, holding a tenant canvas slot until `CANVAS_TTL_MS`. Pulling one row first costs nothing and makes the canvas and no-canvas deployments fail an empty download identically. |
| 2026-09-25 | Stage a dimension's value list as a `code`/`label` table only onto a caller-supplied canvas | Bulk tables carry codes only, and hand-mapping a 1,621-code NUTS-3 list does not fit inline. Requiring `canvas_id` keeps a plain lookup from taking a canvas slot, and the list lands where the download it labels already is. |
| 2026-05-23 | Use Statistics API (JSON-stat) over SDMX 2.1/3.0 for data queries | JSON-stat simpler to parse, Statistics API is the officially recommended endpoint for public data access. SDMX returns XML requiring additional dependency. |
| 2026-05-23 | Use TOC TXT (not SDMX `dataflow` endpoint) for dataset catalogue | TOC includes predefined tables and the full theme hierarchy tree. SDMX catalog has 8,220 entries vs TOC's 8,933 entries — TOC is more complete. Single source enables both search and tree browse. |
| 2026-05-23 | Cache TOC in memory for session lifetime | File is ~2 MB, changes at most twice daily. Per-call fetch adds 1–2s latency to every browse/search with no benefit. |
| 2026-08-03 | Bound the TOC cache with a 12-hour TTL, superseding the session-lifetime entry above | The original tradeoff assumed a short-lived process; a hosted HTTP deployment keeps serving the snapshot taken at container start. A TTL matched to the upstream twice-daily cadence keeps the per-call cost at zero inside the window while capping staleness, and stale-on-error preserves the availability the in-memory cache was chosen for. |
| 2026-10-14 | Disclose a partial catalogue on every success rather than only logging it | A failed Comext merge or TOC refresh left search and browse answering from part of the catalogue with nothing in the result saying so, so a success implied the `DS-*` collections, or Eurostat's latest updates, did not exist. `comextListMissing`, `catalogueLoadedAt`, and one last-wins `notice` reach both surfaces; a search `no_match` and a browse `not_found` carry both disclosures in their recovery hint. |
| 2026-10-14 | Fold whitespace beside punctuation out of the search haystack, never split query tokens | Splitting both sides on punctuation also matched `Rev.2` to `Rev. 2`, but its one-character pieces matched almost everything (`R&D`: 89 → 7,562 of 7,571 datasets) and broke `DS-*` code detection. Folding only the haystack fixes the spacing misses without narrowing any query. |
| 2026-08-03 | Bind search cursors to the query and TOC snapshot that produced them | The framework's `paginateArray` round-trips only `{offset, limit}`, so any structurally valid cursor paged any result set. Carrying the normalized query and the TOC load timestamp in the cursor turns both a cross-query cursor and a mid-pagination catalogue refresh into a clean `invalid_cursor` rejection instead of a silently shifted page. |
| 2026-05-23 | Decode JSON-stat in the service layer | The stride-based flat index math is non-trivial and should not be re-implemented by callers. Every output consumer needs labeled data, not numeric indexes. |
| 2026-05-23 | Surface async response as ServiceUnavailable (retryable) rather than implement polling | Async is Eurostat's soft error for oversized queries. The right recovery is adding filters, not polling. Polling would require cross-call state with no supported mechanism in the Statistics API. |
| 2026-08-04 | Classify `async_response` as non-retryable across all three data tools, superseding the blanket "retryable" entry above | The 413 warning is deterministic — the identical request produces the identical oversized response, so a retry is guidance toward a call that cannot succeed. `get_dimension_values` and `query_dataset` were already tightened; `get_dataset_info` was the last holdout, and its recovery hint now points at catalogue-level coverage metadata and per-dimension inspection instead of a wait-and-retry it cannot narrow. |
| 2026-09-25 | Drop `async_response` from `get_dataset_info` and `get_dimension_values` and declare `upstream_fault` instead, superseding the entry above for those two tools | Both read only the SDMX structure and content constraint, which never raise `async_response` and are served whole even at 23 MB, while an unreadable body raised `upstream_fault`, which neither contract declared. |
| 2026-08-04 | Omit annotation-derived metadata fields rather than defaulting them | `obs_count: 0`, `time_range: {start:"",end:""}`, and `last_updated: ""` were indistinguishable from a real zero or a genuinely empty value. Omission follows the `metadata_url` precedent already in the extractor and preserves the upstream's own uncertainty. Applies to all three schemas reading those annotations: `get_dataset_info`, the `eurostat://dataset/{dataset_code}` resource, and `query_dataset`'s `time_range`, which falls back to the same two period annotations when the result carries no `time` dimension. |
| 2026-08-04 | Spend a second bounded request in `get_dataset_info` to count `time` | The `lastTimePeriod=1` slice that makes the call cheap also reduces `time` to one value, and the tool tells callers to size a dimension from `values_count` — so `time` reported `1` for every dataset. The pin-and-probe already built for `get_dimension_values` reuses the first response as its probe, so the real period count costs one extra round trip bounded to \|time\| observations. |
| 2026-08-30 | Use dataset-scoped SDMX dataflow descendants plus content constraints for metadata, superseding observation-backed discovery | The Statistics slice still couples structure discovery to observation volume and only describes values populated in the selected slice. The scoped dataflow supplies labels, annotations, concepts, and the DSD; its content constraint supplies the actual positions, including the full time set. The join preserves `DatasetMeta`, avoids the rejected global datastructure fallback, and makes an empty geo level a scoped `no_results` rather than a missing-dataset claim. |
| 2026-08-04 | Split the JSON-stat status into `OBS_FLAG` and `CONF_STATUS`, breaking `query_dataset`'s output contract | JSON-stat has no `CONF_STATUS` field and folds the code into the observation status behind a `|`, so a confidential cell staged as `obs_flag = '|C'` — a value from a different codelist, carrying an encoding artifact, in a column documented as holding an `OBS_FLAG`. No `OBS_FLAG` code contains a `|`, so the separator is unambiguous. Splitting it puts the code in `conf_status` on both staging paths, which is what makes a query table and a bulk table joinable on the flag columns: the same slice previously agreed on 6 of 12 flags and now agrees on all 12, matching the SDMX-CSV rendering. Kept as a break rather than a parallel column, because the old value was wrong rather than merely awkward. |
| 2026-08-04 | Decide `query_dataset`'s `no_results` from the response's cell count rather than from `value` alone | The guard tested `value` while the decoder treats a cell as an observation when its index appears in `value` **or** `status`. JSON-stat carries a confidential cell in `status` with no `value` entry, so a slice where every cell is confidential arrives as `"value": {}` and was rejected as an empty match — `sts_inpr_m` filtered to IE over 2023-01…2023-06 threw `no_results`, while the same request with BG added returned all 12 rows, the 6 Irish ones included. Reading `obs_count`, the total already scanned from both key maps, leaves one place deciding what an observation is, so a rejected query and a returned one cannot disagree; a match with both maps empty still raises `no_results`, and its recovery hint now names the period range, the other way Eurostat answers 200 with nothing. |
| 2026-08-04 | Apply `query_dataset`'s 5,000-row cap inside the decoder, and count the totals from the response's cell keys | The cap previously ran after every matched cell had been decoded, so a broad query built ~1.1M observation objects to return 5,000. Stopping the decode at the cap removes that allocation. The totals then cannot come from the decoded array, so `obs_count`, `missing_obs_count` and `time_range` are counted from the `value`/`status` keys instead — one pass, no per-observation object — and keep describing the whole match. End-to-end latency barely moves: the full response body is already in memory before decoding starts, and transferring it is ~93% of a broad query's wall time. |
| 2026-08-30 | Add `query_dataset.preview_limit` while keeping 5,000 as an independent staging threshold, superseding the fixed 5,000-row inline response | Most callers need orientation before they need thousands of decoded objects. A deterministic 1–500 prefix bounds both response paths without changing full-match totals or the uncapped row generator; retaining the threshold separately avoids minting Canvas state for smaller matches. Filters remain the only control that reduces the upstream match, and no cursor or offset is added. |
| 2026-08-04 | A failed time enumeration omits `time`'s `values_count`/`sample_values` instead of failing the call | The second request in `get_dataset_info` answers one dimension's value count; everything else comes from the first. Aborting the call over it discarded the label, dimension list, period range, observation count and metadata URL already retrieved. Falling back to the one-period slice was rejected — it silently restores `values_count: 1` for every dataset, the exact defect the second request was added to fix. Omission extends the idiom already used for the annotation-derived fields and works identically on the tool and the resource, which has no enrichment surface for a notice. |
| 2026-08-04 | Resolve a duplicated folder code to its first TOC placement, and disclose the others | `code_index` kept the last placement, so a duplicated code browsed the final branch and the earlier one became unreachable — most visibly the root code `data`, which returned "Cross cutting topics" 2 children instead of the 9 top-level themes. First-wins matches the canonical-placement rule `search()` already applies to duplicate dataset codes, and in all 10 live cases where placements differ the first lists at least as many children as the ones it shadows (a superset in nine; `data` is the exception, its two branches listing different children that a root-level browse already unions). `other_placements` returns the breadcrumbs of the branches not taken, so an ambiguous code is visible rather than silently resolved. |
| 2026-08-30 | Distinguish known dataset and table codes from absent browse codes | A code returned by browsing is valid catalogue data even when it cannot be expanded. `not_a_folder` preserves that distinction, names the actual entry type, and routes the code to the metadata and query tools; `not_found` remains reserved for codes absent from the TOC and keeps root-navigation recovery. |
| 2026-08-04 | Stage a capped `query_dataset` match on a DataCanvas, superseding the "Why no DataCanvas" decision above | The cap left rows unreachable with no cursor and no continuation — the only recovery was hand-partitioning the query. Those rows are already in the parsed response body, so staging them costs no extra upstream request. Canvas stays off by default; the server's behaviour without one is unchanged. |
| 2026-08-04 | Feed the spill from a lazy generator, never a materialised array | The 0.3.0 cap exists to stop a broad query building ~1.1M observation objects. Collecting the full match into an array to hand to the canvas would reinstate exactly that allocation. One generator walks the response's populated cells; the capped decode takes its first 5,000 yields and the canvas appender pulls the rest one row at a time — which also makes the inline rows a prefix of the staged table by construction rather than by agreement between two code paths. |
| 2026-08-04 | Automatically stage only above 5,000 matched observations | The threshold keeps ordinary small and medium lookups from consuming a per-tenant canvas slot; preview length never triggers staging. Explicit `stage: true` now lets the caller request one below that threshold. |
| 2026-08-30 | Put `dataframe_describe` before `dataframe_query` in every staged response | Query and bulk tables have different dimension-column shapes, so a table handle alone is not enough to write reliable SQL. Carrying the ordered workflow in structured notices, rendered content, and schema descriptions keeps both consumption paths aligned; deployments without a Canvas omit the tools and their guidance together. |
| 2026-08-04 | Flat `<dim>` / `<dim>_label` columns with `obs_`-prefixed measures, on a declared schema | A dataframe column holds a scalar, so the nested `{code, label}` observation shape cannot cross into SQL intact; splitting it keeps both halves queryable. The `obs_` prefix matches Eurostat's own SDMX-CSV naming and cannot collide with a dimension code. The schema is declared rather than sniffed because inference reads only the leading rows and would type an all-integer prefix as `BIGINT`, which the canvas then returns as a string. |
| 2026-08-04 | No row cap on what is staged | The transfer timeout already bounds this path far below any size DuckDB struggles with — the largest response that fits in the 30 s default is ~1M observations, and DuckDB spills to the configured scratch directory rather than failing. A second cap would be a limit guarding a state the first one already prevents. |
| 2026-08-04 | Register the dataframe tools via `disabledTool()` rather than omitting them | Omitting them hides the capability from the landing page and server card too, so an operator reading the README sees a tool the server never mentions. The wrapper keeps them off `tools/list` — clients still cannot call them — while rendering the reason and the variable that enables them, and it keeps the framework's canvas-consumer pairing check satisfied in both configurations. |
| 2026-08-04 | Fail rather than degrade when staging errors | A canvas that quietly stops working looks identical to one that was never enabled, and the difference only surfaces as a capability silently missing. Acquire failures caused by an unwritable scratch directory are re-thrown naming `CANVAS_TEMP_PATH`, so the actionable case is actionable rather than a bare `EACCES`. |
| 2026-10-03 | Re-throw an unwritable `CANVAS_TEMP_PATH` as `ConfigurationError` (`canvas_unavailable`), superseding `ServiceUnavailable` | Since framework 0.13.9 the provider creates a private `mcp-canvas-XXXXXX` directory inside `CANVAS_TEMP_PATH` and fails canvas creation as `ConfigurationError`, with the filesystem error on `cause`. Its message names the variable, but the errno never reaches the caller and `CANVAS_PROVIDER_TYPE=none` goes unmentioned, so the re-throw stays to add both. It keeps the framework's code: `ServiceUnavailable` counted a local misconfiguration as an upstream outage in `mcp.error.category`. |
| 2026-08-04 | `dataframe_describe` omits the canvas's `approxSizeBytes` | The framework populates that field from DuckDB's `duckdb_tables().estimated_size`, which is an estimated row *cardinality*, not a byte size — measured, it comes back equal to `rowCount` (6,607 and 7,882 on two staged tables). Surfacing it would report a row count under a byte-shaped name, and `row_count` already carries that number exactly. |
| 2026-08-04 | `@duckdb/node-api` as a runtime dependency, with no build-time gate on it | The canvas is already gated at runtime by `CANVAS_PROVIDER_TYPE` (`none` by default), so the ~110 MB binding sits inert until an operator turns the feature on. Gating the install on top of that — a dev dependency plus a Docker build arg — would mean the published image, which is built with no custom build args, could never list the dataframe tools at all. Shipping the binding in every install and image leaves one switch to reason about. The `.mcpb` bundle is the one surface that cannot run the canvas: it strips platform-specific native bindings to stay portable and inside the registry size cap. |
| 2026-10-19 | Default `CANVAS_PROVIDER_TYPE` to `duckdb`, with the `.mcpb` manifest setting `none`, superseding "Canvas stays off by default" above | Every npm install and image already carries the binding, so off by default kept the dataframe tools and full-match staging behind a variable most deployments never set. The framework default stays `none`, so `src/index.ts` runs the framework's config parse first (it loads `.env` without overwriting set variables, so an earlier default would mask a `.env` value of `none`), applies the default with `\|\|=` so an empty value from a client config gets it too, and drops the cached parse. The bundle has no DuckDB binding, so with `duckdb` it would start and then fail on its first staging call. |
| 2026-08-04 | Add `eurostat_download_dataset` over the SDMX 2.1 TSV endpoint rather than widening `query_dataset` | The two answer different questions and have different failure modes. `query_dataset` fetches a filtered slice as JSON-stat and decodes it in memory; the bulk path streams a whole dataset in a format with different error encoding (XML SOAP), different transport behaviour (undeclared gzip, chunked), and a size bound this server has to impose itself. Folding that into one tool would mean one description covering two shapes and one error contract covering both fault vocabularies. |
| 2026-08-04 | Take filters as a dimension map and build the positional key server-side | The SDMX key must carry one position per dimension in dataset order; a count mismatch is faultcode 140, not a partial match. Emitting a position for every dimension of the resolved order makes correct arity structural rather than the caller's problem. The residual failure — a filter naming a dimension the dataset does not have — is caught locally, before the request, and answered with the real dimension list. |
| 2026-08-04 | Resolve the dimension order only when a filter is present, and omit the key segment otherwise | An unfiltered download needs no key, and the TSV header names the dimensions anyway, so the metadata request is skipped. An all-wildcard key of the right arity is accepted upstream, but omitting it asks the same question without staking the request on this server's copy of the dimension order still being current. |
| 2026-08-04 | Offer no `last_n_periods` on the bulk tool | Mapping it to `lastNObservations` keeps every period column in the TSV header and blanks the unselected cells — measured at ~3× the equivalent JSON-stat body, so the bulk path would be slower and larger than the tool it exists to beat. `startPeriod` removes the columns, so `since_period`/`until_period` are the only period controls and the description says why rather than leaving the omission to look like an oversight. |
| 2026-08-04 | Sniff gzip off the stream instead of reading headers or predicting from size | Eurostat compresses large bodies with no `Content-Encoding`; `Content-Type` stays `text/tab-separated-values` and the only header-level tell is a `.tsv.gz` filename on `Content-Disposition`. The switch is not monotonic in observation count — `migr_asyappctzm` (103M observations) arrives plain while `proj_19rp3` (91M) arrives gzipped — so neither headers nor a size heuristic decide it. The magic bytes do. |
| 2026-08-04 | Enforce the byte budget on decoded bytes, while streaming, and cancel the transfer | The body is chunked with no `Content-Length`, so a limit applied after the fact has already paid for the whole download. Counting decoded rather than wire bytes is the one measure that means the same thing for both encodings, and since a gzip body is never larger than what it expands to, bounding the decoded size bounds the transfer too. |
| 2026-08-04 | Truncate on overspend rather than throwing | The caller has already paid for everything downloaded when the budget runs out; raising an error trades a usable prefix of the dataset for nothing. `budgetExceeded`, `bytesRead` and a notice naming `EUROSTAT_BULK_MAX_BYTES` make the partial result loud, and the half-line the budget cut is dropped rather than parsed, so a truncated download never emits a row with silently missing fields. |
| 2026-08-04 | Classify the `SUBMITTED` queue envelope explicitly, on the success path | It arrives as HTTP 200 with `Content-Type: application/xml`; read as TSV it yields a header row of XML and no rows, which presents as a successful empty download. Detecting it before the header parse turns a silent wrong answer into a non-retryable error naming what to narrow. It is triggered by server-side cost rather than response size and is not deterministic per dataset, so it cannot be predicted from the request. |
| 2026-08-04 | Stage bulk rows as code columns only, with no `<dim>_label` companions | The TSV endpoint carries no labels, so label columns would stage as all-null and claim a lookup that never happened. The divergence from `query_dataset`'s staged shape is real, so both dataframe tool descriptions now tell callers to read the columns from `dataframe_describe` rather than assume one layout. |
| 2026-08-04 | Buffer the TSV header to its line break with no length cap, while still capping the XML classification peek | The header carries one field per period, so its length tracks the dataset's period count rather than any fixed shape — `ert_bil_eur_d` is 13,852 fields and 166 KB. A fixed peek window would parse a prefix of it as the whole header, drop every period past the cap, and hand the header's own tail to the row parser as data; measured, that reported 95,722 observations for a dataset holding 512,524, with `budgetExceeded` false. The byte budget is the bound that belongs here. The peek window stays on the XML branch, where both non-data shapes are under 400 bytes. |
| 2026-08-04 | Ship a static OBS_FLAG / CONF_STATUS dictionary, and leave unknown codes unlabelled | The bulk format carries flag codes with no labels. Both dictionaries are the published codelists copied verbatim — 42 `OBS_FLAG` codes from `sdmx/2.1/codelist/ESTAT/OBS_FLAG`, composite rather than decomposable (`bdep` is one code, and the bare `b` it builds on is 1,907 of `nama_10_gdp`'s observations), and `C` / `N` / `P` from `sdmx/2.1/codelist/ESTAT/CONF_STATUS`. A static copy can fall behind, so a code the dictionary does not hold stages with a null label rather than an invented one. |
| 2026-08-04 | Drain the download even when no canvas is configured | Stopping at `preview_limit` would report the preview length for a dataset of millions. Draining keeps `rowCount`, `missingCount` and `periodRange` describing the download, keeps one code path under both configurations, and leaves the byte budget bounding what is transferred. The response says plainly that only the preview is retained rather than implying the rest is reachable. |
| 2026-08-04 | Give the bulk path its own timeout, and no retry | A bulk body streams for minutes where a metadata call answers in seconds, so sharing `EUROSTAT_REQUEST_TIMEOUT_MS` would either time out every download or loosen every metadata call. Retry is omitted for the same reason inverted: re-running the most expensive request this server makes, on a transient failure, costs the caller another full transfer. |
| 2026-05-23 | 5 tools, no prompts, 1 resource | Domain is read-only data retrieval with a natural tool workflow (discover → inspect → query). Prompts add no value over well-designed tool descriptions. Resource for `eurostat://dataset/{dataset_code}` provides cache-injectable context without requiring a full query. |
| 2026-05-23 | Exclude SDMX codelist tool | Global codelists (4,292 geo entries) are unhelpful without dataset scoping. `get_dimension_values` is dataset-scoped and returns actionable values. |
| 2026-09-25 | Check period literals in the handler through one shared helper, not with a schema `pattern`, and reject components that do not exist | A `pattern` cannot trim first, so it would fail the blank and padded bounds that mean "no bound" and the trimmed value today, and a schema rejection arrives as `invalid_arguments` without the declared `invalid_period` hint. Existence (month, quarter, semester, ISO week, calendar day) is checked because the bulk endpoint — and the Statistics API for `2021-W53` and `2021-02-29` — rolls an impossible component into a neighbouring period and answers for a range nobody asked for. A zero-padded frequency number (`2020-Q01`, `2020-W001`) is rewritten to its canonical form rather than rejected: it maps one-to-one onto a literal both endpoints read, the bulk endpoint already served it correctly, and rejecting it would break working calls to keep one grammar. The grammar also covers the SDMX forms both endpoints already served — trimester `YYYY-Tn`, day-of-year `YYYY-Dnnn`, and (bulk only) annual `YYYY-A1` — on the same terms, since leaving them out would have turned working calls into `invalid_period`. |
| 2026-09-25 | Split bulk fault 140 on its fault string | The same code carries `TIME_PERIOD_FILTER_SPEC_INVALID` for an unreadable period and `INVALID_QUERY_NB_FILTERS` for a key of the wrong arity; mapping both to `filter_arity` told callers the dataset structure had changed when the period was the problem. |
| 2026-09-25 | Diagnose `query_dataset`'s empty match from the reply's own `category.index`, and reuse the comparison on success | The JSON-stat reply already says which filter values matched nothing and which periods it selected; reading it costs no request. Keying on `size === 0` alone misses a value dropped beside a matched one (`geo=DE,XX`), and the same drop on a successful query otherwise reads as a complete result. One comparison serves both paths, so `unmatchedValues` has one shape whether the call succeeded or failed. `matchedPeriods` lists at most the newest 24 periods beside a full `matchedPeriodCount`, since an unnarrowed daily index would otherwise put ~14,000 entries in one error. |
| 2026-09-25 | Reject an empty `since_period`/`until_period` range by comparing the start of one period against the end of the other | Neither endpoint refuses an inverted range; both answer with data outside it. Mapping every accepted form to a span of days decides emptiness for any pair of frequencies without a per-frequency rule, and start-versus-end keeps pairs such as `2020-06` to `2020` valid. |
| 2026-09-25 | Match filter keys to dimension ids case-insensitively in every server-side check, and send the keys as given | Eurostat reads `GEO` as `geo`, so an exact-case check let `GEO` plus `geo_level` through and missed its unmatched values; the bulk key builder rejected it outright. Rewriting keys upstream is unnecessary — the Statistics API already accepts any case and the bulk key is positional — so only the checks change. |
| 2026-09-25 | Disclose `download_dataset`'s short preview in `notice` and `totalCount`, not `truncated` | `truncated: true` on nearly every complete download read as "the data was cut short", which on this tool is `budgetExceeded`'s job, and it meant the opposite of `query_dataset`'s `truncated` for the same situation. `ctx.enrich.total` keeps the framework's capped-list disclosure satisfied. The no-canvas sentence stops recommending a narrower query when the rows already fit inline, where that advice was false. |
| 2026-09-21 | Declare every `canvas_id` input with the framework's `CanvasIdSchema` | The minted 10-character shape then reaches `inputSchema`, so a caller sees it before calling, and an impossible id fails argument validation instead of a registry lookup. The accepted cost is on the two staging tools: a malformed id is now rejected even where a well-formed one would be ignored (no canvas, or a match at or below 5,000). |
| 2026-10-03 | Ship `dataframe_drop` behind `EUROSTAT_DATAFRAME_DROP_ENABLED` (default `false`), wrapped in `disabledTool()` until the flag and the canvas are both on | A drop cannot be undone, and on a no-auth deployment holding a `canvas_id` is the only access check, so any caller with an id could remove a table another is still querying. Staged tables already expire with their canvas, which makes cleanup a convenience an operator opts into rather than a default. |
| 2026-10-03 | Declare `dataframe_drop`'s `table_name` with the framework's `CANVAS_IDENTIFIER_REGEX` | A name no staged table could carry then fails argument validation with a message pointing at `dataframe_describe`, and the pattern reaches `inputSchema`. The canvas's own rejection of the same name carries a hint about choosing a new one, which a caller removing an existing table cannot act on. A bare SQL keyword still passes the pattern; the handler re-throws the canvas's `identifier_reserved`, and its `canvas_not_found`, through `ctx.fail` for the same reason. |
| 2026-10-03 | Parse the server config in `setup()`, and read the drop flag ahead of `createApp()` without reporting a parse failure there | A tool made the first `getServerConfig()` call, so a bad value let the server report ready and then failed every call. The tool list needs the flag before `createApp()` runs, and an error thrown there escapes as an uncaught stack trace; `setup()` parses again and fails through the framework's configuration banner instead. |
| 2026-10-14 | Re-throw the canvas's `canvas_not_found` and `missing_table` through `ctx.fail` on every canvas tool, extending the `dataframe_drop` precedent | The canvas attaches its own generic hint to both, and a hint set at the throw site outranks a declared recovery, so every declared recovery for them was dead text. The staging tools' own advice — omit `canvas_id` — is the one a caller can act on. Matching on the reason and passing everything else through keeps SQL gate rejections and `canvas_unavailable` exactly as they were. |
| 2026-10-14 | Offer only narrowing on a canvas-off over-cap `query_dataset` match, never `download_dataset` | Without a canvas a download keeps only its inline preview and points back at a filtered query, so naming it from the query's notice and banner sent the caller in a loop. The tool descriptions still name it, since a deployment-agnostic description cannot know whether a canvas runs, and the download's own description discloses what it keeps without one. |
| 2026-10-14 | On a deployment without a canvas, let `get_dimension_values` page with `canvas_id` beside `cursor` instead of refusing the pair | `canvas_id` is documented as ignored without a canvas, and the refusal exists only to stop the list being staged again on every page, which cannot happen there. Refusing it told the caller a staged table held every value when nothing had been staged. |
| 2026-10-14 | Treat a blank or whitespace-only filter value as unset on both data tools, through one shared normalization | A form-based client sends `[""]` for "no filter". Sent upstream it became an empty SDMX key position (a download widened to every value, or an HTTP 500 fault blamed on Eurostat) or an empty `geo=` (an HTTP 400 reported as `conflicting_params`). One helper decides what a filter restricts, so the request, the conflict checks, the applied-filters echo and the too-large hint cannot disagree. |
| 2026-10-14 | Reject a `query_dataset` filter key naming a Statistics API control as `invalid_dimension`, rather than remapping it to the dedicated input | Eurostat reads control names in any case, so such a key bypassed the dedicated input's validation or overrode it while the echo reported the input's value. Remapping would need per-control value parsing for string arrays and conflict rules against a set input, and would keep a second undocumented spelling of every control. No dataset dimension shares a control's name. |
| 2026-10-14 | Reject a `time`/`time_period` filter beside a period input locally as `conflicting_params`, and map Eurostat's "cannot be set at the same time" label there ahead of the period-label backstop | Eurostat refuses the pair, and its label names `sinceTimePeriod`/`untilTimePeriod`, so the period backstop reported a valid period as `invalid_period` with a format hint. The match is anchored on a time parameter, since Eurostat refuses `geo` beside `geoLevel` in the same words. |
| 2026-10-14 | Classify a request that met HTTP 5xx or an unreachable host on every retry as `upstream_fault` with `retryable: true`, through one helper every fetch calls | It surfaced reasonless, with no recovery, on every tool — `get_dataset_info` first among them, the route a `DS-*` code is pointed to. One predicate and one error shape for the structure, Statistics, bulk and catalogue fetches keeps the four from drifting; reusing `upstream_fault` keeps one reason for "Eurostat could not answer", with `retryable` and the hint telling an outage from an unreadable body. `query_dataset`, `search_datasets` and `browse_themes` gain the reason for this. Timeouts, 404s, cancellations, and modelled refusals on a 5xx keep their own outcomes. |
| 2026-10-14 | Retry the bulk request on an outage, before any of its body is read, superseding the 2026-08-04 no-retry entry for that case | An outage fails before the body streams — a 5xx carries at most the framework's error excerpt, and a refused connection carries nothing — so the full-transfer cost that entry guarded against does not arise, and a single attempt made the unfiltered download the one path a transient blip failed outright. The retry predicate admits only an outage, so a timeout, a modelled fault, and anything after the body starts still surface on the first attempt. |
