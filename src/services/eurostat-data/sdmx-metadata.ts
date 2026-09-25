/**
 * @fileoverview Dataset-scoped SDMX 2.1 structure and content-constraint parser.
 * @module services/eurostat-data/sdmx-metadata
 */

import type { DatasetMeta, GeoLevel } from './types.js';

interface XmlNode {
  attributes: Record<string, string>;
  children: XmlNode[];
  name: string;
  qualifiedName: string;
  text: string;
}

interface DimensionDefinition {
  code: string;
  codelistId?: string;
  /** True for the `TimeDimension` element, which the positional series key never includes. */
  isTime: boolean;
  label: string;
  position: number;
}

export interface SdmxDatasetMetadata {
  geoLevelsByCode: Record<string, GeoLevel>;
  meta: DatasetMeta;
  valuesByDimension: Record<string, Array<{ code: string; label: string }>>;
}

interface SdmxCodeDefinition {
  geoLevel?: GeoLevel;
  label: string;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, token: string) => {
    if (token[0] === '#') {
      const radix = token[1]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? token.slice(2) : token.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isNaN(codePoint) ? entity : String.fromCodePoint(codePoint);
    }
    return (
      {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        quot: '"',
      }[token.toLowerCase()] ?? entity
    );
  });
}

function localName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);
}

function findTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < xml.length; index++) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  throw new Error('Unterminated XML tag');
}

function currentNode(stack: XmlNode[]): XmlNode {
  const current = stack.at(-1);
  if (!current) throw new Error('XML parser lost its document root');
  return current;
}

/** Parse only ordinary XML syntax; DTDs and custom entities are deliberately unsupported. */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = {
    attributes: {},
    children: [],
    name: '#document',
    qualifiedName: '#document',
    text: '',
  };
  const stack = [root];
  let cursor = 0;

  while (cursor < xml.length) {
    const opening = xml.indexOf('<', cursor);
    if (opening === -1) {
      currentNode(stack).text += decodeXml(xml.slice(cursor));
      break;
    }
    if (opening > cursor) currentNode(stack).text += decodeXml(xml.slice(cursor, opening));

    if (xml.startsWith('<!--', opening)) {
      const end = xml.indexOf('-->', opening + 4);
      if (end === -1) throw new Error('Unterminated XML comment');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', opening)) {
      const end = xml.indexOf(']]>', opening + 9);
      if (end === -1) throw new Error('Unterminated CDATA section');
      currentNode(stack).text += xml.slice(opening + 9, end);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', opening)) {
      const end = xml.indexOf('?>', opening + 2);
      if (end === -1) throw new Error('Unterminated XML declaration');
      cursor = end + 2;
      continue;
    }
    if (/^<!DOCTYPE\b/i.test(xml.slice(opening, opening + 10))) {
      throw new Error('SDMX XML must not contain a DOCTYPE');
    }
    if (xml.startsWith('<!', opening)) {
      const end = findTagEnd(xml, opening + 2);
      cursor = end + 1;
      continue;
    }

    const end = findTagEnd(xml, opening + 1);
    const rawTag = xml.slice(opening + 1, end).trim();
    if (rawTag.startsWith('/')) {
      const closingName = rawTag.slice(1).trim();
      const node = stack.pop();
      if (!node || node.qualifiedName !== closingName) {
        throw new Error(`Mismatched XML closing tag: ${closingName}`);
      }
      cursor = end + 1;
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const body = selfClosing ? rawTag.slice(0, -1).trimEnd() : rawTag;
    const nameEnd = body.search(/\s/);
    const qualifiedName = nameEnd === -1 ? body : body.slice(0, nameEnd);
    const attributes: Record<string, string> = {};
    const attributeSource = nameEnd === -1 ? '' : body.slice(nameEnd + 1);
    const attributePattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of attributeSource.matchAll(attributePattern)) {
      const attributeName = match[1];
      if (attributeName) attributes[attributeName] = decodeXml(match[2] ?? match[3] ?? '');
    }

    const node: XmlNode = {
      attributes,
      children: [],
      name: localName(qualifiedName),
      qualifiedName,
      text: '',
    };
    currentNode(stack).children.push(node);
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }

  if (stack.length !== 1) throw new Error('Unclosed XML tag');
  return root;
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  const matches: XmlNode[] = [];
  const pending = [...node.children].reverse();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.name === name) matches.push(current);
    for (let index = current.children.length - 1; index >= 0; index--) {
      const child = current.children[index];
      if (child) pending.push(child);
    }
  }
  return matches;
}

function firstDescendant(node: XmlNode, name: string): XmlNode | undefined {
  return descendants(node, name)[0];
}

function nodeText(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const text = [node.text, ...node.children.map((child) => nodeText(child) ?? '')].join('').trim();
  return text || undefined;
}

function localizedName(node: XmlNode): string | undefined {
  const names = children(node, 'Name');
  const english = names.find(
    (name) => (name.attributes['xml:lang'] ?? name.attributes.lang)?.toLowerCase() === 'en',
  );
  return nodeText(english ?? names[0]);
}

function normalizeDimensionCode(code: string): string {
  return code.toUpperCase() === 'TIME_PERIOD' ? 'time' : code;
}

function annotationValue(dataflow: XmlNode, type: string, field: string): string | undefined {
  const annotation = descendants(dataflow, 'Annotation').find(
    (candidate) => nodeText(children(candidate, 'AnnotationType')[0]) === type,
  );
  return nodeText(annotation ? children(annotation, field)[0] : undefined);
}

function parseGeoLevel(value: string | undefined): GeoLevel | undefined {
  return (
    {
      '0': 'country',
      '1': 'nuts1',
      '2': 'nuts2',
      '3': 'nuts3',
      AGG: 'aggregate',
    } as const
  )[value ?? ''];
}

function parseCodelists(root: XmlNode): Map<string, Map<string, SdmxCodeDefinition>> {
  const codelists = new Map<string, Map<string, SdmxCodeDefinition>>();
  for (const codelist of descendants(root, 'Codelist')) {
    const id = codelist.attributes.id;
    if (!id) continue;
    const values = new Map<string, SdmxCodeDefinition>();
    for (const code of children(codelist, 'Code')) {
      const value = code.attributes.id;
      if (!value) continue;
      const geoLevel =
        id === 'GEO' ? parseGeoLevel(annotationValue(code, 'LEVEL', 'AnnotationTitle')) : undefined;
      values.set(value, {
        label: localizedName(code) ?? value,
        ...(geoLevel && { geoLevel }),
      });
    }
    codelists.set(id, values);
  }
  return codelists;
}

function parseConceptLabels(root: XmlNode): Map<string, string> {
  const concepts = new Map<string, string>();
  for (const concept of descendants(root, 'Concept')) {
    const id = concept.attributes.id;
    if (id) concepts.set(id, localizedName(concept) ?? id);
  }
  return concepts;
}

function parseDimensions(root: XmlNode, conceptLabels: Map<string, string>): DimensionDefinition[] {
  const dimensionList = firstDescendant(root, 'DimensionList');
  if (!dimensionList) throw new Error('SDMX structure omitted the dimension list');

  return dimensionList.children
    .filter(({ name }) => name === 'Dimension' || name === 'TimeDimension')
    .map((dimension, index) => {
      const rawCode = dimension.attributes.id;
      if (!rawCode) throw new Error('SDMX dimension omitted its id');
      const code = normalizeDimensionCode(rawCode);
      const conceptIdentity = children(dimension, 'ConceptIdentity')[0];
      const conceptId = conceptIdentity
        ? firstDescendant(conceptIdentity, 'Ref')?.attributes.id
        : undefined;
      const enumeration = firstDescendant(dimension, 'Enumeration');
      const codelistId = enumeration
        ? firstDescendant(enumeration, 'Ref')?.attributes.id
        : undefined;
      return {
        code,
        ...(codelistId && { codelistId }),
        isTime: dimension.name === 'TimeDimension',
        label: (conceptId && conceptLabels.get(conceptId)) ?? conceptLabels.get(rawCode) ?? code,
        position: Number.parseInt(dimension.attributes.position ?? '', 10) || index + 1,
      };
    })
    .sort((left, right) => left.position - right.position);
}

function parseConstraintValues(root: XmlNode): Map<string, string[]> {
  const valuesByDimension = new Map<string, string[]>();
  for (const region of descendants(root, 'CubeRegion')) {
    if (region.attributes.include?.toLowerCase() === 'false') continue;
    for (const keyValue of children(region, 'KeyValue')) {
      const rawCode = keyValue.attributes.id;
      if (!rawCode) continue;
      const dimensionCode = normalizeDimensionCode(rawCode);
      const values = valuesByDimension.get(dimensionCode) ?? [];
      const seen = new Set(values);
      for (const value of children(keyValue, 'Value')) {
        const code = nodeText(value);
        if (code && !seen.has(code)) {
          values.push(code);
          seen.add(code);
        }
      }
      valuesByDimension.set(dimensionCode, values);
    }
  }
  return valuesByDimension;
}

/** One dataflow from an SDMX 2.1 dataflow list (`dataflow/{agency}`). */
export interface SdmxDataflowSummary {
  /** `ESMS_HTML` annotation: the dataflow's metadata page, which names its collection. */
  esmsUrl?: string;
  id: string;
  /** English name, whitespace collapsed. Falls back to the id. */
  label: string;
  /** `UPDATE_DATA` annotation, verbatim (e.g. `2026-09-15T11:00:00+0200`). */
  lastUpdated?: string;
}

/**
 * The dataflows an SDMX 2.1 dataflow list describes, with the annotations a
 * catalogue entry needs. The list requested with no `detail` carries every
 * dataflow's names and annotations — 23 KB for the Comext host's 11 — where the
 * `allstubs` form carries names only.
 */
export function parseSdmxDataflowList(xml: string): SdmxDataflowSummary[] {
  return descendants(parseXml(xml), 'Dataflow').flatMap((dataflow) => {
    const id = dataflow.attributes.id;
    if (!id) return [];
    const lastUpdated = annotationValue(dataflow, 'UPDATE_DATA', 'AnnotationTitle');
    const esmsUrl = annotationValue(dataflow, 'ESMS_HTML', 'AnnotationURL');
    return [
      {
        id,
        label: (localizedName(dataflow) ?? id).replace(/\s+/g, ' '),
        ...(lastUpdated && { lastUpdated }),
        ...(esmsUrl && { esmsUrl }),
      },
    ];
  });
}

/**
 * The key dimensions of an SDMX 2.1 structure definition (`datastructure/{agency}/{id}`),
 * in the order the positional series key places them, time excluded.
 *
 * Order comes from each dimension's `position` attribute, not document order. The
 * structure definition runs to a few KB whatever the dataset's size, so reading the
 * order here never trips the extraction limit an observation request can hit.
 */
export function parseSdmxDimensionOrder(dataStructureXml: string): string[] {
  return parseDimensions(parseXml(dataStructureXml), new Map())
    .filter(({ isTime }) => !isTime)
    .map(({ code }) => code);
}

/** Combine one dataflow's referencepartial descendants with its dataset content constraint. */
export function parseSdmxDatasetMetadata(
  dataflowXml: string,
  constraintXml: string,
  datasetCode: string,
): SdmxDatasetMetadata {
  const dataflowRoot = parseXml(dataflowXml);
  const constraintRoot = parseXml(constraintXml);
  const dataflow = descendants(dataflowRoot, 'Dataflow').find(
    (candidate) => candidate.attributes.id?.toLowerCase() === datasetCode.toLowerCase(),
  );
  if (!dataflow) throw new Error(`SDMX dataflow response omitted dataset "${datasetCode}"`);

  const codelists = parseCodelists(dataflowRoot);
  const conceptLabels = parseConceptLabels(dataflowRoot);
  const dimensions = parseDimensions(dataflowRoot, conceptLabels);
  const constraintValues = parseConstraintValues(constraintRoot);
  const geoLevelsByCode: Record<string, GeoLevel> = {};
  const valuesByDimension: Record<string, Array<{ code: string; label: string }>> = {};
  const measuredDimensions = new Set<string>();

  for (const dimension of dimensions) {
    const codeDefinitions = dimension.codelistId ? codelists.get(dimension.codelistId) : undefined;
    const constrainedCodes = constraintValues.get(dimension.code);
    if (constrainedCodes !== undefined || codeDefinitions !== undefined) {
      measuredDimensions.add(dimension.code);
    }
    const codes = constrainedCodes ?? [...(codeDefinitions?.keys() ?? [])];
    valuesByDimension[dimension.code] = codes.map((code) => ({
      code,
      label: codeDefinitions?.get(code)?.label ?? code,
    }));
    if (dimension.code === 'geo') {
      for (const code of codes) {
        const level = codeDefinitions?.get(code)?.geoLevel;
        if (level) geoLevelsByCode[code] = level;
      }
    }
  }

  const observationCount = Number.parseInt(
    annotationValue(dataflow, 'OBS_COUNT', 'AnnotationTitle') ?? '',
    10,
  );
  const start = annotationValue(dataflow, 'OBS_PERIOD_OVERALL_OLDEST', 'AnnotationTitle');
  const end = annotationValue(dataflow, 'OBS_PERIOD_OVERALL_LATEST', 'AnnotationTitle');
  const lastUpdated = annotationValue(dataflow, 'UPDATE_DATA', 'AnnotationTitle');
  const metadataUrl = annotationValue(dataflow, 'ESMS_HTML', 'AnnotationURL');

  return {
    geoLevelsByCode,
    meta: {
      code: datasetCode,
      label: localizedName(dataflow) ?? datasetCode,
      dimensions: dimensions.map(({ code, label }) => {
        const values = valuesByDimension[code] ?? [];
        return {
          code,
          label,
          ...(measuredDimensions.has(code) && {
            valuesCount: values.length,
            sampleValues: values.slice(0, 10),
          }),
        };
      }),
      timeRange: { ...(start && { start }), ...(end && { end }) },
      ...(!Number.isNaN(observationCount) && { obsCount: observationCount }),
      ...(lastUpdated && { lastUpdated }),
      ...(metadataUrl && { metadataUrl }),
    },
    valuesByDimension,
  };
}
