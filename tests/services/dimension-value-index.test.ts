/**
 * @fileoverview Tests for the dimension value index: loading Eurostat's metabase and codelist
 * dump as streams (over excerpts cut from both), and matching words at word starts of the
 * labels, including the timing of that matching over caller-sized text.
 * @module tests/services/dimension-value-index.test
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDimensionValueIndex,
  type DimensionValueIndex,
  fetchDimensionValueIndex,
} from '@/services/eurostat-catalogue/dimension-value-index.js';
import { foldSearchText, occursAtWordStart } from '@/services/eurostat-catalogue/search-text.js';

const FIXTURES = new URL('../fixtures/dimension-value-index/', import.meta.url);
/** Real metabase lines for nine datasets, a few values each, `time` rows included. */
const METABASE = readFileSync(new URL('metabase-excerpt.tsv', FIXTURES), 'utf8');
/** The codelist dump's header and footer around the codes those lines list, each verbatim. */
const CODELISTS = readFileSync(new URL('codelists-excerpt.xml', FIXTURES), 'utf8');

const DATASETS = [
  'aact_eaa01_r_h',
  'hlth_rs_grd',
  'hlth_rs_grd2',
  'hlth_rs_prs1',
  'hlth_rs_prs2',
  'hlth_rs_prsrg',
  'namq_10_gdp',
  'prc_hicp_ct',
  'sts_inpr_m',
];

async function* streamOf(...chunks: string[]): AsyncGenerator<string> {
  yield* chunks;
}

/** `text` in chunks of `size` characters. */
function chunksOf(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

function build(metabase = METABASE, codelists = CODELISTS): Promise<DimensionValueIndex> {
  return buildDimensionValueIndex(streamOf(metabase), streamOf(codelists));
}

/** `CODELISTS` with the English name of one code replaced; throws when the name is absent. */
function renamed(name: string, replacement: string): string {
  const element = `<c:Name xml:lang="en">${name}</c:Name>`;
  expect(CODELISTS).toContain(element);
  return CODELISTS.replace(element, replacement);
}

/** The datasets with a value whose label carries `word` at a word start, as search folds it. */
function datasetsWith(index: DimensionValueIndex, word: string): string[] {
  const flags = index.labelsAtWordStart(foldSearchText(word));
  if (!flags) return [];
  return DATASETS.filter((code) => index.hasValue(index.datasetOf(code) as number, flags));
}

/** The values of `dataset` whose label carries any of `words` at a word start. */
function valuesWith(index: DimensionValueIndex, dataset: string, ...words: string[]) {
  const flagSets = words.flatMap((word) => index.labelsAtWordStart(foldSearchText(word)) ?? []);
  return index.valuesMarked(index.datasetOf(dataset) as number, flagSets);
}

/** Everything the index answers for a set of words, to compare two builds. */
function answers(index: DimensionValueIndex) {
  const words = [
    'pharmacists',
    'physicians',
    'surgeons',
    'poland',
    'essex',
    'kitchen',
    '&',
    'café',
  ];
  return {
    size: index.size,
    values: DATASETS.map((dataset) => valuesWith(index, dataset, ...words)),
  };
}

describe('buildDimensionValueIndex', () => {
  it('lists every non-time value of each dataset, labelled by its first English name', async () => {
    const index = await build();
    // 24 (dimension, code) pairs; "Pharmacists" and "Physiotherapists" each label two of them.
    expect(index.size).toEqual({ datasets: 9, labels: 22, values: 24 });
    expect(valuesWith(index, 'hlth_rs_prs2', 'pharmacists', 'physiotherapists', 'poland')).toEqual([
      { dimension: 'geo', code: 'PL', label: 'Poland' },
      { dimension: 'med_spec', code: 'PHARM', label: 'Pharmacists' },
      { dimension: 'med_spec', code: 'PHYSIO', label: 'Physiotherapists' },
    ]);
    // German and French names, a codelist's own name, and annotation text label nothing.
    for (const word of ['polen', 'pologne', 'medical', 'speciality', 'guidelines']) {
      expect(index.labelsAtWordStart(word)).toBeUndefined();
    }
  });

  it('keeps the first of two English names a code carries', async () => {
    const index = await build(
      METABASE,
      renamed(
        'Pharmacists',
        '<c:Name xml:lang="en">Pharmacists</c:Name><c:Name xml:lang="en">Chemists</c:Name>',
      ),
    );
    expect(index.labelsAtWordStart('chemists')).toBeUndefined();
    expect(datasetsWith(index, 'pharmacists')).toEqual([
      'hlth_rs_grd',
      'hlth_rs_grd2',
      'hlth_rs_prs1',
      'hlth_rs_prs2',
      'hlth_rs_prsrg',
    ]);
  });

  it('leaves the time dimension out, and a dataset that lists only time', async () => {
    const timeCodelist =
      '<s:Codelist agencyID="ESTAT" id="TIME" version="1.0"><c:Name xml:lang="en">Time</c:Name><s:Code id="2025"><c:Name xml:lang="en">Year 2025</c:Name></s:Code></s:Codelist>';
    const index = await build(
      `${METABASE}only_time\ttime\t2025\n`,
      CODELISTS.replace('<s:Codelists>', `<s:Codelists>${timeCodelist}`),
    );
    expect(index.size).toEqual({ datasets: 9, labels: 22, values: 24 });
    expect(index.labelsAtWordStart('year')).toBeUndefined();
    expect(index.datasetOf('only_time')).toBeUndefined();
  });

  it('shares a value listed under several datasets, across dimensions with one label', async () => {
    const index = await build();
    // med_spec=PHARM in two datasets, isco08=OC2262 in three: Eurostat's own search lists these five.
    expect(datasetsWith(index, 'pharmacists')).toEqual([
      'hlth_rs_grd',
      'hlth_rs_grd2',
      'hlth_rs_prs1',
      'hlth_rs_prs2',
      'hlth_rs_prsrg',
    ]);
    expect(valuesWith(index, 'hlth_rs_prs1', 'pharmacists')).toEqual([
      { dimension: 'isco08', code: 'OC2262', label: 'Pharmacists' },
    ]);
    expect(datasetsWith(index, 'poland')).toEqual([
      'hlth_rs_prs2',
      'namq_10_gdp',
      'prc_hicp_ct',
      'sts_inpr_m',
    ]);
    expect(index.datasetOf('DS-045409')).toBeUndefined();
  });

  it('keeps a value whose codelist lacks its code, or that has no codelist, unlabelled', async () => {
    const withoutLicensed = CODELISTS.replace(/<s:Code id="LIC"[\s\S]*?<\/s:Code>/, '');
    expect(withoutLicensed).not.toContain('id="LIC"');
    const index = await build(`${METABASE}hlth_rs_prs2\tno_codelist\tX\n`, withoutLicensed);
    expect(index.size).toEqual({ datasets: 9, labels: 21, values: 25 });
    expect(index.labelsAtWordStart('licensed')).toBeUndefined();
    expect(valuesWith(index, 'hlth_rs_prs2', 'practising')).toEqual([
      { dimension: 'wstatus', code: 'PRACT', label: 'Practising' },
    ]);
  });

  it('decodes entities and character references in names and identifiers', async () => {
    const codelists = renamed(
      'Physicians',
      '<c:Name xml:lang="en">Physicians &amp; surgeons, Caf&#233; &lt;x&gt;</c:Name>',
    ).replace('<s:Code id="NR"', '<s:Code id="N&#x52;"');
    const index = await build(METABASE, codelists);
    expect(valuesWith(index, 'hlth_rs_prs2', 'surgeons', 'number')).toEqual([
      { dimension: 'med_spec', code: 'PHYS', label: 'Physicians & surgeons, Café <x>' },
      { dimension: 'unit', code: 'NR', label: 'Number' },
    ]);
    expect(index.labelsAtWordStart('café')).toBeDefined();
  });

  it('reads the same index however the streams are cut', async () => {
    const codelists = renamed(
      'Physicians',
      '<c:Name xml:lang="en">Physicians &amp; surgeons, Caf&#233;</c:Name>',
    );
    const expected = answers(await build(METABASE, codelists));
    expect(expected.values[4]).toContainEqual({
      dimension: 'med_spec',
      code: 'PHYS',
      label: 'Physicians & surgeons, Café',
    });

    // Every cut through a metabase line's code, and from a code's English name tag, through
    // its entity and character reference, to the code's closing tag.
    const line = 'hlth_rs_prs2\tmed_spec\tPHARM\n';
    const lineAt = METABASE.indexOf(line);
    const elementAt = codelists.indexOf('<c:Name xml:lang="en">Physicians &amp;');
    const element = codelists.slice(elementAt, codelists.indexOf('</s:Code>', elementAt) + 9);
    expect(lineAt).toBeGreaterThan(0);
    expect(elementAt).toBeGreaterThan(0);
    expect(element).toMatch(/&#233;<\/c:Name>.*<\/s:Code>$/);
    for (let cut = lineAt; cut <= lineAt + line.length; cut++) {
      const index = await buildDimensionValueIndex(
        streamOf(METABASE.slice(0, cut), METABASE.slice(cut)),
        streamOf(codelists),
      );
      expect(answers(index)).toEqual(expected);
    }
    for (let cut = elementAt; cut <= elementAt + element.length; cut++) {
      const index = await buildDimensionValueIndex(
        streamOf(METABASE),
        streamOf(codelists.slice(0, cut), codelists.slice(cut)),
      );
      expect(answers(index)).toEqual(expected);
    }
    // Chunks too small to hold a closing tag, and chunks that hold several.
    for (const size of [1, 7, 64, 1000]) {
      const index = await buildDimensionValueIndex(
        streamOf(...chunksOf(METABASE, size)),
        streamOf(...chunksOf(codelists, size)),
      );
      expect(answers(index)).toEqual(expected);
    }
  });

  it('reads CRLF line endings and skips blank lines', async () => {
    const crlf = `${METABASE.replaceAll('\n', '\r\n')}\r\n\n`;
    expect(answers(await build(crlf))).toEqual(answers(await build()));
  });

  it.each([
    ['a line with two fields', 'hlth_rs_prs2\tmed_spec\n', /Metabase line 41 is not a dataset/],
    ['a line with four fields', 'hlth_rs_prs2\tmed_spec\tPHARM\tx\n', /Metabase line 41 /],
    ['a line cut short', 'hlth_rs_prs2\tmed_sp', /Metabase line 41 /],
    ['a line with an empty dataset', '\tmed_spec\tPHARM\n', /Metabase line 41 /],
  ])('rejects a metabase with %s', async (_name, tail, message) => {
    await expect(build(`${METABASE}${tail}`)).rejects.toThrow(message);
  });

  it('rejects a metabase that lists no dataset', async () => {
    await expect(build('')).rejects.toThrow('The metabase listed no dataset dimension values');
    await expect(build('only_time\ttime\t2025\n')).rejects.toThrow(
      'The metabase listed no dataset dimension values',
    );
  });

  it('rejects a codelist dump cut short, inside a code or right after one', async () => {
    const lastCode = CODELISTS.lastIndexOf('</s:Code>') + '</s:Code>'.length;
    for (const cut of [Math.floor(CODELISTS.length / 2), lastCode, CODELISTS.length - 2]) {
      await expect(build(METABASE, CODELISTS.slice(0, cut))).rejects.toThrow(
        'The codelist dump ended before its root element closed',
      );
    }
    await expect(build(METABASE, '<html><body>Service unavailable</body></html>')).rejects.toThrow(
      'The codelist dump ended before its root element closed',
    );
  });

  it('rejects codelists that label none of the metabase codes', async () => {
    const unrelated = CODELISTS.replace(/<s:Codelist [\s\S]*<\/s:Codelist>/, (lists) =>
      lists.slice(0, lists.indexOf('</s:Codelist>') + '</s:Codelist>'.length),
    );
    expect(unrelated).toContain('id="OGA_NRH"');
    expect(unrelated).not.toContain('id="MED_SPEC"');
    await expect(build(METABASE, unrelated)).rejects.toThrow(
      'The codelists labelled none of the metabase codes',
    );
  });

  it('passes on a stream that fails mid-transfer', async () => {
    async function* failing(): AsyncGenerator<string> {
      yield CODELISTS.slice(0, 1000);
      throw new TypeError('unexpected end of file');
    }
    await expect(buildDimensionValueIndex(streamOf(METABASE), failing())).rejects.toThrow(
      'unexpected end of file',
    );
  });
});

describe('labelsAtWordStart', () => {
  it('matches a word only where it begins a word of the folded label', async () => {
    const index = await build();
    // "sex" sits inside "Essex", "harmacists" inside "Pharmacists".
    expect(index.labelsAtWordStart('sex')).toBeUndefined();
    expect(index.labelsAtWordStart('harmacists')).toBeUndefined();
    expect(datasetsWith(index, 'essex')).toEqual(['aact_eaa01_r_h']);
    // A prefix of a word matches: the singular finds the plural.
    expect(datasetsWith(index, 'pharmacist')).toHaveLength(5);
    // "adjusted" first occurs inside "Unadjusted", then at a word start in the same label.
    expect(valuesWith(index, 'namq_10_gdp', 'adjusted')).toEqual([
      {
        dimension: 's_adj',
        code: 'NSA',
        label: 'Unadjusted data (i.e. neither seasonally adjusted nor calendar adjusted data)',
      },
    ]);
    // A word after punctuation starts a word.
    expect(valuesWith(index, 'aact_eaa01_r_h', 'nuts')).toHaveLength(2);
  });

  it('reads labels folded the way catalogue text is, and returns them as published', async () => {
    const index = await build();
    // Folding lowercases and drops the space beside "(": "product (GDP)" reads "product(gdp)".
    expect(foldSearchText('Product (GDP)')).toBe('product(gdp)');
    const pcGdp = {
      dimension: 'unit',
      code: 'PC_GDP',
      label: 'Percentage of gross domestic product (GDP)',
    };
    expect(valuesWith(index, 'namq_10_gdp', 'GDP')).toEqual([pcGdp]);
    expect(valuesWith(index, 'namq_10_gdp', 'product(gdp)')).toEqual([pcGdp]);
    expect(valuesWith(index, 'sts_inpr_m', 'Index,2015=100')).toEqual([
      { dimension: 'unit', code: 'I15', label: 'Index, 2015=100' },
    ]);
  });

  it('tells a value carrying every word from words spread over several values', async () => {
    const index = await build();
    const flags = ['kitchen', 'furniture'].map((word) => index.labelsAtWordStart(word));
    expect(flags.every((flag) => flag !== undefined)).toBe(true);
    const marks = flags as Uint8Array[];
    const stsInprM = index.datasetOf('sts_inpr_m') as number;
    const prcHicpCt = index.datasetOf('prc_hicp_ct') as number;
    // nace_r2=C3102 "Manufacture of kitchen furniture" carries both words.
    expect(index.hasValueMarkedByAll(stsInprM, marks)).toBe(true);
    // prc_hicp_ct has "kitchen" and "furniture" only in separate coicop18 values.
    expect(marks.every((flag) => index.hasValue(prcHicpCt, flag))).toBe(true);
    expect(index.hasValueMarkedByAll(prcHicpCt, marks)).toBe(false);
    expect(index.valuesMarked(prcHicpCt, marks).map(({ code }) => code)).toEqual([
      'CP05111',
      'CP05311',
      'CP05403',
    ]);
  });

  it('lists the values carrying the most of the words first, then in metabase order', async () => {
    const index = await build();
    const marks = ['kitchen', 'furniture'].map((word) => index.labelsAtWordStart(word));
    const stsInprM = index.datasetOf('sts_inpr_m') as number;
    // The metabase lists C31 and C3101 ("furniture" alone) before C3102 ("kitchen furniture").
    expect(index.valuesMarked(stsInprM, marks as Uint8Array[]).map(({ code }) => code)).toEqual([
      'C3102',
      'C31',
      'C3101',
    ]);
  });
});

describe('fetchDimensionValueIndex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDownloads(metabase: Uint8Array, codelists: Uint8Array): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        urls.push(url);
        return new Response(url.includes('metabase') ? metabase : codelists);
      }),
    );
    return urls;
  }

  it('downloads the metabase, then the codelist dump, and builds from the decoded gzip', async () => {
    const urls = stubDownloads(gzipSync(METABASE), gzipSync(CODELISTS));
    const index = await fetchDimensionValueIndex(
      requestContextService.createRequestContext({ operation: 'test' }),
    );
    expect(answers(index)).toEqual(answers(await build()));
    expect(urls).toEqual([
      expect.stringMatching(/\/catalogue\/metabase\.txt\.gz$/),
      expect.stringMatching(/\/sdmx\/2\.1\/codelist\/ESTAT\/all\/latest\?compressed=true$/),
    ]);
  });

  it('keeps a multi-byte character whole when the decoded text splits it', async () => {
    // Stored (level 0) gzip fed two bytes at a time decodes at most two bytes per chunk, so
    // the three-byte "’" always spans two chunks.
    const codelists = renamed('Physicians', '<c:Name xml:lang="en">Physicians’ café</c:Name>');
    const compressed = gzipSync(codelists, { level: 0 });
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= compressed.length) return controller.close();
        controller.enqueue(compressed.subarray(at, at + 2));
        at += 2;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes('metabase') ? new Response(gzipSync(METABASE)) : new Response(body),
      ),
    );
    const index = await fetchDimensionValueIndex(
      requestContextService.createRequestContext({ operation: 'test' }),
    );
    expect(valuesWith(index, 'hlth_rs_prs2', 'physicians')).toEqual([
      { dimension: 'med_spec', code: 'PHYS', label: 'Physicians’ café' },
    ]);
  });

  it('rejects a gzip body cut short', async () => {
    const codelists = gzipSync(CODELISTS);
    stubDownloads(gzipSync(METABASE), codelists.subarray(0, codelists.length - 20));
    await expect(
      fetchDimensionValueIndex(requestContextService.createRequestContext({ operation: 'test' })),
    ).rejects.toThrow();
  });
});

/**
 * Word-start matching scans text with a caller's word: the timing below grows the scanned
 * text by doubling, with a word found at every repetition but never at a word start, so each
 * scanner walks every occurrence.
 */
describe('word-start matching timing', () => {
  /** The least thread CPU ms per call of `run`, over five batches of `batch` calls. */
  function cpuMsPerCall(run: () => unknown, batch: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let measurement = 0; measurement < 5; measurement++) {
      const before = process.threadCpuUsage();
      for (let call = 0; call < batch; call++) run();
      const { user, system } = process.threadCpuUsage(before);
      best = Math.min(best, (user + system) / 1000 / batch);
    }
    return best;
  }

  /** Thread CPU per call grows no faster than linearly with size, checked at every doubling. */
  function expectLinear(timeAt: (size: number) => number, sizes: readonly number[]): void {
    const first = sizes[0] as number;
    const base = Math.max(timeAt(first), 0.001);
    for (const size of sizes.slice(1)) {
      const ms = timeAt(size);
      expect(ms / base, `${size} characters`).toBeLessThan(4 * (size / first));
      expect(ms, `${size} characters`).toBeLessThan(50);
    }
  }

  /** One label of `text`, listed by one dataset. */
  async function indexOfLabel(text: string): Promise<DimensionValueIndex> {
    return buildDimensionValueIndex(
      streamOf('ds\tdim\tCODE\n'),
      streamOf(
        `<m:Structure><s:Codelists><s:Codelist id="DIM"><s:Code id="CODE"><c:Name xml:lang="en">x${text}y</c:Name></s:Code></s:Codelist></s:Codelists></m:Structure>`,
      ),
    );
  }

  const BELOW_SLOW_MODE = [5_000, 10_000, 20_000, 40_000, 80_000];
  const FULL_SPAN = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const shapes: Array<[string, (n: number) => string, string, readonly number[]]> = [
    [
      'a section mark, a digit, a blank and a letter',
      (n) => `${'§1 x'.repeat(n / 4)}\ny`,
      ' x',
      BELOW_SLOW_MODE,
    ],
    ['blanks and line breaks', (n) => '  \r\n'.repeat(n / 4), ' \r\n x', BELOW_SLOW_MODE],
    ['a long digit run', (n) => '1'.repeat(n), '11', FULL_SPAN],
  ];

  it.each(shapes)('stays linear over %s', async (_name, make, word, sizes) => {
    const texts = new Map(sizes.map((size) => [size, `x${make(size)}`]));
    const batchOf = (size: number) => Math.max(1, Math.round(320_000 / size));
    expect(occursAtWordStart(texts.get(sizes[0] as number) as string, word)).toBe(false);
    expectLinear(
      (size) =>
        cpuMsPerCall(() => occursAtWordStart(texts.get(size) as string, word), batchOf(size)),
      sizes,
    );
    expectLinear(
      (size) => cpuMsPerCall(() => foldSearchText(texts.get(size) as string), batchOf(size)),
      sizes,
    );
    const indexes = new Map<number, DimensionValueIndex>();
    for (const size of sizes) indexes.set(size, await indexOfLabel(make(size)));
    const folded = foldSearchText(word);
    expectLinear(
      (size) => cpuMsPerCall(() => indexes.get(size)?.labelsAtWordStart(folded), batchOf(size)),
      sizes,
    );
  });
});
