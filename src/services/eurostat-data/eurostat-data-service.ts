/**
 * @fileoverview Eurostat Data Service — Statistics API querying plus dataset-scoped SDMX metadata.
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
  CONF_STATUS_COLUMN,
  CONF_STATUS_LABEL_COLUMN,
  CONF_STATUS_LABELS,
  decodeTextValue,
  OBS_FLAG_COLUMN,
  OBS_FLAG_LABEL_COLUMN,
  OBS_FLAG_LABELS,
  OBS_VALUE_COLUMN,
  OBS_VALUE_TEXT_COLUMN,
} from '@/services/eurostat-codelists.js';
import { dataHostFor, isComextDataset } from '@/services/eurostat-hosts.js';
import { awaitShared } from '@/services/shared-load.js';
import {
  parseSdmxDatasetMetadata,
  parseSdmxDimensionOrder,
  type SdmxDatasetMetadata,
} from './sdmx-metadata.js';
import {
  type DatasetMeta,
  type DimensionValuesResult,
  type GeoLevel,
  type JsonStatResponse,
  type NoResultsDiagnosis,
  OBS_CAP,
  type Observation,
  type ObservationRow,
  type QueryExecution,
  type UnmatchedValues,
} from './types.js';

/** Separator between the observation flag and the confidentiality status inside a JSON-stat status. */
const CONF_SEPARATOR = '|';

/** A Statistics API error label that names one of the two period parameters. */
const PERIOD_PARAM_LABEL = /'(since|until)TimePeriod'/;

/**
 * How long parsed dataset metadata is reused. Eurostat publishes data at 11:00 and
 * 23:00 Brussels time, so an hour bounds how stale a constraint's period list or
 * `lastUpdated` can get while sparing repeat calls the structure download — 23 MB
 * for `DS-045409`.
 */
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Estimated bytes of parsed metadata held at once, least recently used evicted first.
 * The bound is on size because entries differ by three orders of magnitude: a
 * main-host dataset holds a few KB, `DS-045409`'s 37,069 labelled product codes
 * about 13.5 MB (measured retained heap; {@link estimateMetadataBytes} puts it at
 * 13.8 MB). A dataset estimated past the whole budget is answered but not kept.
 */
const METADATA_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Upper-end estimate of one entry's retained heap: two bytes per character of every
 * code and label (a label outside Latin-1 is stored at two bytes a character), plus
 * a fixed cost per value and per entry for the objects that hold them.
 */
function estimateMetadataBytes({ valuesByDimension }: SdmxDatasetMetadata): number {
  let bytes = 4_096;
  for (const values of Object.values(valuesByDimension)) {
    for (const { code, label } of values) bytes += 2 * (code.length + label.length) + 100;
  }
  return bytes;
}

interface MetadataCacheEntry {
  /** {@link estimateMetadataBytes} of the settled parse; absent while the load is in flight. */
  bytes?: number;
  expiresAt: number;
  metadata: Promise<SdmxDatasetMetadata>;
}

/** Freeze a parsed structure all the way down, so no caller can edit a cached entry. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Filter values the reply matched to nothing, compared case-insensitively
 * against each filtered dimension's `category.index`.
 *
 * Eurostat drops an unmatched value from the index rather than failing, and a
 * dimension keeps `size` ≥ 1 as long as one value beside it matched — so `size`
 * alone misses `geo=DE,XX`. It also matches codes in any case (`geo=de` comes
 * back as `DE`), which the comparison mirrors — for the dimension key too, since
 * `GEO=DE` is answered under `geo`. Values are reported under the key and in the
 * spelling sent, each once. A filtered dimension the reply does not describe at all
 * is skipped: there is nothing to compare against, and guessing would invent a
 * mismatch.
 */
export function findUnmatchedValues(
  sent: Record<string, string[]>,
  data: JsonStatResponse,
): UnmatchedValues | undefined {
  const unmatched: UnmatchedValues = {};
  for (const [key, values] of Object.entries(sent)) {
    const dim = data.id?.find((id) => id.toLowerCase() === key.toLowerCase());
    const index = dim === undefined ? undefined : data.dimension?.[dim]?.category?.index;
    if (!index) continue;
    const known = new Set(Object.keys(index).map((code) => code.toLowerCase()));
    const missing = [...new Set(values)].filter((v) => !known.has(v.toLowerCase()));
    if (missing.length > 0) unmatched[key] = missing;
  }
  return Object.keys(unmatched).length > 0 ? unmatched : undefined;
}

/**
 * Read an empty match's envelope for why it is empty, without another request.
 *
 * Three signals, which can co-occur: filter values absent from their dimension's
 * index; a `time` dimension of size 0, meaning the requested range selected no
 * period of the dataset; and, when every dimension matched at least one value,
 * the periods the reply selected — none of which carries a value for the slice.
 */
function diagnoseEmptyMatch(
  data: JsonStatResponse,
  sent: Record<string, string[]>,
  annotation: (type: string) => string | undefined,
): NoResultsDiagnosis {
  const unmatchedValues = findUnmatchedValues(sent, data);
  const dims = data.id ?? [];
  const sizes = data.size ?? [];
  const timeDim = dims.indexOf('time');
  const diagnosis: NoResultsDiagnosis = { ...(unmatchedValues && { unmatchedValues }) };
  if (timeDim < 0) return diagnosis;

  if (sizes[timeDim] === 0) {
    const oldest = annotation('OBS_PERIOD_OVERALL_OLDEST');
    const latest = annotation('OBS_PERIOD_OVERALL_LATEST');
    diagnosis.outsideCoverage = { ...(oldest && { oldest }), ...(latest && { latest }) };
  } else if (sizes.length === dims.length && sizes.every((size) => size >= 1)) {
    diagnosis.matchedPeriods = Object.entries(data.dimension?.time?.category?.index ?? {})
      .sort(([, a], [, b]) => a - b)
      .map(([code]) => code);
  }
  return diagnosis;
}

/**
 * Split a JSON-stat status into its observation flag and its confidentiality status.
 *
 * JSON-stat publishes no `CONF_STATUS` field, so Eurostat folds that code into the
 * observation status behind a `|`: a confidential cell arrives as `|C` labelled
 * `|confidential`, a provisional one as `p` labelled `provisional`. The `|` is a
 * separator, not part of a code — `sdmx/2.1/codelist/ESTAT/OBS_FLAG` has 42 codes
 * and none contains one — so the left side is the `OBS_FLAG` code and the right the
 * `CONF_STATUS` code, and either side may be empty. The SDMX TSV endpoint carries
 * the same pair around an `@` and the SDMX-CSV rendering publishes them as separate
 * columns; splitting here is what puts a given observation in the same columns
 * whichever endpoint staged it.
 *
 * The response's own label map is split the same way and consulted first, so a
 * localized `OBS_FLAG` label survives (`vorläufig` under `lang=DE`). Eurostat leaves
 * the confidentiality half untranslated, and a half it labels with nothing falls
 * back to the published codelist, then to the bare code.
 */
export function splitStatus(
  code: string,
  labels: Record<string, string>,
): { confStatus?: { code: string; label: string }; flag?: { code: string; label: string } } {
  const rawLabel = labels[code] ?? '';
  const codeSep = code.indexOf(CONF_SEPARATOR);
  const labelSep = rawLabel.indexOf(CONF_SEPARATOR);

  const flagCode = codeSep === -1 ? code : code.slice(0, codeSep);
  const confCode = codeSep === -1 ? '' : code.slice(codeSep + 1);
  const flagLabel = labelSep === -1 ? rawLabel : rawLabel.slice(0, labelSep);
  const confLabel = labelSep === -1 ? '' : rawLabel.slice(labelSep + 1);

  return {
    ...(flagCode && {
      flag: { code: flagCode, label: flagLabel || OBS_FLAG_LABELS[flagCode] || flagCode },
    }),
    ...(confCode && {
      confStatus: {
        code: confCode,
        label: confLabel || CONF_STATUS_LABELS[confCode] || confCode,
      },
    }),
  };
}

/** Run an SDMX parse, reporting a body it cannot read as a non-retryable upstream fault. */
function parseSdmx<T>(datasetCode: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw serviceUnavailable(
      `Eurostat returned malformed SDMX metadata for dataset "${datasetCode}": ${error instanceof Error ? error.message : String(error)}`,
      { reason: 'upstream_fault', datasetCode, retryable: false },
    );
  }
}

export class EurostatDataService {
  /**
   * Parsed metadata per dataset, keyed by host and lowercased code — Eurostat matches
   * codes in any case, so `ds-045409` and `DS-045409` share one entry. The value is the
   * in-flight or settled parse, so concurrent first calls share one download. Entries
   * are deep-frozen, expire after {@link METADATA_CACHE_TTL_MS}, are bounded in total
   * by {@link METADATA_CACHE_MAX_BYTES}, and a failed load is dropped rather than
   * cached. Map order is recency order: a hit is re-inserted.
   */
  private readonly metadataCache = new Map<string, MetadataCacheEntry>();

  // config and storage accepted to match the standard service init pattern;
  // this service uses only the Eurostat public API and per-request config.
  // biome-ignore lint/complexity/noUselessConstructor: standard init pattern
  constructor(_config: AppConfig, _storage: StorageService) {}

  private buildUrl(datasetCode: string, params: Record<string, string | string[]>): URL {
    const url = new URL(
      `${dataHostFor(datasetCode)}/statistics/1.0/data/${encodeURIComponent(datasetCode)}`,
    );
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

  /**
   * One dataset-scoped SDMX 2.1 structure URL — every structure read goes through
   * here, on the host {@link dataHostFor} picks for the code.
   *
   * The structure definition is requested unversioned, which Eurostat answers with
   * the current one. Its version moves with the dataset (`earn_ses_annual`'s is
   * 22.0), and a pinned `/1.0` returns the dataset's first structure instead.
   */
  private buildSdmxUrl(
    resource: 'contentconstraint' | 'dataflow' | 'datastructure',
    datasetCode: string,
  ): URL {
    const version = resource === 'datastructure' ? '' : '/1.0';
    const url = new URL(
      `${dataHostFor(datasetCode)}/sdmx/2.1/${resource}/ESTAT/${encodeURIComponent(datasetCode)}${version}`,
    );
    if (resource === 'dataflow') {
      url.searchParams.set('references', 'descendants');
      url.searchParams.set('detail', 'referencepartial');
    }
    return url;
  }

  /**
   * `signal` cancels the request. It is the caller's own for a read one caller owns,
   * and undefined for the shared metadata load, which no single caller may cancel.
   */
  private fetchSdmxXml(
    url: URL,
    datasetCode: string,
    ctx: Context,
    signal: AbortSignal | undefined,
    timeoutMs = getServerConfig().requestTimeoutMs,
  ): Promise<string> {
    return withRetry(
      async () => {
        try {
          const response = await fetchWithTimeout(url.toString(), timeoutMs, ctx, {
            ...(signal && { signal }),
            expectedStatuses: [404],
          });
          return await response.text();
        } catch (error) {
          const status = error instanceof McpError ? error.data?.status : undefined;
          if (status === 404) {
            throw notFound(
              `Dataset "${datasetCode}" was not found in Eurostat's SDMX dataflows. Verify the code with eurostat_search_datasets or eurostat_browse_themes.`,
              { reason: 'not_found', datasetCode },
            );
          }
          throw error;
        }
      },
      {
        operation: 'fetchSdmxMetadata',
        context: ctx,
        baseDelayMs: 1000,
        ...(signal && { signal }),
      },
    );
  }

  /**
   * The dataset's parsed metadata, from {@link metadataCache} when a live entry holds it.
   *
   * The load is shared by every caller of the dataset, so it runs without a caller's
   * signal and is bounded by its timeouts alone: a caller that cancels stops waiting
   * without failing the others or the entry.
   */
  private getSdmxMetadata(datasetCode: string, ctx: Context): Promise<SdmxDatasetMetadata> {
    return awaitShared(ctx.signal, () => {
      const key = `${dataHostFor(datasetCode)} ${datasetCode.toLowerCase()}`;
      const now = Date.now();
      const hit = this.metadataCache.get(key);
      this.metadataCache.delete(key);
      if (hit && hit.expiresAt > now) {
        this.metadataCache.set(key, hit);
        return hit.metadata;
      }

      const entry: MetadataCacheEntry = {
        expiresAt: now + METADATA_CACHE_TTL_MS,
        metadata: this.loadSdmxMetadata(datasetCode, ctx).then(deepFreeze),
      };
      this.metadataCache.set(key, entry);
      entry.metadata.then(
        (metadata) => {
          entry.bytes = estimateMetadataBytes(metadata);
          if (entry.bytes > METADATA_CACHE_MAX_BYTES) {
            if (this.metadataCache.get(key) === entry) this.metadataCache.delete(key);
          } else {
            this.evictToBudget();
          }
        },
        () => {
          if (this.metadataCache.get(key) === entry) this.metadataCache.delete(key);
        },
      );
      return entry.metadata;
    });
  }

  /**
   * Drop settled entries, least recently used first, until the estimated total fits
   * {@link METADATA_CACHE_MAX_BYTES}. A load still in flight has no size yet and is
   * kept, so concurrent callers of it still share one download.
   */
  private evictToBudget(): void {
    let total = 0;
    for (const { bytes } of this.metadataCache.values()) total += bytes ?? 0;
    for (const [key, { bytes }] of this.metadataCache) {
      if (total <= METADATA_CACHE_MAX_BYTES) break;
      if (bytes === undefined) continue;
      this.metadataCache.delete(key);
      total -= bytes;
    }
  }

  /**
   * Download and parse one dataset's dataflow structure and content constraint.
   *
   * The dataflow carries a label for every code the dataset uses, so it is the one
   * structure read that scales with the dataset — 23 MB, uncompressed, for the CN8
   * collection — and it alone gets `EUROSTAT_METADATA_TIMEOUT_MS`.
   */
  private async loadSdmxMetadata(datasetCode: string, ctx: Context): Promise<SdmxDatasetMetadata> {
    const { metadataTimeoutMs } = getServerConfig();
    const [dataflowXml, constraintXml] = await Promise.all([
      this.fetchSdmxXml(
        this.buildSdmxUrl('dataflow', datasetCode),
        datasetCode,
        ctx,
        undefined,
        metadataTimeoutMs,
      ),
      this.fetchSdmxXml(
        this.buildSdmxUrl('contentconstraint', datasetCode),
        datasetCode,
        ctx,
        undefined,
      ),
    ]);
    /**
     * The parse's strings are slices of the response bodies, and a slice keeps its
     * whole source string alive: kept as parsed, a `DS-045409` entry pins the 23 MB
     * dataflow body and retains 52 MB instead of 13.5 MB. Cloning copies every string
     * out, so the bodies are freed once the load ends.
     */
    return parseSdmx(datasetCode, () =>
      structuredClone(parseSdmxDatasetMetadata(dataflowXml, constraintXml, datasetCode)),
    );
  }

  private fetchJson(url: URL, ctx: Context): Promise<JsonStatResponse> {
    const { requestTimeoutMs } = getServerConfig();
    return withRetry(
      async () => {
        let response: Awaited<ReturnType<typeof fetchWithTimeout>>;
        try {
          response = await fetchWithTimeout(url.toString(), requestTimeoutMs, ctx, {
            signal: ctx.signal,
            // 400 (invalid dimension / conflicting params), 404 (unknown dataset) and 413
            // (extraction too large) are modeled outcomes reclassified below into the
            // declared error contract, not service failures — log them at debug. The
            // thrown McpError is unchanged.
            expectedStatuses: [400, 404, 413],
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
      { operation: 'fetchJsonStat', context: ctx, baseDelayMs: 1000, signal: ctx.signal },
    );
  }

  private checkResponseErrors(data: JsonStatResponse, url: string): void {
    const firstError = Array.isArray(data.error) ? data.error[0] : undefined;

    /**
     * Query too large to serve. Eurostat answers with a warning object on HTTP 200
     * (the asynchronous response) or an error-array item on HTTP 413 — its label
     * `EXTRACTION_TOO_BIG` with the estimated row count, or `ASYNCHRONOUS_RESPONSE`.
     * Both are classified before withRetry sees them and are non-retryable: the same
     * query re-run just re-triggers the refusal, so the caller has to narrow it. The
     * dimensions to narrow by are the dataset's own, which the tool names; this
     * message cannot, since a refusal carries no dimension list.
     */
    if (data.warning?.status === 413) {
      throw serviceUnavailable(
        'Eurostat returned an asynchronous response — the query matched too many observations. Add dimension filters or a narrower period range to reduce the result size, then retry.',
        { reason: 'async_response', url, retryable: false },
      );
    }
    if (firstError?.status === 413) {
      throw serviceUnavailable(
        `Eurostat refused the query as too large to serve (${firstError.label}). Add dimension filters or a narrower period range to reduce the result size, then retry.`,
        { reason: 'async_response', url, retryable: false },
      );
    }

    // Error responses
    if (firstError) {
      const err = firstError;
      if (err.status === 200 && err.id === 100) {
        throw notFound(
          `Eurostat returned no observations for this query. Verify the dimension filters with eurostat_get_dimension_values and keep the period range inside the dataset's coverage.`,
          { reason: 'no_results', eurostatError: err },
        );
      }
      if (err.status === 404) {
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
        // Eurostat's own refusal of a period literal: error id 140 for one it cannot parse
        // as a time filter, or a generic 400 whose label names the period parameter.
        if (err.id === 140 || PERIOD_PARAM_LABEL.test(err.label)) {
          throw validationError(
            `Eurostat rejected the period range. Eurostat error: ${err.label}.`,
            {
              reason: 'invalid_period',
              eurostatError: err,
            },
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
   * `decodeObservations` stops at its preview bound, so the totals reported alongside a
   * preview cannot be derived from the decoded array. This walks the `value`/`status` key
   * maps instead — one pass, no per-observation object — so the caller is told how large
   * the whole match is, how much of it is missing, and which periods it spans, whatever
   * the preview bound. Cell membership matches the decoder exactly: a cell counts when it appears in
   * either map at an in-range linear index, and counts as missing when no numeric value
   * accompanies it. `queryDataset` also reads `obsCount` reaching zero as the no-results
   * condition, so one count decides both what the response reports and whether there is a
   * response at all.
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

    // A text value (PRODCOM's `:C`, `KG`) carries no number, so it counts as missing.
    for (const key in value) count(key, typeof value[key] !== 'number');
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
   * the same walk serve both a bounded preview and an uncapped dataframe spill.
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

      const obs: Observation = {
        dimensions,
        value: typeof rawValue === 'number' ? rawValue : null,
      };
      if (statusCode) {
        const { flag, confStatus } = splitStatus(statusCode, statusLabels);
        if (flag) obs.status = flag;
        if (confStatus) obs.confStatus = confStatus;
      }
      if (typeof rawValue === 'string') {
        const { confStatus, text } = decodeTextValue(rawValue);
        if (confStatus && !obs.confStatus) {
          obs.confStatus = {
            code: confStatus,
            label: CONF_STATUS_LABELS[confStatus] ?? confStatus,
          };
        }
        if (text) obs.valueText = text;
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
   * Fetch complete dataset metadata from its scoped SDMX structure and content constraint.
   *
   * Returns a copy of the cached entry carrying `code` as this caller spelled it: the
   * cache is shared across spellings, and a caller that edits the result edits its own.
   */
  async getDatasetInfo(datasetCode: string, ctx: Context): Promise<DatasetMeta> {
    ctx.log.info('Fetching dataset info', { datasetCode });
    const { meta } = await this.getSdmxMetadata(datasetCode, ctx);
    return { ...structuredClone(meta), code: datasetCode };
  }

  /**
   * The dataset's dimensions in key order, `time` excluded.
   *
   * This is the order the SDMX positional key is built from, read from the
   * dataset's structure definition. That response is a few KB however large the
   * dataset is, where an observation request — even a one-period slice — is
   * refused with HTTP 413 once the latest period alone exceeds Eurostat's
   * extraction limit (`earn_ses_annual`). Verified against live SDMX TSV headers
   * and JSON-stat `id` arrays: the header's comma-joined key field is exactly this
   * order.
   */
  async getDimensionOrder(datasetCode: string, ctx: Context): Promise<string[]> {
    const xml = await this.fetchSdmxXml(
      this.buildSdmxUrl('datastructure', datasetCode),
      datasetCode,
      ctx,
      ctx.signal,
    );
    const order = parseSdmx(datasetCode, () => parseSdmxDimensionOrder(xml));
    if (order.length === 0) {
      throw serviceUnavailable(
        `Eurostat reported no dimensions for dataset "${datasetCode}", so a positional filter key cannot be built. Retry without filters to download the whole dataset.`,
        { reason: 'upstream_fault', datasetCode },
      );
    }
    return order;
  }

  /**
   * Get all valid values for a specific dimension in a dataset.
   *
   * Values come from the dataset's content constraint, not from a populated observation
   * slice. For `geo`, the requested hierarchy level is applied locally and defaults to
   * `country`; the effective level is returned so an omitted default is still visible.
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

    const metadata = await this.getSdmxMetadata(datasetCode, ctx);
    const dimDef = metadata.meta.dimensions.find(({ code }) => code === dimension);
    const values = metadata.valuesByDimension[dimension];
    if (!dimDef || !values) {
      throw notFound(
        `Dimension "${dimension}" not found in dataset "${datasetCode}". Use eurostat_get_dataset_info to see valid dimensions.`,
        { reason: 'not_found', datasetCode, dimension },
      );
    }

    // A fresh array either way: the cached list is frozen and shared across calls.
    const effectiveGeoLevel = dimension === 'geo' ? (geoLevel ?? 'country') : undefined;
    const filteredValues = effectiveGeoLevel
      ? values.filter(({ code }) => metadata.geoLevelsByCode[code] === effectiveGeoLevel)
      : [...values];
    if (effectiveGeoLevel && filteredValues.length === 0) {
      throw notFound(
        `Dataset "${datasetCode}" has no "geo" values at the "${effectiveGeoLevel}" level. Choose a different geo_level or omit geo_level only when country values are wanted.`,
        {
          reason: 'no_results',
          datasetCode,
          dimension,
          geoLevel: effectiveGeoLevel,
        },
      );
    }

    return {
      dimensionCode: dimension,
      dimensionLabel: dimDef.label,
      ...(effectiveGeoLevel && { geoLevel: effectiveGeoLevel }),
      values: filteredValues,
      totalCount: filteredValues.length,
    };
  }

  /**
   * Query dataset observations with dimension filters.
   *
   * Returns the requested observation preview alongside `rows()`, a lazy
   * generator over the whole match. Both read the same response body — already
   * in memory before decoding starts — so reaching rows outside the preview
   * costs no additional upstream request.
   */
  async queryDataset(
    datasetCode: string,
    filters: Record<string, string[]>,
    geoLevel: GeoLevel | undefined,
    sinceP: string | undefined,
    untilP: string | undefined,
    lastN: number | undefined,
    lang: string,
    previewLimit: number,
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

    // Validate mutually exclusive params. Eurostat reads filter keys in any case, so `GEO` is geo.
    if (geoLevel && Object.keys(appliedFilters).some((key) => key.toLowerCase() === 'geo')) {
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

    // Totals describe the whole match and are counted from the response's cell keys, so the
    // decode cap below cannot shrink them.
    const { obsCount, missingObsCount, timeCodes } = this.scanCells(data);

    // Emptiness is the cell count reaching zero — the same count reported below and the same
    // membership the decoder walks. Reading `value` alone instead would reject a slice whose
    // every cell is confidential: JSON-stat carries such a cell in `status` with no `value`
    // entry, so the whole slice arrives as `"value": {}` while still being data the decoder
    // yields. Deriving both the guard and the reported total from one count is what keeps a
    // rejected query and a returned one from disagreeing about what an observation is.
    //
    // The empty reply still says which filter values matched nothing and which periods it
    // selected, so that diagnosis rides the error for the tool to explain.
    if (obsCount === 0) {
      throw notFound(
        `Query returned no observations for dataset "${datasetCode}". The dimension filter combination may not exist in the data, or the period range may fall outside the dataset's coverage. Verify dimension values with eurostat_get_dimension_values first.`,
        {
          reason: 'no_results',
          datasetCode,
          filters: appliedFilters,
          ...diagnoseEmptyMatch(data, appliedFilters, (type) =>
            this.extractAnnotation(data, type, 'title'),
          ),
        },
      );
    }
    const unmatchedValues = findUnmatchedValues(appliedFilters, data);

    const observations = this.decodeObservations(data, Math.min(previewLimit, OBS_CAP));

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
      ...(unmatchedValues && { unmatchedValues }),
      rows: () => this.iterateRows(data, dimensionsUsed, isComextDataset(datasetCode)),
    };
  }

  /** {@link iterateObservations}, flattened to dataframe rows one at a time. */
  private *iterateRows(
    data: JsonStatResponse,
    dimensionsUsed: string[],
    valueText: boolean,
  ): Generator<ObservationRow> {
    for (const obs of this.iterateObservations(data)) {
      yield toObservationRow(obs, dimensionsUsed, valueText);
    }
  }
}

/**
 * Flatten one observation into a dataframe row.
 *
 * The inverse of the nested shape `Observation` carries: each dimension
 * contributes `<dim>` (code) and `<dim>_label`, the observation flag contributes
 * `obs_flag` / `obs_flag_label`, and the confidentiality status contributes
 * `conf_status` / `conf_status_label`. Anything the observation does not carry —
 * a dimension, either flag — yields `null` in its columns rather than an absent
 * key, so every row has the same column set the table is declared with.
 *
 * `valueText` adds the `obs_value_text` column, which a `DS-*` table declares (see
 * {@link observationRowSchema}).
 */
export function toObservationRow(
  obs: Observation,
  dimensionsUsed: string[],
  valueText = false,
): ObservationRow {
  const row: ObservationRow = {};
  for (const dim of dimensionsUsed) {
    const cell = obs.dimensions[dim];
    row[dim] = cell?.code ?? null;
    row[`${dim}_label`] = cell?.label ?? null;
  }
  row[OBS_VALUE_COLUMN] = obs.value;
  if (valueText) row[OBS_VALUE_TEXT_COLUMN] = obs.valueText ?? null;
  row[OBS_FLAG_COLUMN] = obs.status?.code ?? null;
  row[OBS_FLAG_LABEL_COLUMN] = obs.status?.label ?? null;
  row[CONF_STATUS_COLUMN] = obs.confStatus?.code ?? null;
  row[CONF_STATUS_LABEL_COLUMN] = obs.confStatus?.label ?? null;
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
 *
 * `valueText` declares `obs_value_text` after `obs_value`. The query tool sets it for a
 * `DS-*` dataset, whose PRODCOM indicators publish units and flags as text.
 */
export function observationRowSchema(dimensionsUsed: string[], valueText = false): ColumnSchema[] {
  return [
    ...dimensionsUsed.flatMap((dim): ColumnSchema[] => [
      { name: dim, type: 'VARCHAR', nullable: true },
      { name: `${dim}_label`, type: 'VARCHAR', nullable: true },
    ]),
    { name: OBS_VALUE_COLUMN, type: 'DOUBLE', nullable: true },
    ...(valueText
      ? [{ name: OBS_VALUE_TEXT_COLUMN, type: 'VARCHAR', nullable: true } satisfies ColumnSchema]
      : []),
    { name: OBS_FLAG_COLUMN, type: 'VARCHAR', nullable: true },
    { name: OBS_FLAG_LABEL_COLUMN, type: 'VARCHAR', nullable: true },
    { name: CONF_STATUS_COLUMN, type: 'VARCHAR', nullable: true },
    { name: CONF_STATUS_LABEL_COLUMN, type: 'VARCHAR', nullable: true },
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
