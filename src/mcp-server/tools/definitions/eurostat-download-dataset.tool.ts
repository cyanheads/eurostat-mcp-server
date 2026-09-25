/**
 * @fileoverview Tool for downloading a whole Eurostat dataset through the SDMX
 * 2.1 TSV bulk endpoint and staging it on the dataframe canvas.
 * @module mcp-server/tools/definitions/eurostat-download-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { dimensionsToNarrow, narrowingAdvice } from '@/mcp-server/tools/narrowing-advice.js';
import { acquireCanvas, getCanvas, newTableName } from '@/services/canvas-accessor.js';
import {
  bulkRowSchema,
  getEurostatBulkService,
} from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import type { BulkRow } from '@/services/eurostat-bulk/types.js';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import { PERIOD_FORMS, resolvePeriods } from '@/services/eurostat-periods.js';

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

/** Put back a row already pulled off `rest`, so the canvas receives the stream whole. */
async function* prepend(first: BulkRow, rest: AsyncGenerator<BulkRow>): AsyncGenerator<BulkRow> {
  yield first;
  yield* rest;
}

export const eurostatDownloadDataset = tool('eurostat_download_dataset', {
  title: 'Download Eurostat Dataset',
  description:
    'Download a Eurostat dataset in bulk through the SDMX 2.1 TSV endpoint and stage every observation as a SQL table on the dataframe canvas — the route to a whole dataset, where eurostat_query_dataset is the route to a slice of one. The TSV wire format is roughly half the bytes of the JSON-stat body eurostat_query_dataset reads, so it reaches datasets that would otherwise time out, and it is expanded here into one row per observation. Filters take the same dimension-code map eurostat_query_dataset uses and are applied server-side by Eurostat; call eurostat_get_dataset_info first for the dimension codes and eurostat_get_dimension_values for their values. Narrow with since_period/until_period rather than asking for the most recent N periods — the TSV layout keeps a column for every period whichever is requested, so a period range is what actually shrinks the response. Transfers are bounded by a byte budget enforced while streaming: when it is spent the download stops and budgetExceeded is set, leaving a prefix of the dataset rather than an error. Only preview_limit rows come back inline. When a table is staged, call eurostat_dataframe_describe first to confirm its columns, then eurostat_dataframe_query; without a canvas, rows past the preview are not retained.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    dataset_code: z
      .string()
      .min(1)
      .describe(
        'Dataset code (e.g., "nama_10_gdp"). Required. A DS-* code — Comext detailed trade or PRODCOM, in any case — is served by the Comext host, which refuses an unfiltered download of its large collections as extraction_too_big: filter it, including freq on the trade flows, which mix annual and monthly series.',
      ),
    filters: z
      .record(z.string(), z.array(z.string()))
      .default({})
      .describe(
        'Dimension filters as a map of dimension code → array of accepted values, applied by Eurostat before the body is sent. Example: {"unit": ["CP_MEUR"], "na_item": ["B1G"], "geo": ["DE", "FR"]}. Omit a dimension or pass an empty array to accept every value for it. Dimension codes match in any case ("GEO" is geo). Do not put "time" here — use since_period/until_period. Naming a dimension the dataset does not have is rejected with the dataset\'s dimension list rather than silently ignored.',
      ),
    since_period: z
      .string()
      .optional()
      .describe(
        `Start of the period range, inclusive, sent as startPeriod. Accepted forms: ${PERIOD_FORMS} (e.g., "2020", "2023-Q1", "2024-01"). Extra leading zeros after the letter are dropped ("2020-W001" is sent as "2020-W01"), a day of the year is sent as three digits ("2026-D1" as "2026-D001"), YYYY-A1 is sent as YYYY, and a period of another frequency is mapped onto the dataset's own. A malformed or non-existent period (e.g., "2020-13") is rejected as invalid_period. The most effective way to shrink a bulk response: it removes period columns from the TSV rather than blanking their cells.`,
      ),
    until_period: z
      .string()
      .optional()
      .describe(
        'End of the period range, inclusive (e.g., "2024"), sent as endPeriod, in the same forms as since_period. Omit for data through the latest available period. The range must hold at least one day: a since_period that starts after until_period ends is rejected as invalid_period, while pairs of different frequencies are fine ("2020-06" to "2020").',
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
    canvas_id: CanvasIdSchema.optional().describe(
      'Reuse an existing dataframe canvas so this download lands beside earlier results and can be joined against them. Pass the canvasId a previous eurostat_download_dataset or eurostat_query_dataset response returned; omit to start a fresh canvas. Ignored on deployments without a dataframe canvas. A download that carries no observations fails as no_results and leaves the canvas untouched.',
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
            'One observation as a flat row: one column per dimension holding its code, "time" for the period, then obs_value, obs_flag, obs_flag_label, conf_status, conf_status_label. A label column is null when Eurostat publishes no label for that code. Rows of a DS-* dataset also carry obs_value_text after obs_value: a value Eurostat published as text, such as a PRODCOM quantity unit ("KG"), kept verbatim with obs_value null; a PRODCOM ":C" arrives as conf_status "C" instead.',
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
    totalCount: z
      .number()
      .describe(
        'Observations the download produced — equal to rowCount. The inline observations array holds only the first preview_limit of them; budgetExceeded, not this count, says whether the download is the whole dataset.',
      ),
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
        'Guidance on every download: the staged table with the required eurostat_dataframe_describe then eurostat_dataframe_query sequence (or, without a canvas, what was returned inline and what was discarded), preceded by byte-budget disclosure when the budget stopped the transfer and by the inline-preview length when preview_limit returns fewer rows than were downloaded.',
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
      thrownBy: 'service',
    },
    {
      reason: 'invalid_dimension',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter names a dimension the dataset does not have, or a value or period range Eurostat rejects (SDMX faultcode 150).',
      recovery:
        'Check dimension codes with eurostat_get_dataset_info and their values with eurostat_get_dimension_values, and keep the period range inside the dataset coverage.',
      thrownBy: 'service',
    },
    {
      reason: 'filter_arity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Eurostat rejected the positional dimension key because it carried the wrong number of positions (SDMX faultcode 140, INVALID_QUERY_NB_FILTERS), meaning the dataset structure has changed since the metadata call.',
      recovery:
        'Retry without filters to download the whole dataset, or re-read the dimensions with eurostat_get_dataset_info.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_period',
      code: JsonRpcErrorCode.ValidationError,
      when: 'since_period or until_period is not a period literal, or names a month, quarter, semester, trimester, week or day that does not exist, or since_period starts after until_period ends. Checked before any request — the bulk endpoint would otherwise roll an out-of-range period into a neighbouring one, and answer an inverted range with the whole series — and SDMX faultcode 140 TIME_PERIOD_FILTER_SPEC_INVALID maps here too.',
      recovery: `Write since_period/until_period as ${PERIOD_FORMS}, for example "2020", "2020-01" or "2020-Q1", with since_period starting no later than until_period ends.`,
    },
    {
      reason: 'async_queued',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Eurostat answered HTTP 200 with a SOAP syncResponse queue ticket (status SUBMITTED) instead of data, because the extraction was too costly to serve synchronously.',
      retryable: false,
      recovery:
        'Add dimension filters or a period range so Eurostat serves the extraction inline; the queued result cannot be collected here.',
      thrownBy: 'service',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The download completed but carried no populated observation cells. Nothing is staged, and no canvas is created or touched.',
      recovery:
        "Verify the filter values with eurostat_get_dimension_values and keep since_period/until_period inside the series' coverage — a combination that exists in no cell and a range that misses the series both download as an empty table.",
    },
    {
      reason: 'extraction_too_big',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Eurostat refused the extraction as too large (SDMX faultcode 413, HTTP 413): past its 5,000,000-row extraction limit, or an unfiltered download of a large DS-* Comext collection, which Eurostat serves only filtered. Covers every dataset, on either host.',
      retryable: false,
      recovery:
        'Add dimension filters or a narrower since_period/until_period range to shrink the extraction; the same request fails the same way on every retry.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_fault',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The SDMX endpoint returned a fault this server does not model, or a body that is not a TSV table.',
      recovery: 'Retry in a few minutes, or narrow the request with dimension filters.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A canvas_id was supplied for staging but is unknown or its lifetime has elapsed.',
      recovery: 'Omit canvas_id so the download starts a fresh canvas and returns its canvasId.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const bulk = getEurostatBulkService();
    // Trimmed, checked, and rewritten to canonical form: this is both what is sent and
    // what appliedQuery echoes.
    const periods = resolvePeriods({
      since_period: input.since_period?.trim() || undefined,
      until_period: input.until_period?.trim() || undefined,
    });
    if (!periods.ok) {
      throw ctx.fail('invalid_period', periods.message, ctx.recoveryFor('invalid_period'));
    }
    const { since_period: sinceP, until_period: untilP } = periods;
    const filters = Object.fromEntries(
      Object.entries(input.filters).filter(([, values]) => values.length > 0),
    );

    /**
     * The positional key needs every dimension in order, not just the filtered
     * ones, so a filtered download first reads the dataset's structure
     * definition, a few KB whatever the dataset's size. An unfiltered download
     * needs no key and skips it — the TSV header names the dimensions anyway.
     */
    let dimensionOrder: string[] = [];

    /**
     * `ctx.fail` is typed against this tool's reason union, so the mapping stays
     * here rather than inside a helper that would have to take a bare string.
     */
    const asContract = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (err) {
        const mapped = mapBulkFailure(err, input.dataset_code, {
          dimensions:
            (err as McpError).data?.reason === 'extraction_too_big'
              ? await dimensionsToNarrow(input.dataset_code, dimensionOrder, ctx)
              : undefined,
          filtered: Object.keys(filters),
        });
        if (!mapped) throw err;
        throw ctx.fail(mapped.reason, mapped.message, { recovery: { hint: mapped.hint } });
      }
    };

    if (Object.keys(filters).length > 0) {
      dimensionOrder = await asContract(() =>
        getEurostatDataService().getDimensionOrder(input.dataset_code, ctx),
      );
    }

    const download = await asContract(() =>
      bulk.startDownload(input.dataset_code, dimensionOrder, filters, sinceP, untilP, ctx),
    );

    const preview: BulkRow[] = [];
    const rows = teePreview(download.rows(), preview, input.preview_limit);

    let staged: { canvasId: string; stagedRowCount: number; tableName: string } | undefined;
    /**
     * Every exit closes the row stream, which cancels the response body. A
     * canvas that cannot be acquired, or a staging call that fails before it
     * pulls a row, would otherwise leave the body undrained and its connection
     * held. Closing a stream that already ended is a no-op.
     */
    try {
      /**
       * Nothing touches a canvas until the stream has yielded a row. An empty
       * download would otherwise mint a canvas the error never names, or add a
       * 0-row table to the caller's, before failing — so it fails here instead,
       * exactly as it does on a deployment without a canvas.
       */
      const first = await rows.next();
      if (first.done) {
        const range = [
          ...(sinceP ? [`since_period "${sinceP}"`] : []),
          ...(untilP ? [`until_period "${untilP}"`] : []),
        ].join(' and ');
        throw ctx.fail(
          'no_results',
          `The download of "${input.dataset_code}" carried no observations.`,
          {
            recovery: {
              hint: `Eurostat returned a table with no populated cells for "${input.dataset_code}". Verify the filter values with eurostat_get_dimension_values — a combination present in no cell downloads as an empty body.${
                range
                  ? ` Also check that ${range} overlaps the series: a range outside the series' own coverage downloads as an empty table too.`
                  : ''
              }`,
            },
          },
        );
      }

      const canvas = getCanvas();
      if (canvas) {
        const instance = await acquireCanvas(canvas, input.canvas_id, ctx);
        const handle = await instance.registerTable(newTableName(), prepend(first.value, rows), {
          schema: bulkRowSchema(download.header.dimensions, download.valueText),
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
        for await (const _row of rows) {
          // Drained for its counters; nothing is retained past the preview.
        }
      }
    } finally {
      await rows.return(undefined);
    }

    const { stats } = download;
    const firstPeriod = stats.periodsSeen[0];
    const lastPeriod = stats.periodsSeen.at(-1);

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
    /**
     * A preview shorter than the download is disclosed as a notice and a total, not
     * as `truncated`: the download itself is complete, and `budgetExceeded` is what
     * says when it is not. `notice` is last-wins, so every sentence is collected and
     * written once.
     */
    ctx.enrich.total(stats.rowCount);
    const notices: string[] = [];
    if (stats.budgetExceeded) {
      notices.push(
        `The byte budget stopped this transfer after ${stats.bytesRead.toLocaleString()} bytes, so these ${stats.rowCount.toLocaleString()} observations are the start of "${input.dataset_code}" and not all of it. Add dimension filters or a since_period/until_period range to fit the dataset inside the budget, or raise EUROSTAT_BULK_MAX_BYTES.`,
      );
    }
    if (stats.rowCount > preview.length) {
      notices.push(
        `preview_limit=${input.preview_limit.toLocaleString()} returns the first ${preview.length.toLocaleString()} of ${stats.rowCount.toLocaleString()} downloaded observations inline; it does not reduce the download.`,
      );
    }
    if (!staged) {
      /**
       * A narrower query is advice only for a download larger than preview_limit can
       * ever return; below that, the rows either all came back or are one larger
       * preview_limit away.
       */
      const discarded = stats.rowCount - preview.length;
      notices.push(
        discarded === 0
          ? `This deployment runs without a dataframe canvas, so nothing was staged; all ${stats.rowCount.toLocaleString()} downloaded observations are returned inline.`
          : `This deployment runs without a dataframe canvas, so nothing was staged: only the ${preview.length.toLocaleString()} observations returned inline are retained, and the other ${discarded.toLocaleString()} were counted and discarded. ${
              stats.rowCount <= PREVIEW_MAX
                ? `Raise preview_limit to ${stats.rowCount.toLocaleString()} to return every one inline, or set CANVAS_PROVIDER_TYPE=duckdb to keep the download.`
                : 'Set CANVAS_PROVIDER_TYPE=duckdb to keep the download, or use eurostat_query_dataset with dimension filters to fetch a slice small enough to return whole.'
            }`,
      );
    } else {
      notices.push(
        `All ${staged.stagedRowCount.toLocaleString()} downloaded observations are staged as table "${staged.tableName}" on canvas "${staged.canvasId}". Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query.`,
      );
    }
    ctx.enrich.notice(notices.join(' '));

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
  | 'extraction_too_big'
  | 'filter_arity'
  | 'invalid_dimension'
  | 'invalid_period'
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
 *
 * `request.dimensions` is the dataset's dimension list, when known, and
 * `request.filtered` the dimensions the request already filtered — together they let
 * a too-large refusal name the dimensions still open to filter.
 */
function mapBulkFailure(
  err: unknown,
  datasetCode: string,
  request: { dimensions: string[] | undefined; filtered: string[] },
): { hint: string; message: string; reason: MappedReason } | undefined {
  const reason = (err as McpError).data?.reason;
  const message = (err as Error).message;
  switch (reason) {
    case 'extraction_too_big':
      return {
        reason,
        message,
        hint: `Eurostat will not serve this extraction of "${datasetCode}" whole, and retrying repeats the refusal. ${narrowingAdvice(datasetCode, request.dimensions, request.filtered)}`,
      };
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
    case 'invalid_period':
      return {
        reason,
        message,
        hint: `Eurostat could not read the period range for "${datasetCode}". Write since_period/until_period as ${PERIOD_FORMS}, for example "2020", "2020-01" or "2020-Q1".`,
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
