/**
 * @fileoverview Tool for browsing the Eurostat theme hierarchy.
 * @module mcp-server/tools/definitions/eurostat-browse-themes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEurostatCatalogueService } from '@/services/eurostat-catalogue/eurostat-catalogue-service.js';
import { outageAnswer } from '@/services/eurostat-outage.js';

export const eurostatBrowseThemes = tool('eurostat_browse_themes', {
  title: 'Browse Eurostat Theme Hierarchy',
  description:
    "Navigate the Eurostat theme tree, for discovery when you know the domain but not the dataset code; eurostat_search_datasets finds datasets by keyword. Without theme_code it returns the top-level theme folders, with one that folder's immediate subfolders and datasets. The tree is the dissemination table of contents plus the Comext host's DS-* collections: detailed trade under ext_go_detail (in ext_go) and PRODCOM under prom (in icts). A collection on neither, such as the legacy PRODCOM DS-056120, is not disseminated and appears nowhere in the tree.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    theme_code: z
      .string()
      .optional()
      .describe(
        'Folder code to expand (e.g., "economy", "reg"), matched exactly, then ignoring case. Omit for the top-level folders.',
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
                'A folder code to pass as theme_code, or a dataset code for eurostat_get_dataset_info.',
              ),
            label: z.string().describe('Display name.'),
            type: z
              .enum(['folder', 'dataset', 'table'])
              .describe('Entry type: "folder", or a queryable "dataset" or "table".'),
            hasChildren: z.boolean().describe('True when a folder holds sub-items.'),
            dataStart: z
              .string()
              .optional()
              .describe(
                'Earliest period (e.g., "1995"); omitted for folders and when not reported.',
              ),
            dataEnd: z
              .string()
              .optional()
              .describe('Latest period; omitted for folders and when not reported.'),
            obsCount: z
              .number()
              .optional()
              .describe(
                'Approximate observation count; omitted for folders and when not reported.',
              ),
            lastUpdated: z
              .string()
              .optional()
              .describe(
                'Date of the last data update (e.g., "22.05.2026"); omitted for folders and when not reported.',
              ),
          })
          .describe('A theme folder, dataset, or table entry.'),
      )
      .describe('Immediate children of theme_code, or the root themes without it.'),
    parentPath: z
      .array(z.string())
      .describe('Breadcrumb from the root to theme_code; empty at the root.'),
    otherPlacements: z
      .array(
        z
          .array(z.string())
          .describe('Breadcrumb from the root to one other folder carrying the code.'),
      )
      .optional()
      .describe(
        'Breadcrumbs of other branches filing this same folder code. items come from the first branch the catalogue lists, which never has fewer children but can list different ones; reach the others by browsing down from the root. Omitted for a code with one placement.',
      ),
    nextStep: z.string().optional().describe('Suggested next call, when one is clear.'),
  }),
  enrichment: {
    itemCount: z.number().describe('Number of items at this level.'),
    themeCode: z.string().optional().describe('Folder code browsed; omitted at the root.'),
    comextListMissing: z
      .boolean()
      .optional()
      .describe(
        'True on a browse of ext_go or icts when the Comext dataflow list could not be loaded, so its DS-* collection folder is not listed. Omitted otherwise.',
      ),
    catalogueLoadedAt: z
      .string()
      .optional()
      .describe(
        'When the catalogue that answered was loaded (ISO 8601); present only when a failed refresh left that older copy in service.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Names any part of the catalogue missing from this listing and what to do about it.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'theme_code is not in the catalogue, or is a Comext folder (ext_go_detail, prom, comext) or DS-* code while the Comext list cannot be loaded.',
      recovery:
        'Call eurostat_browse_themes without theme_code to see valid root themes, then navigate from there. A Comext folder missing because its list could not be loaded returns once the merge is retried, about once a minute; eurostat_get_dataset_info reads a DS-* code directly.',
    },
    {
      reason: 'not_a_folder',
      code: JsonRpcErrorCode.ValidationError,
      when: 'theme_code names a dataset or table, not a folder.',
      recovery:
        'Pass the code to eurostat_get_dataset_info to inspect it, then eurostat_query_dataset to retrieve data.',
    },
    {
      reason: 'upstream_fault',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "No catalogue was loaded yet and Eurostat's table of contents could not be read: marked retryable after a timeout, rate limit, server error or unreachable host on every retry, not after a refusal Eurostat would repeat. Once a catalogue is loaded, a failed refresh serves that copy instead.",
      recovery:
        "Retry in a few minutes: the catalogue load failed on Eurostat's side and runs again on the next call.",
    },
  ],

  async handler(input, ctx) {
    const svc = getEurostatCatalogueService();
    const themeCode = input.theme_code?.trim() || undefined;
    let browsed: Awaited<ReturnType<typeof svc.browse>>;
    try {
      browsed = await svc.browse(themeCode, ctx);
    } catch (err) {
      const data = (err as McpError).data;
      if (data?.reason === 'not_found') {
        const stale = data.catalogueLoadedAt
          ? `The catalogue could not be refreshed, so this lookup ran against the copy loaded at ${data.catalogueLoadedAt}; folders Eurostat added since then are not in it.`
          : undefined;
        const hint = data.comextListMissing
          ? [
              `The Comext dataflow list merge is retried about once a minute: browse "${themeCode}" again after that. eurostat_get_dataset_info reads a DS-* code directly.`,
              stale,
            ]
          : [
              stale,
              'Call eurostat_browse_themes without theme_code to see valid root themes, then navigate from there.',
            ];
        throw ctx.fail('not_found', (err as Error).message, {
          recovery: { hint: hint.filter(Boolean).join(' ') },
        });
      }
      if (data?.reason === 'not_a_folder') {
        const canonicalThemeCode = data.themeCode;
        throw ctx.fail('not_a_folder', (err as Error).message, {
          themeCode: canonicalThemeCode,
          entryType: data.entryType,
          recovery: {
            hint: `Pass "${canonicalThemeCode}" as dataset_code to eurostat_get_dataset_info to inspect its dimensions, then eurostat_query_dataset to retrieve data.`,
          },
        });
      }
      if (data?.reason === 'upstream_fault' && data.retryable === true) {
        throw ctx.fail('upstream_fault', (err as Error).message, {
          retryable: true,
          recovery: {
            hint: `Eurostat's table of contents ${outageAnswer(data.status)} on every attempt, so there is no catalogue to browse yet — an upstream outage, not a fault in the request. The load runs again on the next call, so retry in a few minutes.`,
          },
        });
      }
      throw err;
    }
    const {
      comextListMissing,
      catalogueLoadedAt,
      themeCode: canonicalThemeCode,
      ...listing
    } = browsed;
    ctx.log.info('Theme browse complete', { themeCode, itemCount: listing.items.length });
    ctx.enrich({
      itemCount: listing.items.length,
      ...(canonicalThemeCode && { themeCode: canonicalThemeCode }),
      ...(comextListMissing && { comextListMissing }),
      ...(catalogueLoadedAt && { catalogueLoadedAt }),
    });
    // `notice` is last-wins, so every sentence is collected here and written once.
    const notices: string[] = [];
    if (comextListMissing) {
      notices.push(
        'The Comext dataflow list could not be loaded, so the DS-* collections filed in this folder are not listed; the merge is retried about once a minute. eurostat_get_dataset_info reads a DS-* code directly.',
      );
    }
    if (catalogueLoadedAt) {
      notices.push(
        `The catalogue could not be refreshed, so this listing comes from the copy loaded at ${catalogueLoadedAt}; folders and datasets Eurostat added or changed since then are not reflected.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    const nextStep =
      listing.items.length === 0
        ? undefined
        : listing.items.some((i) => i.type !== 'folder')
          ? `Pass a dataset/table code to eurostat_get_dataset_info to inspect dimensions. Pass a folder code back to theme_code to drill deeper.`
          : `Pass a folder code back to theme_code to drill into sub-themes.`;
    return { ...listing, ...(nextStep && { nextStep }) };
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
        `  **Code:** ${item.code} | **Type:** ${item.type}${item.hasChildren ? ' (has children)' : ' (no children)'}`,
      );
      if (item.dataStart || item.dataEnd) {
        lines.push(`  **Period:** ${item.dataStart ?? '?'} – ${item.dataEnd ?? '?'}`);
      }
      if (item.obsCount != null)
        lines.push(`  **Observations:** ${item.obsCount.toLocaleString('en-US')}`);
      if (item.lastUpdated) lines.push(`  **Last updated:** ${item.lastUpdated}`);
    }
    if (result.otherPlacements && result.otherPlacements.length > 0) {
      lines.push(
        `\n**Also filed under:** this code appears in ${result.otherPlacements.length} other branch${result.otherPlacements.length !== 1 ? 'es' : ''} — ${result.otherPlacements.map((p) => p.join(' › ')).join('; ')}. The items above are from the branch listed first in the catalogue.`,
      );
    }
    if (result.nextStep) lines.push(`\n**Next step:** ${result.nextStep}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
