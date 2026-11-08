/**
 * @fileoverview XML entity decoding for the text Eurostat's XML documents carry — SDMX
 * structures, the codelist dump, and SOAP fault strings.
 * @module services/xml-entities
 */

const XML_ENTITY = /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi;

const PREDEFINED_ENTITY: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/**
 * `text` with XML's five predefined entities and its numeric character references
 * (`&#233;`, `&#xE9;`) decoded in one pass, so `&amp;lt;` reads `&lt;`. Names match in any
 * case. A reference past U+10FFFF and any other entity stay as written; DTD-declared
 * entities are not supported.
 */
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(XML_ENTITY, (entity, token: string) => {
    if (token[0] !== '#') return PREDEFINED_ENTITY[token.toLowerCase()] ?? entity;
    const hex = token[1] === 'x' || token[1] === 'X';
    const codePoint = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}
