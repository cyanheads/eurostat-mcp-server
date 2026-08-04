/**
 * @fileoverview Eurostat Data Service — HTTP client for the Statistics API (JSON-stat 2.0),
 * includes JSON-stat parsing and stride-based index decoding.
 * @module services/eurostat-data/eurostat-data-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
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
import type {
  DatasetMeta,
  DimensionInfo,
  DimensionValuesResult,
  GeoLevel,
  JsonStatResponse,
  Observation,
  QueryResult,
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

  /**
   * Decode a JSON-stat 2.0 response into labeled observations using stride-based indexing.
   */
  private decodeObservations(data: JsonStatResponse): Observation[] {
    if (!data.id || !data.size || !data.dimension) return [];

    const dims = data.id;
    const sizes = data.size;
    const value = data.value ?? {};
    const status = data.status ?? {};
    const statusLabels = data.extension?.status?.label ?? {};

    // Compute strides: stride[i] = product of sizes[i+1..n-1]
    const strides: number[] = new Array(dims.length).fill(1) as number[];
    for (let i = dims.length - 2; i >= 0; i--) {
      // noUncheckedIndexedAccess: bounds are [0..dims.length-2], so i+1 and sizes[i+1] are safe
      strides[i] = (strides[i + 1] ?? 1) * (sizes[i + 1] ?? 1);
    }

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

    const observations: Observation[] = [];
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
      observations.push(obs);
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

  private extractMetadata(data: JsonStatResponse, datasetCode: string): DatasetMeta {
    const dims = data.id ?? [];
    const dimension = data.dimension ?? {};

    const dimensions: DimensionInfo[] = dims.map((dimCode) => {
      const cat = dimension[dimCode]?.category;
      const allValues = cat?.index ? Object.entries(cat.index).sort(([, a], [, b]) => a - b) : [];
      return {
        code: dimCode,
        label: dimension[dimCode]?.label ?? dimCode,
        valuesCount: allValues.length,
        sampleValues: allValues.slice(0, 10).map(([code]) => ({
          code,
          label: cat?.label?.[code] ?? code,
        })),
      };
    });

    const obsCountRaw = this.extractAnnotation(data, 'OBS_COUNT', 'title');
    const obsCount = obsCountRaw ? parseInt(obsCountRaw, 10) : 0;

    const oldest = this.extractAnnotation(data, 'OBS_PERIOD_OVERALL_OLDEST', 'title') ?? '';
    const latest = this.extractAnnotation(data, 'OBS_PERIOD_OVERALL_LATEST', 'title') ?? '';
    const lastUpdated = this.extractAnnotation(data, 'UPDATE_DATA', 'date') ?? '';
    const metadataUrl = this.extractAnnotation(data, 'ESMS_HTML', 'href');

    return {
      code: datasetCode,
      label: data.label ?? datasetCode,
      dimensions,
      timeRange: { start: oldest, end: latest },
      obsCount: Number.isNaN(obsCount) ? 0 : obsCount,
      lastUpdated,
      ...(metadataUrl && { metadataUrl }),
    };
  }

  /** Fetch dataset metadata using a minimal lastTimePeriod=1 query. */
  async getDatasetInfo(datasetCode: string, ctx: Context): Promise<DatasetMeta> {
    ctx.log.info('Fetching dataset info', { datasetCode });
    const url = this.buildUrl(datasetCode, { lastTimePeriod: '1' });
    const data = await this.fetchJson(url, ctx);
    return this.extractMetadata(data, datasetCode);
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
   */
  async getDimensionValues(
    datasetCode: string,
    dimension: string,
    geoLevel: GeoLevel | undefined,
    ctx: Context,
  ): Promise<DimensionValuesResult> {
    ctx.log.info('Fetching dimension values', { datasetCode, dimension, geoLevel });

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
   * Returns decoded observations.
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
  ): Promise<QueryResult> {
    ctx.log.info('Querying dataset', { datasetCode, filters, geoLevel, sinceP, untilP, lastN });

    // Validate mutually exclusive params
    if (filters.geo && geoLevel) {
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
    for (const [dim, values] of Object.entries(filters)) {
      if (values.length > 0) params[dim] = values;
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
        { reason: 'no_results', datasetCode, filters },
      );
    }

    const observations = this.decodeObservations(data);
    const missingObsCount = observations.filter((o) => o.value === null).length;

    // Compute timeRange from the actual time dimension values in the response.
    // Fall back to dataset-wide annotations only when no time dimension is present.
    const oldest = this.extractAnnotation(data, 'OBS_PERIOD_OVERALL_OLDEST', 'title') ?? '';
    const latest = this.extractAnnotation(data, 'OBS_PERIOD_OVERALL_LATEST', 'title') ?? '';
    const timeCodes = observations
      .map((o) => (o.dimensions as Record<string, { code: string } | undefined>).time?.code)
      .filter((c): c is string => c !== undefined)
      .sort();
    const timeRange = {
      start: timeCodes[0] ?? oldest,
      end: timeCodes[timeCodes.length - 1] ?? latest,
    };

    return {
      datasetCode,
      datasetLabel: data.label ?? datasetCode,
      dimensionsUsed: data.id ?? [],
      observations,
      obsCount: observations.length,
      timeRange,
      missingObsCount,
    };
  }
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
