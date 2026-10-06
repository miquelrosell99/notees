/**
 * The editable DOM of a block — plain text runs interleaved with atomic
 * node-link pills, mirroring the archived editor's inline model (and the
 * read-mode rendering): a mention is a `contenteditable="false"` span, one
 * caret unit, visually identical to the read-mode dashed-underline link.
 * Class chips render the same way (their label is re-resolved at build
 * time through `resolveClassName` — the wire token stores no text).
 *
 * Prose offsets stay the single coordinate system (editor/selection.ts):
 * a pill contributes its captured `text` (or the chip's resolved label)
 * length, so `el.textContent` equals `proseFromAst(ast)` and every
 * prose-based operation (capture triggers, splices, mark ranges) works
 * unchanged. Only the DOM build and the DOM⇄prose mapping know about the
 * pill elements.
 *
 * Quote children render FLAT into the editable (a quote is plain text in
 * edit mode, as before); their mention children become pills too. Keyboard
 * atom selection/deletion enumerates TOP-LEVEL mentions and chips only — a
 * prose range inside a quote cannot be spliced structurally (spliceTokens
 * would drop the whole quote token), so quote-nested pills stay
 * point-and-menu only.
 */

import { proseFromAst, proseSpans, type ClassNameResolver } from "@/editor/prose.js";

/** CSS class of the atomic pill element (also the click/hit-test hook). */
export const ATOM_CLASS = "nt-atom";

/** CSS class distinguishing a class chip from a mention pill. */
export const CHIP_CLASS = "nt-atom--chip";

/** One atomic pill in the editable DOM (top-level token). */
export interface EditableAtom {
  /** Index of the token inside the top-level content stream. */
  tokenIndex: number;
  /** Inclusive prose offset where the pill starts. */
  start: number;
  /** Exclusive prose offset where the pill ends. */
  end: number;
  /** The referenced node — a mention's target, a chip's class. */
  targetNodeId: string;
  /** Rendered surface text (the pill's DOM content and prose contribution). */
  text: string;
  /** Custom label override, when set. */
  displayText?: string;
  /** Pill kind — the class chip is atomic like a mention but references a
   *  class and owns no link menu. */
  kind?: "mention" | "chip";
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

function isChip(token: unknown): token is Record<string, unknown> & { classId: string } {
  return (
    typeof token === "object" &&
    token !== null &&
    (token as Record<string, unknown>).type === "class_chip" &&
    typeof (token as Record<string, unknown>).classId === "string"
  );
}

/** A chip token's rendered label: the one-off wording when set, else the
 *  re-resolved class display name, else "" (unresolvable chips render
 *  nothing — consistent with the prose projection, which contributes "" too). */
function chipText(token: Record<string, unknown>, resolveClassName?: ClassNameResolver): string {
  if (typeof token.displayText === "string" && token.displayText.length > 0) return token.displayText;
  if (typeof token.classId === "string") return resolveClassName?.(token.classId) ?? "";
  return "";
}

/** Top-level pill spans (prose order) — the keyboard-addressable atoms. */
export function editableAtoms(ast: readonly unknown[], resolveClassName?: ClassNameResolver): EditableAtom[] {
  const atoms: EditableAtom[] = [];
  for (const span of proseSpans(ast, resolveClassName)) {
    if (span.end <= span.start) continue;
    const token = ast[span.tokenIndex];
    if (isMention(token)) {
      atoms.push({
        tokenIndex: span.tokenIndex,
        start: span.start,
        end: span.end,
        targetNodeId: token.targetNodeId,
        text: token.text,
        kind: "mention",
        ...(token.displayText !== undefined ? { displayText: token.displayText } : {}),
      });
      continue;
    }
    if (isChip(token)) {
      atoms.push({
        tokenIndex: span.tokenIndex,
        start: span.start,
        end: span.end,
        targetNodeId: token.classId,
        text: chipText(token, resolveClassName),
        kind: "chip",
        ...(typeof token.displayText === "string" ? { displayText: token.displayText } : {}),
      });
    }
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
 * `resolveClassName` renders class chip labels (re-resolved per build).
 */
export function buildEditableDom(
  el: HTMLElement,
  ast: readonly unknown[],
  resolveClassName?: ClassNameResolver,
): void {
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
        case "class_chip": {
          const label = chipText(t, resolveClassName);
          if (label === "") break; // unresolvable and unlabeled: nothing renders
          const pill = document.createElement("span");
          pill.className = `${ATOM_CLASS} ${CHIP_CLASS}`;
          pill.contentEditable = "false";
          pill.spellcheck = false;
          pill.textContent = label;
          pill.dataset.atomKey = `${offset}:${offset + label.length}`;
          offset += label.length;
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
  // An empty AST leaves the editable with zero children — no line box, so the
  // caret renders at an unpredictable height and point-hit caret placement
  // (focusAtPoint) can resolve outside the editable. A lone <br> is the
  // standard contentEditable empty state: it contributes no textContent, so
  // drafts, prose offsets, and rehydration signatures are unaffected.
  if (el.childNodes.length === 0) el.appendChild(document.createElement("br"));
}

/** Structural signature: prose text + pill count — for rehydrate comparisons. */
export function editableDomSignature(ast: readonly unknown[], resolveClassName?: ClassNameResolver): string {
  let pills = 0;
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      if (t.type === "mention" && typeof t.text === "string") pills += 1;
      else if (t.type === "class_chip") pills += 1;
      else if (t.type === "quote" && Array.isArray(t.children))
        walk(t.children as readonly unknown[]);
    }
  };
  walk(ast);
  return `${proseFromAst(ast, resolveClassName)}#${pills}`;
}
