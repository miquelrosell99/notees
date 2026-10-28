/**
 * The editable DOM of a block — plain text runs interleaved with atomic
 * node-link pills, mirroring the archived editor's inline model (and the
 * read-mode rendering): a mention is a `contenteditable="false"` span, one
 * caret unit, visually identical to the read-mode dashed-underline link.
 * A mention's pill text is its LABEL (`mentionProse`: the one-off
 * `customLabel`, else the target's re-resolved CURRENT full title — the
 * same chain read mode renders —, else the raw target id for a broken
 * reference), so the link text is always live graph state — the wire
 * stores no captured text to go stale. The label length is what the pill
 * contributes to the prose offsets, keeping
 * `el.textContent === proseFromAst(ast)` — the single coordinate system
 * every prose-based operation rides. Class chips render the same way
 * (their label is re-resolved at build time through `resolveClassName` —
 * the wire token stores no text), with the read-mode class-link look: a
 * wavy underline tinted by the class's effective color through
 * `resolveClassColor`.
 *
 * Quote children render FLAT into the editable (a quote is plain text in
 * edit mode, as before); their mention children become pills too.
 * Keyboard atom selection/deletion enumerates TOP-LEVEL mentions and chips
 * only — a prose range inside a quote cannot be spliced structurally
 * (spliceTokens would drop the whole quote token), so quote-nested pills
 * stay point-and-menu only.
 */

import {
  proseFromAst,
  proseSpans,
  mentionProse,
  type ClassNameResolver,
  type MentionNameResolver,
} from "@/editor/prose.js";
import { cssColorFor } from "@/components/ui/kit/colorPresets.js";

/** CSS class of the atomic pill element (also the click/hit-test hook). */
export const ATOM_CLASS = "nt-atom";

/** CSS class distinguishing a class chip from a mention pill. */
export const CHIP_CLASS = "nt-atom--chip";

/** Resolves a class's effective color (stored preset token or hex) — tints
 *  the chip atom's wavy underline at build time. */
export type ClassColorResolver = (classId: string) => string | null;

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
  /** Custom label override, when set (a mention's `customLabel`, a chip's
   *  `displayText`). */
  customLabel?: string;
  /** Pill kind — the class chip is atomic like a mention but references a
   *  class and owns no link menu. */
  kind?: "mention" | "chip";
}

function isMention(token: unknown): token is Record<string, unknown> & {
  targetNodeId: string;
  customLabel?: string;
} {
  return (
    typeof token === "object" &&
    token !== null &&
    (token as Record<string, unknown>).type === "mention" &&
    typeof (token as Record<string, unknown>).targetNodeId === "string"
  );
}

function isChip(token: unknown): token is Record<string, unknown> & { classId: string } {
  return (
    typeof token === "object" &&
    token !== null &&
    (token as Record<string, unknown>).type === "class_link" &&
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
export function editableAtoms(
  ast: readonly unknown[],
  resolveClassName?: ClassNameResolver,
  resolveMentionName?: MentionNameResolver,
): EditableAtom[] {
  const atoms: EditableAtom[] = [];
  for (const span of proseSpans(ast, resolveClassName, resolveMentionName)) {
    if (span.end <= span.start) continue;
    const token = ast[span.tokenIndex];
    if (isMention(token)) {
      atoms.push({
        tokenIndex: span.tokenIndex,
        start: span.start,
        end: span.end,
        targetNodeId: token.targetNodeId,
        // The pill's surface text — the same label precedence the prose
        // projection and the DOM build use (customLabel → re-resolved full
        // title → raw id), so atoms, spans, and the DOM never disagree
        // about a pill's length.
        text: mentionProse(token, resolveMentionName),
        kind: "mention",
        ...(token.customLabel !== undefined ? { customLabel: token.customLabel } : {}),
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
        ...(typeof token.displayText === "string" ? { customLabel: token.displayText } : {}),
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
 * `resolveClassName` renders class chip labels (re-resolved per build);
 * `resolveClassColor` tints the chip's wavy underline with the class's
 * effective color (the read-mode nt-link--class parity).
 * `resolveMentionName` renders mention pill labels (re-resolved per build —
 * the read-mode full-title chain; a stale captured text never surfaces).
 */
export function buildEditableDom(
  el: HTMLElement,
  ast: readonly unknown[],
  resolveClassName?: ClassNameResolver,
  resolveClassColor?: ClassColorResolver,
  resolveClassAssigned?: (classId: string) => boolean,
  resolveMentionName?: MentionNameResolver,
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
          // The pill renders the LABEL (customLabel → re-resolved full
          // title → raw id), never a stored text — the wire stores none
          // (read-mode parity; the link text is always live graph state).
          const label = mentionProse(t, resolveMentionName);
          const pill = document.createElement("span");
          pill.className = ATOM_CLASS;
          pill.contentEditable = "false";
          pill.spellcheck = false;
          pill.textContent = label;
          pill.dataset.atomKey = `${offset}:${offset + label.length}`;
          offset += label.length;
          el.appendChild(pill);
          break;
        }
        case "class_link": {
          const label = chipText(t, resolveClassName);
          if (label === "") break; // unresolvable and unlabeled: nothing renders
          const assigned = typeof t.classId === "string" ? (resolveClassAssigned?.(t.classId) ?? true) : true;
          const pill = document.createElement("span");
          pill.className = `${ATOM_CLASS} ${CHIP_CLASS}${assigned ? "" : " nt-atom--chip-pending"}`;
          pill.contentEditable = "false";
          pill.spellcheck = false;
          pill.textContent = label;
          if (typeof t.classId === "string") {
            const color = resolveClassColor?.(t.classId) ?? null;
            if (color !== null) pill.style.textDecorationColor = cssColorFor(color);
          }
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
        case "heading":
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
export function editableDomSignature(
  ast: readonly unknown[],
  resolveClassName?: ClassNameResolver,
  resolveMentionName?: MentionNameResolver,
): string {
  let pills = 0;
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      if (t.type === "mention" && typeof t.targetNodeId === "string") pills += 1;
      else if (t.type === "class_link") pills += 1;
      else if (t.type === "quote" && Array.isArray(t.children))
        walk(t.children as readonly unknown[]);
      else if (t.type === "heading" && Array.isArray(t.children))
        walk(t.children as readonly unknown[]);
    }
  };
  walk(ast);
  return `${proseFromAst(ast, resolveClassName, resolveMentionName)}#${pills}`;
}
