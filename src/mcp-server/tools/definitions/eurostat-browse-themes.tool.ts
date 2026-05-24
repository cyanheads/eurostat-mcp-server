/**
 * @fileoverview Tool for browsing the Eurostat theme hierarchy.
 * @module mcp-server/tools/definitions/eurostat-browse-themes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';

export const eurostatBrowseThemes = tool('eurostat_browse_themes', {
  title: 'Browse Eurostat Theme Hierarchy',
  description:
    'Navigate the Eurostat theme tree. Without theme_code returns the 11 top-level theme folders (Economy, Population, Transport, etc.) — the practical starting points. With a theme_code returns its immediate children: subtheme folders and datasets in that branch. Use this for structured discovery when you know the domain but not the dataset code, or to drill down from a broad topic to a specific dataset. Pair with eurostat_search_datasets for keyword-based discovery.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    theme_code: z
      .string()
      .optional()
      .describe(
        'Folder code to expand (e.g., "econ", "reg"). Omit to list the 11 top-level theme folders.',
      ),
  }),
  output: z.object({
    items: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Theme or dataset code. Pass to theme_code to drill into a folder, or use as dataset_code for data tools.',
              ),
            label: z.string().describe('Human-readable name.'),
            type: z
              .enum(['folder', 'dataset', 'table'])
              .describe(
                'Item type: "folder" has sub-items; "dataset"/"table" can be queried for data.',
              ),
            hasChildren: z
              .boolean()
              .describe(
                'True when this folder contains sub-items. Only meaningful for type "folder".',
              ),
            dataStart: z
              .string()
              .optional()
              .describe(
                'Earliest data period (e.g., "1995"). Omitted for folders and when not reported.',
              ),
            dataEnd: z
              .string()
              .optional()
              .describe('Most recent data period. Omitted for folders and when not reported.'),
            obsCount: z
              .number()
              .optional()
              .describe(
                'Approximate observation count. Omitted for folders and when not reported.',
              ),
          })
          .describe('A theme folder, dataset, or table entry.'),
      )
      .describe(
        'Immediate children of the requested theme, or the 11 root themes if theme_code was omitted.',
      ),
    parentPath: z
      .array(z.string())
      .describe(
        'Breadcrumb from root to the requested theme (e.g., ["Economy and finance", "National accounts"]). Empty when browsing root.',
      ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The provided theme_code does not exist as a folder in the TOC.',
      recovery:
        'Call eurostat_browse_themes without theme_code to see valid root themes, then navigate from there.',
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatCatalogueService();
    const themeCode = input.theme_code?.trim() || undefined;
    const { items, parentPath } = await svc.browse(themeCode, ctx);
    ctx.log.info('Theme browse complete', { themeCode, itemCount: items.length });
    return { items, parentPath };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.parentPath.length > 0) {
      lines.push(`**Path:** ${result.parentPath.join(' › ')}\n`);
    }
    lines.push(`**${result.items.length} item${result.items.length !== 1 ? 's' : ''}**\n`);
    for (const item of result.items) {
      const icon = item.type === 'folder' ? '📁' : '📊';
      lines.push(`${icon} **${item.label}**`);
      lines.push(
        `  **Code:** ${item.code} | **Type:** ${item.type}${item.hasChildren ? ' (has children)' : ''}`,
      );
      if (item.dataStart || item.dataEnd) {
        lines.push(`  **Period:** ${item.dataStart ?? '?'} – ${item.dataEnd ?? '?'}`);
      }
      if (item.obsCount != null)
        lines.push(`  **Observations:** ${item.obsCount.toLocaleString()}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
