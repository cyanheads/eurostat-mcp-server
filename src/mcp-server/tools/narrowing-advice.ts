/**
 * @fileoverview Recovery wording shared by the two data tools: the best-effort reads
 * behind a hint that names a dataset's own dimensions or values, the advice for a
 * request Eurostat refused as too large, and the wording for a filter key or value that
 * cannot match the dataset.
 * @module mcp-server/tools/narrowing-advice
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';
import type { SdmxDatasetMetadata } from '@/services/eurostat-data/sdmx-metadata.js';
import type { UnmatchedValues, ValidValues } from '@/services/eurostat-data/types.js';
import { isComextDataset } from '@/services/eurostat-hosts.js';

/**
 * The opening of both data tools' `invalid_dimension` `when`. Each tool appends the
 * further causes its own path raises.
 */
export const UNKNOWN_FILTER_KEY_WHEN =
  "A filter key is not a dimension of this dataset; the error names every such key and lists the dataset's dimensions in key order";

/** The hint for a filter key that names no dimension, shared by both data tools. */
export const RENAME_FILTER_KEYS_HINT =
  'Rename each filter key the error names to one of the dimensions it lists.';

/** A filter value holding ".", with the dimension it was sent for. */
type DottedEntry = { dimension: string; value: string };

/**
 * Advice for filter values holding ".", which no Eurostat code contains, as one hint:
 * the opening sentence once, then one piece of advice per value. A Comext `DS-*`
 * collection's classification codes are bare digits, so there a value of digits and dots
 * is a code printed with separators and its stripped form is the code to send
 * (`2204.21` → `220421`). Elsewhere stripping can yield a non-code (COICOP `01.1.1` is
 * `CP0111`), so the advice is a value search on the stripped form instead. `literals`
 * holds the values the hint quotes for the caller to send back.
 */
export function dottedValueAdvice(
  datasetCode: string,
  entries: [DottedEntry, ...DottedEntry[]],
): { hint: string; literals: string[] } {
  const advise = ({ dimension, value }: DottedEntry) => {
    const stripped = value.replaceAll('.', '');
    if (isComextDataset(datasetCode) && value.split('.').every((part) => /^\d+$/.test(part))) {
      return {
        joiner: '. ',
        literals: [stripped, value, dimension],
        text: `Write "${stripped}" for "${value}" in filters.${dimension}.`,
      };
    }
    if (stripped.trim() === '') {
      return {
        joiner: '. ',
        literals: [dimension],
        text: `List the codes of "${dimension}" with eurostat_get_dimension_values.`,
      };
    }
    return {
      joiner: ', and ',
      literals: [value, stripped, dimension],
      text: `"${value}" without its dots may not be a code of "${datasetCode}" either. Find the code with eurostat_get_dimension_values, dimension "${dimension}" and filter "${stripped}".`,
    };
  };
  const [head, ...tail] = entries;
  const first = advise(head);
  const rest = tail.map(advise);
  return {
    hint: `No Eurostat code contains "."${first.joiner}${first.text}${rest.map(({ text }) => ` ${text}`).join('')}`,
    literals: [first, ...rest].flatMap(({ literals }) => literals),
  };
}

/**
 * `geo=[DE, XX]; age=[ZZZ]`, each dimension code and value passed through `encode`.
 * Authored Markdown (a notice, a `format()` line, the filters trailer) passes
 * `escapeMarkdownInline`, so a caller's value renders as sent; an error message stays
 * raw, as the framework escapes it.
 */
export function formatValues(
  values: Record<string, string[]>,
  encode: (text: string) => string = (text) => text,
): string {
  return Object.entries(values)
    .map(([dim, codes]) => `${encode(dim)}=[${codes.map((code) => encode(code)).join(', ')}]`)
    .join('; ');
}

/**
 * Total allowance for the read behind a hint, every attempt and backoff included. It
 * runs after the request it explains, which can have spent its own 30 s, and MCP SDK
 * clients give up at 60 s.
 */
const HINT_READ_DEADLINE_MS = 5_000;

/**
 * The dataset's key dimensions, for a recovery hint to name. `known` is the order the
 * request already read, if any; otherwise the structure definition is read now, a few
 * KB. The failure being explained carries no dimension list, and its hint is only more
 * specific with one, so a failed or late read returns `undefined` rather than replacing
 * that failure with a second error. A cancelled call is the exception: its abort is
 * rethrown so it reaches the caller as a cancellation.
 */
export async function dimensionsToNarrow(
  datasetCode: string,
  known: string[],
  ctx: Context,
): Promise<string[] | undefined> {
  if (known.length > 0) return known;
  try {
    return await getEurostatDataService().getDimensionOrder(
      datasetCode,
      ctx,
      HINT_READ_DEADLINE_MS,
    );
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.debug('Could not read dimensions for a recovery hint', {
      datasetCode,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

/**
 * The dataset's metadata, for a recovery hint to name its dimension values, or
 * `undefined` when it is not in hand within {@link HINT_READ_DEADLINE_MS}. The metadata
 * load is shared and takes no deadline of its own (a cold Comext dataflow outlasts the
 * allowance several times over), so the read races a timer instead; a load the timer
 * beats keeps running and fills the cache, so a follow-up value lookup is served from
 * it. A failed read degrades the hint the same way, and a cancelled call is rethrown.
 */
export async function dimensionValuesForHint(
  datasetCode: string,
  ctx: Context,
): Promise<SdmxDatasetMetadata | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), HINT_READ_DEADLINE_MS);
  });
  try {
    return await Promise.race([getEurostatDataService().getSdmxMetadata(datasetCode, ctx), late]);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.debug('Could not read dimension values for a recovery hint', {
      datasetCode,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Most values a hint lists for one dimension: eurostat_get_dimension_values' default
 * page. A longer list is not cut to its first values, which in Eurostat's order say
 * nothing about the value sent (a CN product list opens with confidential-trade totals).
 */
const VALUES_LISTED_MAX = 25;

/**
 * What to send instead of each unmatched filter value, from the dataset's own value
 * lists. A dimension with at most {@link VALUES_LISTED_MAX} values has every code and
 * label listed; a longer one has its total and, per value sent, a value search for it,
 * or {@link dottedValueAdvice} for a value holding ".". `totalCount` counts every value
 * the dimension lists, every `geo` level included, where eurostat_get_dimension_values
 * defaults `geo` to countries. A key the metadata lists no values for lands in
 * `unresolved`, for the caller's generic sentence. `literals` holds the codes and values
 * the sentences quote for sending back.
 */
export function unmatchedValuesAdvice(
  datasetCode: string,
  unmatched: UnmatchedValues,
  { meta, valuesByDimension }: SdmxDatasetMetadata,
): { literals: string[]; sentences: string[]; unresolved: string[]; validValues: ValidValues } {
  const sentences: string[] = [];
  const literals = new Set<string>();
  const validValues: ValidValues = {};
  const unresolved: string[] = [];
  const dotted: { dimension: string; value: string }[] = [];
  let dottedAt = -1;
  for (const [key, sent] of Object.entries(unmatched)) {
    const folded = key.toLowerCase();
    const dimension =
      meta.dimensions.find(({ code }) => code === key) ??
      meta.dimensions.find(({ code }) => code.toLowerCase() === folded);
    const values = dimension && valuesByDimension[dimension.code];
    if (!dimension || !values?.length) {
      unresolved.push(key);
      continue;
    }
    if (values.length <= VALUES_LISTED_MAX) {
      validValues[key] = {
        totalCount: values.length,
        values: values.map(({ code, label }) => ({ code, label })),
      };
      const listed = values.map(({ code, label }) => `${code} (${label})`).join(', ');
      sentences.push(
        `"${key}" has ${values.length === 1 ? '1 code' : `${values.length} codes`}: ${listed}.`,
      );
      for (const { code } of values) literals.add(code);
      continue;
    }
    validValues[key] = { totalCount: values.length };
    sentences.push(
      `"${key}" has ${values.length.toLocaleString('en-US')} codes, too many to list here.`,
    );
    for (const value of sent) {
      if (value.includes('.')) {
        dotted.push({ dimension: key, value });
        if (dotted.length === 1) {
          dottedAt = sentences.length;
          sentences.push('');
        }
        continue;
      }
      sentences.push(
        `Find the code for "${value}" with eurostat_get_dimension_values, dimension "${key}" and filter "${value}"${dimension.code === 'geo' ? ', adding geo_level for a code below country level' : ''}.`,
      );
      literals.add(value).add(key);
    }
  }
  const [firstDotted, ...otherDotted] = dotted;
  if (firstDotted) {
    const advice = dottedValueAdvice(datasetCode, [firstDotted, ...otherDotted]);
    sentences[dottedAt] = advice.hint;
    for (const literal of advice.literals) literals.add(literal);
  }
  return { literals: [...literals], sentences, unresolved, validValues };
}

/**
 * Tell the caller how to shrink a refused request, naming the dimensions of this
 * dataset it left unfiltered. `dimensions` is the dataset's key dimensions, or
 * undefined when they could not be read; `filtered` names the dimensions the request
 * filtered, in any case.
 */
export function narrowingAdvice(
  datasetCode: string,
  dimensions: string[] | undefined,
  filtered: string[],
): string {
  if (!dimensions) {
    return `Add dimension filters — eurostat_get_dataset_info lists the dimensions of "${datasetCode}" — or a narrower since_period/until_period range.`;
  }
  const done = new Set(filtered.map((dim) => dim.toLowerCase()));
  const open = dimensions.filter((dim) => dim !== 'time' && !done.has(dim.toLowerCase()));
  return open.length > 0
    ? `Filter on ${open.join(', ')} — the dimensions of "${datasetCode}" this request left unfiltered — or narrow since_period/until_period.`
    : `Every dimension of "${datasetCode}" (${dimensions.join(', ')}) is already filtered: select fewer values per dimension, or a narrower since_period/until_period range.`;
}
