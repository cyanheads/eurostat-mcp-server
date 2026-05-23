/**
 * @fileoverview Eurostat Catalogue Service — fetches and caches the TOC TXT file,
 * provides dataset search and theme tree navigation.
 * @module services/eurostat-catalogue/eurostat-catalogue-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { BrowseItem, DatasetResult, TocEntry } from './types.js';

// Context satisfies the runtime contract of RequestContext (requestId, tenantId, etc.)
// but lacks the [key: string]: unknown index signature required by fetchWithTimeout/withRetry.
const asReqCtx = (ctx: Context) => ctx as unknown as Record<string, unknown> & typeof ctx;

/** Parsed TOC held in memory for the session lifetime. */
interface TocCache {
  /** Map from code → entry index for O(1) lookup. */
  codeIndex: Map<string, number>;
  entries: TocEntry[];
  loadedAt: Date;
}

export class EurostatCatalogueService {
  private cache: TocCache | undefined;

  // config and storage accepted to match the standard service init pattern;
  // this service uses only the Eurostat public API and per-request config.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Ensure the TOC is loaded, fetching if not yet cached. */
  private async ensureLoaded(ctx: Context): Promise<TocCache> {
    if (this.cache) return this.cache;
    this.cache = await this.fetchAndParseToc(ctx);
    return this.cache;
  }

  private async fetchAndParseToc(ctx: Context): Promise<TocCache> {
    const { baseUrl, requestTimeoutMs } = getServerConfig();
    const url = `${baseUrl}/catalogue/toc/txt?lang=en`;
    ctx.log.info('Fetching Eurostat TOC', { url });

    const text = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, requestTimeoutMs, asReqCtx(ctx), {
          signal: ctx.signal,
        });
        const body = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(body)) {
          throw serviceUnavailable(
            'Eurostat TOC returned HTML instead of TSV — likely rate-limited or temporarily unavailable.',
          );
        }
        return body;
      },
      { operation: 'fetchToc', context: asReqCtx(ctx), baseDelayMs: 1000, signal: ctx.signal },
    );

    const entries = this.parseToc(text);
    const codeIndex = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      // noUncheckedIndexedAccess: entries[i] is always defined in a length-bounded loop
      const e = entries[i];
      if (e) codeIndex.set(e.code, i);
    }
    ctx.log.info('TOC loaded', { entryCount: entries.length });
    return { entries, codeIndex, loadedAt: new Date() };
  }

  /**
   * Parse the TSV TOC format.
   * Header: title, code, type, last update of data, last table structure change,
   *         data start, data end, values (datasets only — 7 vs 8 cols).
   * Title column uses 4 spaces per depth level as indentation.
   */
  private parseToc(text: string): TocEntry[] {
    const lines = text.split('\n');
    const entries: TocEntry[] = [];
    // Stack of [depth, entryIndex] for tracking parent relationships.
    const depthStack: Array<{ depth: number; index: number }> = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      // Split tab-separated fields. Each non-numeric field is double-quoted.
      const cols = line.split('\t');
      if (cols.length < 7) continue;

      // cols.length >= 7 is asserted above — these accesses are safe
      const rawTitle = this.unquote(cols[0]!);
      if (!rawTitle) continue;

      // First column is the raw header row
      const code = this.unquote(cols[1]!);
      const typeRaw = this.unquote(cols[2]!);

      // Skip header row
      if (code === 'code') continue;
      if (!code) continue;

      const type = this.parseType(typeRaw);
      const depth = this.measureDepth(rawTitle);
      const label = rawTitle.trimStart();

      // Resolve parent index from the depth stack
      while (depthStack.length > 0) {
        const top = depthStack[depthStack.length - 1];
        if (top === undefined || top.depth < depth) break;
        depthStack.pop();
      }
      const stackTop = depthStack[depthStack.length - 1];
      const parentIndex = stackTop !== undefined ? stackTop.index : -1;

      const lastUpdated = cols[3] ? this.unquote(cols[3]) || undefined : undefined;
      const dataStart = cols[5] ? this.unquote(cols[5]!) || undefined : undefined;
      const dataEnd = cols[6] ? this.unquote(cols[6]!) || undefined : undefined;

      // 8th column (index 7) is obs count — only present for datasets/tables
      let obsCount: number | undefined;
      const col7 = cols[7];
      if (cols.length >= 8 && col7) {
        const raw = col7.trim();
        if (raw) {
          const n = parseInt(raw, 10);
          if (!isNaN(n)) obsCount = n;
        }
      }

      const entry: TocEntry = {
        label,
        code,
        type,
        depth,
        parentIndex,
        ...(lastUpdated && { lastUpdated }),
        ...(dataStart && { dataStart }),
        ...(dataEnd && { dataEnd }),
        ...(obsCount !== undefined && { obsCount }),
      };

      const idx = entries.length;
      entries.push(entry);
      depthStack.push({ depth, index: idx });
    }

    return entries;
  }

  private unquote(s: string): string {
    const t = s?.trim() ?? '';
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).trim();
    return t;
  }

  private measureDepth(title: string): number {
    let spaces = 0;
    for (const c of title) {
      if (c === ' ') spaces++;
      else break;
    }
    return Math.floor(spaces / 4);
  }

  private parseType(raw: string): 'dataset' | 'table' | 'folder' {
    if (raw === 'dataset') return 'dataset';
    if (raw === 'table') return 'table';
    return 'folder';
  }

  /**
   * Build a breadcrumb path from root to a given entry (exclusive of the entry itself).
   */
  private buildPath(entries: TocEntry[], entryIndex: number): string[] {
    const path: string[] = [];
    let current: TocEntry | undefined = entries[entryIndex];
    while (current !== undefined && current.parentIndex >= 0) {
      const parent: TocEntry | undefined = entries[current.parentIndex];
      if (parent === undefined) break;
      path.unshift(parent.label);
      current = parent;
    }
    return path;
  }

  /**
   * Find the "root" of the TOC — the 11 second-level theme folders.
   * The TOC has a single depth-0 root ("Database by themes"); we skip it
   * and return its depth-1 children as the practical entry points.
   */
  private findRootChildren(entries: TocEntry[]): number[] {
    const rootIdx = entries.findIndex((e) => e.depth === 0 && e.type === 'folder');
    if (rootIdx === -1) {
      return entries.map((_, i) => i).filter((i) => (entries[i]?.depth ?? -1) === 0);
    }
    return entries.map((_, i) => i).filter((i) => entries[i]?.parentIndex === rootIdx);
  }

  /** Get immediate children of a folder code, or root theme folders if code is undefined. */
  async browse(
    themeCode: string | undefined,
    ctx: Context,
  ): Promise<{ items: BrowseItem[]; parentPath: string[] }> {
    const toc = await this.ensureLoaded(ctx);

    if (!themeCode) {
      const childIndexes = this.findRootChildren(toc.entries);
      const items = childIndexes.flatMap((i) => {
        const item = this.toBrowseItem(toc.entries, i);
        return item ? [item] : [];
      });
      return { items, parentPath: [] };
    }

    const folderIdxMaybe = toc.codeIndex.get(themeCode);
    const folderEntry = folderIdxMaybe !== undefined ? toc.entries[folderIdxMaybe] : undefined;
    if (
      folderIdxMaybe === undefined ||
      folderEntry === undefined ||
      folderEntry.type !== 'folder'
    ) {
      throw notFound(
        `Theme "${themeCode}" not found in the Eurostat TOC. Use eurostat_browse_themes without theme_code to see top-level themes, then navigate from there.`,
        { themeCode },
      );
    }
    const folderIdx: number = folderIdxMaybe;

    const childIndexes = toc.entries
      .map((_, i) => i)
      .filter((i) => toc.entries[i]?.parentIndex === folderIdx);

    const items = childIndexes.flatMap((i) => {
      const item = this.toBrowseItem(toc.entries, i);
      return item ? [item] : [];
    });
    const parentPath = this.buildPath(toc.entries, folderIdx);
    parentPath.push(folderEntry.label);

    return { items, parentPath };
  }

  private toBrowseItem(entries: TocEntry[], index: number): BrowseItem | undefined {
    const e: TocEntry | undefined = entries[index];
    if (!e) return;
    const hasChildren = e.type === 'folder' && entries.some((c) => c.parentIndex === index);
    return {
      code: e.code,
      label: e.label,
      type: e.type,
      hasChildren,
      ...(e.dataStart && { dataStart: e.dataStart }),
      ...(e.dataEnd && { dataEnd: e.dataEnd }),
      ...(e.obsCount !== undefined && { obsCount: e.obsCount }),
    };
  }

  /**
   * Search datasets by case-insensitive substring match against labels.
   * Returns datasets only (not folders), up to `limit` results.
   */
  async search(
    query: string,
    limit: number,
    ctx: Context,
  ): Promise<{ datasets: DatasetResult[]; totalMatches: number }> {
    const toc = await this.ensureLoaded(ctx);
    const q = query.toLowerCase();

    const matched = toc.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type !== 'folder' && e.label.toLowerCase().includes(q));

    const totalMatches = matched.length;
    const sliced = matched.slice(0, limit);

    const datasets: DatasetResult[] = sliced.map(({ e, i }) => ({
      code: e.code,
      label: e.label,
      type: e.type as 'dataset' | 'table',
      ...(e.dataStart && { dataStart: e.dataStart }),
      ...(e.dataEnd && { dataEnd: e.dataEnd }),
      ...(e.lastUpdated && { lastUpdated: e.lastUpdated }),
      ...(e.obsCount !== undefined && { obsCount: e.obsCount }),
      themePath: this.buildPath(toc.entries, i),
    }));

    return { datasets, totalMatches };
  }
}

// --- Init/accessor pattern ---

let _service: EurostatCatalogueService | undefined;

export function initEurostatCatalogueService(config: AppConfig, storage: StorageService): void {
  _service = new EurostatCatalogueService(config, storage);
}

export function getEurostatCatalogueService(): EurostatCatalogueService {
  if (!_service) {
    throw new Error(
      'EurostatCatalogueService not initialized — call initEurostatCatalogueService() in setup()',
    );
  }
  return _service;
}
