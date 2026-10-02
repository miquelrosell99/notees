/**
 * The editable DOM of a block — plain text runs interleaved with atomic
 * node-link pills, mirroring the archived editor's inline model (and the
 * read-mode rendering): a mention is a `contenteditable="false"` span, one
 * caret unit, visually identical to the read-mode dashed-underline link.
 *
 * Prose offsets stay the single coordinate system (editor/selection.ts):
 * a pill contributes its captured `text` length, so `el.textContent` equals
 * `proseFromAst(ast)` and every prose-based operation (capture triggers,
 * splices, mark ranges) works unchanged. Only the DOM build and the
 * DOM⇄prose mapping know about the pill elements.
 *
 * Quote children render FLAT into the editable (a quote is plain text in
 * edit mode, as before); their mention children become pills too. Keyboard
 * atom selection/deletion enumerates TOP-LEVEL mentions only — a prose range
 * inside a quote cannot be spliced structurally (spliceTokens would drop
 * the whole quote token), so quote-nested pills stay point-and-menu only.
 */

import { proseFromAst, proseSpans } from "@/editor/prose.js";

/** CSS class of the atomic pill element (also the click/hit-test hook). */
export const ATOM_CLASS = "nt-atom";

/** One atomic mention in the editable DOM (top-level token). */
export interface EditableAtom {
  /** Index of the mention token inside the top-level content stream. */
  tokenIndex: number;
  /** Inclusive prose offset where the pill starts. */
  start: number;
  /** Exclusive prose offset where the pill ends. */
  end: number;
  targetNodeId: string;
  /** Captured surface text (the pill's DOM content and prose contribution). */
  text: string;
  /** Custom label override, when set. */
  displayText?: string;
}

function isMention(token: unknown): token is Record<string, unknown> & {
  targetNodeId: string;
  text: string;
  displayText?: string;
} {
  return (
    typeof token === "object" &&
    token !== null &&
    (token as Record<string, unknown>).type === "mention" &&
    typeof (token as Record<string, unknown>).targetNodeId === "string" &&
    typeof (token as Record<string, unknown>).text === "string"
  );
}

/** Top-level mention spans (prose order) — the keyboard-addressable atoms. */
export function editableAtoms(ast: readonly unknown[]): EditableAtom[] {
  const atoms: EditableAtom[] = [];
  for (const span of proseSpans(ast)) {
    if (span.end <= span.start) continue;
    const token = ast[span.tokenIndex];
    if (!isMention(token)) continue;
    atoms.push({
      tokenIndex: span.tokenIndex,
      start: span.start,
      end: span.end,
      targetNodeId: token.targetNodeId,
      text: token.text,
      ...(token.displayText !== undefined ? { displayText: token.displayText } : {}),
    });
  }
  return atoms;
}

/** Stable identity for a pill within one build (validated before use). */
export function atomKey(atom: Pick<EditableAtom, "start" | "end">): string {
  return `${atom.start}:${atom.end}`;
}

/** Resolve a pill element's data-atom-key against the current atom list. */
export function atomFromKey(
  atoms: readonly EditableAtom[],
  key: string | undefined,
): EditableAtom | null {
  if (key === undefined) return null;
  return atoms.find((a) => atomKey(a) === key) ?? null;
}

/**
 * Rebuild the editable DOM from a token stream (text runs + pill elements).
 * The pill data-atom-key carries the BUILD-TIME prose range; consumers must
 * validate keys against the CURRENT atom list (offsets drift as the user
 * types — selection state is cleared on input, so a stale key never acts).
 */
export function buildEditableDom(el: HTMLElement, ast: readonly unknown[]): void {
  el.replaceChildren();
  let offset = 0;
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      switch (t.type) {
        case "text":
        case "typed_link":
          if (typeof t.text === "string") {
            el.appendChild(document.createTextNode(t.text));
            offset += t.text.length;
          }
          break;
        case "mention": {
          if (typeof t.text !== "string") break;
          const pill = document.createElement("span");
          pill.className = ATOM_CLASS;
          pill.contentEditable = "false";
          pill.spellcheck = false;
          pill.textContent = t.text;
          pill.dataset.atomKey = `${offset}:${offset + t.text.length}`;
          offset += t.text.length;
          el.appendChild(pill);
          break;
        }
        case "hard_break":
          el.appendChild(document.createTextNode("\n"));
          offset += 1;
          break;
        case "math":
          if (typeof t.expression === "string") {
            el.appendChild(document.createTextNode(t.expression));
            offset += t.expression.length;
          }
          break;
        case "quote":
          if (Array.isArray(t.children)) walk(t.children as readonly unknown[]);
          break;
        default:
          // asset_ref / embed_ref / query / whiteboard carry no prose.
          break;
      }
    }
  };
  walk(ast);
}

/** Structural signature: prose text + pill count — for rehydrate comparisons. */
export function editableDomSignature(ast: readonly unknown[]): string {
  let pills = 0;
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      if (t.type === "mention" && typeof t.text === "string") pills += 1;
      else if (t.type === "quote" && Array.isArray(t.children))
        walk(t.children as readonly unknown[]);
    }
  };
  walk(ast);
  return `${proseFromAst(ast)}#${pills}`;
}
