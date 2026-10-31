/**
 * @fileoverview Lift dimensions holding one value across the rows shown into a single
 * header line, so content[] does not repeat them on every row.
 * @module mcp-server/tools/hoist-dimensions
 */

/**
 * Picks the dimensions `cell` renders identically on every row and joins them into a header.
 * Fewer than two rows hoist nothing. `cell` returns undefined where a row has no value, which
 * keeps that dimension on the rows: a header entry must rebuild every row exactly.
 *
 * The header says "rows shown" because a preview shorter than the match can show one value of
 * a dimension the whole match varies on.
 */
export function hoistDimensions<Row>(
  rows: Row[],
  dimensions: string[],
  cell: (row: Row, dimension: string) => string | undefined,
): { header: string | undefined; hoisted: Set<string> } {
  const shared = new Map<string, string>();
  for (const dimension of rows.length < 2 ? [] : dimensions) {
    const values = new Set(rows.map((row) => cell(row, dimension)));
    const [value] = values;
    if (values.size === 1 && value !== undefined) shared.set(dimension, value);
  }
  return {
    header:
      shared.size > 0
        ? `**Same in all ${rows.length} rows shown:** ${[...shared.values()].join(' | ')}`
        : undefined,
    hoisted: new Set(shared.keys()),
  };
}
