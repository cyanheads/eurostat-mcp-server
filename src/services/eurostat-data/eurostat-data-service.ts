/**
 * @fileoverview Eurostat Data Service — HTTP client for the Statistics API (JSON-stat 2.0),
 * includes JSON-stat parsing and stride-based index decoding.
 * @module services/eurostat-data/eurostat-data-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  type DatasetMeta,
  type DimensionInfo,
  type DimensionValuesResult,
  type GeoLevel,
  type JsonStatResponse,
  OBS_CAP,
  OBS_FLAG_COLUMN,
  OBS_FLAG_LABEL_COLUMN,
  OBS_VALUE_COLUMN,
  type Observation,
  type ObservationRow,
  type QueryExecution,
} from './types.js';

// Context satisfies the runtime contract of RequestContext but lacks the index signature
// required by fetchWithTimeout/withRetry.
const asReqCtx = (ctx: Context) => ctx as unknown as Record<string, unknown> & typeof ctx;

export class EurostatDataService {
  // config and storage accepted to match the standard service init pattern;
  // this service uses only the Eurostat public API and per-request config.
  // biome-ignore lint/complexity/noUselessConstructor: standard init pattern
  constructor(_config: AppConfig, _storage: StorageService) {}

  private buildUrl(datasetCode: string, params: Record<string, string | string[]>): URL {
    const { baseUrl } = getServerConfig();
    const url = new URL(`${baseUrl}/statistics/1.0/data/${encodeURIComponent(datasetCode)}`);
    url.searchParams.set('format', 'JSON');
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  private fetchJson(url: URL, ctx: Context): Promise<JsonStatResponse> {
    const { requestTimeoutMs } = getServerConfig();
    return withRetry(
      async () => {
        let response: Awaited<ReturnType<typeof fetchWithTimeout>>;
        try {
          response = await fetchWithTimeout(url.toString(), requestTimeoutMs, asReqCtx(ctx), {
            signal: ctx.signal,
            // 400 (invalid dimension / conflicting params) and 404 (unknown dataset) are
            // modeled outcomes reclassified below into the declared error contract, not
            // service failures — log them at debug. The thrown McpError is unchanged.
            expectedStatuses: [400, 404],
          });
        } catch (err) {
          // fetchWithTimeout throws an McpError for ANY non-2xx response BEFORE the JSON
          // error body is parsed, so checkResponseErrors() never sees a live error response —
          // it only runs on HTTP 200 (e.g. the async 413 warning). Re-parse the captured error
          // body (already on err.data, truncated to 500 bytes) and route it through the same
          // classifier so Eurostat's error array maps to the declared contract on the live
          // path too: id 100 → not_found, id 150 → invalid_dimension, other 400 →
          // conflicting_params. Both channels then carry the reason + recovery hint.
          const errData =
            err instanceof McpError
              ? (err.data as { errorSource?: string; body?: string } | undefined)
              : undefined;
          if (errData?.errorSource === 'FetchHttpError' && typeof errData.body === 'string') {
            let parsed: JsonStatResponse | undefined;
            try {
              parsed = JSON.parse(errData.body) as JsonStatResponse;
            } catch {
              // Body was truncated past the 500-byte cap or is non-JSON (e.g. an HTML
              // error page) — fall through and rethrow the raw HTTP error unchanged.
            }
            if (parsed) this.checkResponseErrors(parsed, url.toString());
          }
          throw err;
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'Eurostat Statistics API returned HTML instead of JSON — likely rate-limited or temporarily unavailable.',
          );
        }
        let parsed: JsonStatResponse;
        try {
          parsed = JSON.parse(text) as JsonStatResponse;
        } catch {
          throw serviceUnavailable(
            `Eurostat Statistics API returned unparseable response. Response excerpt: ${text.slice(0, 200)}`,
          );
        }
        this.checkResponseErrors(parsed, url.toString());
        return parsed;
      },
      { operation: 'fetchJsonStat', context: asReqCtx(ctx), baseDelayMs: 1000, signal: ctx.signal },
    );
  }

  private checkResponseErrors(data: JsonStatResponse, url: string): void {
    // Async response: query too large
    if (data.warning?.status === 413) {
      // Non-retryable: the same query re-run immediately just re-triggers the async warning.
      // Fail fast so callers narrow the query instead of hammering the endpoint (matches the
      // async_response contract's retryable: false).
      throw serviceUnavailable(
        'Eurostat returned an asynchronous response — the query matched too many observations. Add dimension filters (geo, unit, na_item, etc.) to reduce the result size and retry.',
        { reason: 'async_response', url, retryable: false },
      );
    }

    // Error responses
    if (Array.isArray(data.error) && data.error.length > 0) {
      const err = data.error[0];
      if (!err) return; // noUncheckedIndexedAccess: length > 0 guarantees this, but guard for TS
      if (err.status === 404 || err.id === 100) {
        throw notFound(
          `Dataset not found. Eurostat error: ${err.label}. Verify the dataset code with eurostat_search_datasets or eurostat_browse_themes.`,
          { reason: 'not_found', eurostatError: err },
        );
      }
      if (err.status === 400) {
        if (err.id === 150) {
          throw validationError(
            `Invalid dimension code. Eurostat error: ${err.label}. Use eurostat_get_dataset_info to see valid dimensions for this dataset.`,
            { reason: 'invalid_dimension', eurostatError: err },
          );
        }
        throw validationError(`Bad request. Eurostat error: ${err.label}.`, {
          reason: 'conflicting_params',
          eurostatError: err,
        });
      }
      throw serviceUnavailable(`Eurostat API error ${err.status}: ${err.label}.`, {
        eurostatError: err,
      });
    }
  }

  /** Strides for a JSON-stat linear index: stride[i] = product of sizes[i+1..n-1]. */
  private computeStrides(sizes: number[]): number[] {
    const strides: number[] = new Array(sizes.length).fill(1) as number[];
    for (let i = sizes.length - 2; i >= 0; i--) {
      // noUncheckedIndexedAccess: bounds are [0..sizes.length-2], so i+1 is safe
      strides[i] = (strides[i + 1] ?? 1) * (sizes[i + 1] ?? 1);
    }
    return strides;
  }

  /**
   * Count the response's populated cells without decoding them.
   *
   * `decodeObservations` stops at its row cap, so the totals reported alongside a capped
   * result cannot be derived from the decoded array. This walks the `value`/`status` key
   * maps instead — one pass, no per-observation object — so the caller is told how large
   * the whole match is, how much of it is missing, and which periods it spans, whatever
   * the cap. Cell membership matches the decoder exactly: a cell counts when it appears in
   * either map at an in-range linear index, and counts as missing when no numeric value
   * accompanies it.
   */
  private scanCells(data: JsonStatResponse): {
    obsCount: number;
    missingObsCount: number;
    timeCodes: string[];
  } {
    const dims = data.id ?? [];
    const sizes = data.size ?? [];
    const value = data.value ?? {};
    const status = data.status ?? {};
    const totalCells = sizes.reduce((a, b) => a * b, 1);

    const timeDim = dims.indexOf('time');
    const timeStride = timeDim >= 0 ? (this.computeStrides(sizes)[timeDim] ?? 1) : 1;
    const timeSize = timeDim >= 0 ? (sizes[timeDim] ?? 0) : 0;
    const timeSeen = new Uint8Array(timeSize);

    let obsCount = 0;
    let missingObsCount = 0;

    const count = (key: string, missing: boolean): void => {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= totalCells) return;
      obsCount++;
      if (missing) missingObsCount++;
      if (timeSize > 0) timeSeen[Math.floor(idx / timeStride) % timeSize] = 1;
    };

    for (const key in value) count(key, value[key] == null);
    // A cell flagged in `status` but absent from `value` decodes to a null value.
    for (const key in status) {
      if (!(key in value)) count(key, true);
    }

    const timeIndex = data.dimension?.time?.category?.index ?? {};
    const timeCodeAt: string[] = new Array(timeSize) as string[];
    for (const [code, pos] of Object.entries(timeIndex)) {
      if (pos >= 0 && pos < timeSize) timeCodeAt[pos] = code;
    }
    const timeCodes: string[] = [];
    for (let pos = 0; pos < timeSize; pos++) {
      if (timeSeen[pos]) timeCodes.push(timeCodeAt[pos] ?? String(pos));
    }
    return { obsCount, missingObsCount, timeCodes: timeCodes.sort() };
  }

  /**
   * Walk a JSON-stat 2.0 response's populated cells, yielding one labeled
   * observation at a time via stride-based indexing.
   *
   * Cells come out in ascending linear-index order — an order this walk sets
   * itself rather than reading from the upstream key order, so a given response
   * always yields the same rows in the same sequence. Being a generator, it
   * allocates one observation per pull and none in advance, which is what lets
   * the same walk serve both a capped decode and an uncapped dataframe spill.
   *
   * This is the only place cell membership is decided: a cell is an observation
   * when its linear index appears in `value` or in `status`. `scanCells` counts
   * that same predicate from the other direction (over the key maps) so the
   * totals it reports describe exactly this set.
   */
  private *iterateObservations(data: JsonStatResponse): Generator<Observation> {
    if (!data.id || !data.size || !data.dimension) return;

    const dims = data.id;
    const sizes = data.size;
    const value = data.value ?? {};
    const status = data.status ?? {};
    const statusLabels = data.extension?.status?.label ?? {};

    const strides = this.computeStrides(sizes);

    // Build dimension value arrays: index position → {code, label}
    const dimValues: Array<Array<{ code: string; label: string }>> = dims.map((dim) => {
      const cat = data.dimension?.[dim]?.category;
      if (!cat?.index) return [];
      return Object.entries(cat.index)
        .sort(([, a], [, b]) => a - b)
        .map(([code]) => ({
          code,
          label: cat.label?.[code] ?? code,
        }));
    });

    const totalCells = sizes.reduce((a, b) => a * b, 1);

    for (let linearIdx = 0; linearIdx < totalCells; linearIdx++) {
      const keyStr = String(linearIdx);
      if (!(keyStr in value) && !(keyStr in status)) continue;

      const dimensions: Record<string, { code: string; label: string }> = {};
      let remaining = linearIdx;
      for (let d = 0; d < dims.length; d++) {
        const stride = strides[d] ?? 1;
        const pos = Math.floor(remaining / stride);
        remaining = remaining % stride;
        const dimName = dims[d];
        const dimArr = dimValues[d];
        const dimVal = dimArr?.[pos];
        if (dimName) {
          dimensions[dimName] = dimVal ?? { code: String(pos), label: String(pos) };
        }
      }

      const rawValue = value[keyStr] ?? null;
      const statusCode = status[keyStr];

      const obs: Observation = { dimensions, value: rawValue };
      if (statusCode) {
        obs.status = {
          code: statusCode,
          label: statusLabels[statusCode] ?? statusCode,
        };
      }
      yield obs;
    }
  }

  /**
   * Take the first `limit` observations off {@link iterateObservations}.
   *
   * Bounding here keeps an oversized match from ever materializing as observation
   * objects — the walk stops the moment the cap is reached. The counts that
   * describe the whole match come from `scanCells`.
   */
  private decodeObservations(data: JsonStatResponse, limit: number): Observation[] {
    const observations: Observation[] = [];
    for (const obs of this.iterateObservations(data)) {
      observations.push(obs);
      if (observations.length >= limit) break;
    }
    return observations;
  }

  private extractAnnotation(
    data: JsonStatResponse,
    type: string,
    field: 'title' | 'date' | 'href',
  ): string | undefined {
    return data.extension?.annotation?.find((a) => a.type === type)?.[field];
  }

  /**
   * Build dataset metadata from a `lastTimePeriod=1` slice.
   *
   * `timeSlice`, when supplied, is a second response covering the dataset's full period
   * range (see `getDatasetInfo`); the `time` dimension is read from it and from nowhere
   * else. The one-period slice reports a single value for `time` whatever the dataset's
   * real range, so with no usable `timeSlice` that dimension's `valuesCount`/`sampleValues`
   * are omitted rather than taken from it — an unmeasured period count is not a count of 1.
   *
   * Annotation-derived fields are omitted when Eurostat does not report them — a missing
   * observation count is not a zero, and a missing period bound is not an empty string.
   */
  private extractMetadata(
    data: JsonStatResponse,
    datasetCode: string,
    timeSlice?: JsonStatResponse,
  ): DatasetMeta {
    const dims = data.id ?? [];
    const dimension = data.dimension ?? {};

    const dimensions: DimensionInfo[] = dims.map((dimCode) => {
      const isTime = dimCode === 'time';
      const cat = isTime ? timeSlice?.dimension?.[dimCode]?.category : dimension[dimCode]?.category;
      const label = dimension[dimCode]?.label ?? dimCode;
      if (isTime && !cat) return { code: dimCode, label };
      const allValues = cat?.index ? Object.entries(cat.index).sort(([, a], [, b]) => a - b) : [];
      return {
        code: dimCode,
        label,
        valuesCount: allValues.length,
        sampleValues: allValues.slice(0, 10).map(([code]) => ({
          code,
          label: cat?.label?.[code] ?? code,
        })),
      };
    });

    // An absent annotation and an unparseable one both land on NaN, and neither is a count.
    const obsCount = Number.parseInt(this.extractAnnotation(data, 'OBS_COUNT', 'title') ?? '', 10);

    const start = this.extractAnnotation(data, 'OBS_PERIOD_OVERALL_OLDEST', 'title');
    const end = this.extractAnnotation(data, 'OBS_PERIOD_OVERALL_LATEST', 'title');
    const lastUpdated = this.extractAnnotation(data, 'UPDATE_DATA', 'date');
    const metadataUrl = this.extractAnnotation(data, 'ESMS_HTML', 'href');

    return {
      code: datasetCode,
      label: data.label ?? datasetCode,
      dimensions,
      timeRange: { ...(start && { start }), ...(end && { end }) },
      ...(!Number.isNaN(obsCount) && { obsCount }),
      ...(lastUpdated && { lastUpdated }),
      ...(metadataUrl && { metadataUrl }),
    };
  }

  /**
   * Fetch dataset metadata using a minimal `lastTimePeriod=1` query.
   *
   * That slice carries every dimension's full codelist except `time`, which it truncates to
   * the single period it selects. A second bounded query — the same pin-and-probe
   * `getDimensionValues` uses, with the first response serving as the probe — enumerates the
   * real period set, so `time` reports its actual count instead of the filter's artifact.
   * Cost: one extra round trip, bounded to |time| observations.
   *
   * That second request answers one dimension's value count; every other field comes from
   * the first response. A failure on it therefore returns the metadata already in hand with
   * `time`'s `valuesCount`/`sampleValues` omitted, rather than discarding the dataset label,
   * dimension list, period range, observation count and metadata URL along with it.
   */
  async getDatasetInfo(datasetCode: string, ctx: Context): Promise<DatasetMeta> {
    ctx.log.info('Fetching dataset info', { datasetCode });
    const data = await this.fetchJson(this.buildUrl(datasetCode, { lastTimePeriod: '1' }), ctx);
    let timeSlice: JsonStatResponse | undefined;
    if ((data.id ?? []).includes('time')) {
      try {
        timeSlice = await this.fetchJson(
          this.buildUrl(datasetCode, this.pinDimensions(data, 'time')),
          ctx,
        );
      } catch (error) {
        ctx.log.warning('Time period enumeration failed — reporting metadata without it', {
          datasetCode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.extractMetadata(data, datasetCode, timeSlice);
  }

  /**
   * Build a filter that pins every dimension except `exceptDim` to its first (index 0)
   * value, drawn from a probe response. Eurostat orders the primary/aggregate value first
   * (e.g. an EU aggregate for `geo`), which typically carries the dataset's full time
   * coverage — so pinning to it and leaving `exceptDim` unfiltered enumerates that
   * dimension's complete value set with a minimal observation count.
   */
  private pinDimensions(data: JsonStatResponse, exceptDim: string): Record<string, string> {
    const pins: Record<string, string> = {};
    for (const dim of data.id ?? []) {
      if (dim === exceptDim) continue;
      const index = data.dimension?.[dim]?.category?.index;
      if (!index) continue;
      let firstCode: string | undefined;
      let firstPos = Number.POSITIVE_INFINITY;
      for (const [code, pos] of Object.entries(index)) {
        if (pos < firstPos) {
          firstPos = pos;
          firstCode = code;
        }
      }
      if (firstCode !== undefined) pins[dim] = firstCode;
    }
    return pins;
  }

  /**
   * Get all valid values for a specific dimension in a dataset.
   *
   * `time` is the only dimension truncated by a `lastTimePeriod=1` slice, so it is enumerated
   * by pinning the other dimensions to a single value each (from a cheap probe) and leaving
   * `time` unfiltered — returning the full period range while keeping the query bounded to
   * |time| observations (avoiding the async 413 an unfiltered query risks on large datasets).
   * Every other dimension's full codelist is present in any single period, so `lastTimePeriod=1`
   * is both complete and cheap; for `geo` the NUTS level is applied, defaulting to `country`.
   *
   * `geoLevel` is a NUTS filter and only applies to `geo`; pairing it with any other dimension
   * is rejected rather than accepted and ignored.
   */
  async getDimensionValues(
    datasetCode: string,
    dimension: string,
    geoLevel: GeoLevel | undefined,
    ctx: Context,
  ): Promise<DimensionValuesResult> {
    ctx.log.info('Fetching dimension values', { datasetCode, dimension, geoLevel });

    if (geoLevel && dimension !== 'geo') {
      throw validationError(
        `"geo_level" filters the NUTS hierarchy of the "geo" dimension and has no effect on "${dimension}". Omit geo_level, or set dimension to "geo".`,
        { reason: 'conflicting_params', dimension, geoLevel },
      );
    }

    let data: JsonStatResponse;
    if (dimension === 'time') {
      const probe = await this.fetchJson(this.buildUrl(datasetCode, { lastTimePeriod: '1' }), ctx);
      data = await this.fetchJson(
        this.buildUrl(datasetCode, this.pinDimensions(probe, 'time')),
        ctx,
      );
    } else {
      const params: Record<string, string | string[]> = { lastTimePeriod: '1' };
      if (dimension === 'geo') params.geoLevel = geoLevel ?? 'country';
      data = await this.fetchJson(this.buildUrl(datasetCode, params), ctx);
    }

    const dimDef = data.dimension?.[dimension];
    if (!dimDef) {
      throw notFound(
        `Dimension "${dimension}" not found in dataset "${datasetCode}". Use eurostat_get_dataset_info to see valid dimensions.`,
        { reason: 'not_found', datasetCode, dimension },
      );
    }

    const cat = dimDef.category;
    const allValues = cat?.index
      ? Object.entries(cat.index)
          .sort(([, a], [, b]) => a - b)
          .map(([code]) => ({ code, label: cat.label?.[code] ?? code }))
      : [];

    return {
      dimensionCode: dimension,
      dimensionLabel: dimDef.label ?? dimension,
      values: allValues,
      totalCount: allValues.length,
    };
  }

  /**
   * Query dataset observations with dimension filters.
   *
   * Returns the capped observation list alongside `rows()`, a lazy generator
   * over the whole match. Both read the same response body — already in memory
   * before decoding starts — so reaching the rows past the cap costs no
   * additional upstream request.
   */
  async queryDataset(
    datasetCode: string,
    filters: Record<string, string[]>,
    geoLevel: GeoLevel | undefined,
    sinceP: string | undefined,
    untilP: string | undefined,
    lastN: number | undefined,
    lang: string,
    ctx: Context,
  ): Promise<QueryExecution> {
    // A zero-length filter array places no restriction on the request. Drop those entries once,
    // up front, so the conflict check, the request URL, the log line, and the applied filters
    // echoed back to the caller all describe the same query.
    const appliedFilters = Object.fromEntries(
      Object.entries(filters).filter(([, values]) => values.length > 0),
    );

    ctx.log.info('Querying dataset', {
      datasetCode,
      filters: appliedFilters,
      geoLevel,
      sinceP,
      untilP,
      lastN,
    });

    // Validate mutually exclusive params
    if (appliedFilters.geo && geoLevel) {
      throw validationError(
        `"geo" filter and "geo_level" cannot be used together. Use one or the other: "geo" for specific country/region codes, "geo_level" for filtering by NUTS hierarchy level.`,
        { reason: 'conflicting_params' },
      );
    }
    if (lastN && (sinceP || untilP)) {
      throw validationError(
        `"since_period"/"until_period" and "last_n_periods" are mutually exclusive — use one or the other.`,
        { reason: 'conflicting_params' },
      );
    }

    const params: Record<string, string | string[]> = { lang };

    // Apply dimension filters
    for (const [dim, values] of Object.entries(appliedFilters)) {
      params[dim] = values;
    }
    if (geoLevel) params.geoLevel = geoLevel;
    if (sinceP && !lastN) params.sinceTimePeriod = sinceP;
    if (untilP && !lastN) params.untilTimePeriod = untilP;
    if (lastN) params.lastTimePeriod = String(lastN);

    const url = this.buildUrl(datasetCode, params);
    const data = await this.fetchJson(url, ctx);

    // Detect no-results case (empty value object, no error)
    if (data.id && data.value !== undefined && Object.keys(data.value).length === 0) {
      throw notFound(
        `Query returned no observations for dataset "${datasetCode}". The dimension filter combination may not exist in the data. Verify dimension values with eurostat_get_dimension_values first.`,
        { reason: 'no_results', datasetCode, filters: appliedFilters },
      );
    }

    // Totals describe the whole match and are counted from the response's cell keys, so the
    // decode cap below cannot shrink them.
    const { obsCount, missingObsCount, timeCodes } = this.scanCells(data);
    const observations = this.decodeObservations(data, OBS_CAP);

    // Compute timeRange from the actual time dimension values in the response.
    // Fall back to dataset-wide annotations only when no time dimension is present, and omit
    // a bound neither source reports — an unknown period is not an empty one.
    const start =
      timeCodes[0] ?? this.extractAnnotation(data, 'OBS_PERIOD_OVERALL_OLDEST', 'title');
    const end =
      timeCodes.at(-1) ?? this.extractAnnotation(data, 'OBS_PERIOD_OVERALL_LATEST', 'title');
    const timeRange = { ...(start && { start }), ...(end && { end }) };

    const dimensionsUsed = data.id ?? [];

    return {
      datasetCode,
      datasetLabel: data.label ?? datasetCode,
      dimensionsUsed,
      observations,
      obsCount,
      timeRange,
      missingObsCount,
      appliedFilters,
      rows: () => this.iterateRows(data, dimensionsUsed),
    };
  }

  /** {@link iterateObservations}, flattened to dataframe rows one at a time. */
  private *iterateRows(
    data: JsonStatResponse,
    dimensionsUsed: string[],
  ): Generator<ObservationRow> {
    for (const obs of this.iterateObservations(data)) {
      yield toObservationRow(obs, dimensionsUsed);
    }
  }
}

/**
 * Flatten one observation into a dataframe row.
 *
 * The inverse of the nested shape `Observation` carries: each dimension
 * contributes `<dim>` (code) and `<dim>_label`, and the status flag contributes
 * `obs_flag` / `obs_flag_label`. A dimension the observation does not carry
 * yields `null` in both of its columns rather than an absent key, so every row
 * has the same column set the table is declared with.
 */
export function toObservationRow(obs: Observation, dimensionsUsed: string[]): ObservationRow {
  const row: ObservationRow = {};
  for (const dim of dimensionsUsed) {
    const cell = obs.dimensions[dim];
    row[dim] = cell?.code ?? null;
    row[`${dim}_label`] = cell?.label ?? null;
  }
  row[OBS_VALUE_COLUMN] = obs.value;
  row[OBS_FLAG_COLUMN] = obs.status?.code ?? null;
  row[OBS_FLAG_LABEL_COLUMN] = obs.status?.label ?? null;
  return row;
}

/**
 * Explicit canvas column schema for {@link toObservationRow}'s output.
 *
 * Declared rather than sniffed. Inference reads only the leading rows, which is
 * enough to get the measure column wrong twice over: an all-integer prefix types
 * it `BIGINT`, which the canvas then serializes as a string, and an all-missing
 * prefix types it from nulls alone. Every column is nullable — a dimension can
 * be absent from a cell, and a status flag usually is.
 *
 * Names and order mirror {@link toObservationRow}. Nothing in the type system
 * ties a row's keys to a schema's names, so the service tests assert the two
 * against each other instead.
 */
export function observationRowSchema(dimensionsUsed: string[]): ColumnSchema[] {
  return [
    ...dimensionsUsed.flatMap((dim): ColumnSchema[] => [
      { name: dim, type: 'VARCHAR', nullable: true },
      { name: `${dim}_label`, type: 'VARCHAR', nullable: true },
    ]),
    { name: OBS_VALUE_COLUMN, type: 'DOUBLE', nullable: true },
    { name: OBS_FLAG_COLUMN, type: 'VARCHAR', nullable: true },
    { name: OBS_FLAG_LABEL_COLUMN, type: 'VARCHAR', nullable: true },
  ];
}

// --- Init/accessor pattern ---

let _service: EurostatDataService | undefined;

export function initEurostatDataService(config: AppConfig, storage: StorageService): void {
  _service = new EurostatDataService(config, storage);
}

export function getEurostatDataService(): EurostatDataService {
  if (!_service) {
    throw new Error(
      'EurostatDataService not initialized — call initEurostatDataService() in setup()',
    );
  }
  return _service;
}
