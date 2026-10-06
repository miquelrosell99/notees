/**
 * Unlinked-reference actions — the promote half.
 *
 * Promote converts the source block's literal text match into a real
 * mention: the first text run carrying the target's display name splits
 * into [before, mention, after], preserving the original token's marks on
 * the text remainder. One level of quote children is searched too (FTS
 * indexes quote text). Null when no run matches (the name changed after
 * the index ran) — the gesture then stays inert rather than guessing.
 *
 * Pure grammar work over ContentAst — the caller owns the updateObject write.
 */

import type { ContentAst, ContentToken } from "@notees/protocol";

interface TextTokenShape {
  type?: string;
  text?: string;
  marks?: string[];
}

function textRunOf(token: unknown): TextTokenShape | null {
  const t = token as TextTokenShape;
  return t !== null && typeof t === "object" && t.type === "text" && typeof t.text === "string"
    ? t
    : null;
}

function mentionTokensFor(run: TextTokenShape, at: number, length: number, targetId: string) {
  const tokens: ContentToken[] = [];
  const before = run.text!.slice(0, at);
  const after = run.text!.slice(at + length);
  const marks = run.marks !== undefined && run.marks.length > 0 ? { marks: run.marks } : {};
  if (before !== "") tokens.push({ type: "text", text: before, ...marks } as ContentToken);
  tokens.push({ type: "mention", targetNodeId: targetId, text: run.text!.slice(at, at + length) });
  if (after !== "") tokens.push({ type: "text", text: after, ...marks } as ContentToken);
  return tokens;
}

/**
 * The AST with the first literal occurrence of `targetName` promoted to a
 * mention of `targetId`; null when nothing matches.
 */
export function promoteMentionInAst(
  ast: ContentAst,
  targetName: string,
  targetId: string,
): ContentAst | null {
  if (targetName.trim() === "") return null;
  const name = targetName.trim();
  for (let i = 0; i < ast.length; i++) {
    const token = ast[i]!;
    const run = textRunOf(token);
    if (run !== null) {
      const at = run.text!.indexOf(name);
      if (at !== -1) {
        return [...ast.slice(0, i), ...mentionTokensFor(run, at, name.length, targetId), ...ast.slice(i + 1)];
      }
      continue;
    }
    if ((token as { type?: string }).type === "quote") {
      const children = (token as { children?: unknown[] }).children ?? [];
      for (let j = 0; j < children.length; j++) {
        const childRun = textRunOf(children[j]);
        if (childRun === null) continue;
        const at = childRun.text!.indexOf(name);
        if (at === -1) continue;
        const nextChildren = [
          ...children.slice(0, j),
          ...mentionTokensFor(childRun, at, name.length, targetId),
          ...children.slice(j + 1),
        ];
        return [
          ...ast.slice(0, i),
          { ...(token as object), children: nextChildren } as ContentToken,
          ...ast.slice(i + 1),
        ];
      }
    }
  }
  return null;
}
