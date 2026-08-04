# eurostat-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `eurostat_search_datasets` | Search the Eurostat catalogue by keyword (whitespace tokens ANDed across label, theme breadcrumb, and code). Returns matching datasets with codes, descriptions, and period coverage; cursor-paginated. | `query`, `limit`, `cursor?` | `readOnlyHint: true` |
| `eurostat_browse_themes` | List the Eurostat theme hierarchy. At root returns the second-level theme folders (Economy, Population, Transport, etc.) — the practical entry points for navigation. With a `theme_code` returns its immediate children (subthemes and datasets). Enables tree-navigation for dataset discovery without text search. | `theme_code?` | `readOnlyHint: true, openWorldHint: true` |
| `eurostat_get_dataset_info` | Fetch metadata for a dataset: dimensions, their codes and descriptions, time range, obs count, and last-updated date. The prerequisite call before querying data — reveals what `unit`, `na_item`, and other dimension values are valid. | `dataset_code` | `readOnlyHint: true` |
| `eurostat_get_dimension_values` | List valid values for a specific dimension in a dataset (e.g., all `unit` codes for `nama_10_gdp`). Useful when the full dimension list from `get_dataset_info` is large and needs exploring. | `dataset_code`, `dimension` | `readOnlyHint: true` |
| `eurostat_query_dataset` | Fetch statistical data from a dataset with dimension filters. Returns decoded observations (code, label, value, status flag) plus metadata about the query. Supports `geoLevel` for NUTS hierarchy filtering. | `dataset_code`, `filters{}`, `geo_level?`, `since_period?`, `until_period?`, `last_n_periods?`, `lang?` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `eurostat://dataset/{dataset_code}` | Dataset metadata — dimensions, time range, obs count, last updated. Same data as `eurostat_get_dataset_info`. | No |

### Prompts

None. The domain is data retrieval; the workflow is well-served by the tools themselves.

---

## Overview

eurostat-mcp-server exposes Eurostat — the European Union's central statistical office — as an MCP server. It covers EU-wide and member-state-level statistics across economy, demography, trade, labour, environment, and science, plus NUTS sub-national regional data at levels 1–3 (major regions down to local areas). The server wraps two Eurostat APIs: the Statistics API (JSON-stat 2.0) for data queries and the Catalogue API (TOC TXT) for dataset discovery. No authentication is required.

Target users: economic researchers comparing EU countries or regions, journalists covering EU policy and economics, business analysts evaluating European markets, and policy researchers — particularly those pairing this server with BLS (US) or World Bank (global) for multi-region analysis.

---

## Requirements

- Read-only; no writes to Eurostat
- Dataset discovery by keyword search across the Eurostat catalogue
- Theme tree navigation (second-level theme folders as practical root, hierarchical subthemes)
- Dataset metadata: dimensions, valid dimension values, time range, obs count
- Data queries filtered by any combination of dimensions (geo, time, unit, na_item, etc.)
- `geoLevel` support: `aggregate`, `country`, `nuts1`, `nuts2`, `nuts3`
- NUTS region granularity for sub-national analysis (127 NUTS1, 309 NUTS2, 1343 NUTS3 regions)
- JSON-stat 2.0 response parsing — flat numeric index decoded to labeled observations
- Observation status flags preserved (e.g., `p` = provisional, `e` = estimated)
- Async response handling: Eurostat returns `{"warning": {"status": 413, "label": "ASYNCHRONOUS_RESPONSE..."}}` for very large queries; the server surfaces this as a recoverable error with guidance to filter more tightly
- No rate limit headers observed; generous public API — standard retry with backoff on 5xx

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `EurostatCatalogueService` | Catalogue API: TOC TXT (`/catalogue/toc/txt`) | `search_datasets`, `browse_themes` |
| `EurostatDataService` | Statistics API (`/statistics/1.0/data/{code}`) | `get_dataset_info`, `get_dimension_values`, `query_dataset` |

`EurostatCatalogueService` fetches and parses the full TOC on first use — a ~2 MB TSV file, updated twice daily at 11:00 and 23:00 Europe/Brussels time. The parsed index is held in memory for `EUROSTAT_TOC_CACHE_TTL_MS` (default 12 hours) and reused by every search and browse call in that window, so neither tool pays per-query network overhead. The first call past the TTL refreshes it; concurrent callers share that one refresh, and a failed refresh keeps serving the last loaded TOC.

`EurostatDataService` makes per-query HTTP calls against the Statistics API. JSON-stat 2.0 responses are parsed in the service layer: flat `value` dict decoded via stride-based indexing into labeled `{dimCode, dimLabel, value, status?}` observations.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `EUROSTAT_BASE_URL` | No | Override API base URL (default: `https://ec.europa.eu/eurostat/api/dissemination`) |
| `EUROSTAT_REQUEST_TIMEOUT_MS` | No | HTTP request timeout in ms (default: `30000`) |
| `EUROSTAT_TOC_CACHE_TTL_MS` | No | How long a fetched catalogue TOC stays usable before the next catalogue call refreshes it, in ms (default: `43200000` — 12 hours) |

No API keys required.

---

## Implementation Order

1. Config and server setup (`server-config.ts` with the two optional env vars)
2. `EurostatCatalogueService` — fetch/parse/cache TOC, implement search + tree traversal
3. `eurostat_search_datasets` + `eurostat_browse_themes` tools (catalogue layer)
4. `EurostatDataService` — HTTP client, JSON-stat parser, retry logic
5. `eurostat_get_dataset_info` tool (use the Statistics API response dimensions as metadata — no separate metadata endpoint needed; dimensions returned inline with any filtered query)
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

**Async responses** (very large queries): HTTP 200, body `{"warning":{"status":413,"label":"ASYNCHRONOUS_RESPONSE. Your request will be treated asynchronously. Please try again later."}}`. Add more dimension filters to reduce result size.

**Error format:** `{"error":[{"status":404,"id":100,"label":"ERR_NOT_FOUND_4: ..."}]}`

### Catalogue API

- TOC TXT: `GET /catalogue/toc/txt?lang=en` — tab-separated, quoted fields. Header row: `title`, `code`, `type`, `last update of data`, `last table structure change`, `data start`, `data end`, `values`. **Folder rows have 7 columns** (no `values`); **dataset/table rows have 8 columns** (`values` = obs count as unquoted integer). The parser must handle both row lengths. Title column uses leading spaces (4 spaces per depth level) to encode hierarchy depth. All other string fields are double-quoted; the `values` integer is unquoted.
- SDMX 2.1 dataflow catalog: `GET /sdmx/2.1/dataflow/ESTAT/all?format=json` — returns 8,220+ entries with dataset IDs, labels, and annotation metadata (obs count, period range, update times)

### Codelist API (SDMX 2.1)

`GET /sdmx/2.1/codelist/ESTAT/{CODELIST_ID}?format=json`

Returns all valid values for a named codelist (e.g., `GEO`, `FREQ`, `UNIT`, `NA_ITEM`). Codelists are global across datasets; dataset-specific constraints may be narrower than the full codelist. For dataset-specific valid values, query the Statistics API with all other dimensions pinned.

---

## Tool Design Details

### `eurostat_search_datasets`

Searches the in-memory TOC index (loaded from the catalogue TXT file). The query is tokenized on whitespace and every token must match (AND), case-insensitively, somewhere in a combined `label + theme_path + code` haystack — so concept-order and theme-named queries resolve even when no single label contains the phrase verbatim. A query carrying no non-whitespace token is rejected by the input schema, and the service treats an empty token list as zero matches rather than a match against everything.

Returns datasets only (not folders), in TOC order, one row per code — Eurostat files some datasets under several TOC branches, so matches are deduplicated by code (first matching placement wins as the canonical `theme_path`) before any offset math, keeping `total_matches` and page slots counted in unique query targets.

Paginated with the framework's opaque-cursor primitives (`encodeCursor` / `decodeCursor`): `limit` is the page size and the returned `next_cursor` fetches the next page over a stable order. The cursor payload carries the normalized query and the load timestamp of the TOC snapshot it was paged over alongside `offset`/`limit`. A cursor that is malformed, presented with a different query, or presented after the catalogue has refreshed underneath it is rejected as `invalid_cursor` rather than silently applied to a different result set — one message and one recovery cover all three, since the cursor is opaque and the caller's next move is the same in each case.

**Input:**
- `query: string` — search terms (tokenized, AND-matched across label + theme_path + code)
- `limit: number` (default 20, max 100) — page size
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
Enrichment (both surfaces): `total_matches` (full count across all pages), `truncated` (true when more matches remain beyond this page), `next_cursor?` (opaque cursor for the next page; omitted on the last page — pass back as `cursor`).

**Errors:**
- `no_match` (NotFound): no datasets matched the query
- `invalid_cursor` (InvalidParams): the cursor is malformed, or was issued for a different query or for a catalogue snapshot that has since refreshed

### `eurostat_browse_themes`

Navigation tool for the TOC tree. Without `theme_code` returns the second-level theme folders. The TOC may contain more than one depth-0 root folder — historically a single "Database by themes" wrapper, but the live TOC also carries a separate "Cross cutting topics" root — so this tool skips every depth-0 wrapper and unions their depth-1 children, in root order, ensuring all top-level themes are reachable from a root-level browse. With `theme_code` returns its immediate children (subthemes and datasets in that branch).

Eurostat files some folder codes under more than one branch — the "Cross cutting topics" tree re-files part of the primary catalogue under different groupings, and a few survey folders are relisted per wave inside the primary tree itself. Of the ~1,900 folder codes in the live TOC (12,235 entries in total, most of them datasets), 43 carry more than one placement and 10 of those have differing child sets. A code lookup resolves to its **first** placement in TOC order, the same canonical-placement rule `eurostat_search_datasets` applies to duplicate dataset codes. In all 10 differing cases the first placement lists at least as many children as the ones it shadows — a superset in nine; the tenth is the root code `data`, whose two branches list entirely different children, both of which a root-level browse already unions. The breadcrumbs of the branches not taken are returned as `other_placements` so an ambiguous code is visible as such rather than silently resolved.

**Input:**
- `theme_code: string?` — folder code to expand; omit for root

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

**Errors:**
- `not_found` (NotFound): theme_code does not exist in the TOC as a folder node

### `eurostat_get_dataset_info`

Fetches dataset metadata from the Statistics API — a minimal `lastTimePeriod=1` call, plus one bounded follow-up when the dataset has a `time` dimension — then extracts dimension structure and annotation metadata from the responses.

**Implementation note:** The Statistics API returns dimension metadata only for values present in the queried result slice. For `get_dataset_info`, the service issues an unfiltered `lastTimePeriod=1` request (no dimension filters), which returns dimension codes and labels for all values present in the most recent period — all `unit`, `na_item`, and other categorical dimension values present in recent data, and all recent `geo` values (typically 40–50 country-level codes). That slice truncates `time` to the single period it selects, so when the dataset has a `time` dimension the service issues one more bounded query — every other dimension pinned to its first value (the same pin-and-probe `get_dimension_values` uses, with the first response as the probe), `time` unfiltered — and reads `time`'s values from it. Cost: one extra round trip when `time` is present, bounded to |time| observations; a dataset without a `time` dimension stays at one request. That second request answers one dimension's value count and nothing else, so a failure on it is caught: the call returns the metadata the first response already produced, with `time`'s `values_count`/`sample_values` omitted. They are not filled from the one-period slice — that slice reports a single period for every dataset, which is the defect the second request exists to fix. A failure on the *first* request still fails the call. Dataset-level metadata (`OBS_COUNT`, periods, `last_updated`) is extracted from `extension.annotation`: note that `OBS_COUNT` is in the annotation's `title` field as a string and must be parsed to integer; `UPDATE_DATA` is in the `date` field. Each of these is omitted from the output when its annotation is absent, rather than defaulted to `0` or `""` — an absent value is unknown, not zero. The dataset's human label comes from the top-level `label` field in the response.

**Input:**
- `dataset_code: string` — e.g., `nama_10_gdp`

**Output:**
```
code: string
label: string
dimensions: [{
  code: string            // e.g., "unit"
  label: string           // e.g., "Unit of measure"
  values_count: number?   // full period count for `time`; recent-period codelist size otherwise. Omitted when the value set could not be measured — only `time` can be, and an omitted count is unknown, not 1
  sample_values: [{code, label}]?  // first 10 values as orientation; omitted alongside values_count
}]
time_range: { start: string?, end: string? }  // each bound omitted when not reported
obs_count: number?       // omitted when not reported — an absent count is unknown, not zero
last_updated: string?    // ISO timestamp; omitted when not reported
metadata_url: string?    // link to ESMS metadata HTML
```

**Errors:**
- `not_found` (NotFound): dataset code does not exist or is not available for dissemination
- `async_response` (ServiceUnavailable, non-retryable): Eurostat returned async warning on the *first* request. This tool exposes no filters to narrow, so the same call cannot succeed — recovery is catalogue-level coverage from `eurostat_search_datasets`/`eurostat_browse_themes`, or `eurostat_get_dimension_values` one dimension at a time. The same warning on the second (time-enumeration) request is not an error: the call succeeds with `time`'s `values_count`/`sample_values` omitted

### `eurostat_get_dimension_values`

Returns all valid values for a single dimension in a dataset, using the Statistics API. `time` is the only dimension truncated by a `lastTimePeriod=1` slice, so it is enumerated over its full range by pinning every other dimension to a single representative value (drawn from a cheap probe query) and leaving `time` unfiltered — bounding the query to |time| observations so it returns the complete period set without the async 413 an unfiltered query risks on large datasets. Every other dimension's full codelist is present in any single period, so a `lastTimePeriod=1` slice is both complete and cheap; for `geo`, the NUTS-level filter is applied, defaulting to `country`.

**Input:**
- `dataset_code: string`
- `dimension: string` — dimension code (e.g., `unit`, `na_item`, `geo`)
- `geo_level: "aggregate"|"country"|"nuts1"|"nuts2"|"nuts3"?` — applies only when `dimension === "geo"` (default: `country`; use `nuts1`/`nuts2`/`nuts3` to retrieve regional codes for datasets that carry NUTS data). Pairing it with any other dimension is rejected as `conflicting_params` rather than accepted and ignored

**Output:**
```
dimension_code: string
dimension_label: string
values: [{
  code: string
  label: string
}]
total_count: number
```

**Errors:**
- `not_found` (NotFound): dataset or dimension code does not exist
- `async_response` (ServiceUnavailable, non-retryable): the dimension query matched too many observations; fall back to the sampled set from `get_dataset_info`, or narrow `geo` with `geo_level`
- `conflicting_params` (ValidationError): `geo_level` was sent with a dimension other than `geo`, where it has no effect

### `eurostat_query_dataset`

The primary data-fetching tool. Accepts dimension filters as a map and returns decoded observations.

**Implementation note:** the response carries at most 5,000 observations. That bound is applied inside the JSON-stat decoder, which stops once 5,000 cells have been built, in ascending linear-index order — an order the decoder walks itself rather than reading from the upstream key order, so a given response always yields the same rows. A broad query therefore never materializes its full observation set: `nama_10_gdp` unfiltered matches ~1.1M cells, and only the first 5,000 become objects. The totals that describe the match — `obs_count`, `missing_obs_count`, and the `time_range` bounds — are counted from the response's `value`/`status` cell keys instead of from the decoded array, so they stay whole while the row list is capped, and `obs_count` is what `truncated` is computed from. This bounds the client-side work and allocation, not the request: Eurostat still serves the full body (~18 MB for that query, ~93% of its wall time), so the way to make a broad query fast is to filter it.

**Input:**
- `dataset_code: string`
- `filters: Record<string, string[]>` — dimension filters; key = dimension code, value = array of codes. Example: `{"unit": ["CP_MEUR"], "na_item": ["B1GQ"], "geo": ["DE", "FR"]}`. An empty array means "no filter for this dimension", not an error: it is dropped before the request is built, before the `geo`/`geo_level` conflict check, and from the applied filters echoed back — so `{"geo": []}` neither restricts the query nor conflicts with `geo_level`. Do not include `"geo"` here when using `geo_level`. Invalid dimension values silently return no data rather than an error — verify codes with `eurostat_get_dimension_values` first.
- `geo_level: "aggregate"|"country"|"nuts1"|"nuts2"|"nuts3"?` — filter by NUTS hierarchy level. Mutually exclusive with a non-empty `"geo"` entry in `filters`; sending both is rejected as `conflicting_params` before the request reaches Eurostat.
- `since_period: string?` — e.g., `"2020"`, `"2023-Q1"`, `"2024-01"`. Use `last_n_periods` instead for the N most recent periods without knowing the end date.
- `until_period: string?` — e.g., `"2024"`. Omit for data through the latest available period.
- `last_n_periods: number?` — N most recent periods; mutually exclusive with `since_period`/`until_period`
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
  status?: { code: string, label: string }  // e.g., {code:"p", label:"provisional"}
}]
obs_count: number                 // observations matched, before the 5,000-row cap
truncated: boolean                // true when obs_count exceeds the cap and rows were dropped
time_range: { start: string?, end: string? }  // bounds of the whole match, not of the returned rows; each omitted when neither the match nor Eurostat report it
missing_obs_count: number         // observations with null value, across the whole match
```
`observations` is capped at 5,000 rows; every other field above describes the full match, so `obs_count` and `observations.length` diverge whenever `truncated` is true.

**Errors:**
- `not_found` (NotFound): dataset code not found (HTTP 404, Eurostat error id 100)
- `no_results` (NotFound): query returned no observations — `value: {}` with no error body; occurs when dimension value filters match no data (e.g., invalid geo code, future time period, or valid-but-absent combination). Detected by checking `value === {}` on an otherwise successful response.
- `async_response` (ServiceUnavailable, non-retryable): query too large; add dimension filters to reduce result set
- `invalid_dimension` (ValidationError): dimension *code* is not defined in this dataset's structure (HTTP 400, Eurostat error id 150). Note: invalid dimension *values* do not produce an error — they silently return `no_results`.
- `conflicting_params` (ValidationError): mutually exclusive parameters combined — a non-empty `geo` filter with `geo_level`, or `since_period`/`until_period` with `last_n_periods`. Both are rejected locally, before the request reaches Eurostat.

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

### Common workflow: explore unknown topic domain

| # | Action | Tool |
|:--|:-------|:-----|
| 1 | List top-level themes | `eurostat_browse_themes` |
| 2 | Drill into a theme | `eurostat_browse_themes` (`theme_code`) |
| 3 | Find dataset by keyword | `eurostat_search_datasets` |
| 4 | Get metadata → query | `eurostat_get_dataset_info` → `eurostat_query_dataset` |

---

## Design Decisions

**Why the TOC is cached in memory, not fetched per call:** The TOC TXT file is ~2 MB and parsed to ~10,000 entries. A per-call fetch would add 1–2s latency to every browse/search operation, and the catalogue changes at most twice daily. Fetch-on-first-use with a 12-hour TTL (`EUROSTAT_TOC_CACHE_TTL_MS`) matched to that upstream cadence is the right tradeoff: zero per-call cost inside the window, bounded staleness for a process that stays up for weeks. The first call past the TTL triggers one refresh and concurrent callers share it; a refresh that fails logs and keeps serving the last loaded TOC, so an upstream outage does not take discovery down once the server holds valid data. A failed refresh also holds the next attempt off for a minute: `withRetry` bounds a single attempt, and without a rate bound every call for the duration of an outage would pay a full retry-and-backoff cycle before falling back to the same cache. A successful refresh clears the hold; a cold-start failure is not subject to it, since there is no cache to serve instead.

**Why `get_dataset_info` uses the Statistics API instead of SDMX structure queries:** The SDMX datastructure endpoint returns XML (~3.5 MB for a single dataset with descendants), requires XML parsing, and maps codelists to global rather than dataset-specific values. The Statistics API returns JSON, the dimension values are already filtered to what that dataset actually has, and the response is significantly smaller when pinned to a narrow time slice.

**Why `geo` filter and `geoLevel` are mutually exclusive at the tool layer:** This mirrors the Eurostat API constraint — sending both causes a 400 error with `"'geo' parameter and 'geoLevel' parameter cannot be set at the same time."` The server validates and rejects early with a clear message rather than passing through to Eurostat.

**Why dataset search runs against the TOC (not the SDMX catalog):** The TOC carries more entries than the SDMX `dataflow` endpoint — it includes predefined tables the dataflow list omits (at the 2026-05 design pass the counts were ~8,220 SDMX dataflows vs ~8,933 TOC entries; both drift upstream over time, so treat these figures as historical). The TOC also includes theme hierarchy which powers `browse_themes`. Using one source for both tools keeps the implementation simpler and avoids two large fetch operations.

**Why no `eurostat_get_codelist` tool:** The SDMX codelist endpoint (e.g., `/codelist/ESTAT/GEO`) returns global codelists with 4,292+ geo entries — the vast majority are irrelevant to any specific dataset. The `get_dimension_values` tool is dataset-scoped and returns only the values that actually appear in the data, which is what agents need.

**Why `query_dataset` returns decoded observations instead of raw JSON-stat:** JSON-stat's flat numeric index (`{"0": 4219310.0}`) with separate dimension index maps requires non-trivial decoding math. Every caller would need to re-implement it. The service layer does the stride-based decoding once and returns human-usable `{dimension_code: {code, label}, value, status}` objects. The raw format details are an implementation concern, not a public API surface.

**Why no async polling:** Eurostat's async response is a soft error with guidance to narrow the query. Implementing polling (retry-after semantics) would require state management between tool calls. The better UX is to detect the async response immediately and return a non-retryable `ServiceUnavailable` error whose recovery hint names a narrower call to make instead.

**Why no DataCanvas:** The query tool returns decoded observations that are human-readable in format(). Tabular analysis can be done by the agent in subsequent steps. DataCanvas would add complexity; the domain's natural unit is a result set per filtered query, not a persistent analytical workspace.

---

## Known Limitations

**No free-text search on dimension values:** The Statistics API has no endpoint for searching dimension codes by label (e.g., "find the code for 'purchasing power standard per inhabitant'"). The agent must browse dimension values via `get_dimension_values` or know the codes.

**Async responses for large unfiltered queries:** Eurostat's API may return a `{"warning":{"status":413,...}}` async response for very large queries — documented API behavior, though it appears to depend on server load and is not guaranteed for any specific query size. The server detects and surfaces this as a non-retryable `ServiceUnavailable` error with guidance to filter more tightly — repeating the identical request cannot change the outcome. Very large datasets like `nama_10_gdp` (1.1M observations) should be queried with at least geo + time filters as a best practice regardless.

**TOC metadata lag:** The cached TOC is at most `EUROSTAT_TOC_CACHE_TTL_MS` old (default 12 hours). A dataset Eurostat adds in one of its twice-daily updates will not appear in search or browse results until the next catalogue call past the TTL refreshes the cache. Acceptable for a statistical data server; lower the TTL to shorten the window.

**NUTS version differences:** Eurostat NUTS classifications change periodically (NUTS 2013, 2016, 2021). Codes may refer to different geographies across versions. Dataset metadata notes the NUTS version, but the server does not expose NUTS version comparison tooling.

**Shadowed folder placements are not addressable:** `theme_code` takes a bare code, not a path, so a code filed under several branches always resolves to the first one — including when the caller has just browsed a different placement and drills into a folder code it listed. `other_placements` makes the ambiguity visible, but reaching a shadowed branch would need path-qualified addressing. Affects 43 of the ~1,900 folder codes, 10 with differing child sets.

**No SDMX constraint data:** The Statistics API returns dimension values observed in actual data for a filtered query, not all theoretically valid codes for the dataset. A code may be valid per the codelist but absent from the data for a given time period or geography.

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-05-23 | Use Statistics API (JSON-stat) over SDMX 2.1/3.0 for data queries | JSON-stat simpler to parse, Statistics API is the officially recommended endpoint for public data access. SDMX returns XML requiring additional dependency. |
| 2026-05-23 | Use TOC TXT (not SDMX `dataflow` endpoint) for dataset catalogue | TOC includes predefined tables and the full theme hierarchy tree. SDMX catalog has 8,220 entries vs TOC's 8,933 entries — TOC is more complete. Single source enables both search and tree browse. |
| 2026-05-23 | Cache TOC in memory for session lifetime | File is ~2 MB, changes at most twice daily. Per-call fetch adds 1–2s latency to every browse/search with no benefit. |
| 2026-08-03 | Bound the TOC cache with a 12-hour TTL, superseding the session-lifetime entry above | The original tradeoff assumed a short-lived process; a hosted HTTP deployment keeps serving the snapshot taken at container start. A TTL matched to the upstream twice-daily cadence keeps the per-call cost at zero inside the window while capping staleness, and stale-on-error preserves the availability the in-memory cache was chosen for. |
| 2026-08-03 | Bind search cursors to the query and TOC snapshot that produced them | The framework's `paginateArray` round-trips only `{offset, limit}`, so any structurally valid cursor paged any result set. Carrying the normalized query and the TOC load timestamp in the cursor turns both a cross-query cursor and a mid-pagination catalogue refresh into a clean `invalid_cursor` rejection instead of a silently shifted page. |
| 2026-05-23 | Decode JSON-stat in the service layer | The stride-based flat index math is non-trivial and should not be re-implemented by callers. Every output consumer needs labeled data, not numeric indexes. |
| 2026-05-23 | Surface async response as ServiceUnavailable (retryable) rather than implement polling | Async is Eurostat's soft error for oversized queries. The right recovery is adding filters, not polling. Polling would require cross-call state with no supported mechanism in the Statistics API. |
| 2026-08-04 | Classify `async_response` as non-retryable across all three data tools, superseding the blanket "retryable" entry above | The 413 warning is deterministic — the identical request produces the identical oversized response, so a retry is guidance toward a call that cannot succeed. `get_dimension_values` and `query_dataset` were already tightened; `get_dataset_info` was the last holdout, and its recovery hint now points at catalogue-level coverage metadata and per-dimension inspection instead of a wait-and-retry it cannot narrow. |
| 2026-08-04 | Omit annotation-derived metadata fields rather than defaulting them | `obs_count: 0`, `time_range: {start:"",end:""}`, and `last_updated: ""` were indistinguishable from a real zero or a genuinely empty value. Omission follows the `metadata_url` precedent already in the extractor and preserves the upstream's own uncertainty. Applies to all three schemas reading those annotations: `get_dataset_info`, the `eurostat://dataset/{dataset_code}` resource, and `query_dataset`'s `time_range`, which falls back to the same two period annotations when the result carries no `time` dimension. |
| 2026-08-04 | Spend a second bounded request in `get_dataset_info` to count `time` | The `lastTimePeriod=1` slice that makes the call cheap also reduces `time` to one value, and the tool tells callers to size a dimension from `values_count` — so `time` reported `1` for every dataset. The pin-and-probe already built for `get_dimension_values` reuses the first response as its probe, so the real period count costs one extra round trip bounded to \|time\| observations. |
| 2026-08-04 | Apply `query_dataset`'s 5,000-row cap inside the decoder, and count the totals from the response's cell keys | The cap previously ran after every matched cell had been decoded, so a broad query built ~1.1M observation objects to return 5,000. Stopping the decode at the cap removes that allocation. The totals then cannot come from the decoded array, so `obs_count`, `missing_obs_count` and `time_range` are counted from the `value`/`status` keys instead — one pass, no per-observation object — and keep describing the whole match. End-to-end latency barely moves: the full response body is already in memory before decoding starts, and transferring it is ~93% of a broad query's wall time. |
| 2026-08-04 | A failed time enumeration omits `time`'s `values_count`/`sample_values` instead of failing the call | The second request in `get_dataset_info` answers one dimension's value count; everything else comes from the first. Aborting the call over it discarded the label, dimension list, period range, observation count and metadata URL already retrieved. Falling back to the one-period slice was rejected — it silently restores `values_count: 1` for every dataset, the exact defect the second request was added to fix. Omission extends the idiom already used for the annotation-derived fields and works identically on the tool and the resource, which has no enrichment surface for a notice. |
| 2026-08-04 | Resolve a duplicated folder code to its first TOC placement, and disclose the others | `code_index` kept the last placement, so a duplicated code browsed the final branch and the earlier one became unreachable — most visibly the root code `data`, which returned "Cross cutting topics" 2 children instead of the 9 top-level themes. First-wins matches the canonical-placement rule `search()` already applies to duplicate dataset codes, and in all 10 live cases where placements differ the first lists at least as many children as the ones it shadows (a superset in nine; `data` is the exception, its two branches listing different children that a root-level browse already unions). `other_placements` returns the breadcrumbs of the branches not taken, so an ambiguous code is visible rather than silently resolved. |
| 2026-05-23 | 5 tools, no prompts, 1 resource | Domain is read-only data retrieval with a natural tool workflow (discover → inspect → query). Prompts add no value over well-designed tool descriptions. Resource for `eurostat://dataset/{dataset_code}` provides cache-injectable context without requiring a full query. |
| 2026-05-23 | Exclude SDMX codelist tool | Global codelists (4,292 geo entries) are unhelpful without dataset scoping. `get_dimension_values` is dataset-scoped and returns actionable values. |
