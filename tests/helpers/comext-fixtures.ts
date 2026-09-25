/**
 * @fileoverview Test helper: recorded Comext host payloads and a fetch stub that
 * answers per host, so a test can see which host every request went to.
 *
 * The fixtures under `tests/fixtures/comext/` are live responses recorded on
 * 2026-09-25. The DS-045409 dataflow and constraint are trimmed to a few codes
 * per dimension (the originals are 23 MB and 1 MB), and its TSV to the first
 * three series; every other file is verbatim. `.gitattributes` stores them byte
 * for byte, so the TSVs keep the CRLF line endings Eurostat sends.
 *
 * @module tests/helpers/comext-fixtures
 */

import { readFileSync } from 'node:fs';

export const MAIN_HOST = 'https://ec.europa.eu/eurostat/api/dissemination';
export const COMEXT_HOST = 'https://ec.europa.eu/eurostat/api/comext/dissemination';

/** A recorded payload from `tests/fixtures/comext/`, as text. */
export function comextFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/comext/${name}`, import.meta.url), 'utf8');
}

/** `DS-045409`'s content constraint with its `product` value list replaced by `count` codes. */
export function constraintWithProducts(count: number): string {
  const values = Array.from(
    { length: count },
    (_, index) => `<c:Value>P${String(index).padStart(6, '0')}</c:Value>`,
  ).join('');
  return comextFixture('ds-045409-constraint.xml').replace(
    /<c:KeyValue id="product">.*?<\/c:KeyValue>/s,
    `<c:KeyValue id="product">${values}</c:KeyValue>`,
  );
}

export const xml = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/xml' } });

export const json = (body: string | object, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const tsv = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/tab-separated-values' } });

/** A request as the stub saw it: which host, which route, which dataset code. */
export interface RoutedRequest {
  code: string;
  host: 'comext' | 'main';
  route:
    | 'contentconstraint'
    | 'data'
    | 'dataflow'
    | 'dataflow-list'
    | 'datastructure'
    | 'statistics'
    | 'toc';
  url: URL;
}

/** Classify a request URL by host and route. Throws on a URL neither host serves. */
export function routeOf(input: unknown): RoutedRequest {
  const url = new URL(String(input));
  const href = url.href;
  const host = href.startsWith(COMEXT_HOST)
    ? 'comext'
    : href.startsWith(MAIN_HOST)
      ? 'main'
      : undefined;
  if (!host) throw new Error(`Request to an unknown host: ${href}`);
  const path = url.pathname.replace(/^.*\/dissemination\//, '');
  if (path.startsWith('catalogue/toc/')) return { code: '', host, route: 'toc', url };
  if (path === 'sdmx/2.1/dataflow/ESTAT') return { code: '', host, route: 'dataflow-list', url };
  const segments = path.split('/');
  if (path.startsWith('statistics/1.0/data/')) {
    return { code: decodeURIComponent(segments[3] ?? ''), host, route: 'statistics', url };
  }
  const resource = segments[2] as RoutedRequest['route'];
  const code = decodeURIComponent(resource === 'data' ? (segments[3] ?? '') : (segments[4] ?? ''));
  return { code, host, route: resource, url };
}

/** The SOAP fault envelope both hosts wrap SDMX errors in. */
export const soapFault = (code: string, text: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><S:Fault xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>${code}</faultcode><faultstring>${text}</faultstring></S:Fault>`;

/** The fault the Comext host answers an unfiltered TSV download of a large collection with. */
export const COMEXT_FULL_EXTRACTION_FAULT = soapFault(
  '413',
  'EXTRACTION_TOO_BIG_COMEXT: The requested extraction is too big. Full extraction of COMEXT datasets is forbidden, please add filters to reduce the extraction size',
);
