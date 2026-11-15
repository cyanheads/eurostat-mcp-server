/**
 * @fileoverview Tool for listing all valid values for a specific Eurostat dataset dimension.
 * @module mcp-server/tools/definitions/eurostat-get-dimension-values.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { clampReadLimit } from '@/mcp-server/tools/clamp-read-limit.js';
import {
  filterTokens,
  foldCodePrefix,
  matchCodePrefix,
  matchValues,
} from '@/mcp-server/tools/value-list-paging.js';
import {
  acquireCanvas,
  getCanvas,
  isCanvasFailure,
  newTableName,
} from '@/services/canvas-accessor.js';
import {
  geoLevelMiss,
  getEurostatDataService,
} from '@/services/eurostat-data/eurostat-data-service.js';
import {
  GEO_LEVEL_VALUES,
  type GeoLevel,
  type ListedValue,
} from '@/services/eurostat-data/types.js';
import { isComextDataset } from '@/services/eurostat-hosts.js';
import { outageAnswer } from '@/services/eurostat-outage.js';

/**
 * The sentence an empty page adds for a code_prefix holding ".", which no Eurostat code
 * contains. A `DS-*` collection's classification codes are bare digits, so there a prefix
 * of digits and dots is a code printed with separators and its stripped form is the prefix
 * to send; elsewhere stripping can yield a non-code (COICOP `01.1` is `CP011`).
 */
function dottedPrefixAdvice(datasetCode: string, prefix: string | undefined): string {
  if (!prefix?.includes('.')) return '';
  const stripped = prefix.replaceAll('.', '');
  return isComextDataset(datasetCode) && /^\d+$/.test(stripped)
    ? ` No Eurostat code contains ".": a code printed with separators is sent without them, so pass code_prefix "${stripped}".`
    : ' No Eurostat code contains ".", so a code_prefix holding one matches nothing: find the code with filter instead.';
}

/**
 * The staged value list: `{code, label}` pairs, declared rather than sniffed. The
 * service falls back to the code when Eurostat publishes no label, so neither
 * column is ever null.
 */
const VALUE_TABLE_SCHEMA: ColumnSchema[] = [
  { name: 'code', type: 'VARCHAR', nullable: false },
  { name: 'label', type: 'VARCHAR', nullable: false },
];

/**
 * A staged `geo` list adds each code's NUTS level, whether or not geo_level was
 * passed, so every `geo` table has one shape. Null for a code with no level the
 * server maps.
 */
const GEO_VALUE_TABLE_SCHEMA: ColumnSchema[] = [
  ...VALUE_TABLE_SCHEMA,
  { name: 'level', type: 'VARCHAR', nullable: true },
];

/** Longest filter accepted: room for many words, while its echo and cursor stay small. */
const FILTER_MAX_CHARS = 500;

/** Longest code_prefix accepted: well past any Eurostat code, while its cursor copy stays small. */
const CODE_PREFIX_MAX_CHARS = 100;

/** Count limit shared by first pages and legacy cursor continuations. */
const MAX_PAGE_SIZE = 1000;

/** A blank or whitespace-only string from a form client is "unset", never a value to validate. */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

const formatCount = (n: number) => n.toLocaleString('en-US');

/** A staged geo list's rows per NUTS level, in hierarchy order: "aggregate 1, country 34, NULL 2". */
function levelCounts(values: readonly ListedValue[]): string {
  const counts = new Map<GeoLevel | null, number>();
  for (const { level = null } of values) counts.set(level, (counts.get(level) ?? 0) + 1);
  return [...GEO_LEVEL_VALUES, null]
    .flatMap((level) => {
      const count = counts.get(level);
      return count === undefined ? [] : [`${level ?? 'NULL'} ${formatCount(count)}`];
    })
    .join(', ');
}

/**
 * The notice of a geo table staged without geo_level that holds more rows than the
 * `inline` level lists: its rows per level, and how to keep a JOIN on it from summing
 * levels that overlap. When the dataset lists no value at the inline level (`tgs00010`
 * has no country code), the page is empty and a filter on that level selects no row, so
 * the notice names the geo_level that lists one of the table's levels inline instead.
 */
function everyLevelNotice(
  datasetCode: string,
  inline: GeoLevel,
  inlineCount: number,
  table: { canvasId: string; tableName: string },
  listed: readonly ListedValue[],
): string {
  const holds = `Table \`${table.tableName}\` on canvas \`${table.canvasId}\` holds every "geo" level "${datasetCode}" lists`;
  const level = "with each code's level in a level column (NULL for a code with no NUTS level).";
  if (inlineCount > 0) {
    return `${holds}, not only the ${inline} values listed here — ${levelCounts(listed)} — ${level} Aggregates and regions overlap the countries they contain, so a JOIN on this table keeps them beside the countries: filter g.level (e.g. WHERE g.level = 'country') before summing or averaging, or pass geo_level to stage one level. Inspect it with eurostat_dataframe_describe, then search or join it with eurostat_dataframe_query.`;
  }
  const levels = GEO_LEVEL_VALUES.filter((l) => listed.some((v) => v.level === l));
  const overlap =
    levels.length > 1
      ? ' Codes at different levels overlap, an aggregate or region containing the regions below it, so a JOIN on this table keeps them side by side: filter g.level to one level before summing or averaging.'
      : '';
  const route =
    levels.length > 0
      ? `: pass geo_level (${levels.join(', ')}) to list one level inline.`
      : ', and none of its "geo" codes carries a NUTS level, so no geo_level lists them inline.';
  return `${holds} — ${levelCounts(listed)} — ${level}${overlap} "${datasetCode}" lists no ${inline} values, so none are listed here${route} Inspect the table with eurostat_dataframe_describe, then search or join it with eurostat_dataframe_query.`;
}

type Value = { code: string; label: string };

/** What a cursor is bound to: a cursor replayed with any of these changed is refused. */
interface CursorBinding {
  dataset: string;
  dimension: string;
  /** The folded filter words, sorted and space-joined; empty without a filter. */
  filter: string;
  geoLevel: string | null;
  /** The folded code_prefix; empty without one. A cursor with no such field reads as empty. */
  prefix: string;
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

/**
 * The `content[]` Staged line. A geo table holds more rows than the inline level
 * only when it was staged without geo_level, so every level: an explicit level
 * stages exactly the `totalCount` values the page is drawn from. With no value at
 * the inline level, a country filter on the table selects nothing, so none is offered.
 */
function stagedLine(result: DimensionValuesOutput): string {
  const table = `**Staged:** table \`${result.tableName}\` on canvas \`${result.canvasId}\` (stagedRowCount ${result.stagedRowCount})`;
  const next =
    'inspect it with eurostat_dataframe_describe first, then join it in eurostat_dataframe_query';
  if (!result.geoLevel) return `${table}, columns code and label — ${next}`;
  const everyLevel =
    result.stagedRowCount === undefined || result.stagedRowCount <= result.totalCount
      ? ''
      : result.totalCount === 0
        ? ` — every geo level the dataset lists, though it lists no ${result.geoLevel} values, so none are listed below`
        : ` — every geo level the dataset lists, not only the ${result.geoLevel} values below. Aggregates and regions overlap the countries they contain, so a JOIN on it keeps them beside the countries: filter level (e.g. g.level = 'country') before summing or averaging`;
  return `${table}, columns code, label and level (NUTS level, NULL when the code has none)${everyLevel} — ${next}`;
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
      : [`**Matching:** ${result.matchCount}${partial(result.matchCount)}`]),
    ...(result.tableName ? [stagedLine(result)] : []),
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
  binding: Pick<CursorBinding, 'dataset' | 'filter' | 'prefix'>,
  ctx: Context,
): { after: string; dimension: unknown; geoLevel: unknown; limit: number } | undefined {
  try {
    const state = decodeCursor(cursor, ctx);
    if (
      typeof state.after === 'string' &&
      state.dataset === binding.dataset &&
      state.filter === binding.filter &&
      (state.prefix === undefined ? '' : state.prefix) === binding.prefix
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
  'Unusable cursor: it is malformed, or was issued for a different dataset_code, dimension, geo_level, filter or code_prefix.';

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
      "List every value a Eurostat dataset carries in one dimension, with codes and labels exactly as published: when eurostat_get_dataset_info's sample is not enough, or to confirm filter codes before querying. Narrow a long list with filter (words in a code or label) or code_prefix (the codes under a parent, such as one country's regions), and page with cursor. Pass canvas_id to also stage the whole list as a table, to label a download's codes through a join.",
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
          'Dimension code (e.g., "geo", "unit"), matched exactly, then ignoring case; TIME_PERIOD aliases time. eurostat_get_dataset_info lists them.',
        ),
      geo_level: z
        .enum(GEO_LEVEL_VALUES)
        .optional()
        .describe(
          'NUTS level, for the "geo" dimension only (rejected with any other): "aggregate" (EU/EA codes), "country" (2-letter codes, the inline default), "nuts1", "nuts2", "nuts3".',
        ),
      filter: blankAsUnset(z.string().max(FILTER_MAX_CHARS).optional()).describe(
        `Words to find, up to ${FILTER_MAX_CHARS} characters: keeps values whose code and label, joined by a space, contain every word as a substring, in any order, ignoring case and accents. Punctuation is part of a word; spellings are not transliterated ("münchen" does not find MUENCHEN). Applies to the whole list at the effective geo_level before paging, in Eurostat's order.`,
      ),
      code_prefix: blankAsUnset(z.string().max(CODE_PREFIX_MAX_CHARS).optional()).describe(
        `Keep values whose code starts with this text, ignoring case: the codes under a parent where codes nest by prefix ("DE" with geo_level "nuts2" lists the German NUTS 2 regions; a CN heading lists its codes, itself included). Aggregates outside the code tree are not reached. Up to ${CODE_PREFIX_MAX_CHARS} characters, no wildcards. Applies at the effective geo_level, with filter, before paging.`,
      ),
      limit: (clampLimits
        ? z.number().multipleOf(1).min(1)
        : z.number().int().min(1).max(MAX_PAGE_SIZE)
      )
        .default(25)
        .describe(
          `Values per page, default 25; ${clampLimits ? 'values above 1,000 clamp to 1,000 with a notice' : 'maximum 1,000, larger values are rejected'}. Fixed by the first call and ignored with cursor.`,
        ),
      cursor: blankAsUnset(z.string().optional()).describe(
        'Opaque nextCursor from the previous page; omit for the first. Bound to dataset_code, dimension (any accepted spelling), geo_level, filter and code_prefix, so send those unchanged.',
      ),
      canvas_id: CanvasIdSchema.optional().describe(
        "Also stage the dimension's whole list on this canvas, whatever filter, code_prefix and limit, narrowed only by an explicit geo_level: columns code and label, plus level for geo (NULL for a code with no NUTS level). Without geo_level a geo table holds every level, aggregates and regions beside the countries they contain, so filter level before summing or averaging. Pass the canvasId of a eurostat_query_dataset or eurostat_download_dataset response; this tool never starts a canvas. First call only, not with cursor. Ignored without a dataframe canvas.",
      ),
    }),
    output: z.object({
      dimensionCode: z.string().describe('The dimension code queried.'),
      dimensionLabel: z.string().describe('Dimension name.'),
      geoLevel: z
        .enum(GEO_LEVEL_VALUES)
        .optional()
        .describe(
          'NUTS level of the inline values, for geo only: country when geo_level was omitted.',
        ),
      values: z
        .array(
          z
            .object({
              code: z
                .string()
                .describe(
                  'Value code, the filter value in eurostat_query_dataset and eurostat_download_dataset.',
                ),
              label: z.string().describe('Value label.'),
            })
            .describe('A dimension value code and label pair.'),
        )
        .describe(
          "This page of values in Eurostat's order: for geo, those at geoLevel; with filter or code_prefix, the matches. Up to limit; truncated and nextCursor say when more follow.",
        ),
      totalCount: z
        .number()
        .describe(
          'Values the dimension lists, at geoLevel for geo, before filter, code_prefix and paging. 0 only when the dataset lists no country values and an every-level geo table was staged.',
        ),
      matchCount: z
        .number()
        .optional()
        .describe(
          'Values passing filter and code_prefix across the whole list, before paging; only when either was passed.',
        ),
      canvasId: z
        .string()
        .optional()
        .describe('Canvas holding the staged list; omitted when nothing was staged.'),
      tableName: z
        .string()
        .optional()
        .describe(
          'Staged table (VARCHAR code and label, plus level for geo). Call eurostat_dataframe_describe with canvasId, then join it in eurostat_dataframe_query.',
        ),
      stagedRowCount: z
        .number()
        .optional()
        .describe(
          "Rows staged: totalCount, or for a geo table staged without geo_level, every level (the dataset's geo valuesCount).",
        ),
    }),
    enrichment: {
      truncated: z
        .boolean()
        .optional()
        .describe('True when more values follow; pass nextCursor as cursor for them.'),
      nextCursor: z
        .string()
        .optional()
        .describe('Cursor for the next page. Omitted on the last page.'),
      notice: z
        .string()
        .optional()
        .describe(
          'Clamp disclosure, continuation routes, why a filter or code_prefix matched nothing, and, for a geo table staged without geo_level, its rows per level and the overlap warning, or the geo_level that lists one of its levels inline.',
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
        when: 'The dataset has no geo values at the geo_level passed, or at the country default when nothing was staged.',
        recovery:
          'Choose a geo_level the error names, each holding at least one code of this dataset; when it names none, eurostat_get_dataset_info lists sample geo codes.',
      },
      {
        reason: 'conflicting_params',
        code: JsonRpcErrorCode.ValidationError,
        when: 'geo_level was passed for a dimension other than "geo", or canvas_id with cursor where a canvas runs.',
        recovery:
          'Drop geo_level for a dimension other than "geo"; when paging with cursor, drop canvas_id — a first call that carried canvas_id staged every value.',
      },
      {
        reason: 'invalid_cursor',
        code: JsonRpcErrorCode.InvalidParams,
        when: 'The cursor is malformed, belongs to another dataset_code, dimension, geo_level, filter or code_prefix, or resumes after a code the list no longer holds.',
        recovery:
          'Call again without cursor, keeping dataset_code, dimension, geo_level, filter and code_prefix, then page with the nextCursor that call returns.',
      },
      {
        reason: 'upstream_fault',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'Eurostat returned a dataset structure this server cannot read, or refused the structure read, which is not retried; marked retryable when the structure endpoint failed or could not be reached on every retry.',
        recovery:
          'Retry in a few minutes, since a failed structure read is not cached. If it fails the same way, filter eurostat_query_dataset on the code in question: a code the dataset lacks comes back in unmatchedValues.',
      },
      {
        reason: 'canvas_not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'The canvas_id is unknown or expired.',
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
      const prefix = input.code_prefix ? foldCodePrefix(input.code_prefix) : '';
      const narrowed = filtered || prefix !== '';
      const binding: Omit<CursorBinding, 'geoLevel'> = {
        dataset: input.dataset_code.toLowerCase(),
        dimension: input.dimension,
        filter: [...tokens].sort().join(' '),
        prefix,
      };
      const resume = input.cursor ? readCursor(input.cursor, binding, ctx) : undefined;
      if (input.cursor && !resume) throw ctx.fail('invalid_cursor', UNUSABLE_CURSOR);

      /** A level that lists no value, with the recovery built from the levels its error names. */
      const noResults = (err: McpError) =>
        ctx.fail('no_results', err.message, {
          recovery: {
            hint: geoLevelHint(
              input.dataset_code,
              err.data?.geoLevel as GeoLevel,
              err.data?.availableGeoLevels as GeoLevel[],
            ),
          },
        });

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
        if (reason === 'no_results') throw noResults(err as McpError);
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
        const status = (err as McpError).data?.status;
        if (reason === 'upstream_fault' && typeof status === 'number') {
          // An HTTP status the fetch layer does not retry (a 501): an answer, not a body to read.
          throw ctx.fail('upstream_fault', (err as Error).message, {
            recovery: {
              hint: `Eurostat's SDMX structure endpoint answered HTTP ${status}, a status this server does not retry on its own, so the "${input.dimension}" values of "${input.dataset_code}" cannot be listed. A failed read is not cached, so retry in a few minutes. If it fails the same way, filter eurostat_query_dataset on the code in question: a code the dataset lacks comes back in unmatchedValues.`,
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
       * dimension's whole list, narrowed only by an explicit geo_level: filter,
       * limit, cursor and the inline country default shape the page alone.
       */
      const canvas = input.canvas_id ? getCanvas() : undefined;
      let staged: { canvasId: string; stagedRowCount: number; tableName: string } | undefined;
      if (canvas && result.listedValues.length > 0) {
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
        const handle = await instance.registerTable(newTableName(), result.listedValues, {
          schema: result.geoLevel ? GEO_VALUE_TABLE_SCHEMA : VALUE_TABLE_SCHEMA,
          signal: ctx.signal,
        });
        staged = {
          canvasId: instance.canvasId,
          stagedRowCount: handle.rowCount,
          tableName: handle.tableName,
        };
      }
      /**
       * The service returns an empty country default rather than failing it, since the
       * every-level list beside it may still stage. With nothing staged the call fails
       * exactly as an explicit level that lists nothing does.
       */
      if (result.geoLevel && result.totalCount === 0 && !staged) {
        throw noResults(
          geoLevelMiss(
            input.dataset_code,
            result.geoLevel,
            result.listedValues.map(({ level }) => level),
          ),
        );
      }
      /**
       * A geo table staged without geo_level that holds more rows than the country
       * default lists holds other levels, so a JOIN on it stops acting as the country
       * filter the inline default suggests: said on every such call, whatever page it
       * returns, and never for a list that holds countries alone.
       */
      const levelNotice =
        staged && result.geoLevel && !input.geo_level && staged.stagedRowCount > result.totalCount
          ? everyLevelNotice(
              input.dataset_code,
              result.geoLevel,
              result.totalCount,
              staged,
              result.listedValues,
            )
          : undefined;

      const prefixed = prefix ? matchCodePrefix(result.values, prefix) : result.values;
      const matched = filtered ? matchValues(prefixed, tokens) : prefixed;
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
            `Unusable cursor: it resumes after "${resume.after}", which the "${input.dimension}" values of "${input.dataset_code}" no longer list${narrowed ? ` under this ${[filtered && 'filter', prefix && 'code_prefix'].filter(Boolean).join(' and ')}` : ''}.`,
          );
        }
        start = anchor + 1;
      }

      const filterEcho = input.filter?.trim().replace(/\s+/g, ' ');
      const prefixEcho = input.code_prefix?.trim();
      const matching = filtered ? ` matching filter "${filterEcho}"` : '';
      const pool = narrowed
        ? `${formatCount(matched.length)} values${prefix ? ` with code prefix "${prefixEcho}"` : ''}${matching}`
        : `${formatCount(matched.length)} "${input.dimension}" values`;
      const canvasRoute = staged
        ? levelNotice
          ? ''
          : ` Every one of the ${formatCount(staged.stagedRowCount)} values is staged as table \`${staged.tableName}\` on canvas \`${staged.canvasId}\` — inspect it with eurostat_dataframe_describe, then search it with eurostat_dataframe_query (e.g. \`SELECT code, label FROM ${staged.tableName} WHERE label ILIKE '%term%'\`).`
        : getCanvas()
          ? ` Or, on a call without cursor, pass canvas_id — the canvasId of a eurostat_query_dataset or eurostat_download_dataset response — to stage all ${
              result.geoLevel
                ? `${formatCount(result.listedValues.length)} "geo" values${input.geo_level ? ` at geo_level "${input.geo_level}"` : ', every level,'} as a code/label/level table`
                : `${formatCount(result.listedValues.length)} as a code/label table`
            } to search with eurostat_dataframe_query.`
          : '';

      const page = (k: number): { enrichment: PageEnrichment; output: DimensionValuesOutput } => {
        const values = matched.slice(start, start + k);
        const output: DimensionValuesOutput = {
          dimensionCode: result.dimensionCode,
          dimensionLabel: result.dimensionLabel,
          ...(result.geoLevel && { geoLevel: result.geoLevel }),
          values,
          totalCount: result.totalCount,
          ...(narrowed && { matchCount: matched.length }),
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
        // An empty page needs saying only when a cursor, filter or code_prefix emptied it.
        if (values.length > 0 || !(input.cursor || narrowed)) return { output, enrichment: {} };
        return { output, enrichment: { notice: emptyPageNotice() } };
      };
      const emptyPageNotice = (): string => {
        if (input.cursor) {
          return `No "${input.dimension}" values of "${input.dataset_code}" follow the code this cursor resumes after: the list ends there.`;
        }
        const atLevel = result.geoLevel ? ` at geo_level "${result.geoLevel}"` : '';
        const searchStaged = (table: NonNullable<typeof staged>) =>
          `search all ${formatCount(table.stagedRowCount)} values, staged as table \`${table.tableName}\` on canvas \`${table.canvasId}\`: inspect it with eurostat_dataframe_describe, then query it with eurostat_dataframe_query`;
        if (!prefix) {
          const filterRoute = result.geoLevel
            ? ` filter applies within geo_level "${result.geoLevel}": pass another geo_level to search the codes of that level.`
            : '';
          return `No "${input.dimension}" value${atLevel} of "${input.dataset_code}" matched filter "${filterEcho}": every word must appear in a value's code or label, in any order, ignoring case and accents.${filterRoute} Drop or shorten a word, or ${
            staged
              ? `${searchStaged(staged)} (e.g. \`SELECT code, label FROM ${staged.tableName} WHERE label ILIKE '%term%'\`).`
              : `call without filter to page through all ${formatCount(result.totalCount)}.`
          }`;
        }
        const levelRoute = result.geoLevel
          ? ` code_prefix applies within geo_level "${result.geoLevel}": pass another geo_level to list the codes of that level.`
          : '';
        return `No "${input.dimension}" value${atLevel} of "${input.dataset_code}" has a code starting with code_prefix "${prefixEcho}"${filtered ? ` and matches filter "${filterEcho}"` : ''}, ignoring case.${dottedPrefixAdvice(input.dataset_code, prefixEcho)}${levelRoute} Shorten or drop code_prefix${filtered ? ' or filter' : ''}, or ${
          staged
            ? `${searchStaged(staged)}.`
            : `call without ${filtered ? 'them' : 'it'} to page through all ${formatCount(result.totalCount)}.`
        }`;
      };
      const { output, enrichment } = page(Math.min(pageLimit, matched.length - start));
      const { notice, ...fields } = enrichment;
      ctx.enrich(fields);
      const notices = [applied.notice, notice, levelNotice].filter(Boolean);
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

      ctx.log.info('Dimension values fetched', {
        datasetCode: input.dataset_code,
        dimension: input.dimension,
        totalCount: result.totalCount,
        ...(narrowed && { matchCount: matched.length }),
        shown: output.values.length,
        hasMore: enrichment.truncated === true,
        ...(staged && { canvasId: staged.canvasId, tableName: staged.tableName }),
      });
      return output;
    },

    format: (result) => [{ type: 'text', text: renderText(result) }],
  });

export const eurostatGetDimensionValues = createEurostatGetDimensionValues(true);
