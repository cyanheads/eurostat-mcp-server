/**
 * @fileoverview Tool for listing all valid values for a specific Eurostat dataset dimension.
 * @module mcp-server/tools/definitions/eurostat-get-dimension-values.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { clampReadLimit } from '@/mcp-server/tools/clamp-read-limit.js';
import { filterTokens, matchValues } from '@/mcp-server/tools/value-list-paging.js';
import {
  acquireCanvas,
  getCanvas,
  isCanvasFailure,
  newTableName,
} from '@/services/canvas-accessor.js';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import { GEO_LEVEL_VALUES, type GeoLevel } from '@/services/eurostat-data/types.js';
import { outageAnswer } from '@/services/eurostat-outage.js';

/**
 * The staged value list: the same `{code, label}` pairs as the inline `values`,
 * declared rather than sniffed. The service falls back to the code when Eurostat
 * publishes no label, so neither column is ever null.
 */
const VALUE_TABLE_SCHEMA: ColumnSchema[] = [
  { name: 'code', type: 'VARCHAR', nullable: false },
  { name: 'label', type: 'VARCHAR', nullable: false },
];

/** Longest filter accepted: room for many words, while its echo and cursor stay small. */
const FILTER_MAX_CHARS = 500;

/** Count limit shared by first pages and legacy cursor continuations. */
const MAX_PAGE_SIZE = 1000;

/** A blank or whitespace-only string from a form client is "unset", never a value to validate. */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

const formatCount = (n: number) => n.toLocaleString('en-US');

type Value = { code: string; label: string };

/** What a cursor is bound to: a cursor replayed with any of these changed is refused. */
interface CursorBinding {
  dataset: string;
  dimension: string;
  /** The folded filter words, sorted and space-joined; empty without a filter. */
  filter: string;
  geoLevel: string | null;
}

/** The success payload, as the output schema declares it. */
interface DimensionValuesOutput {
  canvasId?: string | undefined;
  dimensionCode: string;
  dimensionLabel: string;
  geoLevel?: (typeof GEO_LEVEL_VALUES)[number] | undefined;
  matchCount?: number | undefined;
  stagedRowCount?: number | undefined;
  tableName?: string | undefined;
  totalCount: number;
  values: Value[];
}

/** The enrichment one page carries. */
interface PageEnrichment {
  nextCursor?: string;
  notice?: string;
  truncated?: true;
}

/** The `content[]` text of the payload. */
function renderText(result: DimensionValuesOutput): string {
  const listed = result.values.length;
  const partial = (of: number) => (listed < of ? ` — ${listed} listed below` : '');
  const lines: string[] = [
    `**Dimension:** ${result.dimensionLabel} (\`${result.dimensionCode}\`)`,
    ...(result.geoLevel ? [`**Geo level:** \`${result.geoLevel}\``] : []),
    `**Total values:** ${result.totalCount}${result.matchCount === undefined ? partial(result.totalCount) : ''}`,
    ...(result.matchCount === undefined
      ? []
      : [`**Matching filter:** ${result.matchCount}${partial(result.matchCount)}`]),
    ...(result.tableName
      ? [
          `**Staged:** table \`${result.tableName}\` on canvas \`${result.canvasId}\` (stagedRowCount ${result.stagedRowCount}), columns code and label — inspect it with eurostat_dataframe_describe first, then join it in eurostat_dataframe_query`,
        ]
      : []),
    '',
  ];
  for (const v of result.values) {
    lines.push(`- \`${v.code}\` — ${v.label}`);
  }
  return lines.join('\n');
}

/**
 * Decode a cursor and confirm it belongs to this call in every binding the input
 * alone settles; `undefined` when it does not. Malformed and mismatched cursors
 * are refused alike: the recovery is the same, and the cursor is opaque. The
 * effective geo level is left to the caller, which knows it only once the
 * dimension's values are loaded.
 */
function readCursor(
  cursor: string,
  binding: Pick<CursorBinding, 'dataset' | 'filter'>,
  ctx: Context,
): { after: string; dimension: unknown; geoLevel: unknown; limit: number } | undefined {
  try {
    const state = decodeCursor(cursor, ctx);
    if (
      typeof state.after === 'string' &&
      state.dataset === binding.dataset &&
      state.filter === binding.filter
    ) {
      return {
        after: state.after,
        dimension: state.dimension,
        geoLevel: state.geoLevel,
        limit: state.limit,
      };
    }
  } catch {
    // Undecodable — the same refusal as one that decodes but belongs to another call.
  }
  return;
}

/** The refusal of a cursor that is malformed or belongs to another call. */
const UNUSABLE_CURSOR =
  'Unusable cursor: it is malformed, or was issued for a different dataset_code, dimension, geo_level or filter.';

/**
 * Recovery for a `geo_level` that holds no value. `levels` are the ones the dataset
 * lists, as the service's error reports them, so every level offered returns values;
 * omitting `geo_level` is one of those offers only when `country` is among them.
 */
function geoLevelHint(datasetCode: string, failed: GeoLevel, levels: GeoLevel[]): string {
  const missed = `Dataset "${datasetCode}" has no "geo" values at the "${failed}" level.`;
  if (levels.length === 0) {
    return `${missed} None of its "geo" codes carries a NUTS level, so no geo_level selects them. eurostat_get_dataset_info lists sample "geo" codes.`;
  }
  const omit = levels.includes('country') ? ' Omitting geo_level requests country values.' : '';
  return `${missed} Choose geo_level from the levels it lists: ${levels.join(', ')}.${omit}`;
}

/** Select the count-limit schema before registering the tool. */
export const createEurostatGetDimensionValues = (clampLimits: boolean) =>
  tool('eurostat_get_dimension_values', {
    title: 'Get Eurostat Dimension Values',
    description:
      'List the valid values for a dimension in a Eurostat dataset, preserving value codes and labels exactly. Use this when eurostat_get_dataset_info returns more values than its sample, or to confirm exact filter codes before querying. Dimension identifiers match exactly first, then case-insensitively; TIME_PERIOD aliases time. For geo, use geo_level to select the NUTS hierarchy (country, nuts1, nuts2, nuts3). To find codes in a long list, pass filter: words its code or label contains. Pages default to 25 values, maximum 1,000; pass nextCursor back as cursor for the next page with the same dataset, dimension, geo level and filter. Canonical and alias dimension spellings resume the same list. Pass canvas_id on the first call to also stage every value as a two-column code/label table, regardless of filter or limit. Inspect that table with eurostat_dataframe_describe, then search or join it with eurostat_dataframe_query.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    input: z.object({
      dataset_code: z
        .string()
        .min(1)
        .describe('Dataset code (e.g., "nama_10_gdp", or "DS-045409" for a Comext collection).'),
      dimension: z
        .string()
        .min(1)
        .describe(
          'Dimension code to retrieve values for (e.g., "unit", "na_item", "geo"). Exact match first, then case-insensitive; TIME_PERIOD aliases time. Use eurostat_get_dataset_info to see available dimensions.',
        ),
      geo_level: z
        .enum(GEO_LEVEL_VALUES)
        .optional()
        .describe(
          'NUTS hierarchy level filter — applies only when dimension is "geo"; passing it with any other dimension is rejected. Options: "aggregate" (EU/EA codes), "country" (2-letter codes, default), "nuts1" (3-char), "nuts2" (4-char), "nuts3" (5-char).',
        ),
      filter: blankAsUnset(z.string().max(FILTER_MAX_CHARS).optional()).describe(
        `Words to find, up to ${FILTER_MAX_CHARS} characters: keeps only values whose code and label, joined by a space, contain every whitespace-separated word as a substring — in any order, ignoring case and accents ("palma frankfurt" finds DE_EDDF_ES_LEPA, "zurich" finds Zürich). Punctuation is part of a word, and spellings are not transliterated ("münchen" does not find MUENCHEN). Runs over the whole list at the effective geo_level before paging and keeps Eurostat's order, with no ranking; matchCount counts the matches.`,
      ),
      limit: (clampLimits
        ? z.number().multipleOf(1).min(1)
        : z.number().int().min(1).max(MAX_PAGE_SIZE)
      )
        .default(25)
        .describe(
          'Most values per page, default 25, maximum 1,000. Larger positive integers clamp with a notice when EUROSTAT_CLAMP_LIMITS is enabled. Fixed by the first call: with cursor, the cursor carries that limit and this field is ignored.',
        ),
      cursor: blankAsUnset(z.string().optional()).describe(
        "Opaque nextCursor from the previous page; omit for the first page. It resumes after that page's last code and is bound to dataset_code, dimension, geo_level and filter, so send those unchanged. Cannot be combined with canvas_id on a deployment with a dataframe canvas.",
      ),
      canvas_id: CanvasIdSchema.optional().describe(
        'Also stage the values on this dataframe canvas as a table with two columns, code and label, holding every value the dimension lists at the geo_level requested (country when it is omitted), whatever filter and limit are. Pass the canvasId a eurostat_download_dataset or eurostat_query_dataset response returned, then search the staged table with SQL or join it to a download on the dimension column (e.g., d.geo = g.code). Only on a call without cursor; omit to return the values inline only: this tool never starts a canvas. Ignored on deployments without a dataframe canvas.',
      ),
    }),
    output: z.object({
      dimensionCode: z.string().describe('The dimension code that was queried.'),
      dimensionLabel: z.string().describe('Human-readable dimension name.'),
      geoLevel: z
        .enum(GEO_LEVEL_VALUES)
        .optional()
        .describe(
          'Effective NUTS hierarchy level for the geo value set. Present only for the geo dimension; country is reported when geo_level was omitted.',
        ),
      values: z
        .array(
          z
            .object({
              code: z
                .string()
                .describe(
                  'Dimension value code. Use these as filter values in eurostat_query_dataset and eurostat_download_dataset.',
                ),
              label: z.string().describe('Human-readable label for this value.'),
            })
            .describe('A dimension value code and label pair.'),
        )
        .describe(
          "This page of dataset-available values, in Eurostat's order — for geo, the subset at geoLevel; with filter, only the matches. A page holds the effective limit (default 25, maximum 1,000), fewer only at the end; truncated and nextCursor are set when more follow.",
        ),
      totalCount: z
        .number()
        .describe(
          'Number of distinct values the dimension lists, after geoLevel filtering for geo — every one, whatever filter and paging apply.',
        ),
      matchCount: z
        .number()
        .optional()
        .describe(
          'Values matching filter across the whole list, before paging. Present only when filter was passed.',
        ),
      canvasId: z
        .string()
        .optional()
        .describe(
          'Dataframe canvas the values were staged on — the canvas_id supplied. Omitted when nothing was staged: canvas_id was omitted, this deployment runs without a dataframe canvas, or the dimension lists no values.',
        ),
      tableName: z
        .string()
        .optional()
        .describe(
          'Canvas table holding every value as two VARCHAR columns, code and label. Call eurostat_dataframe_describe with canvasId first to confirm it, then join it in eurostat_dataframe_query. Omitted alongside canvasId.',
        ),
      stagedRowCount: z
        .number()
        .optional()
        .describe(
          'Rows written to the canvas table. Equals totalCount. Omitted alongside tableName.',
        ),
    }),
    enrichment: {
      truncated: z
        .boolean()
        .optional()
        .describe(
          'True when more values follow this page — pass nextCursor as cursor to fetch them. Omitted on the last page.',
        ),
      nextCursor: z
        .string()
        .optional()
        .describe(
          "Opaque cursor for the next page. Pass it back as cursor with dataset_code, dimension, geo_level and filter unchanged; it resumes after this page's last code. Omitted on the last page.",
        ),
      notice: z
        .string()
        .optional()
        .describe(
          'Count-limit clamp disclosure, continuation routes (nextCursor, filter, canvas_id), or an explanation of a filter that matched nothing.',
        ),
    },
    errors: [
      {
        reason: 'not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'The dataset code or dimension code does not exist.',
        recovery:
          'Verify the dataset code with eurostat_search_datasets and the dimension code with eurostat_get_dataset_info.',
      },
      {
        reason: 'no_results',
        code: JsonRpcErrorCode.NotFound,
        when: 'The dataset has no geo values at the effective geo_level.',
        recovery:
          'Choose a geo_level the error names, each holding at least one code of this dataset; when it names none, eurostat_get_dataset_info lists sample geo codes.',
      },
      {
        reason: 'conflicting_params',
        code: JsonRpcErrorCode.ValidationError,
        when: 'geo_level was combined with a dimension other than "geo", where it has no effect; or, on a deployment with a dataframe canvas, canvas_id was combined with cursor, which would stage the list again on every page.',
        recovery:
          'Drop geo_level for a dimension other than "geo"; when paging with cursor, drop canvas_id — a first call that carried canvas_id staged every value.',
      },
      {
        reason: 'invalid_cursor',
        code: JsonRpcErrorCode.InvalidParams,
        when: 'The cursor is malformed, was issued for a different dataset_code, dimension, geo_level or filter, or resumes after a code the list no longer holds.',
        recovery:
          'Call again without cursor, keeping dataset_code, dimension, geo_level and filter, then page with the nextCursor that call returns.',
      },
      {
        reason: 'upstream_fault',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: "Eurostat returned a dataset structure or content constraint this server cannot read — malformed, truncated, not XML, or missing the requested dataset's dataflow — or the structure endpoint answered HTTP 5xx or could not be reached on every retry, which the error marks retryable.",
        recovery:
          'Retry in a few minutes, since a failed structure read is not cached. If it fails the same way, filter eurostat_query_dataset on the code in question: a code the dataset lacks comes back in unmatchedValues.',
      },
      {
        reason: 'canvas_not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'A canvas_id was supplied for staging but is unknown or its lifetime has elapsed.',
        recovery:
          'Pass the canvasId a recent eurostat_download_dataset or eurostat_query_dataset response returned, or omit canvas_id to list the values inline only.',
      },
    ],

    async handler(input, ctx) {
      /**
       * Without a dataframe canvas canvas_id is ignored, so it cannot re-stage the
       * list on every page and there is nothing to refuse.
       */
      if (input.cursor && input.canvas_id && getCanvas()) {
        throw ctx.fail(
          'conflicting_params',
          'canvas_id stages the whole list, so it belongs on the first call; sent with cursor it would stage the list again for every page.',
          {
            recovery: {
              hint: 'Drop canvas_id to keep paging with cursor; a first call that carried canvas_id has already staged every value. To stage the list now, call again with canvas_id and without cursor.',
            },
          },
        );
      }

      /**
       * A cursor is checked against everything the input settles before the
       * dimension's values are loaded, so a cursor replayed for another dataset
       * fails without downloading that dataset's structure.
       */
      const tokens = input.filter ? filterTokens(input.filter) : [];
      const filtered = tokens.length > 0;
      const binding: Omit<CursorBinding, 'geoLevel'> = {
        dataset: input.dataset_code.toLowerCase(),
        dimension: input.dimension,
        filter: [...tokens].sort().join(' '),
      };
      const resume = input.cursor ? readCursor(input.cursor, binding, ctx) : undefined;
      if (input.cursor && !resume) throw ctx.fail('invalid_cursor', UNUSABLE_CURSOR);

      const svc = getEurostatDataService();
      let result: Awaited<ReturnType<typeof svc.getDimensionValues>>;
      try {
        result = await svc.getDimensionValues(
          input.dataset_code,
          input.dimension,
          input.geo_level,
          ctx,
        );
      } catch (err) {
        const reason = (err as McpError).data?.reason;
        if (reason === 'not_found') {
          if (resume) throw ctx.fail('invalid_cursor', UNUSABLE_CURSOR);
          throw ctx.fail('not_found', (err as Error).message, {
            recovery: {
              hint: `Verify the dataset code with eurostat_search_datasets and the dimension code for "${input.dataset_code}" with eurostat_get_dataset_info.`,
            },
          });
        }
        if (reason === 'no_results') {
          throw ctx.fail('no_results', (err as Error).message, {
            recovery: {
              hint: geoLevelHint(
                input.dataset_code,
                input.geo_level ?? 'country',
                (err as McpError).data?.availableGeoLevels as GeoLevel[],
              ),
            },
          });
        }
        if (reason === 'conflicting_params') {
          throw ctx.fail('conflicting_params', (err as Error).message, {
            recovery: {
              hint: `geo_level applies only to the "geo" dimension and had no effect on "${input.dimension}". Re-send without geo_level, or set dimension to "geo".`,
            },
          });
        }
        if (reason === 'upstream_fault' && (err as McpError).data?.retryable === true) {
          throw ctx.fail('upstream_fault', (err as Error).message, {
            retryable: true,
            recovery: {
              hint: `Eurostat's SDMX structure endpoint ${outageAnswer((err as McpError).data?.status)} on every attempt, so the "${input.dimension}" values of "${input.dataset_code}" cannot be listed — an upstream outage, not a fault in the request. A failed read is not cached, so retry in a few minutes.`,
            },
          });
        }
        if (reason === 'upstream_fault') {
          throw ctx.fail('upstream_fault', (err as Error).message, {
            recovery: {
              hint: `Eurostat returned a structure this server cannot read, so the "${input.dimension}" values of "${input.dataset_code}" cannot be listed. A failed read is not cached, so retry in a few minutes. If it fails the same way, filter eurostat_query_dataset on the code in question: a code the dataset lacks comes back in unmatchedValues.`,
            },
          });
        }
        throw err;
      }
      binding.dimension = result.dimensionCode;
      if (resume && resume.dimension !== result.dimensionCode)
        throw ctx.fail('invalid_cursor', UNUSABLE_CURSOR);
      /**
       * Staging needs a caller-supplied canvas: without canvas_id there is nothing
       * to acquire, so a plain lookup never takes a canvas slot. An empty list
       * stages nothing rather than a 0-row table. The table is written from the
       * service's whole value list, whatever bound applies to the inline array.
       */
      const canvas = input.canvas_id ? getCanvas() : undefined;
      let staged: { canvasId: string; stagedRowCount: number; tableName: string } | undefined;
      if (canvas && result.values.length > 0) {
        // Re-thrown so the declared recovery replaces the canvas service's generic one.
        const instance = await acquireCanvas(canvas, input.canvas_id, ctx).catch((err: unknown) => {
          if (isCanvasFailure(err, 'canvas_not_found')) {
            throw ctx.fail(
              'canvas_not_found',
              err.message,
              { canvasId: input.canvas_id },
              { cause: err },
            );
          }
          throw err;
        });
        const handle = await instance.registerTable(newTableName(), result.values, {
          schema: VALUE_TABLE_SCHEMA,
          signal: ctx.signal,
        });
        staged = {
          canvasId: instance.canvasId,
          stagedRowCount: handle.rowCount,
          tableName: handle.tableName,
        };
      }

      const matched = filtered ? matchValues(result.values, tokens) : result.values;
      const geoLevel = result.geoLevel ?? null;

      /**
       * Where this page starts: after the code the cursor names, wherever that code
       * now sits, so a list that grew between calls still resumes after the right
       * value. The codec's `offset` is recorded but never trusted for position.
       */
      let start = 0;
      const applied = clampReadLimit(
        resume?.limit ?? input.limit,
        MAX_PAGE_SIZE,
        'limit',
        'eurostat_get_dimension_values',
        ctx,
      );
      const pageLimit = applied.value;
      if (resume) {
        if (resume.geoLevel !== geoLevel) throw ctx.fail('invalid_cursor', UNUSABLE_CURSOR);
        const anchor = matched.findIndex(({ code }) => code === resume.after);
        if (anchor < 0) {
          throw ctx.fail(
            'invalid_cursor',
            `Unusable cursor: it resumes after "${resume.after}", which the "${input.dimension}" values of "${input.dataset_code}" no longer list${filtered ? ' under this filter' : ''}.`,
          );
        }
        start = anchor + 1;
      }

      const filterEcho = input.filter?.trim().replace(/\s+/g, ' ');
      const pool = filtered
        ? `${formatCount(matched.length)} values matching filter "${filterEcho}"`
        : `${formatCount(matched.length)} "${input.dimension}" values`;
      const canvasRoute = staged
        ? ` Every one of the ${formatCount(staged.stagedRowCount)} values is staged as table "${staged.tableName}" on canvas "${staged.canvasId}" — search it with eurostat_dataframe_query (e.g. SELECT code, label FROM ${staged.tableName} WHERE label ILIKE '%term%').`
        : getCanvas()
          ? ` Or, on a call without cursor, pass canvas_id — the canvasId of a eurostat_query_dataset or eurostat_download_dataset response — to stage all ${formatCount(result.totalCount)} as a code/label table to search with eurostat_dataframe_query.`
          : '';

      const page = (k: number): { enrichment: PageEnrichment; output: DimensionValuesOutput } => {
        const values = matched.slice(start, start + k);
        const output: DimensionValuesOutput = {
          ...result,
          values,
          ...(filtered && { matchCount: matched.length }),
          ...staged,
        };
        if (start + k < matched.length) {
          const endedBy = `limit ${formatCount(pageLimit)}`;
          return {
            output,
            enrichment: {
              truncated: true,
              nextCursor: encodeCursor({
                offset: start + k,
                limit: pageLimit,
                after: values[k - 1]?.code,
                ...binding,
                geoLevel,
              }),
              notice: `Values ${formatCount(start + 1)}–${formatCount(start + k)} of ${pool}, in Eurostat's order; ${endedBy} ended this page. Pass nextCursor as cursor for the next page, or ${filtered ? 'add words to filter' : 'pass filter (words of the code or label)'} to narrow the list.${canvasRoute}`,
            },
          };
        }
        // An empty page needs saying only when a cursor or filter emptied it.
        if (values.length > 0 || !(input.cursor || filtered)) return { output, enrichment: {} };
        return {
          output,
          enrichment: {
            notice: input.cursor
              ? `No "${input.dimension}" values of "${input.dataset_code}" follow the code this cursor resumes after: the list ends there.`
              : `No "${input.dimension}" value${result.geoLevel ? ` at geo_level "${result.geoLevel}"` : ''} of "${input.dataset_code}" matched filter "${filterEcho}": every word must appear in a value's code or label, in any order, ignoring case and accents. Drop or shorten a word, or ${
                  staged
                    ? `search all ${formatCount(staged.stagedRowCount)} values, staged as table "${staged.tableName}" on canvas "${staged.canvasId}", with eurostat_dataframe_query (e.g. SELECT code, label FROM ${staged.tableName} WHERE label ILIKE '%term%').`
                    : `call without filter to page through all ${formatCount(result.totalCount)}.`
                }`,
          },
        };
      };
      const { output, enrichment } = page(Math.min(pageLimit, matched.length - start));
      const { notice, ...fields } = enrichment;
      ctx.enrich(fields);
      const notices = [applied.notice, notice].filter(Boolean);
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

      ctx.log.info('Dimension values fetched', {
        datasetCode: input.dataset_code,
        dimension: input.dimension,
        totalCount: result.totalCount,
        ...(filtered && { matchCount: matched.length }),
        shown: output.values.length,
        hasMore: enrichment.truncated === true,
        ...(staged && { canvasId: staged.canvasId, tableName: staged.tableName }),
      });
      return output;
    },

    format: (result) => [{ type: 'text', text: renderText(result) }],
  });

export const eurostatGetDimensionValues = createEurostatGetDimensionValues(true);
