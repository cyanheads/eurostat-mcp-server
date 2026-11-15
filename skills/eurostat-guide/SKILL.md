---
name: eurostat-guide
description: Use with eurostat_* tools to compare countries or regions, analyse trade, resolve statistical codes, and query staged observations with SQL. Apply coverage and comparability checks before ranking, aggregating, or reporting missing data.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.3.0"
---

## Scope

Use this server for statistics disseminated by Eurostat, including detailed Comext trade and PRODCOM collections. No API key is required. Catalogue discovery is not evidence that every European statistic is covered; use the dataset's metadata to establish what the figures measure.

## Identifiers

| Identifier | Obtain it from |
|:---|:---|
| Dataset code | A dataset or table result from eurostat_search_datasets or eurostat_browse_themes |
| Theme code | A folder result from eurostat_browse_themes; dataset codes are not folders |
| Dimension code | The selected dataset's eurostat_get_dataset_info result |
| Dimension value code | That dimension's eurostat_get_dimension_values result; metadata samples are not exhaustive |
| Canvas identifier | A staging response's canvasId; supply it as canvas_id in subsequent calls |
| SQL table and column names | eurostat_dataframe_describe on that canvas; do not derive names from a dataset code |

Keep codes as identifiers and labels as display text. Resolve codes within the chosen dataset rather than borrowing a global classification list or another dataset's values.

## Gates

- Before comparing observations, fix the statistical measure and every dimension that could change its meaning: unit, frequency, geography and any indicator, adjustment, demographic or classification breakdown present in the dataset. Inspect the labels rather than guessing a code from its abbreviation.
- Before interpreting a GDP comparison, distinguish economic size, per-inhabitant values and price-adjusted comparisons. For comparisons across countries, PPS removes price-level differences; changes in current-price PPS values are not automatically real growth. Consult [Eurostat's PPP guidance](https://ec.europa.eu/eurostat/en/web/purchasing-power-parities/information-data) when choosing the measure.
- Before a regional time-series comparison, establish the NUTS classification used by the data. A matching code or label alone does not establish unchanged boundaries. Eurostat revises NUTS and historical reconstruction depends on feasibility; consult [NUTS history and changes](https://ec.europa.eu/eurostat/en/web/nuts/history) and the dataset metadata when classifications differ. This server does not supply a concordance operation.
- Before claiming a series is absent, distinguish an unknown metadata bound, an unlisted page, an unmatched code (unmatchedValues), a valid code with no cell in the selected periods (emptyValues), an empty combination of otherwise valid codes and a period range that excludes the period. A code in emptyValues exists and can carry data in other periods or beside other filter values; its absence from the rows is not a statement about the dataset. Eurostat keeps only periods wholly inside since_period–until_period, per frequency, so a bound inside a period drops it (since_period "2022-06" on annual data drops 2022); a notice or error names the bound to use. Inspect notices and discovery freshness; missing Comext discovery is not evidence that a known DS-* dataset is unavailable.
- Before comparing coverage across series, separate a period a series lacks from an observation published without a value. A query reports the former as absentCellCount (periods of a frequency a matched series carries, with no cell, counted from that frequency's first to its latest period with a cell in any series) and stages no row for it; a period before or after that span is named in a notice, not counted; obsCount and missingObsCount count only published cells. A download stages the former as a row with null obs_value and no flag, status or text (an unflagged ":"), counted in rowCount and missingCount, and in absentCellCount when the series carries that frequency and the period lies inside that frequency's span of downloaded observations. Unflagged rows outside the span (a notice names them) and at periods of a frequency the series has no observation of (the padding of a mixed-frequency slice) are left out of absentCellCount. Such a row is not an observation, and its period is not coverage; periodRange and timeRange leave it out. A flagged ":" or a text value is an observation. A download cut short (budgetExceeded) counts absentCellCount, and settles each frequency's span, over the rows it read, so its count can only fall short of the whole dataset's; compare coverage on a complete download. A download whose only rows are unflagged ":" cells succeeds rather than failing as no_results: rowCount and missingCount count those rows, absentCellCount is 0, periodRange has no bound, and the notice says no row carries an observation.
- Before calling observations the latest available for each geography, inspect the selected slice's actual periods. The dataset's latest period can have no populated value for that slice, and last_n_periods counts back from the dataset's latest period, not the slice's. Read the notice naming the periods without cells; when every one follows the slice's latest period with a cell, raise last_n_periods as the notice advises, or select a since_period/until_period range ending at that period; until_period alone selects every period up to it. Do not report an empty latest-period selection as a zero.
- Before calculating totals or rankings, establish that the retained observations cover the intended population. Inline observations are a preview, not a random sample, and a "Same in all N rows shown" line describes those rows, not the match; a query's truncated=false does not prove the preview includes every matched row. Compare obsCount with the observations received or inspect the staged table. A bulk result with budgetExceeded is an ordered prefix, even when that prefix has been staged successfully. Narrow and refetch before presenting a complete total.
- Preserve missing numeric values, published text values, observation flags and confidentiality status. A null numeric value is not zero; a PRODCOM text value is not a numeric quantity. Carry relevant provisional, break-in-series or reliability flags into the interpretation.
- Before summing Comext observations, select a frequency and non-overlapping reporter, partner and product levels. Annual and monthly observations coexist, as do aggregates and their members. Do not sum TOTAL or EU aggregates alongside their constituents, or broad product groups alongside their subgroups.

## Workflows

### Find a dataset and its codes

eurostat_search_datasets needs every word somewhere in a dataset's label, theme breadcrumb or code, in any order, so "business demography NUTS 3" resolves without naming the label verbatim; spacing beside catalogue punctuation is ignored ("2015=100" finds "2015 = 100"). When no dataset holds every word, a missing word can match the start of a word in a dimension value's label: "pharmacist" finds "Pharmacists" (med_spec=PHARM), "sex" does not find "Essex". Those rows carry matchedValues, whose codes are filter values for eurostat_query_dataset.

Within a dataset, eurostat_get_dimension_values filter matches substrings of a value's code and label together, ignoring accents ("palma frankfurt" finds DE_EDDF_ES_LEPA, "zurich" finds Zürich), and code_prefix lists the codes under a parent ("2204" on a CN list returns that heading and the codes beneath it). An aggregate outside the code tree, such as COICOP ELC_GAS or NRG, shares no parent's prefix: find it with filter.

### Compare countries or regions

Resolve the question to a measure before selecting the dataset. Inspect dataset metadata and resolve the required dimension values, then fetch a bounded slice. Request one geographic level at a time with geo_level; to pick regions under one parent, list them with eurostat_get_dimension_values, geo_level and code_prefix (nuts2 with DE for German regions), then filter geo on those codes. Compare the same period and dimensional definition across places; if places have different latest periods, either use a common populated period or state each period explicitly. For regional trends, resolve classification compatibility before treating observations as a continuous series.

### Choose a period range

Write since_period and until_period in any accepted form; each is read as the span of days it covers, and the response echoes the canonical form ("2020-Q01" as "2020-Q1", "2026-D1" as "2026-D001", "2020-A1" as "2020"). Eurostat keeps only the periods wholly inside the range, per frequency: since_period "2022-06" on annual data drops 2022, which starts before the bound, and until_period "2023-06" drops 2023, which ends after it.

A range fails as invalid_period, before any request, when a bound is malformed ("2020-1"), names a period that does not exist ("2020-13", "2020-Q5", "2021-W53" in a 52-week year, "2023-02-29", "2023-D366"), or starts after the other bound ends. Bounds of different frequencies compare by day: "2021" to "2020-06" fails, while "2020-06" to "2020" is accepted but holds no whole annual period, so annual data returns nothing for it.

Both bounds on one day, in any forms ("2022-06-15" twice, "2022-06-15" with "2022-D166", "2022-06-30" with "2022-06"), select that day alone. Eurostat answers such a range as sent with the whole series, so the query asks for that one date, and the download asks for that day and the next and drops the next before anything is counted or staged; its appliedQuery.url ends a day past untilPeriod. A day with no published period (a weekend on daily data, any single day on monthly or annual data) returns nothing: the query fails as no_results, the download as invalid_dimension, or as no_results when only the next day has cells.

eurostat_download_dataset takes no last_n_periods: the bulk table keeps a column for every period when asked for the latest N, so only a period range shrinks the transfer. For the latest N periods of a download, list the dataset's periods with eurostat_get_dimension_values, dimension "time", and set since_period to the earliest of the last N.

### Analyse a large slice or bulk extract

Use eurostat_query_dataset for a filtered slice and eurostat_download_dataset for a bulk extract. On a deployment with dataframe tools, request stage=true in eurostat_query_dataset when a slice needs SQL analysis or has more rows than its preview, even if it is small. A smaller preview does not make the upstream match smaller. Reduce dimension or period coverage when the upstream refuses a large extraction; staging does not bypass Eurostat's extraction limits. An extraction Eurostat is still preparing (async_response from a query, async_queued from a download) is served when the identical call is repeated a few minutes later, so repeat it or narrow it.

When a call stages observations, the response carries canvasId and tableName. Call eurostat_dataframe_describe with that identifier as canvas_id for the staged table and column names before writing SQL, then eurostat_dataframe_query with a read-only query. Pass the same canvas_id back to a staging call to place further results beside the first; the tables expire with the canvas. Check that a table was actually returned rather than assuming every preview has a retained counterpart. Without the dataframe tools, narrow the request until the required observations can be obtained inline.

Bulk observations carry dimension codes without their label columns. To label them, use eurostat_get_dimension_values to stage the relevant dimension's code/label list on the existing canvas, describe the new table, and join on codes. A staged geo table holds every level, with a level column, unless geo_level was passed; filter level to the observations' level before joining or aggregating, because aggregates and regions overlap the countries they contain. A filtered inline value list does not imply that its staged table contains only that filter's matches.

### Join or aggregate observations

First define the result's grain: which dimensions identify one row? Hold other dimensions fixed or retain them in grouping and join keys. Joining only on geography and time can multiply observations when either side still contains several units or indicators. Check key uniqueness before joining, and aggregate only measures that are meaningful to add; averaging or summing percentages and indices requires a justified interpretation.

Use [SQL analysis patterns](references/sql-analysis.md) after describing the actual tables. Keep result completeness separate from data completeness: retrieving every SQL row cannot repair an incomplete bulk transfer or a statistically mismatched slice.

## References

- [SQL analysis patterns](references/sql-analysis.md): inspect grain, attach labels, preserve missingness and retrieve deterministic pages.
