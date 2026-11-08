/**
 * @fileoverview Eurostat Catalogue Service — fetches and caches the TOC TXT file,
 * provides dataset search and theme tree navigation.
 * @module services/eurostat-catalogue/eurostat-catalogue-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  invalidParams,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  decodeCursor,
  encodeCursor,
  fetchWithTimeout,
  logger,
  type PaginationState,
  requestContextService,
  runDetached,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  parseSdmxDataflowList,
  type SdmxDataflowSummary,
} from '@/services/eurostat-data/sdmx-metadata.js';
import { upstreamOutage } from '@/services/eurostat-outage.js';
import { awaitShared } from '@/services/shared-load.js';
import { type DimensionValueIndex, fetchDimensionValueIndex } from './dimension-value-index.js';
import { foldSearchText, occursAtWordStart } from './search-text.js';
import type { BrowseItem, DatasetResult, TocEntry } from './types.js';

/** Upper bound on datasets returned per search page, mirroring the tool's `limit` cap. */
const MAX_PAGE_SIZE = 100;

/** Most distinct words a search that matches no catalogue text looks for in dimension values. */
export const MAX_VALUE_SEARCH_WORDS = 10;

/** Most distinct words, in query order, a search that matches nothing names as held by no dataset. */
export const MAX_UNMATCHED_WORD_CHECKS = 32;

/**
 * How long a failed refresh keeps the stale cache in service before upstream is
 * tried again. `withRetry` bounds one load; this bounds the attempt rate, so
 * an upstream outage costs one fetch per minute rather than one per call. A failed
 * Comext merge is retried on the same schedule.
 */
const REFRESH_RETRY_COOLDOWN_MS = 60_000;

/**
 * Where each Comext collection is filed in the TOC tree, keyed by the stem of its
 * dataflows' `ESMS_HTML` metadata page (`ext_go_detail_sims.htm`, `prom_esms.htm`) —
 * the collection's own code, absent from the TOC. The labels carry "Comext" and
 * "PRODCOM" because two PRODCOM titles contain neither word, and search reads the
 * breadcrumb.
 */
const COMEXT_FOLDERS: Readonly<Record<string, { label: string; parent: string }>> = {
  ext_go_detail: {
    label: 'International trade in goods - detailed data (Comext)',
    parent: 'ext_go',
  },
  prom: {
    label: 'Statistics on the production of manufactured goods (PRODCOM)',
    parent: 'icts',
  },
};

/** Folder for a Comext dataflow whose metadata page names no collection in {@link COMEXT_FOLDERS}. */
const COMEXT_OTHER_FOLDER = {
  code: 'comext',
  label: 'Comext dissemination database - other collections',
};

/** The TOC folders the Comext collection folders are filed under. */
const COMEXT_PARENT_FOLDERS = new Set(Object.values(COMEXT_FOLDERS).map((f) => f.parent));

/** A dataset code on the Comext host's scheme, as a lowercased search token. */
const DS_CODE_TOKEN = /^ds-\d+$/;

/**
 * How a dataset matched a search, best first: 0, its label holds the words as a phrase
 * starting at a word start; 1, its label or code holds every word; 2, some word matched
 * only in its theme breadcrumb.
 */
export type SearchTier = 0 | 1 | 2;

/**
 * The tier test for one search over `words`, whitespace-free tokens as `search()` splits a
 * query. The returned function ranks a dataset from its label, folded by
 * {@link foldSearchText}, and its code, never its breadcrumb, so every TOC placement of a
 * code ranks alike. The phrase is the words joined by single spaces and folded the same way;
 * it must start where no letter or digit precedes it, so "employment rate" is not found
 * inside "Unemployment rate". The word test is the substring test matching applies.
 */
export function searchTierOf(
  words: readonly string[],
): (foldedLabel: string, code: string) => SearchTier {
  const phrase = foldSearchText(words.join(' '));
  const distinct = [...new Set(words.map((word) => word.toLowerCase()))];
  return (label, code) => {
    if (occursAtWordStart(label, phrase)) return 0;
    const lowerCode = code.toLowerCase();
    return distinct.every((word) => label.includes(word) || lowerCode.includes(word)) ? 1 : 2;
  };
}

/** One dataset's text as search reads it ({@link foldSearchText}). */
interface SearchText {
  /** The label alone, which the tier test reads. */
  label: string;
  /** Label, breadcrumb, and code, which matching reads. */
  text: string;
}

/** Parsed TOC held in memory until its TTL expires and the next call refreshes it. */
interface TocCache {
  /** Map from code → entry index for O(1) lookup. */
  codeIndex: Map<string, number>;
  /**
   * Set when the Comext dataflow list could not be merged: the epoch ms after which
   * the next catalogue call retries the merge. `entries` then holds the TOC alone, so
   * the retry merges onto them without re-fetching the TOC.
   */
  comextRetryAt?: number;
  /** The TOC plus the merged Comext dataflows. */
  entries: TocEntry[];
  loadedAt: Date;
  /** Search text per entry, indexed like `entries` — built by the snapshot's first search. */
  searchText?: (SearchText | undefined)[];
}

/** What `countWithoutEachWord` finds for a query that matched nothing; each field is omitted when empty. */
interface BlockingWords {
  allWordsUnmatched?: true;
  unmatchedWords?: string[];
  unmatchedWordsPartial?: true;
  wordRemovalCounts?: Array<{ totalMatches: number; word: string }>;
}

/** The dimension value index and its loading state. */
interface ValueIndexSlot {
  /** Consecutive failed loads, which set the backoff before the next. */
  failures: number;
  /** The index in service: the last one that loaded, kept through a failed refresh. */
  index?: DimensionValueIndex;
  /** The load in flight. It settles without rejecting. */
  loading?: Promise<void>;
  /** Epoch ms before which no load starts after a failure; 0 once one succeeds. */
  retryAt: number;
}

/** A dataset found through dimension values, with what ranks it. */
interface ValueRow {
  dataset: number;
  /** Its TOC placement whose text matched the most query words. */
  i: number;
  /** Bit k set: query word k was found only in a dimension value label. */
  through: number;
}

/** Why a search that matched no catalogue text did not read dimension values. */
export type ValuesNotSearched = 'index_unavailable' | 'too_many_words';

/** The number of set bits of a mask of query words. */
function wordCount(mask: number): number {
  let count = 0;
  for (let rest = mask; rest !== 0; rest &= rest - 1) count += 1;
  return count;
}

export class EurostatCatalogueService {
  private cache: TocCache | undefined;
  /** Shared in-flight refresh so concurrent callers past the TTL trigger one fetch. */
  private refresh: Promise<TocCache> | undefined;
  /** Shared in-flight retry of a failed Comext merge. */
  private remerge: Promise<TocCache> | undefined;
  /**
   * Epoch ms before which a stale cache is served without re-attempting a failed refresh.
   * Non-zero exactly while the last refresh attempt failed, so the cache in service is one
   * past its TTL that the refresh could not replace.
   */
  private refreshRetryAt = 0;
  /**
   * The dimension value index a search that matches no catalogue text reads. Undefined until
   * a TOC load starts the first index load.
   */
  private valueIndex: ValueIndexSlot | undefined;

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
   *
   * A catalogue whose Comext merge failed is served as-is until its retry time,
   * then the next call retries the merge alone; that retry never fails the call.
   *
   * Both loads are shared, so they run without a caller's signal, bounded by their
   * timeouts: a caller that cancels stops waiting without failing the others,
   * caching a failure, or postponing the merge.
   */
  private ensureLoaded(ctx: Context): Promise<TocCache> {
    return awaitShared(ctx.signal, () => this.loadShared(ctx));
  }

  private async loadShared(ctx: Context): Promise<TocCache> {
    if (this.valueIndex) this.loadValueIndex(this.valueIndex);
    const cached = this.cache;
    const now = Date.now();
    if (
      cached &&
      (now - cached.loadedAt.getTime() < getServerConfig().tocCacheTtlMs ||
        now < this.refreshRetryAt)
    ) {
      return cached.comextRetryAt !== undefined && now >= cached.comextRetryAt
        ? this.retryComextMerge(cached, ctx)
        : cached;
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

  /**
   * Fetch the TOC and the Comext dataflow list together, and merge them.
   *
   * Only the TOC is required. A Comext list that fails to load leaves the catalogue
   * answering from the TOC alone: the failure is logged, and the merge is retried
   * after `REFRESH_RETRY_COOLDOWN_MS` without re-fetching the TOC.
   *
   * Every TOC load also starts the dimension value index load, which nothing awaits.
   */
  private async fetchAndParseToc(ctx: Context): Promise<TocCache> {
    this.valueIndex ??= { failures: 0, retryAt: 0 };
    this.loadValueIndex(this.valueIndex);
    const comext = this.fetchComextFlows(ctx).then(
      (flows) => ({ flows }),
      (error: unknown) => ({ error }),
    );
    const tocEntries = await this.fetchTocEntries(ctx);
    const loaded = await comext;
    if ('flows' in loaded) return this.buildCache(tocEntries, loaded.flows, new Date());
    this.logComextFailure(loaded.error, ctx);
    return this.buildCache(tocEntries, undefined, new Date());
  }

  /** Retry a failed Comext merge onto the TOC already held; concurrent callers share it. */
  private retryComextMerge(cached: TocCache, ctx: Context): Promise<TocCache> {
    this.remerge ??= this.fetchComextFlows(ctx)
      .then(
        (flows) => {
          const merged = this.buildCache(cached.entries, flows, cached.loadedAt);
          if (this.cache === cached) this.cache = merged;
          return merged;
        },
        (error: unknown) => {
          this.logComextFailure(error, ctx);
          cached.comextRetryAt = Date.now() + REFRESH_RETRY_COOLDOWN_MS;
          return cached;
        },
      )
      .finally(() => {
        this.remerge = undefined;
      });
    return this.remerge;
  }

  private logComextFailure(error: unknown, ctx: Context): void {
    ctx.log.warning(
      'Comext dataflow list unavailable — search and browse answer from the TOC alone',
      {
        error: error instanceof Error ? error.message : String(error),
        retryAfterMs: REFRESH_RETRY_COOLDOWN_MS,
      },
    );
  }

  /**
   * Start a dimension value index load unless one is in flight, a failed load's backoff has
   * not elapsed, or the index in service is younger than the TOC's TTL. Catalogue calls never
   * wait for it: the load runs detached from the calling request and its trace, logs to the
   * server log, and settles into the slot. A failure keeps the previous index in service and
   * holds off the next attempt for `REFRESH_RETRY_COOLDOWN_MS`, doubling with each failure in
   * a row up to the TOC's TTL.
   */
  private loadValueIndex(slot: ValueIndexSlot): void {
    const now = Date.now();
    const { tocCacheTtlMs } = getServerConfig();
    if (slot.loading || now < slot.retryAt) return;
    if (slot.index && now - slot.index.loadedAt < tocCacheTtlMs) return;

    const context = requestContextService.createRequestContext({
      operation: 'loadDimensionValueIndex',
    });
    slot.loading = runDetached(() => fetchDimensionValueIndex(context))
      .then(
        (index) => {
          slot.index = index;
          slot.failures = 0;
          slot.retryAt = 0;
          logger.info('Dimension value index loaded', withExtra(context, index.size));
        },
        (error: unknown) => {
          slot.failures += 1;
          const retryAfterMs = Math.min(
            REFRESH_RETRY_COOLDOWN_MS * 2 ** (slot.failures - 1),
            tocCacheTtlMs,
          );
          slot.retryAt = Date.now() + retryAfterMs;
          logger.warning(
            slot.index
              ? 'Dimension value index refresh failed — the previous index stays in service'
              : 'Dimension value index unavailable — searches that match no catalogue text do not read dimension values',
            withExtra(context, {
              error: error instanceof Error ? error.message : String(error),
              failures: slot.failures,
              retryAfterMs,
            }),
          );
        },
      )
      .finally(() => {
        delete slot.loading;
      });
  }

  /**
   * Assemble a catalogue snapshot. `flows` undefined means the Comext list failed to
   * load, which arms the merge retry. `loadedAt` is the TOC's load time — the TTL and
   * the cursor generation both key on it. A later merge only appends entries, and
   * `search()` pages entries appended after a walk began behind the ones it began over, so
   * a cursor paged over the TOC alone still pages every match once.
   */
  private buildCache(
    tocEntries: TocEntry[],
    flows: SdmxDataflowSummary[] | undefined,
    loadedAt: Date,
  ): TocCache {
    const entries = flows ? this.mergeComextFlows(tocEntries, flows) : tocEntries;
    return {
      entries,
      codeIndex: this.buildCodeIndex(entries),
      loadedAt,
      ...(!flows && { comextRetryAt: Date.now() + REFRESH_RETRY_COOLDOWN_MS }),
    };
  }

  /** The Comext host's dataflow list — the `DS-*` collections the TOC does not carry. */
  private async fetchComextFlows(ctx: Context): Promise<SdmxDataflowSummary[]> {
    const { comextBaseUrl, requestTimeoutMs } = getServerConfig();
    const fetchCtx = withExtra(ctx, { endpoint: 'comext-dataflows' });
    const text = await withRetry(
      async ({ signal }) => {
        const response = await fetchWithTimeout(
          `${comextBaseUrl}/sdmx/2.1/dataflow/ESTAT`,
          requestTimeoutMs,
          fetchCtx,
          { signal },
        );
        return response.text();
      },
      {
        operation: 'fetchComextFlows',
        context: fetchCtx,
        maxRetries: 0,
        deadlineMs: requestTimeoutMs,
      },
    );
    const flows = parseSdmxDataflowList(text);
    // An empty list is a broken answer, not an empty host: merging it would report every
    // DS-* code as undisseminated, so it is retried like any other failure.
    if (flows.length === 0) throw new Error('The Comext dataflow list listed no dataflows');
    ctx.log.info('Comext dataflow list loaded', { dataflowCount: flows.length });
    return flows;
  }

  /**
   * Append the Comext dataflows to the TOC as datasets, each under the folder its
   * collection maps to in {@link COMEXT_FOLDERS}. A folder is created only when a
   * dataflow lands in it, and is parented to its TOC folder — or to the first root
   * when the TOC no longer carries that folder. Merged entries carry `lastUpdated`
   * in the TOC's `dd.mm.yyyy` form and no period coverage or observation count,
   * which the Comext list does not publish.
   */
  private mergeComextFlows(tocEntries: TocEntry[], flows: SdmxDataflowSummary[]): TocEntry[] {
    const entries = [...tocEntries];
    const firstRoot = entries.findIndex((e) => e.depth === 0 && e.type === 'folder');
    const folderIndex = new Map<string, number>();

    const folderFor = (flow: SdmxDataflowSummary): number => {
      const stem = /([a-z0-9_]+?)(?:_sims|_esms)?\.htm$/i.exec(flow.esmsUrl ?? '')?.[1] ?? '';
      const known = COMEXT_FOLDERS[stem];
      const code = known ? stem : COMEXT_OTHER_FOLDER.code;
      const existing = folderIndex.get(code);
      if (existing !== undefined) return existing;

      const tocParent = known
        ? entries.findIndex((e) => e.code === known.parent && e.type === 'folder')
        : -1;
      const parent = tocParent >= 0 ? tocParent : firstRoot;
      entries.push({
        code,
        label: known?.label ?? COMEXT_OTHER_FOLDER.label,
        type: 'folder',
        depth: (entries[parent]?.depth ?? -1) + 1,
        parentIndex: parent,
      });
      folderIndex.set(code, entries.length - 1);
      return entries.length - 1;
    };

    for (const flow of flows) {
      const parentIndex = folderFor(flow);
      const lastUpdated = flow.lastUpdated && toTocDate(flow.lastUpdated);
      entries.push({
        code: flow.id,
        label: flow.label,
        type: 'dataset',
        depth: (entries[parentIndex]?.depth ?? 0) + 1,
        parentIndex,
        ...(lastUpdated && { lastUpdated }),
      });
    }
    return entries;
  }

  private async fetchTocEntries(ctx: Context): Promise<TocEntry[]> {
    const { baseUrl, requestTimeoutMs } = getServerConfig();
    const fetchCtx = withExtra(ctx, { endpoint: 'toc' });
    ctx.log.info('Fetching Eurostat TOC');

    const text = await withRetry(
      async ({ signal }) => {
        const response = await fetchWithTimeout(
          `${baseUrl}/catalogue/toc/txt?lang=en`,
          requestTimeoutMs,
          fetchCtx,
          { signal },
        );
        const body = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(body)) {
          throw serviceUnavailable(
            'Eurostat TOC returned HTML instead of TSV — likely rate-limited or temporarily unavailable.',
          );
        }
        return body;
      },
      { operation: 'fetchToc', context: fetchCtx, baseDelayMs: 1000, deadlineMs: requestTimeoutMs },
    ).catch((error: unknown) => {
      // The load is shared and runs without a caller's signal, so nothing here is a cancellation.
      const outage = upstreamOutage(
        error,
        "Eurostat's catalogue endpoint",
        'the table-of-contents read',
        {},
      );
      if (outage) throw outage;
      // The TOC URL carries no caller input, so any other HTTP status is a fault on Eurostat's side too.
      const status = error instanceof McpError ? error.data?.status : undefined;
      if (typeof status === 'number') {
        throw serviceUnavailable(
          `Eurostat's catalogue endpoint answered HTTP ${status} to the table-of-contents read.`,
          // 408 and 429 are transient however long they last; any other status repeats until Eurostat changes it.
          { reason: 'upstream_fault', status, retryable: status === 408 || status === 429 },
          { cause: error },
        );
      }
      throw error;
    });

    const entries = this.parseToc(text);
    ctx.log.info('TOC loaded', { entryCount: entries.length });
    return entries;
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
   * `catalogueLoadedAt` while a failed refresh keeps an expired catalogue in service — on the
   * call whose refresh failed and through the cooldown after it.
   */
  private staleness(toc: TocCache): { catalogueLoadedAt?: string } {
    return this.refreshRetryAt === 0 ? {} : { catalogueLoadedAt: toc.loadedAt.toISOString() };
  }

  /**
   * Get immediate children of a folder code, or root theme folders if code is undefined.
   *
   * A code filed under more than one branch resolves to its first placement (see
   * `buildCodeIndex`); the breadcrumbs of the branches not taken are returned as
   * `otherPlacements` so the caller can see that the code was ambiguous and which
   * alternatives exist.
   *
   * While the Comext list is not merged, a browse of a folder its collections file under
   * reports `comextListMissing`, and a Comext folder or `DS-*` code fails `not_found` with
   * `comextListMissing` in its data rather than as an unknown code. `catalogueLoadedAt`
   * marks a catalogue a failed refresh could not replace, on the listing and in the data
   * of a `not_found`.
   */
  async browse(
    themeCode: string | undefined,
    ctx: Context,
  ): Promise<{
    catalogueLoadedAt?: string;
    comextListMissing?: boolean;
    items: BrowseItem[];
    otherPlacements?: string[][];
    parentPath: string[];
    themeCode?: string;
  }> {
    const toc = await this.ensureLoaded(ctx);
    const comextListMissing = toc.comextRetryAt !== undefined;

    if (!themeCode) {
      const childIndexes = this.findRootChildren(toc.entries);
      const items = childIndexes.flatMap((i) => {
        const item = this.toBrowseItem(toc.entries, i);
        return item ? [item] : [];
      });
      return { items, parentPath: [], ...this.staleness(toc) };
    }

    let folderIdxMaybe = toc.codeIndex.get(themeCode);
    if (folderIdxMaybe === undefined) {
      const folded = themeCode.toLowerCase();
      for (const [code, index] of toc.codeIndex) {
        if (code.toLowerCase() === folded) {
          folderIdxMaybe = index;
          break;
        }
      }
    }
    const folderEntry = folderIdxMaybe !== undefined ? toc.entries[folderIdxMaybe] : undefined;
    if (folderIdxMaybe === undefined || folderEntry === undefined) {
      if (
        comextListMissing &&
        (Object.hasOwn(COMEXT_FOLDERS, themeCode.toLowerCase()) ||
          themeCode.toLowerCase() === COMEXT_OTHER_FOLDER.code ||
          DS_CODE_TOKEN.test(themeCode.toLowerCase()))
      ) {
        throw notFound(
          `Theme "${themeCode}" comes from the Comext dataflow list, which could not be loaded, so it is not in the catalogue right now.`,
          { reason: 'not_found', themeCode, comextListMissing: true, ...this.staleness(toc) },
        );
      }
      throw notFound(
        `Theme "${themeCode}" not found in the Eurostat TOC. Use eurostat_browse_themes without theme_code to see top-level themes, then navigate from there.`,
        { reason: 'not_found', themeCode, ...this.staleness(toc) },
      );
    }
    themeCode = folderEntry.code;
    if (folderEntry.type !== 'folder') {
      throw validationError(
        `Theme code "${themeCode}" identifies a ${folderEntry.type} entry, not a folder. Only folder codes can be expanded with eurostat_browse_themes.`,
        { reason: 'not_a_folder', themeCode, entryType: folderEntry.type },
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

    return {
      items,
      parentPath,
      themeCode,
      ...(otherPlacements.length > 0 && { otherPlacements }),
      ...(comextListMissing && COMEXT_PARENT_FOLDERS.has(themeCode) && { comextListMissing }),
      ...this.staleness(toc),
    };
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
   * opaque, so telling them apart would only describe its internal shape. `entryCount`,
   * the snapshot's length when the walk began, can be no more than its length now.
   * `valueIndex`, present on a walk over rows found through dimension values, is checked
   * once `search()` knows which rows it pages.
   */
  private decodeSearchCursor(
    cursor: string,
    queryKey: string,
    generation: number,
    entryCount: number,
    ctx: Context,
  ): PaginationState & { entryCount: number } {
    try {
      const state = decodeCursor(cursor, ctx);
      const walked = state.entryCount;
      if (
        state.query === queryKey &&
        state.generation === generation &&
        typeof walked === 'number' &&
        Number.isInteger(walked) &&
        walked >= 0 &&
        walked <= entryCount
      ) {
        return { ...state, entryCount: walked };
      }
    } catch {
      // Undecodable cursor — same rejection as one that decodes but does not match.
    }
    throw invalidCursor();
  }

  /** One search result row for the TOC placement `entries[i]`. */
  private toDatasetResult(entries: TocEntry[], e: TocEntry, i: number): DatasetResult {
    return {
      code: e.code,
      label: e.label,
      type: e.type as 'dataset' | 'table',
      ...(e.dataStart && { dataStart: e.dataStart }),
      ...(e.dataEnd && { dataEnd: e.dataEnd }),
      ...(e.lastUpdated && { lastUpdated: e.lastUpdated }),
      ...(e.obsCount !== undefined && { obsCount: e.obsCount }),
      themePath: this.buildPath(entries, i),
    };
  }

  /**
   * Each dataset's search text, indexed like `entries`. Folders, which search never
   * returns, are undefined.
   */
  private buildSearchText(entries: TocEntry[]): (SearchText | undefined)[] {
    return entries.map((e, i) =>
      e.type === 'folder'
        ? undefined
        : {
            label: foldSearchText(e.label),
            text: foldSearchText(`${e.label} ${this.buildPath(entries, i).join(' ')} ${e.code}`),
          },
    );
  }

  /**
   * For a query that matched nothing, the words whose removal alone finds matches, with
   * that count (`wordRemovalCounts`), and the words no searched text contains at all
   * (`unmatchedWords`, with `allWordsUnmatched` when that is every word), each in query
   * order and each omitted when empty. `words` maps each distinct token to the word as
   * typed. One pass: a placement missing exactly one word rescues its code for that
   * word, and a code counts once per word whichever placement rescued it — so each count
   * equals the `totalMatches` of the same search without that word.
   *
   * `unmatchedWords` is drawn from the first {@link MAX_UNMATCHED_WORD_CHECKS} distinct
   * words. `unmatchedWordsPartial` is set when a word past them is held by no text the pass
   * read, so it may be one no dataset carries.
   */
  private countWithoutEachWord(
    toc: TocCache,
    texts: (SearchText | undefined)[],
    words: Map<string, string>,
  ): BlockingWords {
    const tokens = [...words.keys()];
    const rescued = new Map<string, Set<string>>();
    /** The words checked against every text, while no text read so far holds them. */
    const unmatched = new Set(tokens.slice(0, MAX_UNMATCHED_WORD_CHECKS));
    /** The words past those, while no text read so far holds them. */
    const unchecked = new Set(tokens.slice(MAX_UNMATCHED_WORD_CHECKS));
    toc.entries.forEach((e, i) => {
      const text = texts[i]?.text;
      if (text === undefined) return;
      let missing: string | undefined;
      let misses = 0;
      for (const token of tokens) {
        if (text.includes(token)) {
          unmatched.delete(token);
          unchecked.delete(token);
        } else if (++misses > 1) {
          break;
        } else {
          missing = token;
        }
      }
      // Past a second miss nothing is rescued; the checked words this text may hold still count.
      if (misses > 1) {
        for (const token of unmatched) if (text.includes(token)) unmatched.delete(token);
      }
      if (misses !== 1 || missing === undefined) return;
      const codes = rescued.get(missing) ?? new Set<string>();
      rescued.set(missing, codes.add(e.code));
    });
    const wordRemovalCounts = [...words].flatMap(([token, word]) => {
      const codes = rescued.get(token);
      return codes ? [{ word, totalMatches: codes.size }] : [];
    });
    const unmatchedWords = [...words].flatMap(([token, word]) =>
      unmatched.has(token) ? [word] : [],
    );
    return {
      ...(wordRemovalCounts.length > 0 && { wordRemovalCounts }),
      ...(unmatchedWords.length > 0 && { unmatchedWords }),
      ...(unmatched.size === words.size && { allWordsUnmatched: true as const }),
      ...(unchecked.size > 0 && { unmatchedWordsPartial: true as const }),
    };
  }

  /**
   * The datasets a query that matched no catalogue text finds when a word may also occur
   * at a word start of the English label of a value the metabase lists for the dataset.
   * Every word must still be found, in the dataset's own text or in a value's label. Each
   * code keeps its placement whose text holds the most words, the first such in TOC order.
   *
   * Ordered by fewer words found only through values; then rows where one value's label
   * carries all of those words; then {@link searchTierOf} over the tokens the dataset's text
   * holds, in query order; then TOC order. `marks` holds, for each word found through
   * values, which labels carry it. `words` are the query's distinct tokens, at most
   * {@link MAX_VALUE_SEARCH_WORDS}.
   */
  private searchValues(
    index: DimensionValueIndex,
    toc: TocCache,
    texts: (SearchText | undefined)[],
    tokens: string[],
    words: string[],
  ): Array<ValueRow & { marks: Uint8Array[] }> {
    const marksOf = new Map<number, Uint8Array | undefined>();
    let live: ValueRow[] = [];
    toc.entries.forEach((e, i) => {
      const dataset = texts[i] && index.datasetOf(e.code);
      if (dataset !== undefined) live.push({ dataset, i, through: 0 });
    });
    for (let k = 0; k < words.length && live.length > 0; k++) {
      const word = words[k] as string;
      const found = new Map<number, boolean>();
      live = live.filter((row) => {
        if (texts[row.i]?.text.includes(word)) return true;
        let has = found.get(row.dataset);
        if (has === undefined) {
          if (!marksOf.has(k)) marksOf.set(k, index.labelsAtWordStart(word));
          const marks = marksOf.get(k);
          has = marks !== undefined && index.hasValue(row.dataset, marks);
          found.set(row.dataset, has);
        }
        if (has) row.through |= 1 << k;
        return has;
      });
    }

    const best = new Map<string, ValueRow>();
    for (const row of live) {
      const code = (toc.entries[row.i] as TocEntry).code;
      const kept = best.get(code);
      if (!kept || wordCount(row.through) < wordCount(kept.through)) best.set(code, row);
    }

    const wordIndex = new Map(words.map((word, k) => [word, k]));
    const tierOfThrough = new Map<number, ReturnType<typeof searchTierOf>>();
    return [...best.values()]
      .map((row) => {
        const marks = words.flatMap((_, k) =>
          row.through & (1 << k) ? [marksOf.get(k) as Uint8Array] : [],
        );
        let tierOf = tierOfThrough.get(row.through);
        if (!tierOf) {
          tierOf = searchTierOf(
            tokens.filter((token) => (row.through & (1 << (wordIndex.get(token) as number))) === 0),
          );
          tierOfThrough.set(row.through, tierOf);
        }
        const e = toc.entries[row.i] as TocEntry;
        return {
          ...row,
          marks,
          sharesOne: marks.length === 1 || index.hasValueMarkedByAll(row.dataset, marks),
          tier: tierOf((texts[row.i] as SearchText).label, e.code),
        };
      })
      .sort(
        (a, b) =>
          a.marks.length - b.marks.length ||
          Number(b.sharesOne) - Number(a.sharesOne) ||
          a.tier - b.tier ||
          a.i - b.i,
      );
  }

  /**
   * Search datasets by keyword. The query is tokenized on whitespace and every
   * token must match (AND), case-insensitively, somewhere in a combined
   * `label + themePath + code` haystack — so concept-order and theme-named
   * queries resolve even when no single label contains the phrase verbatim.
   * Whitespace beside punctuation is removed from the haystack, never from a token,
   * so `Rev.2` finds `Rev. 2` while `R&D` and `DS-045409` keep their punctuation;
   * no query matches less than it would against the unfolded text.
   * A query with no non-whitespace token matches nothing rather than everything.
   *
   * Returns datasets only (not folders), one row per code: a dataset filed under
   * several TOC branches keeps its first matching placement as the canonical
   * `themePath`, so totals and page slots count unique query targets.
   *
   * Matches are ordered by {@link searchTierOf} over the tokens — label phrase, then
   * every word in label or code, then breadcrumb-only — and by that first matching
   * placement within a tier. A tier reads the label and code alone, so it is the same
   * whichever placement supplied the `themePath`.
   *
   * Results are paginated with an opaque cursor (`limit` = page size, capped at
   * 100) bound to the normalized query and the catalogue snapshot that produced
   * it. An unusable cursor — malformed, from another query, or from a catalogue
   * since refreshed — is rejected as `invalid_cursor` instead of silently paging
   * a different result set. A Comext merge that lands mid-walk keeps the snapshot,
   * so the cursor also carries the snapshot's length when the walk began: the
   * datasets the merge appended page after every match the walk began over, each
   * match still once.
   *
   * When no dataset's text holds every token, {@link searchValues} looks for the tokens
   * the text lacks in the English labels of the dataset's dimension values. Its rows
   * carry `matchedValues` and the result `matchedThroughValues`, and their cursor also
   * binds the value index snapshot (`valueIndex`), so an index refresh mid-walk rejects it
   * like a catalogue refresh. No search waits for the index: until one has loaded,
   * `valuesNotSearched` is `index_unavailable`; past {@link MAX_VALUE_SEARCH_WORDS}
   * distinct tokens it is `too_many_words`.
   *
   * An empty match reports the `DS-*` codes the query names that neither source lists
   * (`undisseminatedCodes`), so the caller can be told the collection is not
   * disseminated rather than to broaden the search, and — for two or more distinct
   * words — each word whose removal alone finds matches (`wordRemovalCounts`) and each
   * word no dataset's search text contains (`unmatchedWords`, as first typed), with
   * `allWordsUnmatched` when that is every word. `unmatchedWords` reads the first
   * {@link MAX_UNMATCHED_WORD_CHECKS} distinct words; `unmatchedWordsPartial` flags a query
   * with a later word that may be one no dataset carries. `comextListMissing` flags that the
   * Comext list is not merged right now, so the `DS-*` collections were not searched and
   * absence from that list proves nothing; `catalogueLoadedAt` marks a catalogue a
   * failed refresh could not replace.
   */
  async search(
    query: string,
    limit: number,
    cursor: string | undefined,
    ctx: Context,
  ): Promise<{
    allWordsUnmatched?: true;
    catalogueLoadedAt?: string;
    comextListMissing?: boolean;
    datasets: DatasetResult[];
    matchedThroughValues?: true;
    nextCursor?: string;
    totalMatches: number;
    undisseminatedCodes?: string[];
    unmatchedWords?: string[];
    unmatchedWordsPartial?: true;
    valuesNotSearched?: ValuesNotSearched;
    wordRemovalCounts?: Array<{ totalMatches: number; word: string }>;
  }> {
    const toc = await this.ensureLoaded(ctx);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { datasets: [], totalMatches: 0 };

    /** Cursor identity: the normalized query plus the catalogue snapshot it was paged over. */
    const queryKey = tokens.join(' ');
    const generation = toc.loadedAt.getTime();

    let offset = 0;
    let pageSize = limit;
    /** The snapshot's length when this walk began; any entry past it came from a Comext merge since. */
    let entryCount = toc.entries.length;
    /** The value index snapshot a walk over rows found through dimension values began on. */
    let walkedValueIndex: unknown;
    if (cursor) {
      const state = this.decodeSearchCursor(cursor, queryKey, generation, entryCount, ctx);
      offset = state.offset;
      pageSize = Math.min(state.limit, MAX_PAGE_SIZE);
      entryCount = state.entryCount;
      walkedValueIndex = state.valueIndex;
    }
    const sources = {
      ...(toc.comextRetryAt !== undefined && { comextListMissing: true }),
      ...this.staleness(toc),
    };
    const nextOffset = offset + pageSize;
    const nextCursor = (total: number, valueIndex?: number) =>
      nextOffset < total && {
        nextCursor: encodeCursor({
          offset: nextOffset,
          limit: pageSize,
          query: queryKey,
          generation,
          entryCount,
          ...(valueIndex !== undefined && { valueIndex }),
        }),
      };

    toc.searchText ??= this.buildSearchText(toc.entries);
    const texts = toc.searchText;
    const tierOf = searchTierOf(tokens);
    const distinct = [...new Set(tokens)];
    const seen = new Set<string>();
    const matched = toc.entries
      .flatMap((e, i) => {
        const text = texts[i];
        if (
          text === undefined ||
          seen.has(e.code) ||
          !distinct.every((t) => text.text.includes(t))
        ) {
          return [];
        }
        seen.add(e.code);
        return [{ e, i, appended: i >= entryCount, tier: tierOf(text.label, e.code) }];
      })
      .sort((a, b) => Number(a.appended) - Number(b.appended) || a.tier - b.tier);

    if (matched.length > 0) {
      if (walkedValueIndex !== undefined) throw invalidCursor();
      return {
        datasets: matched
          .slice(offset, offset + pageSize)
          .map(({ e, i }) => this.toDatasetResult(toc.entries, e, i)),
        totalMatches: matched.length,
        ...sources,
        ...nextCursor(matched.length),
      };
    }

    const index = this.valueIndex?.index;
    const valuesNotSearched: ValuesNotSearched | undefined =
      distinct.length > MAX_VALUE_SEARCH_WORDS
        ? 'too_many_words'
        : this.valueIndex && !index
          ? 'index_unavailable'
          : undefined;
    if (cursor && (walkedValueIndex === undefined || walkedValueIndex !== index?.loadedAt)) {
      throw invalidCursor();
    }
    if (index && !valuesNotSearched) {
      const rows = this.searchValues(index, toc, texts, tokens, distinct);
      if (rows.length > 0) {
        return {
          datasets: rows.slice(offset, offset + pageSize).map(({ dataset, i, marks }) => ({
            ...this.toDatasetResult(toc.entries, toc.entries[i] as TocEntry, i),
            matchedValues: index.valuesMarked(dataset, marks),
          })),
          totalMatches: rows.length,
          matchedThroughValues: true,
          ...sources,
          ...nextCursor(rows.length, index.loadedAt),
        };
      }
    }

    const undisseminatedCodes = tokens
      .filter((t) => DS_CODE_TOKEN.test(t) && !toc.codeIndex.has(t.toUpperCase()))
      .map((t) => t.toUpperCase());
    // The typed words line up with the tokens: lowercasing neither adds nor removes whitespace.
    const typed = query.split(/\s+/).filter(Boolean);
    const words = new Map<string, string>();
    tokens.forEach((token, n) => {
      if (!words.has(token)) words.set(token, typed[n] ?? token);
    });
    return {
      datasets: [],
      totalMatches: 0,
      ...(undisseminatedCodes.length > 0 && { undisseminatedCodes }),
      ...(words.size > 1 && this.countWithoutEachWord(toc, texts, words)),
      ...(valuesNotSearched && { valuesNotSearched }),
      ...sources,
    };
  }
}

/** The one rejection for every unusable search cursor. */
function invalidCursor() {
  return invalidParams(
    'Unusable pagination cursor: it is malformed, was issued for a different query, or was issued against a catalogue snapshot that has since refreshed. Repeat the search without a cursor, then page with the nextCursor it returns.',
    { reason: 'invalid_cursor' },
  );
}

/**
 * An SDMX timestamp (`2026-09-15T11:00:00+0200`) in the TOC's `dd.mm.yyyy` form, the
 * date read as published rather than shifted across time zones. Anything else is
 * returned unchanged rather than dropped.
 */
function toTocDate(timestamp: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(timestamp);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : timestamp;
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
