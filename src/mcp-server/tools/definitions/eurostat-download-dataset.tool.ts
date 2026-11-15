/**
 * @fileoverview Tool for downloading a whole Eurostat dataset through the SDMX
 * 2.1 TSV bulk endpoint and staging it on the dataframe canvas.
 * @module mcp-server/tools/definitions/eurostat-download-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { clampReadLimit } from '@/mcp-server/tools/clamp-read-limit.js';
import { hoistDimensions } from '@/mcp-server/tools/hoist-dimensions.js';
import {
  dimensionsToNarrow,
  dottedValueAdvice,
  formatValues,
  narrowingAdvice,
  RENAME_FILTER_KEYS_HINT,
  UNKNOWN_FILTER_KEY_WHEN,
} from '@/mcp-server/tools/narrowing-advice.js';
import { countOf, listEmptyValues, spanOf } from '@/mcp-server/tools/notice-text.js';
import {
  acquireCanvas,
  getCanvas,
  isCanvasFailure,
  newTableName,
} from '@/services/canvas-accessor.js';
import {
  bulkRowSchema,
  getEurostatBulkService,
  remainingBudgetMs,
} from '@/services/eurostat-bulk/eurostat-bulk-service.js';
import { type BulkRow, TIME_COLUMN } from '@/services/eurostat-bulk/types.js';
import {
  getEurostatDataService,
  TIME_DIMENSION_KEYS,
} from '@/services/eurostat-data/eurostat-data-service.js';
import type { OutsideSpan } from '@/services/eurostat-data/types.js';
import { normalizeFilters } from '@/services/eurostat-filters.js';
import { isComextDataset } from '@/services/eurostat-hosts.js';
import { outageAnswer } from '@/services/eurostat-outage.js';
import {
  cutNotice,
  frequenciesOf,
  PERIOD_FORMS,
  periodCuts,
  periodSpan,
  resolvePeriods,
} from '@/services/eurostat-periods.js';

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

/** Selects the advertised limit policy before registration. */
export const createEurostatDownloadDataset = (clampLimits: boolean) =>
  tool('eurostat_download_dataset', {
    title: 'Download Eurostat Dataset',
    description:
      'Download a Eurostat dataset through the SDMX bulk TSV endpoint and stage it as a SQL table on the dataframe canvas — the route to a whole dataset, where eurostat_query_dataset is the route to a slice. It is expanded into one row per non-blank TSV cell; absentCellCount says which rows are not observations. Filter keys come from eurostat_get_dataset_info and values from eurostat_get_dimension_values. Two budgets bound every transfer: a decoded-byte budget (50 MiB by default) and a time budget counted from the start of the call (55 seconds by default, inside the 60 seconds an MCP client waits), so a download that reaches the time budget returns after about 55 seconds. Reached after rows have streamed, either budget keeps them as a prefix with budgetExceeded set; reached before the first row, the call fails. Only preview_limit rows come back inline; without a canvas the rest are not kept.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    input: z.object({
      dataset_code: z
        .string()
        .min(1)
        .describe(
          'Dataset code (e.g., "nama_10_gdp"). Filter a DS-* code (Comext trade or PRODCOM, in any case): an unfiltered download of a large collection is refused as extraction_too_big, and its trade flows mix annual and monthly series, so filter freq.',
        ),
      filters: z
        .record(z.string(), z.array(z.string()))
        .default({})
        .describe(
          'Map of dimension code → values to keep, e.g. {"unit": ["CP_MEUR"], "geo": ["DE", "FR"]}. Keys match in any case; a key the dataset lacks, "time" included (use since_period/until_period), is rejected with its dimension list. An empty array or a blank value is no filter. A value holding "+" is split into separate values (OR). A value holding "." is rejected as invalid_dimension before any request: no Eurostat code contains one. A value Eurostat does not know fails the download as invalid_dimension; a valid one with no observation in the selected periods is named in emptyValues.',
        ),
      since_period: z
        .string()
        .optional()
        .describe(
          `Start of the range, inclusive: ${PERIOD_FORMS}, e.g. "2020", "2023-Q1", "2024-01". A range is the most effective way to shrink a download. Any form works on any dataset, but Eurostat keeps only periods wholly inside the range, per frequency: a bound that falls inside a period excludes it, and a notice names that period when the TSV header shows its frequency. A one-day range (both bounds on the same day) selects that day alone. A malformed or non-existent period, or a since_period after until_period, fails as invalid_period.`,
        ),
      until_period: z
        .string()
        .optional()
        .describe(
          'End of the range, inclusive (e.g., "2024"), in the forms and under the wholly-inside rule of since_period. Omit for data through the latest period.',
        ),
      preview_limit: (clampLimits
        ? z.number().multipleOf(1).min(1)
        : z.number().int().min(1).max(PREVIEW_MAX)
      )
        .default(25)
        .describe(
          `Rows echoed inline, from the start of the download. Default 25; ${clampLimits ? 'positive integers above 500 are clamped to 500 with a notice' : 'maximum 500; larger values are rejected'}. The staged table, when there is one, holds every row.`,
        ),
      canvas_id: CanvasIdSchema.optional().describe(
        'A canvasId from an earlier staging response, to stage this download beside its tables for joins; omit for a fresh canvas.',
      ),
    }),
    output: z.object({
      datasetCode: z.string().describe('Dataset code as provided.'),
      dimensionsUsed: z
        .array(z.string())
        .describe(
          'Dimension codes of the downloaded rows, in key order, from the TSV header; the period is the "time" column.',
        ),
      rowCount: z
        .number()
        .describe(
          'Rows downloaded, one per non-blank TSV cell, unflagged ":" rows included (see absentCellCount).',
        ),
      missingCount: z
        .number()
        .describe(
          'Rows with obs_value null: observations published without a number (a flagged ":" or a text value), and every unflagged ":" row (see absentCellCount).',
        ),
      absentCellCount: z
        .number()
        .describe(
          'An unflagged ":" row (obs_value null with no flag, status or text) is not an observation: it is a period its series lacks, or a period of a frequency the series has no observation of. This counts the first kind: rows at a period of a frequency the same series carries in another downloaded row, inside that frequency\'s span from its first to its latest period any downloaded row has an observation in. Rows before or after the span are named in the notice instead, and rows at a frequency the series has no observation of (mixed-frequency padding, or a series that is ":" throughout) are left out. A flagged ":" or a text value is an observation. Part of rowCount and missingCount; a budget-cut download counts over its prefix.',
        ),
      emptyValues: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          'Valid filter values with no observation in the download, by filter key, as sent; such a value can have data in other periods or beside other filter values. Omitted when every filter value has an observation, and when budgetExceeded is true, since the rows not downloaded could hold any of them.',
        ),
      periodRange: z
        .object({
          start: z
            .string()
            .optional()
            .describe(
              'Earliest period of a row carrying an observation; an unflagged ":" row sets no bound. Omitted, with the other bound, when no row carries an observation.',
            ),
          end: z
            .string()
            .optional()
            .describe(
              'Latest period of a row carrying an observation. Omitted, with the other bound, when no row carries an observation.',
            ),
        })
        .describe(
          'Period coverage of the downloaded observations; narrower than the dataset when budgetExceeded is true or a range was set.',
        ),
      bytesRead: z
        .number()
        .describe(
          'Decoded TSV bytes read, never more than the byte budget (50 MiB by default). With budgetExceeded true, a value equal to the byte budget means that budget ended the transfer; a smaller one, that the time budget did.',
        ),
      compressed: z.boolean().describe('True when the body arrived gzip-compressed.'),
      budgetExceeded: z
        .boolean()
        .describe(
          'True when the byte budget or the time budget counted from the start of the call ended the transfer early: the rows are a prefix, and the notice names which budget. Where a time cut lands depends on how fast the body arrived, so a repeat can stop at a different row.',
        ),
      observations: z
        .array(
          z
            .record(z.string(), z.union([z.string(), z.number(), z.null()]))
            .describe(
              'One downloaded row: one column per dimension with its code, "time", then obs_value, obs_flag, obs_flag_label, conf_status, conf_status_label (a label is null when Eurostat publishes none). DS-* rows add obs_value_text: a value published as text, such as a PRODCOM unit ("KG"), with obs_value null; PRODCOM\'s ":C" arrives as conf_status "C".',
            ),
        )
        .describe(
          'The first preview_limit rows of the download, in the order Eurostat streamed them. A prefix of the staged table, not a sample.',
        ),
      canvasId: z
        .string()
        .optional()
        .describe(
          'Canvas holding the staged table; pass it as canvas_id to the dataframe tools or a later staging call. Omitted when nothing was staged.',
        ),
      tableName: z
        .string()
        .optional()
        .describe(
          'Canvas table holding every downloaded row. Call eurostat_dataframe_describe with canvasId for its columns first, then eurostat_dataframe_query. Omitted without a dataframe canvas, when only the inline rows survive the call.',
        ),
      stagedRowCount: z
        .number()
        .optional()
        .describe('Rows staged; equals rowCount. Omitted with tableName.'),
    }),
    enrichment: {
      totalCount: z
        .number()
        .describe(
          'Rows downloaded, equal to rowCount (see absentCellCount). observations holds only the first preview_limit; budgetExceeded, not this count, says whether the download is whole.',
        ),
      appliedQuery: z
        .object({
          filters: z
            .record(z.string(), z.array(z.string()))
            .describe(
              'Filters sent to Eurostat: "+" values split, blank values and empty dimensions dropped.',
            ),
          sincePeriod: z.string().optional().describe('since_period applied, if any.'),
          untilPeriod: z.string().optional().describe('until_period applied, if any.'),
          url: z
            .string()
            .describe(
              'The SDMX request URL, to reproduce the download. A one-day range asks for that day and the next, so the URL ends a day past untilPeriod.',
            ),
        })
        .describe('The bulk request as the server built it.'),
      notice: z
        .string()
        .optional()
        .describe(
          'Disclosures on every download: the staged table with the eurostat_dataframe_describe then eurostat_dataframe_query sequence, or without a canvas what was kept inline. Before it, when they apply: a period a bound excludes, the budget that stopped the transfer, the unflagged ":" rows (see absentCellCount) before or after a frequency\'s span, inside it and from mixed frequencies, emptyValues (up to 24 named), and the inline-preview length.',
        ),
    },

    enrichmentTrailer: {
      appliedQuery: {
        render: (q) => {
          const parts: string[] = [];
          parts.push(
            Object.keys(q.filters).length > 0
              ? `- **Filters:** ${formatValues(q.filters, escapeMarkdownInline)}`
              : '- **Filters:** none (whole dataset)',
          );
          if (q.sincePeriod || q.untilPeriod) {
            parts.push(`- **Period:** ${q.sincePeriod ?? '…'} – ${q.untilPeriod ?? 'latest'}`);
          }
          parts.push(`- **URL:** ${escapeMarkdownInline(q.url)}`);
          return `**Bulk Request:**\n${parts.join('\n')}`;
        },
      },
    },

    errors: [
      {
        reason: 'byte_budget_exceeded',
        code: JsonRpcErrorCode.ValidationError,
        when: 'The byte budget ran out before a complete header and first row were read.',
        recovery:
          'Add dimension filters or narrow since_period/until_period so the first rows arrive within the byte budget.',
        thrownBy: 'service',
      },
      {
        reason: 'not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'The dataset code is not available for dissemination.',
        recovery:
          'Use eurostat_search_datasets or eurostat_browse_themes to find a valid dataset code.',
        thrownBy: 'service',
      },
      {
        reason: 'invalid_dimension',
        code: JsonRpcErrorCode.ValidationError,
        when: `${UNKNOWN_FILTER_KEY_WHEN}; a filter value contains "." (rejected before any request); Eurostat rejects a filter value; or the period range selects no period of the dataset, missing its coverage or holding no whole period.`,
        recovery:
          'Check dimension codes with eurostat_get_dataset_info and their values with eurostat_get_dimension_values, and keep the period range inside the dataset coverage, holding a whole period.',
      },
      {
        reason: 'filter_arity',
        code: JsonRpcErrorCode.ValidationError,
        when: "Eurostat rejected the filter key's number of positions: the dataset's structure changed since it was read.",
        recovery:
          'Re-read the dimensions with eurostat_get_dataset_info and rebuild the filters on them, or retry without filters to download the whole dataset, except a DS-* Comext collection, which Eurostat serves only filtered.',
        thrownBy: 'service',
      },
      {
        reason: 'invalid_period',
        code: JsonRpcErrorCode.ValidationError,
        when: 'A period bound is not an accepted form or names a period that does not exist, or since_period starts after until_period ends (bounds of different frequencies compare by day). Checked before any request.',
        recovery: `Write since_period/until_period as ${PERIOD_FORMS}, for example "2020", "2020-01" or "2020-Q1", with since_period starting no later than until_period ends.`,
      },
      {
        reason: 'async_queued',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'Eurostat queued the extraction instead of sending data: it prepares it in the background and serves the identical download minutes later. The server sends the request once and does not repeat it.',
        retryable: true,
        recovery:
          'Repeat the identical call in a few minutes, once Eurostat has prepared the extraction, or filter on the dimensions this download left unfiltered or narrow since_period/until_period.',
        thrownBy: 'service',
      },
      {
        reason: 'no_results',
        code: JsonRpcErrorCode.NotFound,
        when: 'The download yielded no row: a header-only table, or a one-day range whose only cells fall on the next day (see appliedQuery.url). Nothing is staged, and no canvas is created or touched.',
        recovery:
          "Verify the filter values with eurostat_get_dimension_values and keep since_period/until_period inside the series' coverage, holding a whole period — a combination that exists in no cell and a range that misses the series both download as an empty table.",
      },
      {
        reason: 'extraction_too_big',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'Eurostat refused the extraction as too large: past its 5,000,000-row limit, or an unfiltered download of a large DS-* collection, which it serves only filtered.',
        retryable: false,
        recovery:
          'Add dimension filters or a narrower since_period/until_period range to shrink the extraction; the same request fails the same way on every retry.',
        thrownBy: 'service',
      },
      {
        reason: 'upstream_fault',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: "Eurostat's data endpoint, or a filtered download's structure endpoint, failed or was unreachable on every attempt, broke the body off, or sent an unmodeled fault, a non-TSV body or an unusable structure; retryable says whether a later call can succeed.",
        recovery: 'Retry in a few minutes, or narrow the request with dimension filters.',
        thrownBy: 'service',
      },
      {
        reason: 'retry_deadline_exceeded',
        code: JsonRpcErrorCode.Timeout,
        when: "The call's time budget (55 seconds by default, counted from the start of the call, every attempt and a filtered download's structure read included) ran out before the first row arrived; reached later, it keeps the rows as a prefix with budgetExceeded instead. Or a filtered download's structure read did not answer within its deadline.",
        recovery:
          'Add dimension filters or a narrower since_period/until_period range to shrink the transfer, retry a structure read that timed out in a few minutes, or read a slice small enough to return with eurostat_query_dataset.',
        thrownBy: 'service',
      },
      {
        reason: 'canvas_not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'canvas_id is unknown or has expired.',
        recovery: 'Omit canvas_id so the download starts a fresh canvas and returns its canvasId.',
      },
    ],

    async handler(request, ctx) {
      // The call's time budget counts from here, so a filtered download's structure read spends it too.
      const startedAt = Date.now();
      const previewLimit = clampReadLimit(
        request.preview_limit,
        PREVIEW_MAX,
        'preview_limit',
        'eurostat_download_dataset',
        ctx,
      );
      const input = { ...request, preview_limit: previewLimit.value };
      const bulk = getEurostatBulkService();
      // Trimmed, checked, and rewritten to canonical form: this is both what is sent and
      // what appliedQuery echoes. The period notice quotes the literals as written.
      const written = {
        since_period: input.since_period?.trim() || undefined,
        until_period: input.until_period?.trim() || undefined,
      };
      const periods = resolvePeriods(written);
      if (!periods.ok) {
        throw ctx.fail('invalid_period', periods.message);
      }
      const { since_period: sinceP, until_period: untilP } = periods;
      const filters = normalizeFilters(input.filters);

      /**
       * No Eurostat code contains ".", and in the positional key a dotted value would add a
       * position, so one is refused here, before the structure read: nothing is sent. Every
       * dotted value is named at once, each with its own advice.
       */
      const dotted = Object.entries(filters).flatMap(([key, values]) =>
        values.filter((value) => value.includes('.')).map((value) => ({ key, value })),
      );
      const [firstDotted, ...otherDotted] = dotted;
      if (firstDotted) {
        const advice = dottedValueAdvice(input.dataset_code, [
          { dimension: firstDotted.key, value: firstDotted.value },
          ...otherDotted.map(({ key, value }) => ({ dimension: key, value })),
        ]);
        throw ctx.fail(
          'invalid_dimension',
          `${dotted.length === 1 ? 'A filter value contains' : `${dotted.length} filter values contain`} ".", so nothing was sent to Eurostat: ${dotted.map(({ key, value }) => `"${value}" in filters.${key}`).join(', ')}.`,
          { recovery: { hint: advice.hint } },
          { literals: [...new Set(advice.literals)] },
        );
      }

      /**
       * The positional key needs every dimension in order, not just the filtered
       * ones, so a filtered download first reads the dataset's dimension order from
       * its structure definition, a few KB whatever the dataset's size. The data
       * service caches the order for an hour beside the dataset's metadata, so a
       * repeat within the hour sends no structure request. An unfiltered download
       * needs no key and skips it — the TSV header names the dimensions anyway.
       */
      let dimensionOrder: string[] = [];

      /**
       * A service failure as the declared contract has it, or the failure unchanged when no
       * reason maps. `ctx.fail` is typed against this tool's reason union, so the mapping
       * stays here rather than inside a helper that would have to take a bare string.
       */
      const contractFailure = async (endpoint: OutageEndpoint, err: unknown): Promise<unknown> => {
        const { reason, periodRange } = (err as McpError).data ?? {};
        const mapped = mapBulkFailure(err, input.dataset_code, {
          dimensions:
            reason === 'extraction_too_big' || reason === 'async_queued'
              ? await dimensionsToNarrow(input.dataset_code, dimensionOrder, ctx)
              : undefined,
          endpoint,
          filters,
          periodSet: sinceP !== undefined || untilP !== undefined,
        });
        if (!mapped) return err;
        /**
         * A key the cached dimension order built can go stale with a structure change since
         * the read: a wrong number of positions (`filter_arity`), a filter key the order
         * lacks, or a value Eurostat rejects at the position the order put it. Dropped, the
         * next filtered download reads the structure again instead of failing until the
         * entry expires. A rejected period range says nothing about the order and keeps it.
         */
        const staleOrder =
          mapped.reason === 'filter_arity' ||
          (mapped.reason === 'invalid_dimension' && periodRange !== true);
        if (staleOrder && dimensionOrder.length > 0) {
          getEurostatDataService().forgetDimensionOrder(input.dataset_code);
        }
        return ctx.fail(
          mapped.reason,
          mapped.message,
          {
            ...(mapped.retryable && { retryable: true }),
            ...mapped.data,
            recovery: { hint: mapped.hint },
          },
          mapped.literals && { literals: mapped.literals },
        );
      };
      const asContract = async <T>(endpoint: OutageEndpoint, run: () => Promise<T>): Promise<T> => {
        try {
          return await run();
        } catch (err) {
          throw await contractFailure(endpoint, err);
        }
      };

      if (Object.keys(filters).length > 0) {
        // The read keeps its own request deadline, cut to what is left of the call's budget.
        dimensionOrder = await asContract('structure', () =>
          getEurostatDataService().getDimensionOrder(
            input.dataset_code,
            ctx,
            Math.min(
              getServerConfig().requestTimeoutMs,
              remainingBudgetMs(input.dataset_code, startedAt),
            ),
          ),
        );
      }

      const download = await asContract('data', () =>
        bulk.startDownload(
          input.dataset_code,
          dimensionOrder,
          filters,
          sinceP,
          untilP,
          ctx,
          startedAt,
        ),
      );

      const preview: BulkRow[] = [];
      const rows = teePreview(download.rows(), preview, input.preview_limit);

      let staged: { canvasId: string; stagedRowCount: number; tableName: string } | undefined;
      /**
       * Every exit closes the row stream, which cancels the response body. A
       * canvas that cannot be acquired, or a staging call that fails before it
       * pulls a row, would otherwise leave the body undrained and its connection
       * held. Closing a stream that already ended is a no-op.
       *
       * The body streams while the rows are staged or drained, so a failure the
       * service raises there takes the data endpoint's contract mapping, as one
       * raised before the first row does.
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
          throw ctx.fail('no_results', `The download of "${input.dataset_code}" yielded no row.`, {
            recovery: {
              hint: `Eurostat returned a table with no populated cells for "${input.dataset_code}". Verify the filter values with eurostat_get_dimension_values — a combination present in no cell downloads as an empty body.${
                range
                  ? ` Also check that ${range} overlaps the series and holds a whole period of it: Eurostat keeps only periods wholly inside the range, so a range outside the series' own coverage or inside one period downloads as an empty table too.`
                  : ''
              }`,
            },
          });
        }

        const canvas = getCanvas();
        if (canvas) {
          // Re-thrown so the declared recovery replaces the canvas service's generic one.
          const instance = await acquireCanvas(canvas, input.canvas_id, ctx).catch(
            (err: unknown) => {
              if (isCanvasFailure(err, 'canvas_not_found')) {
                throw ctx.fail(
                  'canvas_not_found',
                  err.message,
                  { canvasId: input.canvas_id },
                  { cause: err },
                );
              }
              throw err;
            },
          );
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
           * preview — and the byte and time budgets still bound what is transferred. Stopping
           * at preview_limit instead would report a row count of 25 for a dataset of
           * millions.
           */
          for await (const _row of rows) {
            // Drained for its counters; nothing is retained past the preview.
          }
        }
      } catch (err) {
        throw await contractFailure('data', err);
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
      const notices: string[] = previewLimit.notice ? [previewLimit.notice] : [];
      // The header is the only frequency signal: it shows a frequency only when a period
      // of it is in range, so one it hides gets no notice. No coverage reaches the TSV.
      const frequencies = frequenciesOf(download.header.periods);
      if (sinceP || untilP) {
        const cuts = periodCuts({ since_period: sinceP, until_period: untilP }, frequencies);
        if (cuts.length > 0) notices.push(cutNotice(cuts, written));
      }
      if (stats.budgetExceeded === 'bytes') {
        notices.push(
          `The byte budget stopped this transfer after ${stats.bytesRead.toLocaleString('en-US')} bytes, so these ${stats.rowCount.toLocaleString('en-US')} rows are the start of "${escapeMarkdownInline(input.dataset_code)}" and not all of it. Add dimension filters or a since_period/until_period range to fit the dataset inside the budget.`,
        );
      } else if (stats.budgetExceeded === 'time') {
        const seconds = (getServerConfig().bulkTimeoutMs / 1000).toLocaleString('en-US');
        notices.push(
          `The ${seconds}-second time budget of this call ended the transfer after ${stats.bytesRead.toLocaleString('en-US')} bytes, so these ${stats.rowCount.toLocaleString('en-US')} rows are the start of "${escapeMarkdownInline(input.dataset_code)}" and not all of it. Where the budget cuts depends on how fast the body arrives, so a repeat call can stop at a different row. Add dimension filters or a since_period/until_period range so the dataset arrives within the budget.`,
        );
      }
      // With no observation at all every period lies outside a span, which the sentence below says.
      if (stats.outsideSpans?.rowCount && stats.periodsSeen.length > 0) {
        notices.push(outsideSpanNotice(stats.outsideSpans, stats.rowCount));
      }
      if (stats.absentCellCount > 0) {
        notices.push(
          `${stats.absentCellCount.toLocaleString('en-US')} of the ${stats.rowCount.toLocaleString('en-US')} downloaded rows (absentCellCount) ${
            stats.absentCellCount === 1
              ? 'is a period its series lacks, not an observation: an unflagged ":" cell'
              : 'are periods their series lacks, not observations: unflagged ":" cells'
          }, obs_value null with no flag, status or text.`,
        );
      }
      if (stats.periodsSeen.length === 0) {
        notices.push(
          `No downloaded row carries an observation: ${
            stats.rowCount === 1
              ? 'the row is an unflagged ":" cell'
              : `all ${stats.rowCount.toLocaleString('en-US')} rows are unflagged ":" cells`
          } (obs_value null with no flag, status or text), so periodRange has no bound.`,
        );
      }
      if (frequencies.size > 1) {
        notices.push(
          'Frequencies are mixed in this slice, and the TSV gives every series a column for each period of each frequency, so a series also holds unflagged ":" rows (obs_value null with no flag, status or text) at the periods of a frequency it does not carry: they are not observations, and absentCellCount leaves them out.',
        );
      }
      if (stats.emptyValues) notices.push(emptyValuesNotice(stats.emptyValues));
      if (stats.rowCount > preview.length) {
        notices.push(
          `preview_limit=${input.preview_limit.toLocaleString('en-US')} returns the first ${preview.length.toLocaleString('en-US')} of ${stats.rowCount.toLocaleString('en-US')} downloaded rows inline; it does not reduce the download.`,
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
            ? `This deployment runs without a dataframe canvas, so nothing was staged; all ${stats.rowCount.toLocaleString('en-US')} downloaded rows are returned inline.`
            : `This deployment runs without a dataframe canvas, so nothing was staged: only the ${preview.length.toLocaleString('en-US')} rows returned inline are retained, and the other ${discarded.toLocaleString('en-US')} were counted and discarded. ${
                stats.rowCount <= PREVIEW_MAX
                  ? `Raise preview_limit to ${stats.rowCount.toLocaleString('en-US')} to return every one inline.`
                  : 'Use eurostat_query_dataset with dimension filters to fetch a slice small enough to return whole.'
              }`,
        );
      } else {
        notices.push(
          `All ${staged.stagedRowCount.toLocaleString('en-US')} downloaded rows are staged as table \`${staged.tableName}\` on canvas \`${staged.canvasId}\`. Call eurostat_dataframe_describe with that canvas_id first to confirm the table and columns, then call eurostat_dataframe_query.`,
        );
      }
      ctx.enrich.notice(notices.join(' '));

      return {
        datasetCode: input.dataset_code,
        dimensionsUsed: download.header.dimensions,
        rowCount: stats.rowCount,
        missingCount: stats.missingCount,
        absentCellCount: stats.absentCellCount,
        ...(stats.emptyValues && { emptyValues: stats.emptyValues }),
        periodRange: {
          ...(firstPeriod && { start: firstPeriod }),
          ...(lastPeriod && { end: lastPeriod }),
        },
        bytesRead: stats.bytesRead,
        compressed: stats.compressed,
        budgetExceeded: stats.budgetExceeded !== false,
        observations: preview,
        ...staged,
      };
    },

    format: (result) => {
      const { start, end } = result.periodRange;
      const period = start && end ? `${start} – ${end}` : 'none — no row carries an observation';
      const lines: string[] = [
        `# Bulk download \`${result.datasetCode}\``,
        `**Rows:** ${result.rowCount} (${result.missingCount} missing) | **Absent cells:** ${result.absentCellCount} | **Period:** ${period}`,
        `**Dimensions:** ${result.dimensionsUsed.map(escapeMarkdownInline).join(', ')}`,
        `**Transfer:** ${result.bytesRead} bytes decoded | **Compressed:** ${result.compressed} | **Budget exceeded:** ${result.budgetExceeded}${
          result.budgetExceeded ? ' — these rows are the start of the dataset, not all of it' : ''
        }`,
      ];
      if (result.emptyValues) {
        lines.push(
          `**Values with no observation:** ${formatValues(result.emptyValues, escapeMarkdownInline)} — in the dataset but with no value, flag, status or text in this download`,
        );
      }
      lines.push(
        result.tableName
          ? `**Staged:** table \`${result.tableName}\` on canvas \`${result.canvasId}\` (stagedRowCount ${result.stagedRowCount}) — inspect it with eurostat_dataframe_describe first, then query it with eurostat_dataframe_query`
          : '**Staged:** nothing — this deployment runs without a dataframe canvas, so only the rows below are retained',
      );
      lines.push('', `## First ${result.observations.length} rows (\`observations\`)`);
      // dimensionsUsed leaves out the period column, which hoists like any other dimension.
      // The value and flag columns are not candidates, so they stay on every row.
      // Column names come from the TSV header and codes from its rows, so both are escaped.
      const cell = (col: string, value: string | number) =>
        `${escapeMarkdownInline(col)}=${escapeMarkdownInline(String(value))}`;
      const { header, hoisted } = hoistDimensions(
        result.observations,
        [...result.dimensionsUsed, TIME_COLUMN],
        (row, col) => {
          const value = row[col];
          return value == null ? undefined : cell(col, value);
        },
      );
      if (header) lines.push(header, '');
      for (const row of result.observations) {
        lines.push(
          Object.entries(row)
            .filter(([col]) => !hoisted.has(col))
            .map(([col, value]) => cell(col, value === null ? 'NULL' : value))
            .join(' | '),
        );
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  });

/** Default-on read-limit policy; startup selects the deployment policy explicitly. */
export const eurostatDownloadDataset = createEurostatDownloadDataset(true);

/** The filter values with no observation in the download. */
function emptyValuesNotice(values: Record<string, string[]>): string {
  const { list, total } = listEmptyValues(values);
  const one = total === 1;
  return `${countOf(total, 'value')} the download selects ${one ? 'exists' : 'exist'} in the dataset but ${one ? 'has' : 'have'} no observation in this download: ${list}. A value can still carry data in other periods or beside other filter values.`;
}

/**
 * Count and name the rows at each frequency's periods that no downloaded row has an
 * observation in, outside the span from its first to its latest period with one: the
 * unflagged ":" rows `absentCellCount` leaves out.
 */
function outsideSpanNotice(
  outside: { rowCount: number; spans: OutsideSpan[] },
  rowCount: number,
): string {
  let periods = 0;
  const clauses = outside.spans.flatMap((span) => {
    if (span.kind === 'empty') {
      periods += span.periods.length;
      return [
        `${spanOf(span.periods)}, the only ${span.periods.length === 1 ? 'period' : 'periods'} of its frequency in this download`,
      ];
    }
    periods += span.before.length + span.after.length;
    return [
      ...(span.before.length > 0
        ? [`${spanOf(span.before)}, before the first period with one (${span.first})`]
        : []),
      ...(span.after.length > 0
        ? [`${spanOf(span.after)}, after the latest period with one (${span.last})`]
        : []),
    ];
  });
  return `${outside.rowCount.toLocaleString('en-US')} of the ${rowCount.toLocaleString('en-US')} downloaded rows ${outside.rowCount === 1 ? 'is an unflagged ":" cell' : 'are unflagged ":" cells'} in ${periods === 1 ? 'a period' : 'periods'} no downloaded row has an observation in: ${clauses.join('; ')}. absentCellCount leaves them out: it counts only periods from a frequency's first to its latest period with an observation.`;
}

/** The two SDMX endpoints a download reads: the structure for a filter key, then the data. */
type OutageEndpoint = 'data' | 'structure';

/** Contract reasons the bulk service's classified failures map onto. */
type MappedReason =
  | 'async_queued'
  | 'extraction_too_big'
  | 'filter_arity'
  | 'invalid_dimension'
  | 'invalid_period'
  | 'not_found'
  | 'retry_deadline_exceeded'
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
 * `request.filters` the normalized filters the request sent — together they let a
 * refusal to serve name the dimensions still open to filter, and let an unknown time key
 * be answered with the period range its values span. `request.periodSet` says whether
 * since_period or until_period was set. `request.endpoint` is the endpoint the failed
 * read went to: each `upstream_fault` hint names it, and on the structure read a fault
 * with no HTTP status is a structure the order cannot be read from. `data` is the
 * failure's own detail the caller acts on, for the error data, and `literals` the values
 * the hint quotes for the caller to send back.
 */
function mapBulkFailure(
  err: unknown,
  datasetCode: string,
  request: {
    dimensions: string[] | undefined;
    endpoint: OutageEndpoint;
    filters: Record<string, string[]>;
    periodSet: boolean;
  },
):
  | {
      data?: Record<string, unknown>;
      hint: string;
      literals?: string[];
      message: string;
      reason: MappedReason;
      retryable?: true;
    }
  | undefined {
  const data = (err as McpError).data;
  const reason = data?.reason;
  const message = (err as Error).message;
  // A DS-* collection refuses an unfiltered download as too large, so no hint offers one there.
  const offerUnfiltered = !isComextDataset(datasetCode);
  const narrowing = () =>
    narrowingAdvice(datasetCode, request.dimensions, Object.keys(request.filters));
  switch (reason) {
    case 'extraction_too_big':
      return {
        reason,
        message,
        hint: `Eurostat will not serve this extraction of "${datasetCode}" whole, and retrying repeats the refusal. ${narrowing()}`,
      };
    case 'not_found':
      return {
        reason,
        message,
        hint: `Dataset "${datasetCode}" is not available for dissemination. Use eurostat_search_datasets or eurostat_browse_themes to find a valid code.`,
      };
    case 'invalid_dimension':
      // The key builder names every filter key the structure lacks, and the key order.
      if (Array.isArray(data?.unknownDimensions)) {
        const advice = unknownKeysAdvice(
          data.unknownDimensions,
          request.filters,
          request.periodSet,
        );
        return {
          reason,
          message,
          hint: advice.hint,
          ...(advice.literals.length > 0 && { literals: advice.literals }),
          data: {
            unknownDimensions: data.unknownDimensions,
            dimensionOrder: data.dimensionOrder,
          },
        };
      }
      return {
        reason,
        message,
        // The fault carries no frequency and no coverage, so this states the rule and names no bound.
        hint:
          data?.periodRange === true
            ? `Eurostat keeps only periods wholly inside the range, so a bound that falls inside a period excludes it, and a range outside the dataset's coverage selects nothing. List the periods "${datasetCode}" publishes with eurostat_get_dimension_values, dimension "time", then set since_period/until_period on them.`
            : `Check the dimension codes for "${datasetCode}" with eurostat_get_dataset_info and their values with eurostat_get_dimension_values, and keep since_period/until_period inside the dataset's coverage.`,
      };
    case 'filter_arity':
      return {
        reason,
        message,
        hint: `Eurostat expected a different number of filter positions for "${datasetCode}" than its metadata reports. Re-read the dimensions with eurostat_get_dataset_info${offerUnfiltered ? ', or retry without filters' : ''}.`,
      };
    case 'invalid_period':
      return {
        reason,
        message,
        hint: `Eurostat could not read the period range for "${datasetCode}". Write since_period/until_period as ${PERIOD_FORMS}, for example "2020", "2020-01" or "2020-Q1".`,
      };
    case 'async_queued':
      // A served repeat can still outlast the call's time budget, so the hint promises no fit.
      return {
        reason,
        message,
        hint: `Eurostat is preparing this extraction of "${datasetCode}" and serves the identical download once it is ready: repeat the call in a few minutes, or narrow it. ${narrowing()}`,
      };
    case 'retry_deadline_exceeded':
      return {
        reason,
        message,
        data: { deadlineMs: data?.deadlineMs, elapsedMs: data?.elapsedMs },
        hint:
          request.endpoint === 'structure'
            ? `Eurostat's SDMX structure endpoint did not answer for "${datasetCode}" within its deadline, every attempt included, so the dimension order a filtered download needs could not be read. Retry in a few minutes, or read the same filters through the Statistics API with eurostat_query_dataset.`
            : `The download of "${datasetCode}" read no row within this call's time budget, every attempt, backoff and the streamed body included. Retry in a few minutes, or narrow it with dimension filters or a shorter since_period/until_period range, or read a slice small enough to return with eurostat_query_dataset.`,
      };
    case 'upstream_fault':
      // A body that broke off after it began streaming: retried by the caller, not resent here.
      if (data?.retryable === true && typeof data.bytesRead === 'number') {
        return {
          reason,
          message,
          retryable: true,
          hint: `Eurostat's SDMX data endpoint broke off the body of "${datasetCode}" before it ended — an upstream failure, not a fault in the request. Retry in a few minutes, or narrow the request with dimension filters so less has to stream.`,
        };
      }
      // The services mark an endpoint that was down, not one that answered badly.
      if (data?.retryable === true) {
        const answer = outageAnswer(data.status);
        return {
          reason,
          message,
          retryable: true,
          hint:
            request.endpoint === 'structure'
              ? `Eurostat's SDMX structure endpoint ${answer} for "${datasetCode}" on every attempt, so the dimension order a filtered download needs could not be read — an upstream outage, not a fault in the request. Retry in a few minutes.`
              : `Eurostat's SDMX data endpoint ${answer} for "${datasetCode}" on every attempt — an upstream outage, not a fault in the request. Retry in a few minutes.`,
        };
      }
      // An HTTP status the fetch layer does not retry (a 501): an answer, not a body to read.
      if (typeof data?.status === 'number') {
        return {
          reason,
          message,
          hint:
            request.endpoint === 'structure'
              ? `Eurostat's SDMX structure endpoint answered HTTP ${data.status} for "${datasetCode}", a status this server does not retry on its own, so the dimension order a filtered download needs could not be read. Retry in a few minutes. If it fails the same way, eurostat_query_dataset takes the same filters through the Statistics API, which does not depend on this structure${offerUnfiltered ? ', and a download without filters skips the read' : ''}.`
              : `Eurostat's SDMX data endpoint answered HTTP ${data.status} for "${datasetCode}", a status this server does not retry on its own. Retry in a few minutes. If it fails the same way, eurostat_query_dataset reads the observations through the Statistics API, a separate endpoint, for a slice small enough to return.`,
        };
      }
      // The structure read answered, but with no dimension order to key a filter on.
      if (request.endpoint === 'structure') {
        return {
          reason,
          message,
          hint: `Eurostat returned a structure definition for "${datasetCode}" that this server cannot build a positional filter key from, so the filtered download was not sent. Retry in a few minutes. If it fails the same way, eurostat_query_dataset takes the same filters through the Statistics API, which does not depend on this structure${offerUnfiltered ? ', and a download without filters skips the read' : ''}.`,
        };
      }
      return {
        reason,
        message,
        hint: `The SDMX endpoint did not return a TSV table for "${datasetCode}". Retry in a few minutes, or narrow the request with dimension filters.`,
      };
    default:
      return;
  }
}

/**
 * The hint for filter keys that name no dimension of the dataset, each quoted as sent. A
 * time key (`time` or `time_period`, in any case) cannot be renamed to a listed dimension:
 * the bulk endpoint selects periods only by since_period/until_period. So it is removed,
 * and with no period input set the hint names the range spanning its values when every
 * one is a period literal, as `literals` the caller sends back; with one set, removing it
 * is the whole fix. Any other key keeps the rename advice, in the same hint.
 */
function unknownKeysAdvice(
  unknown: string[],
  filters: Record<string, string[]>,
  periodSet: boolean,
): { hint: string; literals: string[] } {
  const timeKeys = unknown.filter((key) => TIME_DIMENSION_KEYS.has(key.toLowerCase()));
  if (timeKeys.length === 0) return { hint: RENAME_FILTER_KEYS_HINT, literals: [] };
  const quoted = (keys: string[]) => keys.map((key) => `"${key}"`).join(', ');
  const others = unknown.filter((key) => !timeKeys.includes(key));
  const rename =
    others.length === 0
      ? ''
      : ` Rename ${quoted(others)} ${others.length === 1 ? 'to' : 'each to'} one of the dimensions the error lists.`;
  const remove = `Remove ${quoted(timeKeys)} from filters`;
  if (periodSet) {
    return {
      hint: `${remove}: since_period/until_period already select the periods.${rename}`,
      literals: [],
    };
  }
  const span = periodSpan(timeKeys.flatMap((key) => filters[key] ?? []));
  const range = span
    ? ` and set since_period "${span.since}" and until_period "${span.until}", the range spanning the periods ${timeKeys.length === 1 ? 'it names' : 'they name'}`
    : ' and select the periods with since_period/until_period';
  return {
    hint: `${remove}${range}: the bulk download selects periods by range, not by filter.${rename}`,
    literals: span ? [span.since, span.until] : [],
  };
}
