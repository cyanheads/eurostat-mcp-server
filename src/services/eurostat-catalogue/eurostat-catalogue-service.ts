/**
 * @fileoverview Eurostat Catalogue Service — fetches and caches the TOC TXT file,
 * provides dataset search and theme tree navigation.
 * @module services/eurostat-catalogue/eurostat-catalogue-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { invalidParams, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  decodeCursor,
  encodeCursor,
  fetchWithTimeout,
  type PaginationState,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { BrowseItem, DatasetResult, TocEntry } from './types.js';

/** Upper bound on datasets returned per search page, mirroring the tool's `limit` cap. */
const MAX_PAGE_SIZE = 100;

/**
 * How long a failed refresh keeps the stale cache in service before upstream is
 * tried again. `withRetry` bounds one attempt; this bounds the attempt rate, so
 * an upstream outage costs one fetch per minute rather than one per call.
 */
const REFRESH_RETRY_COOLDOWN_MS = 60_000;

/** Parsed TOC held in memory until its TTL expires and the next call refreshes it. */
interface TocCache {
  /** Map from code → entry index for O(1) lookup. */
  codeIndex: Map<string, number>;
  entries: TocEntry[];
  loadedAt: Date;
}

export class EurostatCatalogueService {
  private cache: TocCache | undefined;
  /** Shared in-flight refresh so concurrent callers past the TTL trigger one fetch. */
  private refresh: Promise<TocCache> | undefined;
  /** Epoch ms before which a stale cache is served without re-attempting a failed refresh. */
  private refreshRetryAt = 0;

  // config and storage accepted to match the standard service init pattern;
  // this service uses only the Eurostat public API and per-request config.
  // biome-ignore lint/complexity/noUselessConstructor: standard init pattern
  constructor(_config: AppConfig, _storage: StorageService) {}

  /**
   * Ensure a usable TOC is loaded. A cache younger than the configured TTL is
   * reused as-is; past the TTL one refresh runs and concurrent callers share it.
   * A failed refresh keeps serving the last known-good cache and holds off the
   * next attempt for `REFRESH_RETRY_COOLDOWN_MS`, so an outage does not make
   * every catalogue call pay a full retry-and-backoff cycle. Only a cold-start
   * failure surfaces to the caller, and that path retries on the next call.
   */
  private async ensureLoaded(ctx: Context): Promise<TocCache> {
    const cached = this.cache;
    const now = Date.now();
    if (cached) {
      if (now - cached.loadedAt.getTime() < getServerConfig().tocCacheTtlMs) return cached;
      if (now < this.refreshRetryAt) return cached;
    }

    this.refresh ??= this.fetchAndParseToc(ctx)
      .then((fresh) => {
        this.cache = fresh;
        this.refreshRetryAt = 0;
        return fresh;
      })
      .catch((error: unknown) => {
        this.refreshRetryAt = Date.now() + REFRESH_RETRY_COOLDOWN_MS;
        throw error;
      })
      .finally(() => {
        this.refresh = undefined;
      });

    if (!cached) return this.refresh;

    try {
      return await this.refresh;
    } catch (error) {
      ctx.log.warning('Eurostat TOC refresh failed — serving the last loaded catalogue', {
        error: error instanceof Error ? error.message : String(error),
        loadedAt: cached.loadedAt.toISOString(),
        retryAfterMs: REFRESH_RETRY_COOLDOWN_MS,
      });
      return cached;
    }
  }

  private async fetchAndParseToc(ctx: Context): Promise<TocCache> {
    const { baseUrl, requestTimeoutMs } = getServerConfig();
    const url = `${baseUrl}/catalogue/toc/txt?lang=en`;
    ctx.log.info('Fetching Eurostat TOC', { url });

    const text = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, requestTimeoutMs, ctx, {
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
      { operation: 'fetchToc', context: ctx, baseDelayMs: 1000, signal: ctx.signal },
    );

    const entries = this.parseToc(text);
    const codeIndex = this.buildCodeIndex(entries);
    ctx.log.info('TOC loaded', { entryCount: entries.length });
    return { entries, codeIndex, loadedAt: new Date() };
  }

  /**
   * Index code → entry position, keeping the FIRST placement of a code filed more than once.
   *
   * Eurostat files some folder codes under several TOC branches — a "Cross cutting topics"
   * tree re-files part of the primary "Database by themes" tree under other groupings, and
   * a few survey folders are relisted per wave within the primary tree itself. Keeping the
   * last placement made the earlier branch unreachable by code, and the earlier branch never
   * lists fewer children than the ones it shadows. First-wins is the same
   * canonical-placement rule `search()` applies to duplicate dataset codes.
   */
  private buildCodeIndex(entries: TocEntry[]): Map<string, number> {
    const codeIndex = new Map<string, number>();
    entries.forEach((e, i) => {
      if (!codeIndex.has(e.code)) codeIndex.set(e.code, i);
    });
    return codeIndex;
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

      // Destructure after length guard — all indices 0-6 are safe
      const [col0, col1, col2, col3, , col5, col6] = cols;
      const rawTitle = col0 ? this.unquote(col0) : '';
      if (!rawTitle) continue;

      const code = col1 ? this.unquote(col1) : '';
      const typeRaw = col2 ? this.unquote(col2) : '';

      // Skip header row
      if (code === 'code' || !code) continue;

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
      const parentIndex = stackTop?.index ?? -1;

      const lastUpdated = col3 ? this.unquote(col3) || undefined : undefined;
      const dataStart = col5 ? this.unquote(col5).trim() || undefined : undefined;
      const dataEnd = col6 ? this.unquote(col6).trim() || undefined : undefined;

      // 8th column (index 7) is obs count — only present for datasets/tables
      let obsCount: number | undefined;
      const col7 = cols[7];
      if (cols.length >= 8 && col7) {
        const raw = col7.trim();
        if (raw) {
          const n = parseInt(raw, 10);
          if (!Number.isNaN(n)) obsCount = n;
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
    const t = s.trimEnd();
    const trimmed = t.trimStart();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      // Preserve leading spaces — they encode depth (4 spaces per level)
      const leading = t.slice(0, t.length - trimmed.length);
      return leading + trimmed.slice(1, -1);
    }
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
      const parent = entries[current.parentIndex];
      if (parent === undefined) break;
      path.unshift(parent.label);
      current = parent;
    }
    return path;
  }

  /** Return indexes of entries satisfying a predicate. */
  private indexesWhere(entries: TocEntry[], pred: (e: TocEntry) => boolean): number[] {
    return entries.reduce<number[]>((acc, e, i) => {
      if (pred(e)) acc.push(i);
      return acc;
    }, []);
  }

  /**
   * Find the top-level theme folders — the depth-1 children of every depth-0
   * folder root. The live TOC can carry more than one depth-0 root (e.g.
   * "Database by themes" plus a separate "Cross cutting topics" block), so we
   * union the children of all of them, in root order, to keep every top-level
   * theme reachable from a root-level browse.
   */
  private findRootChildren(entries: TocEntry[]): number[] {
    const rootIdxs = this.indexesWhere(entries, (e) => e.depth === 0 && e.type === 'folder');
    if (rootIdxs.length === 0) {
      return this.indexesWhere(entries, (e) => e.depth === 0);
    }
    return rootIdxs.flatMap((rootIdx) =>
      this.indexesWhere(entries, (e) => e.parentIndex === rootIdx),
    );
  }

  /**
   * Get immediate children of a folder code, or root theme folders if code is undefined.
   *
   * A code filed under more than one branch resolves to its first placement (see
   * `buildCodeIndex`); the breadcrumbs of the branches not taken are returned as
   * `otherPlacements` so the caller can see that the code was ambiguous and which
   * alternatives exist.
   */
  async browse(
    themeCode: string | undefined,
    ctx: Context,
  ): Promise<{ items: BrowseItem[]; parentPath: string[]; otherPlacements?: string[][] }> {
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
        { reason: 'not_found', themeCode },
      );
    }
    const childIndexes = this.indexesWhere(toc.entries, (e) => e.parentIndex === folderIdxMaybe);

    const items = childIndexes.flatMap((i) => {
      const item = this.toBrowseItem(toc.entries, i);
      return item ? [item] : [];
    });
    const parentPath = this.buildPath(toc.entries, folderIdxMaybe);
    parentPath.push(folderEntry.label);

    const otherPlacements = this.indexesWhere(
      toc.entries,
      (e) => e.code === themeCode && e.type === 'folder',
    )
      .filter((i) => i !== folderIdxMaybe)
      .map((i) => {
        const path = this.buildPath(toc.entries, i);
        path.push(toc.entries[i]?.label ?? themeCode);
        return path;
      });

    return { items, parentPath, ...(otherPlacements.length > 0 && { otherPlacements }) };
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
   * Decode a search cursor and confirm it belongs to this search. Malformed,
   * cross-query and superseded-snapshot cursors are rejected identically —
   * the caller's recovery is the same in all three cases, and the cursor is
   * opaque, so telling them apart would only describe its internal shape.
   */
  private decodeSearchCursor(
    cursor: string,
    queryKey: string,
    generation: number,
    ctx: Context,
  ): PaginationState {
    try {
      const state = decodeCursor(cursor, ctx);
      if (state.query === queryKey && state.generation === generation) return state;
    } catch {
      // Undecodable cursor — same rejection as one that decodes but does not match.
    }
    throw invalidParams(
      'Unusable pagination cursor: it is malformed, was issued for a different query, or was issued against a catalogue snapshot that has since refreshed. Repeat the search without a cursor, then page with the nextCursor it returns.',
      { reason: 'invalid_cursor' },
    );
  }

  /**
   * Search datasets by keyword. The query is tokenized on whitespace and every
   * token must match (AND), case-insensitively, somewhere in a combined
   * `label + themePath + code` haystack — so concept-order and theme-named
   * queries resolve even when no single label contains the phrase verbatim.
   * A query with no non-whitespace token matches nothing rather than everything.
   *
   * Returns datasets only (not folders), one row per code: a dataset filed under
   * several TOC branches keeps its first matching placement as the canonical
   * `themePath`, so totals and page slots count unique query targets.
   *
   * Results are paginated with an opaque cursor (`limit` = page size, capped at
   * 100) bound to the normalized query and the catalogue snapshot that produced
   * it. An unusable cursor — malformed, from another query, or from a catalogue
   * since refreshed — is rejected as `invalid_cursor` instead of silently paging
   * a different result set.
   */
  async search(
    query: string,
    limit: number,
    cursor: string | undefined,
    ctx: Context,
  ): Promise<{ datasets: DatasetResult[]; totalMatches: number; nextCursor?: string }> {
    const toc = await this.ensureLoaded(ctx);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { datasets: [], totalMatches: 0 };

    const seen = new Set<string>();
    const matched = toc.entries.flatMap((e, i) => {
      if (e.type === 'folder' || seen.has(e.code)) return [];
      const themePath = this.buildPath(toc.entries, i);
      const haystack = `${e.label} ${themePath.join(' ')} ${e.code}`.toLowerCase();
      if (!tokens.every((t) => haystack.includes(t))) return [];
      seen.add(e.code);
      return [{ e, themePath }];
    });

    /** Cursor identity: the normalized query plus the catalogue snapshot it was paged over. */
    const queryKey = tokens.join(' ');
    const generation = toc.loadedAt.getTime();

    let offset = 0;
    let pageSize = limit;
    if (cursor) {
      const state = this.decodeSearchCursor(cursor, queryKey, generation, ctx);
      offset = state.offset;
      pageSize = Math.min(state.limit, MAX_PAGE_SIZE);
    }

    const datasets: DatasetResult[] = matched
      .slice(offset, offset + pageSize)
      .map(({ e, themePath }) => ({
        code: e.code,
        label: e.label,
        type: e.type as 'dataset' | 'table',
        ...(e.dataStart && { dataStart: e.dataStart }),
        ...(e.dataEnd && { dataEnd: e.dataEnd }),
        ...(e.lastUpdated && { lastUpdated: e.lastUpdated }),
        ...(e.obsCount !== undefined && { obsCount: e.obsCount }),
        themePath,
      }));

    const nextOffset = offset + pageSize;
    return {
      datasets,
      totalMatches: matched.length,
      ...(nextOffset < matched.length && {
        nextCursor: encodeCursor({
          offset: nextOffset,
          limit: pageSize,
          query: queryKey,
          generation,
        }),
      }),
    };
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
