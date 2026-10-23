/**
 * @fileoverview Advertised read-limit policies and clamp accounting.
 * @module tests/tools/read-limit-policy.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { clampReadLimit } from '@/mcp-server/tools/clamp-read-limit.js';
import { createEurostatDownloadDataset } from '@/mcp-server/tools/definitions/eurostat-download-dataset.tool.js';
import { createEurostatQueryDataset } from '@/mcp-server/tools/definitions/eurostat-query-dataset.tool.js';
import { createEurostatSearchDatasets } from '@/mcp-server/tools/definitions/eurostat-search-datasets.tool.js';

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (original) => {
  const actual = await original<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    createCounter: (...args: Parameters<typeof actual.createCounter>) =>
      args[0] === 'eurostat.limit_clamps' ? { add } : actual.createCounter(...args),
  };
});

describe('read limit policy', () => {
  for (const [label, make, field, cap, defaults, args] of [
    ['query', createEurostatQueryDataset, 'preview_limit', 500, 50, { dataset_code: 'x' }],
    ['download', createEurostatDownloadDataset, 'preview_limit', 500, 50, { dataset_code: 'x' }],
    ['search', createEurostatSearchDatasets, 'limit', 100, 20, { query: 'GDP' }],
  ] as const) {
    it(`${label} advertises both policies and retains validation and defaults`, () => {
      const on = make(true);
      const off = make(false);
      expect(on.input.parse(args)).toHaveProperty(field, defaults);
      expect(off.input.parse(args)).toHaveProperty(field, defaults);
      for (const bad of [0, -1, 0.5, NaN, Infinity, -Infinity, '500', null]) {
        expect(on.input.safeParse({ ...args, [field]: bad }).success).toBe(false);
        expect(off.input.safeParse({ ...args, [field]: bad }).success).toBe(false);
      }
      expect(on.input.safeParse({ ...args, [field]: cap + 1 }).success).toBe(true);
      expect(on.input.safeParse({ ...args, [field]: 1e100 }).success).toBe(true);
      expect(off.input.safeParse({ ...args, [field]: cap + 1 }).success).toBe(false);
      const onSchema = z.toJSONSchema(on.input) as {
        properties: Record<string, { maximum?: number }>;
      };
      const offSchema = z.toJSONSchema(off.input) as {
        properties: Record<string, { maximum?: number }>;
      };
      expect(onSchema.properties[field]).not.toHaveProperty('maximum');
      expect(offSchema.properties[field]?.maximum).toBe(cap);
    });
  }

  it('records exactly one log and counter per clamped tool and none for in-cap requests', () => {
    add.mockClear();
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'info');
    for (const [tool, field, cap] of [
      ['eurostat_query_dataset', 'preview_limit', 500],
      ['eurostat_download_dataset', 'preview_limit', 500],
      ['eurostat_search_datasets', 'limit', 100],
    ] as const) {
      expect(clampReadLimit(cap, cap, field, tool, ctx)).toEqual({ value: cap });
      expect(clampReadLimit(cap + 1, cap, field, tool, ctx)).toEqual({
        value: cap,
        notice: `${field} requested ${cap + 1}; applied ${cap}, the supported maximum.`,
      });
      expect(add).toHaveBeenLastCalledWith(1, { tool });
      expect(log).toHaveBeenLastCalledWith('Read limit clamped', {
        tool,
        field,
        requested: cap + 1,
        applied: cap,
      });
    }
    expect(add).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('clamps finite integral values beyond the safe-integer range', () => {
    const ctx = createMockContext();
    const result = clampReadLimit(1e100, 500, 'preview_limit', 'eurostat_query_dataset', ctx);
    expect(result).toEqual({
      value: 500,
      notice: 'preview_limit requested 1e+100; applied 500, the supported maximum.',
    });
  });
});
