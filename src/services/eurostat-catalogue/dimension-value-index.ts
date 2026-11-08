/**
 * @fileoverview The dimension value index search reads when a dataset's own text lacks a
 * query word: the codes Eurostat's metabase lists for each dataset (`time` excluded), each
 * labelled in English from the global codelists. Both downloads are gzip files read as
 * streams, never held whole; the index keeps joined strings and typed arrays.
 * @module services/eurostat-catalogue/dimension-value-index
 */

import { fetchWithTimeout, type RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { decodeXmlEntities } from '../xml-entities.js';
import { continuesWord, foldSearchText } from './search-text.js';
import type { MatchedValue } from './types.js';

/** The period dimension, listed for every dataset; its codes are dates, not vocabulary. */
const TIME_DIMENSION = 'time';

/** Joins labels and codes. A search word holds no whitespace, so no match spans two labels. */
const SEPARATOR = '\n';

/**
 * A codelist's opening tag, a code's opening tag, an English name, and a code's closing tag.
 * `<s:Code\b` does not match `<s:Codelist`.
 */
const CODELIST_TOKEN =
  /<s:Codelist\b[^>]*?\sid="([^"]*)"|<s:Code\b[^>]*?\sid="([^"]*)"|<c:Name xml:lang="en">([^<]*)<\/c:Name>|<\/s:Code>/g;

const CODE_CLOSE = '</s:Code>';

/** The codelist dump's root element closes the document; a stream without it was cut short. */
const DOCUMENT_CLOSE = '</m:Structure>';

/**
 * A copy of `text` in a new string. A string cut from a decoded chunk keeps the whole chunk
 * alive, and on JavaScriptCore so does a concatenate-then-slice copy, which slices the
 * original again; a join writes new characters on every runtime.
 */
function copyOf(text: string): string {
  return [text, ''].join(SEPARATOR).slice(0, -SEPARATOR.length);
}

/** The index's arrays. A value is one (dimension, code) pair, shared by every dataset listing it. */
interface IndexParts {
  codeStart: Int32Array;
  /** Every value's code, joined; value `v` spans `codeStart[v]` to `codeStart[v + 1] - 1`. */
  codeText: string;
  datasetIds: Map<string, number>;
  datasetStart: Int32Array;
  /** Each dataset's values, in metabase order; dataset `d` spans `datasetStart[d]` to `datasetStart[d + 1]`. */
  datasetValues: Int32Array;
  dimensions: string[];
  labelStart: Int32Array;
  /** Every distinct label as published, joined. */
  labelText: string;
  searchStart: Int32Array;
  /** Every label folded as search reads it, joined in the same order as `labelText`. */
  searchText: string;
  valueDimension: Int32Array;
  /** Each value's label id, or -1 when its codelist names it in no English label. */
  valueLabel: Int32Array;
}

/** Offsets of each part joined by {@link SEPARATOR}, plus one past the end. */
function offsetsOf(parts: readonly string[]): Int32Array {
  const starts = new Int32Array(parts.length + 1);
  for (let i = 0; i < parts.length; i++) {
    starts[i + 1] = (starts[i] as number) + (parts[i] as string).length + SEPARATOR.length;
  }
  return starts;
}

/** The labels of the codes Eurostat's metabase lists per dataset, searchable at word starts. */
export class DimensionValueIndex {
  /** Epoch ms when this index finished loading: its age, and the snapshot a cursor binds. */
  readonly loadedAt: number;
  private readonly parts: IndexParts;

  constructor(parts: IndexParts, loadedAt: number) {
    this.parts = parts;
    this.loadedAt = loadedAt;
  }

  /** Dataset, value, and label counts, for logging. */
  get size(): { datasets: number; labels: number; values: number } {
    return {
      datasets: this.parts.datasetIds.size,
      labels: this.parts.labelStart.length - 1,
      values: this.parts.valueLabel.length,
    };
  }

  /** The id of a dataset the metabase lists, or undefined for one it does not. */
  datasetOf(code: string): number | undefined {
    return this.parts.datasetIds.get(code);
  }

  /**
   * Flags, per label id, whether `word` occurs in the folded label with no letter or digit
   * right before it; undefined when no label carries it. One scan of the joined labels;
   * past a label's first match the scan resumes at the next label.
   */
  labelsAtWordStart(word: string): Uint8Array | undefined {
    const { searchStart, searchText } = this.parts;
    let flags: Uint8Array | undefined;
    let at = searchText.indexOf(word);
    while (at !== -1) {
      if (continuesWord(searchText, at)) {
        at = searchText.indexOf(word, at + 1);
        continue;
      }
      const label = this.labelAt(at);
      flags ??= new Uint8Array(searchStart.length - 1);
      flags[label] = 1;
      at = searchText.indexOf(word, searchStart[label + 1]);
    }
    return flags;
  }

  /** Whether some value of `dataset` has a label `flags` marks. */
  hasValue(dataset: number, flags: Uint8Array): boolean {
    return this.someValue(dataset, (label) => flags[label] === 1);
  }

  /** Whether one value of `dataset` has a label every one of `flagSets` marks. */
  hasValueMarkedByAll(dataset: number, flagSets: readonly Uint8Array[]): boolean {
    return this.someValue(dataset, (label) => flagSets.every((flags) => flags[label] === 1));
  }

  /**
   * The values of `dataset` whose label any of `flagSets` marks: those marked by the most
   * flag sets first, so a value carrying every word leads the ones carrying one of them,
   * then metabase order.
   */
  valuesMarked(dataset: number, flagSets: readonly Uint8Array[]): MatchedValue[] {
    const { codeStart, codeText, datasetStart, datasetValues, dimensions, labelStart, labelText } =
      this.parts;
    const values: Array<{ marked: number; value: MatchedValue }> = [];
    for (
      let at = datasetStart[dataset] as number;
      at < (datasetStart[dataset + 1] as number);
      at++
    ) {
      const value = datasetValues[at] as number;
      const label = this.parts.valueLabel[value] as number;
      const marked = label < 0 ? 0 : flagSets.filter((flags) => flags[label] === 1).length;
      if (marked === 0) continue;
      values.push({
        marked,
        value: {
          dimension: dimensions[this.parts.valueDimension[value] as number] as string,
          code: codeText.slice(codeStart[value], (codeStart[value + 1] as number) - 1),
          label: labelText.slice(labelStart[label], (labelStart[label + 1] as number) - 1),
        },
      });
    }
    return values.sort((a, b) => b.marked - a.marked).map(({ value }) => value);
  }

  private someValue(dataset: number, test: (label: number) => boolean): boolean {
    const { datasetStart, datasetValues, valueLabel } = this.parts;
    for (
      let at = datasetStart[dataset] as number;
      at < (datasetStart[dataset + 1] as number);
      at++
    ) {
      const label = valueLabel[datasetValues[at] as number] as number;
      if (label >= 0 && test(label)) return true;
    }
    return false;
  }

  /** The label whose span of the joined search text holds offset `at`. */
  private labelAt(at: number): number {
    const { searchStart } = this.parts;
    let low = 0;
    let high = searchStart.length - 2;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((searchStart[mid] as number) <= at) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}

/**
 * Text of a stream in pieces that each end at a boundary, so no token spans two pieces. Only
 * the newest chunk is searched for a boundary, so a long run without one costs its length.
 */
class BoundaryPieces {
  private pending: string[] = [];
  private readonly boundary: string;

  constructor(boundary: string) {
    this.boundary = boundary;
  }

  /** The text up to the last boundary in `chunk`, or undefined while `chunk` holds none. */
  cut(chunk: string): string | undefined {
    const at = chunk.lastIndexOf(this.boundary);
    if (at === -1) {
      this.pending.push(chunk);
      return;
    }
    const end = at + this.boundary.length;
    this.pending.push(chunk.slice(0, end));
    const piece = this.pending.join('');
    this.pending = [chunk.slice(end)];
    return piece;
  }

  /** The text after the last boundary. */
  rest(): string {
    const rest = this.pending.join('');
    this.pending = [];
    return rest;
  }
}

/** The metabase's rows as ids: datasets, dimensions, and (dimension, code) values. */
interface MetabaseTable {
  datasetIds: Map<string, number>;
  dimensionIds: Map<string, number>;
  dimensions: string[];
  rowDatasets: number[];
  rowValues: number[];
  valueCodes: string[];
  valueDimensions: number[];
  /** Value ids by dimension id and code, tab-joined. */
  valueIds: Map<string, number>;
}

/**
 * Reads `dataset<TAB>dimension<TAB>code` lines as they stream in, `time` rows skipped. Every
 * string it keeps is a copy, so no decoded chunk outlives its turn.
 */
class MetabaseReader {
  private line = 0;
  private readonly lines = new BoundaryPieces('\n');
  private readonly table: MetabaseTable = {
    datasetIds: new Map(),
    dimensionIds: new Map(),
    dimensions: [],
    rowDatasets: [],
    rowValues: [],
    valueCodes: [],
    valueDimensions: [],
    valueIds: new Map(),
  };

  read(chunk: string): void {
    const text = this.lines.cut(chunk);
    if (text !== undefined) for (const line of text.slice(0, -1).split('\n')) this.add(line);
  }

  /** The table read. Throws when the metabase listed no dataset: a broken download, not an empty catalogue. */
  finish(): MetabaseTable {
    const rest = this.lines.rest();
    if (rest) this.add(rest);
    if (this.table.datasetIds.size === 0)
      throw new Error('The metabase listed no dataset dimension values');
    return this.table;
  }

  private add(text: string): void {
    this.line += 1;
    const line = text.endsWith('\r') ? text.slice(0, -1) : text;
    if (!line) return;
    const fields = line.split('\t');
    const [dataset, dimension, code] = fields;
    if (fields.length !== 3 || !dataset || !dimension || code === undefined) {
      throw new Error(
        `Metabase line ${this.line} is not a dataset, dimension and code separated by tabs`,
      );
    }
    if (dimension === TIME_DIMENSION) return;
    const table = this.table;
    let datasetId = table.datasetIds.get(dataset);
    if (datasetId === undefined) {
      datasetId = table.datasetIds.size;
      table.datasetIds.set(copyOf(dataset), datasetId);
    }
    let dimensionId = table.dimensionIds.get(dimension);
    if (dimensionId === undefined) {
      dimensionId = table.dimensions.length;
      table.dimensions.push(copyOf(dimension));
      table.dimensionIds.set(table.dimensions[dimensionId] as string, dimensionId);
    }
    const key = `${dimensionId}\t${code}`;
    let valueId = table.valueIds.get(key);
    if (valueId === undefined) {
      valueId = table.valueCodes.length;
      table.valueIds.set(copyOf(key), valueId);
      table.valueCodes.push(copyOf(code));
      table.valueDimensions.push(dimensionId);
    }
    table.rowDatasets.push(datasetId);
    table.rowValues.push(valueId);
  }
}

/**
 * Reads the codelist dump as it streams in, keeping the first English name of each code the
 * metabase lists, from the codelist named after its dimension in upper case.
 */
class CodelistReader {
  private code: string | undefined;
  private readonly codelistDimensions: Map<string, number>;
  private dimensionId: number | undefined;
  private labelled = 0;
  private readonly labels: (string | undefined)[];
  /** Whether the open code, or the codelist before its first code, has had its name. */
  private named = true;
  private readonly pieces = new BoundaryPieces(CODE_CLOSE);
  private readonly table: MetabaseTable;

  constructor(table: MetabaseTable) {
    this.table = table;
    this.labels = new Array(table.valueCodes.length);
    this.codelistDimensions = new Map(
      table.dimensions.map((dimension, id) => [dimension.toUpperCase(), id]),
    );
  }

  read(chunk: string): void {
    const piece = this.pieces.cut(chunk);
    if (piece !== undefined) this.scan(piece);
  }

  /**
   * The index, from the metabase table and the labels read. Throws when the dump stops before
   * its root element closes, or labels none of the metabase's codes.
   */
  finish(): DimensionValueIndex {
    const rest = this.pieces.rest();
    this.scan(rest);
    if (!rest.includes(DOCUMENT_CLOSE)) {
      throw new Error('The codelist dump ended before its root element closed');
    }
    if (this.labelled === 0) throw new Error('The codelists labelled none of the metabase codes');
    return assembleIndex(this.table, this.labels);
  }

  private scan(piece: string): void {
    CODELIST_TOKEN.lastIndex = 0;
    for (let token = CODELIST_TOKEN.exec(piece); token; token = CODELIST_TOKEN.exec(piece)) {
      const [, codelistId, codeId, name] = token;
      if (codelistId !== undefined) {
        this.dimensionId = this.codelistDimensions.get(decodeXmlEntities(codelistId));
        this.named = true;
      } else if (codeId !== undefined) {
        this.code = decodeXmlEntities(codeId);
        this.named = false;
      } else if (name !== undefined) {
        // The codelist's own name precedes its first code; only a code's first name labels it.
        if (this.named || this.dimensionId === undefined) continue;
        this.named = true;
        const valueId = this.table.valueIds.get(`${this.dimensionId}\t${this.code}`);
        if (valueId === undefined || this.labels[valueId] !== undefined) continue;
        this.labels[valueId] = copyOf(decodeXmlEntities(name).trim());
        this.labelled += 1;
      } else {
        this.named = true;
      }
    }
  }
}

/** The index from the metabase table and each value's label. */
function assembleIndex(
  table: MetabaseTable,
  valueLabels: readonly (string | undefined)[],
): DimensionValueIndex {
  const { datasetIds, dimensions, rowDatasets, rowValues, valueCodes, valueDimensions } = table;
  const labelIds = new Map<string, number>();
  const labels: string[] = [];
  const valueLabel = new Int32Array(valueCodes.length).fill(-1);
  valueLabels.forEach((label, valueId) => {
    if (label === undefined) return;
    let labelId = labelIds.get(label);
    if (labelId === undefined) {
      labelId = labels.length;
      labels.push(label);
      labelIds.set(label, labelId);
    }
    valueLabel[valueId] = labelId;
  });
  const folded = labels.map(foldSearchText);

  const datasetStart = new Int32Array(datasetIds.size + 1);
  for (const datasetId of rowDatasets)
    datasetStart[datasetId + 1] = (datasetStart[datasetId + 1] as number) + 1;
  for (let d = 0; d < datasetIds.size; d++) {
    datasetStart[d + 1] = (datasetStart[d + 1] as number) + (datasetStart[d] as number);
  }
  const fill = datasetStart.slice(0, -1);
  const datasetValues = new Int32Array(rowValues.length);
  rowDatasets.forEach((datasetId, row) => {
    datasetValues[(fill[datasetId] as number)++] = rowValues[row] as number;
  });

  return new DimensionValueIndex(
    {
      codeStart: offsetsOf(valueCodes),
      codeText: valueCodes.join(SEPARATOR),
      datasetIds,
      datasetStart,
      datasetValues,
      dimensions,
      labelStart: offsetsOf(labels),
      labelText: labels.join(SEPARATOR),
      searchStart: offsetsOf(folded),
      searchText: folded.join(SEPARATOR),
      valueDimension: Int32Array.from(valueDimensions),
      valueLabel,
    },
    Date.now(),
  );
}

/**
 * Build the index from the metabase (`dataset<TAB>dimension<TAB>code` lines) and the codelist
 * dump (SDMX 2.1 structure XML), each read as a stream of decoded text. The metabase is read
 * first, so only the labels of codes it lists are kept from the codelist named, in upper case,
 * after each dimension. A code's first English name is its label.
 *
 * Throws on a metabase line that is not three tab-separated fields, a metabase that lists no
 * dataset, a codelist dump that stops before its root element closes, or codelists that label
 * none of the metabase's codes: each is a broken download, not an empty catalogue.
 */
export async function buildDimensionValueIndex(
  metabase: AsyncIterable<string>,
  codelists: AsyncIterable<string>,
): Promise<DimensionValueIndex> {
  const metabaseReader = new MetabaseReader();
  for await (const chunk of metabase) metabaseReader.read(chunk);
  const codelistReader = new CodelistReader(metabaseReader.finish());
  for await (const chunk of codelists) codelistReader.read(chunk);
  return codelistReader.finish();
}

/**
 * The decoded text of a gzip file at `url`, chunk by chunk. The request starts when the
 * first chunk is asked for; `timeoutMs` bounds the whole transfer.
 */
async function* gzipText(
  url: string,
  timeoutMs: number,
  context: RequestContext,
): AsyncGenerator<string> {
  const response = await fetchWithTimeout(url, timeoutMs, context);
  if (!response.body) throw new Error(`${new URL(url).pathname} answered with no body`);
  /**
   * `DecompressionStream`'s writable side is typed `BufferSource`, wider than the
   * `Uint8Array` chunks the body carries, so the transform is narrowed to the types in play.
   */
  const reader = response.body
    .pipeThrough(
      new DecompressionStream('gzip') as unknown as {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      },
    )
    .getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    // Ends the transfer when parsing stops early; a no-op once the stream is done.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Download and build the index: the metabase first, then the codelist dump, each within
 * `EUROSTAT_BULK_TIMEOUT_MS`. One attempt; the caller schedules retries.
 */
export function fetchDimensionValueIndex(context: RequestContext): Promise<DimensionValueIndex> {
  const { baseUrl, bulkTimeoutMs } = getServerConfig();
  return buildDimensionValueIndex(
    gzipText(`${baseUrl}/catalogue/metabase.txt.gz`, bulkTimeoutMs, context),
    gzipText(
      `${baseUrl}/sdmx/2.1/codelist/ESTAT/all/latest?compressed=true`,
      bulkTimeoutMs,
      context,
    ),
  );
}
