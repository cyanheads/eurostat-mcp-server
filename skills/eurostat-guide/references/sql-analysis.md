# SQL analysis patterns

Use a single read-only SELECT through eurostat_dataframe_query. Replace the illustrative names below with table and column names returned by eurostat_dataframe_describe. String values use single quotes; identifiers needing quotation use double quotes. These examples assume the described observation table has geo, time and obs_value columns.

Before a join expected to have one observation per geography and period, inspect duplicate keys:

```sql
SELECT geo, time, COUNT(*) AS observations
FROM observations_table
GROUP BY geo, time
HAVING COUNT(*) > 1
ORDER BY geo, time
```

If this returns rows, inspect the remaining dimensions. Restrict them or include them in the intended key before joining. Do not use DISTINCT to hide multiplied observations.

Attach a staged geographic value list without losing observations whose labels are absent:

```sql
SELECT d.geo, g.label AS geo_label, d.time, d.obs_value
FROM observations_table AS d
LEFT JOIN geographic_labels AS g ON d.geo = g.code
ORDER BY d.geo, d.time
```

The ordering is total only when the selected slice has one row per geo/time pair. Otherwise add the other identifying dimensions as tie-breakers. A value-list table has code and label; an observation table produced by the bulk path has no dimension-label companions. Describe both tables instead of assuming their shapes match.

Inspect missingness alongside an aggregate:

```sql
SELECT geo, COUNT(*) AS cells, COUNT(obs_value) AS numeric_cells,
       AVG(obs_value) AS mean_value
FROM observations_table
GROUP BY geo
ORDER BY geo
```

AVG ignores null numeric values. Use it only when that average answers the statistical question; do not replace missing observations with zero. For DS-* tables, inspect obs_value_text before interpreting every null numeric cell as missing data. Inspect obs_flag and conf_status alongside the values before drawing conclusions.

When a SQL result is truncated, retrieve deterministic pages of an unchanged query with a total ORDER BY and LIMIT/OFFSET. Advance OFFSET by the returned rowCount. Restart at offset zero if the first query was unordered. Expired or changing tables and volatile expressions cannot provide stable paging. Integer counts may arrive as strings to preserve precision; do not coerce them to an unsafe JavaScript number.
