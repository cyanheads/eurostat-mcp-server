/**
 * @fileoverview Tool for downloading a whole Eurostat dataset through the SDMX
 * 2.1 TSV bulk endpoint and staging it on the dataframe canvas.
 * @module mcp-server/tools/definitions/eurostat-download-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas, getCanvas, newTableName } from '@/services/canvas-accessor.js';
import {
  bulkRowSchema,
  getEurostatBulkService,
} from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import type { BulkRow } from '@/services/eurostat-bulk/types.js';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

/** Upper bound on rows echoed inline, whatever preview_limit asks for. */
const PREVIEW_MAX = 500;

/**
 * Tee a row source: the first `limit` rows land in `preview`, every row passes
 * through. One pass over the stream serves both the inline echo and the canvas,
 * so the preview is a prefix of the staged table by construction rather than a
 * separately-derived slice that can drift from it.
 */
async function* teePreview(
  rows: AsyncGenerator<BulkRow>,
  preview: BulkRow[],
  limit: number,
): AsyncGenerator<BulkRow> {
  for await (const row of rows) {
    if (preview.length < limit) preview.push(row);
    yield row;
  }
}

export const eurostatDownloadDataset = tool('eurostat_download_dataset', {
  title: 'Download Eurostat Dataset',
  description:
    'Download a Eurostat dataset in bulk through the SDMX 2.1 TSV endpoint and stage every observation as a SQL table on the dataframe canvas — the route to a whole dataset, where eurostat_query_dataset is the route to a slice of one. The TSV wire format is roughly half the bytes of the JSON-stat body eurostat_query_dataset reads, so it reaches datasets that would otherwise time out, and it is expanded here into one row per observation. Filters take the same dimension-code map eurostat_query_dataset uses and are applied server-side by Eurostat; call eurostat_get_dataset_info first for the dimension codes and eurostat_get_dimension_values for their values. Narrow with since_period/until_period rather than asking for the most recent N periods — the TSV layout keeps a column for every period whichever is requested, so a period range is what actually shrinks the response. Transfers are bounded by a byte budget enforced while streaming: when it is spent the download stops and budgetExceeded is set, leaving a prefix of the dataset rather than an error. Only preview_limit rows come back inline. When a table is staged, call eurostat_dataframe_describe first to confirm its columns, then eurostat_dataframe_query; without a canvas, rows past the preview are not retained.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    dataset_code: z.string().min(1).describe('Dataset code (e.g., "nama_10_gdp"). Required.'),
    filters: z
      .record(z.string(), z.array(z.string()))
      .default({})
      .describe(
        'Dimension filters as a map of dimension code → array of accepted values, applied by Eurostat before the body is sent. Example: {"unit": ["CP_MEUR"], "na_item": ["B1G"], "geo": ["DE", "FR"]}. Omit a dimension or pass an empty array to accept every value for it. Do not put "time" here — use since_period/until_period. Naming a dimension the dataset does not have is rejected with the dataset\'s dimension list rather than silently ignored.',
      ),
    since_period: z
      .string()
      .optional()
      .describe(
        'Start of the period range (e.g., "2020", "2023-Q1", "2024-01"), sent as startPeriod. The most effective way to shrink a bulk response: it removes period columns from the TSV rather than blanking their cells.',
      ),
    until_period: z
      .string()
      .optional()
      .describe(
        'End of the period range (e.g., "2024"), sent as endPeriod. Omit for data through the latest available period.',
      ),
    preview_limit: z
      .number()
      .int()
      .min(1)
      .max(PREVIEW_MAX)
      .default(50)
      .describe(
        'How many observations to echo inline, from the start of the download. Caps at 500. The full download is on the canvas table when one was staged; this is orientation, not the result set.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Reuse an existing dataframe canvas so this download lands beside earlier results and can be joined against them. Pass a canvasId from a previous response; omit to start a fresh canvas. Ignored on deployments without a dataframe canvas.',
      ),
  }),
  output: z.object({
    datasetCode: z.string().describe('Dataset code as provided.'),
    dimensionsUsed: z
      .array(z.string())
      .describe(
        'Dimension codes carried by the downloaded rows, in the order Eurostat keys them (e.g., ["freq", "unit", "na_item", "geo"]). Read from the TSV header, so it reflects the response rather than metadata. The period lives in the separate "time" column.',
      ),
    rowCount: z
      .number()
      .describe(
        'Observations expanded from the download — one per populated cell, counting those Eurostat reports as unavailable.',
      ),
    missingCount: z
      .number()
      .describe('Downloaded observations carrying no numeric value (obs_value is null).'),
    periodRange: z
      .object({
        start: z
          .string()
          .optional()
          .describe(
            'Earliest period carrying an observation. Omitted when nothing was downloaded.',
          ),
        end: z
          .string()
          .optional()
          .describe('Latest period carrying an observation. Omitted when nothing was downloaded.'),
      })
      .describe(
        'Period coverage of the rows actually downloaded. Narrower than the dataset when budgetExceeded is true or a period range was applied.',
      ),
    bytesRead: z
      .number()
      .describe(
        'Decoded TSV bytes read from Eurostat — after gzip decompression when the body arrived compressed, so it measures the payload rather than the wire.',
      ),
    compressed: z
      .boolean()
      .describe(
        'True when Eurostat sent the body gzip-compressed. It does so without a Content-Encoding header on large responses, so this reports what the stream actually carried.',
      ),
    budgetExceeded: z
      .boolean()
      .describe(
        'True when the byte budget stopped the transfer before the dataset ended, making the rows a prefix rather than the whole thing. Narrow with filters or a period range, or raise EUROSTAT_BULK_MAX_BYTES.',
      ),
    observations: z
      .array(
        z
          .record(z.string(), z.union([z.string(), z.number(), z.null()]))
          .describe(
            'One observation as a flat row: one column per dimension holding its code, "time" for the period, then obs_value, obs_flag, obs_flag_label, conf_status, conf_status_label. A label column is null when Eurostat publishes no label for that code.',
          ),
      )
      .describe(
        'The first preview_limit observations of the download, in the order Eurostat streamed them. A prefix of the staged table, not a sample.',
      ),
    canvasId: z
      .string()
      .optional()
      .describe(
        'Dataframe canvas holding the staged download. Pass to eurostat_dataframe_describe, eurostat_dataframe_query, or a later staging call. Omitted when nothing was staged.',
      ),
    tableName: z
      .string()
      .optional()
      .describe(
        'Canvas table holding every downloaded observation. Call eurostat_dataframe_describe with canvasId first to confirm the table and columns, then eurostat_dataframe_query. Omitted when this deployment runs without a dataframe canvas, in which case only the inline preview survives the call.',
      ),
    stagedRowCount: z
      .number()
      .optional()
      .describe('Rows written to the canvas table. Matches rowCount. Omitted alongside tableName.'),
  }),
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the inline observation preview omits rows.'),
    shown: z.number().optional().describe('Observations returned in the inline preview.'),
    cap: z.number().optional().describe('The preview_limit applied to inline observations.'),
    appliedQuery: z
      .object({
        filters: z
          .record(z.string(), z.array(z.string()))
          .describe('Dimension filters sent to Eurostat. Empty arrays are dropped.'),
        sincePeriod: z.string().optional().describe('startPeriod applied, if any.'),
        untilPeriod: z.string().optional().describe('endPeriod applied, if any.'),
        url: z.string().describe('The SDMX request URL, so the download can be reproduced.'),
      })
      .describe('The bulk request as the server built it.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for every staged result, including the required eurostat_dataframe_describe then eurostat_dataframe_query sequence, composed with byte-budget, no-canvas, or empty-result disclosure when applicable.',
      ),
  },

  enrichmentTrailer: {
    appliedQuery: {
      render: (q) => {
        const parts: string[] = [];
        const keys = Object.keys(q.filters);
        parts.push(
          keys.length > 0
            ? `- **Filters:** ${keys.map((k) => `${k}=[${(q.filters[k] ?? []).join(', ')}]`).join('; ')}`
            : '- **Filters:** none (whole dataset)',
        );
        if (q.sincePeriod || q.untilPeriod) {
          parts.push(`- **Period:** ${q.sincePeriod ?? '…'} – ${q.untilPeriod ?? 'latest'}`);
        }
        parts.push(`- **URL:** ${q.url}`);
        return `**Bulk Request:**\n${parts.join('\n')}`;
      },
    },
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset code is not available for dissemination (HTTP 404, SDMX faultcode 100).',
      recovery:
        'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.',
    },
    {
      reason: 'invalid_dimension',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter names a dimension the dataset does not have, or a value or period range Eurostat rejects (SDMX faultcode 150).',
      recovery:
        'Check dimension codes with eurostat_get_dataset_info and their values with eurostat_get_dimension_values, and keep the period range inside the dataset coverage.',
    },
    {
      reason: 'filter_arity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Eurostat rejected the positional dimension key because it carried the wrong number of positions (SDMX faultcode 140), meaning the dataset structure has changed since the metadata call.',
      recovery:
        'Retry without filters to download the whole dataset, or re-read the dimensions with eurostat_get_dataset_info.',
    },
    {
      reason: 'async_queued',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Eurostat answered HTTP 200 with a SOAP syncResponse queue ticket (status SUBMITTED) instead of data, because the extraction was too costly to serve synchronously.',
      retryable: false,
      recovery:
        'Add dimension filters or a period range so Eurostat serves the extraction inline; the queued result cannot be collected here.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The download completed but carried no populated observation cells.',
      recovery:
        'Verify the filter values with eurostat_get_dimension_values — a combination that exists in no cell returns an empty body.',
    },
    {
      reason: 'upstream_fault',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The SDMX endpoint returned a fault this server does not model, or a body that is not a TSV table.',
      recovery: 'Retry in a few minutes, or narrow the request with dimension filters.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A canvas_id was supplied for staging but is unknown or its lifetime has elapsed.',
      recovery: 'Omit canvas_id so the download starts a fresh canvas and returns its canvasId.',
    },
  ],

  async handler(input, ctx) {
    const bulk = getEurostatBulkService();
    const sinceP = input.since_period?.trim() || undefined;
    const untilP = input.until_period?.trim() || undefined;
    const filters = Object.fromEntries(
      Object.entries(input.filters).filter(([, values]) => values.length > 0),
    );

    /**
     * `ctx.fail` is typed against this tool's reason union, so the mapping stays
     * here rather than inside a helper that would have to take a bare string.
     */
    const asContract = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (err) {
        const mapped = mapBulkFailure(err, input.dataset_code);
        if (!mapped) throw err;
        throw ctx.fail(mapped.reason, mapped.message, { recovery: { hint: mapped.hint } });
      }
    };

    /**
     * The positional key needs every dimension in order, not just the filtered
     * ones, so a filtered download pays one cheap metadata call first. An
     * unfiltered download needs no key and skips it — the TSV header names the
     * dimensions anyway.
     */
    const dimensionOrder =
      Object.keys(filters).length > 0
        ? await asContract(() =>
            getEurostatDataService().getDimensionOrder(input.dataset_code, ctx),
          )
        : [];

    const download = await asContract(() =>
      bulk.startDownload(input.dataset_code, dimensionOrder, filters, sinceP, untilP, ctx),
    );

    const preview: BulkRow[] = [];
    const source = teePreview(download.rows(), preview, input.preview_limit);

    const canvas = getCanvas();
    let staged: { canvasId: string; stagedRowCount: number; tableName: string } | undefined;
    if (canvas) {
      const instance = await acquireCanvas(canvas, input.canvas_id, ctx);
      const handle = await instance.registerTable(newTableName(), source, {
        schema: bulkRowSchema(download.header.dimensions),
        signal: ctx.signal,
      });
      staged = {
        canvasId: instance.canvasId,
        stagedRowCount: handle.rowCount,
        tableName: handle.tableName,
      };
    } else {
      /**
       * Without a canvas the stream still runs to completion. Everything past
       * the preview is discarded, but the counts, the period coverage and the
       * budget verdict then describe the download rather than describing the
       * preview — and the byte budget still bounds what is transferred. Stopping
       * at preview_limit instead would report a row count of 50 for a dataset of
       * millions.
       */
      for await (const _row of source) {
        // Drained for its counters; nothing is retained past the preview.
      }
    }

    const { stats } = download;
    const firstPeriod = stats.periodsSeen[0];
    const lastPeriod = stats.periodsSeen.at(-1);
    if (stats.rowCount === 0) {
      throw ctx.fail(
        'no_results',
        `The download of "${input.dataset_code}" carried no observations.`,
        {
          recovery: {
            hint: `Eurostat returned a table with no populated cells for "${input.dataset_code}". Verify the filter values with eurostat_get_dimension_values — a combination present in no cell downloads as an empty body.`,
          },
        },
      );
    }

    ctx.log.info('Bulk download complete', {
      datasetCode: input.dataset_code,
      rowCount: stats.rowCount,
      bytesRead: stats.bytesRead,
      compressed: stats.compressed,
      budgetExceeded: stats.budgetExceeded,
      ...(staged && { canvasId: staged.canvasId, tableName: staged.tableName }),
    });

    ctx.enrich({
      appliedQuery: {
        filters,
        ...(sinceP && { sincePeriod: sinceP }),
        ...(untilP && { untilPeriod: untilP }),
        url: download.url,
      },
    });
    if (stats.rowCount > preview.length) {
      ctx.enrich.truncated({ shown: preview.length, cap: input.preview_limit });
    }

    const notices: string[] = [];
    if (stats.budgetExceeded) {
      notices.push(
        `The byte budget stopped this transfer after ${stats.bytesRead.toLocaleString()} bytes, so these ${stats.rowCount.toLocaleString()} observations are the start of "${input.dataset_code}" and not all of it. Add dimension filters or a since_period/until_period range to fit the dataset inside the budget, or raise EUROSTAT_BULK_MAX_BYTES.`,
      );
    }
    if (!staged) {
      notices.push(
        `This deployment runs without a dataframe canvas, so nothing was staged: only the ${preview.length.toLocaleString()} observations returned inline are retained, and the other ${(stats.rowCount - preview.length).toLocaleString()} were counted and discarded. Set CANVAS_PROVIDER_TYPE=duckdb to keep the download, or use eurostat_query_dataset with dimension filters to fetch a slice small enough to return whole.`,
      );
    } else {
      notices.push(
        `All ${staged.stagedRowCount.toLocaleString()} downloaded observations are staged as table "${staged.tableName}" on canvas "${staged.canvasId}". Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      datasetCode: input.dataset_code,
      dimensionsUsed: download.header.dimensions,
      rowCount: stats.rowCount,
      missingCount: stats.missingCount,
      periodRange: {
        ...(firstPeriod && { start: firstPeriod }),
        ...(lastPeriod && { end: lastPeriod }),
      },
      bytesRead: stats.bytesRead,
      compressed: stats.compressed,
      budgetExceeded: stats.budgetExceeded,
      observations: preview,
      ...staged,
    };
  },

  format: (result) => {
    const { start, end } = result.periodRange;
    const UNREPORTED = 'not reported by Eurostat';
    const period = start || end ? `${start ?? UNREPORTED} – ${end ?? UNREPORTED}` : UNREPORTED;
    const lines: string[] = [
      `# Bulk download \`${result.datasetCode}\``,
      `**Observations:** ${result.rowCount} (${result.missingCount} missing) | **Period:** ${period}`,
      `**Dimensions:** ${result.dimensionsUsed.join(', ')}`,
      `**Transfer:** ${result.bytesRead} bytes decoded | **Compressed:** ${result.compressed} | **Budget exceeded:** ${result.budgetExceeded}${
        result.budgetExceeded ? ' — these rows are the start of the dataset, not all of it' : ''
      }`,
    ];
    lines.push(
      result.tableName
        ? `**Staged:** table \`${result.tableName}\` on canvas \`${result.canvasId}\` (stagedRowCount ${result.stagedRowCount}) — inspect it with eurostat_dataframe_describe first, then query it with eurostat_dataframe_query`
        : '**Staged:** nothing — this deployment runs without a dataframe canvas, so only the rows below are retained',
    );
    lines.push('', `## First ${result.observations.length} observations`);
    for (const row of result.observations) {
      lines.push(
        Object.entries(row)
          .map(([col, value]) => `${col}=${value === null ? 'NULL' : value}`)
          .join(' | '),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Contract reasons the bulk service's classified failures map onto. */
type MappedReason =
  | 'async_queued'
  | 'filter_arity'
  | 'invalid_dimension'
  | 'not_found'
  | 'upstream_fault';

/**
 * Translate a service-layer failure into the tool's declared contract.
 *
 * The bulk service classifies SDMX faults into `data.reason` but throws generic
 * factory errors, because a service has no access to a tool's reason union.
 * This resolves the reason and the caller-facing recovery hint; the handler does
 * the throwing, so `ctx.fail` stays typed against the union rather than taking a
 * bare string.
 */
export function mapBulkFailure(
  err: unknown,
  datasetCode: string,
): { hint: string; message: string; reason: MappedReason } | undefined {
  const reason = (err as McpError).data?.reason;
  const message = (err as Error).message;
  switch (reason) {
    case 'not_found':
      return {
        reason,
        message,
        hint: `Dataset "${datasetCode}" is not available for dissemination. Use eurostat_search_datasets or eurostat_browse_themes to find a valid code.`,
      };
    case 'invalid_dimension':
      return {
        reason,
        message,
        hint: `Check the dimension codes for "${datasetCode}" with eurostat_get_dataset_info and their values with eurostat_get_dimension_values, and keep since_period/until_period inside the dataset's coverage.`,
      };
    case 'filter_arity':
      return {
        reason,
        message,
        hint: `Eurostat expected a different number of filter positions for "${datasetCode}" than its metadata reports. Re-read the dimensions with eurostat_get_dataset_info, or retry without filters.`,
      };
    case 'async_queued':
      return {
        reason,
        message,
        hint: `Eurostat queued this extraction rather than serving it. Add dimension filters or a since_period/until_period range to make the request cheap enough for "${datasetCode}" to stream inline.`,
      };
    case 'upstream_fault':
      return {
        reason,
        message,
        hint: `The SDMX endpoint did not return a TSV table for "${datasetCode}". Retry in a few minutes, or narrow the request with dimension filters.`,
      };
    default:
      return;
  }
}
