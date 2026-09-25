/**
 * @fileoverview Recovery wording for a request Eurostat refused as too large, shared by
 * the two data tools so both name the dataset's own dimensions the same way.
 * @module mcp-server/tools/narrowing-advice
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { getEurostatDataService } from '@/services/eurostat-data/eurostat-data-service.js';

/**
 * The dataset's key dimensions, for a too-large refusal's hint to name. `known` is the
 * order the request already read, if any; otherwise the structure definition is read
 * now, a few KB. The refusal itself carries no dimension list, and the hint is only
 * more specific with one, so a failed read leaves it generic rather than replacing the
 * refusal with a second error.
 */
export async function dimensionsToNarrow(
  datasetCode: string,
  known: string[],
  ctx: Context,
): Promise<string[] | undefined> {
  if (known.length > 0) return known;
  try {
    return await getEurostatDataService().getDimensionOrder(datasetCode, ctx);
  } catch (error) {
    ctx.log.debug('Could not read dimensions for a too-large refusal hint', {
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
