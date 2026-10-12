/**
 * Heading conversion — the v1 "Convert to heading" gesture on the content
 * grammar's `heading` token (owner 2026-10-12). Both directions are
 * conditionally visible in the block context menu and ride an ordinary
 * undoable `object.update` content rewrite:
 *
 *  - to-heading:   a block whose content is ONE plain text run wraps it in
 *    a heading token (marks carry into the child);
 *  - from-heading: a block whose content is ONE heading token flattens its
 *    children to a single plain text run (the prose survives; per-child
 *    marks fold away — the honest inverse at block granularity).
 *
 * Anything richer (multi-token content) offers neither direction: the menu
 * stays silent rather than guessing.
 */

import { plainTextExcerpt } from "@notees/domain";
import type { ContentAst, InlineToken } from "@notees/protocol";

import type { ClientNode } from "@/core/workspace-client.js";

export type HeadingConversion = "to-heading" | "from-heading" | null;

/** The conversion direction a node's content shape supports (null = neither). */
export function headingConversionOf(node: ClientNode): HeadingConversion {
  const ast = node.contentAst;
  if (ast.length !== 1) return null;
  const token = ast[0]!;
  if (token.type === "heading") return "from-heading";
  if (token.type === "text") return "to-heading";
  return null;
}

/** Wrap the single text run in a heading token (marks carry into the child). */
export function headingAstOf(node: ClientNode): ContentAst {
  const token = node.contentAst[0];
  if (token?.type !== "text") return node.contentAst;
  const child: InlineToken =
    token.marks !== undefined && token.marks.length > 0
      ? { type: "text", text: token.text, marks: token.marks }
      : { type: "text", text: token.text };
  return [{ type: "heading", children: [child] }];
}

/** Flatten the single heading token back to one plain text run. */
export function plainTextAstOf(node: ClientNode): ContentAst {
  const token = node.contentAst[0];
  if (token?.type !== "heading") return node.contentAst;
  const text = plainTextExcerpt([token]).trim();
  return text === "" ? [] : [{ type: "text", text }];
}
