/**
 * @fileoverview Recovery wording that names a dataset's own dimensions, shared by the two
 * data tools: the best-effort structure read behind it, and the advice for a request
 * Eurostat refused as too large.
 * @module mcp-server/tools/narrowing-advice
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

/**
 * Total allowance for the read behind a hint, every attempt and backoff included. It
 * runs after the request it explains, which can have spent its own 30 s, and MCP SDK
 * clients give up at 60 s. The structure definition answers in about half a second.
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
