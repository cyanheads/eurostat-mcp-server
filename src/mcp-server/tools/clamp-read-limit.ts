/**
 * @fileoverview Bound read previews and search pages, disclosing each applied clamp.
 * @module mcp-server/tools/clamp-read-limit
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';

const clamps = createCounter(
  'eurostat.limit_clamps',
  'Read limits clamped to their supported maximum',
  '{clamps}',
);

/** Returns the effective limit and records one clamp, labelled only by tool. */
export function clampReadLimit(
  requested: number,
  maximum: number,
  field: 'preview_limit' | 'limit',
  toolName:
    | 'eurostat_query_dataset'
    | 'eurostat_download_dataset'
    | 'eurostat_search_datasets'
    | 'eurostat_get_dimension_values',
  ctx: Pick<Context, 'log'>,
): { value: number; notice?: string } {
  if (requested <= maximum) return { value: requested };
  ctx.log.info('Read limit clamped', { tool: toolName, field, requested, applied: maximum });
  clamps.add(1, { tool: toolName });
  return {
    value: maximum,
    notice: `${field} requested ${requested}; applied ${maximum}, the supported maximum.`,
  };
}
