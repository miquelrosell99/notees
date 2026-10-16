/**
 * listStyle marker derivation (SCHEMA.md "Node structure", store schema v23).
 *
 * The wire node field `listStyle` (`"numbered" | "alpha" | "roman"`, null =
 * the bullet default) stores ONLY the style — the marker NUMBER is derived
 * at render time, never stored: a block's position within the contiguous run
 * of same-style siblings directly above it, where any sibling without the
 * same style (or a different one) resets the count to 1/a/i. The numbering
 * is computed per sibling group, so nested lists number independently.
 */

import type { ListStyle } from "@notees/protocol";

import type { ClientNode } from "@/core/workspace-client.js";

/** Lowercase alpha label, spreadsheet-column style: 1 → a, 26 → z, 27 → aa. */
function alphaLabel(position: number): string {
  let label = "";
  let rest = position;
  while (rest > 0) {
    rest -= 1;
    label = String.fromCharCode(97 + (rest % 26)) + label;
    rest = Math.floor(rest / 26);
  }
  return label;
}

/** Lowercase roman numeral (marker scale — up to 3999 covers any list). */
function romanLabel(position: number): string {
  const table: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let label = "";
  let rest = position;
  for (const [value, symbol] of table) {
    while (rest >= value) {
      label += symbol;
      rest -= value;
    }
  }
  return label;
}

/** The marker text for a style at a 1-based run position ("3.", "c.", "iii."). */
export function formatListMarker(style: ListStyle, position: number): string {
  switch (style) {
    case "numbered":
      return `${position}.`;
    case "alpha":
      return `${alphaLabel(position)}.`;
    case "roman":
      return `${romanLabel(position)}.`;
  }
}

/** The node's derived list marker within its sibling group, or null when the
 * node carries no style (the bullet default renders instead) or no parent
 * (a parentless node has no sibling run). `siblings` is the node's direct
 * sibling list in child order (the parent's `getChildren`). A node missing
 * from the group (a transient read) yields null rather than a guessed
 * number. */
export function deriveListMarker(
  node: Pick<ClientNode, "id" | "listStyle"> & { parentId?: string | null },
  siblings: ReadonlyArray<Pick<ClientNode, "id" | "listStyle">>,
): string | null {
  if (node.listStyle === null || node.parentId == null) return null;
  let run = 0;
  for (const sibling of siblings) {
    if (sibling.id === node.id) return formatListMarker(node.listStyle, run + 1);
    run = sibling.listStyle === node.listStyle ? run + 1 : 0;
  }
  return null;
}
