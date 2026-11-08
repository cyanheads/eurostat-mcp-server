/**
 * @fileoverview The deterministic SDMX structure pair with three real GEO codes
 * whose LEVEL annotation the server does not map: `DEA_RUHR` (LEVEL `OTH`, a
 * grouping), `DE_CAP` (LEVEL `5`, a capital region) and `EXT_EA21` (no LEVEL
 * annotation). The `<s:Code>` entries are verbatim from `codelist/ESTAT/GEO`
 * version 28.0, recorded 2026-11-08.
 * @module tests/fixtures/dimension-values/geo-unmapped-levels
 */

import { readFileSync } from 'node:fs';
import { SDMX_CONSTRAINT_XML, SDMX_DATAFLOW_XML } from '../eurostat-sdmx-metadata.js';

const unmappedCodes = readFileSync(
  new URL('./geo-codes-unmapped-level.xml', import.meta.url),
  'utf8',
).trim();

/** The codes the fragment adds, in the order the constraint lists them. */
export const UNMAPPED_GEO_CODES = [
  { code: 'DEA_RUHR', label: 'Ruhrgebiet' },
  { code: 'DE_CAP', label: 'Berlin' },
  { code: 'EXT_EA21', label: 'Extra-euro area - 21 countries (from 2026)' },
];

/** SDMX_DATAFLOW_XML with the three codes appended to its GEO codelist. */
export const DATAFLOW_WITH_UNMAPPED_LEVELS_XML = SDMX_DATAFLOW_XML.replace(
  '<c:Name xml:lang="en">Stuttgart, Stadtkreis</c:Name></s:Code>',
  `<c:Name xml:lang="en">Stuttgart, Stadtkreis</c:Name></s:Code>${unmappedCodes}`,
);

/** SDMX_CONSTRAINT_XML listing the three codes after the fixture's own geo values. */
export const CONSTRAINT_WITH_UNMAPPED_LEVELS_XML = SDMX_CONSTRAINT_XML.replace(
  '<c:Value>DE111</c:Value></c:KeyValue>',
  `<c:Value>DE111</c:Value>${UNMAPPED_GEO_CODES.map(({ code }) => `<c:Value>${code}</c:Value>`).join('')}</c:KeyValue>`,
);
