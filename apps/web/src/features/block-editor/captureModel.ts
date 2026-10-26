/**
 * The capture model of the block editor — the trigger-gesture state the
 * @ / # / + / / popups run on: the trigger kinds and chars, the slash
 * popup's candidate contract, the capture state machine (trigger offset,
 * query, selection-replacement range, fixed label, hint, viewport
 * anchor), the mention token shape, the node-link context-menu state,
 * the quote grammar's admitted child types, and the small helpers
 * (picker-hint truncation, the /query starter AST, strict local
 * YYYY-MM-DD). Pure data and functions — no React. Extracted verbatim
 * from BlockTextEditor.tsx (Stage D monolith split).
 */

/** Which capture trigger opened the popup. */
export type CaptureKind = "mention" | "tag" | "class" | "slash";

/** One selectable row of the slash popup (the TriggerPopup's contract). */
export interface SlashCandidate {
  id: string;
  label: string;
}

export const TRIGGER_CHAR: Record<CaptureKind, string> = { mention: "@", tag: "#", class: "+", slash: "/" };

/**
 * The trigger boundary rule: a sigil opens its picker when typed at the
 * start of the text or right after any NON-word character — whitespace,
 * punctuation, brackets, quotes, dashes… A word character before the sigil
 * (letter, digit, underscore — the email `user@host` case) means mid-word
 * typing: no popup. `prevChar` is the character before the sigil, or
 * undefined at the start of the text.
 */
export function isTriggerBoundary(prevChar: string | undefined): boolean {
  if (prevChar === undefined) return true;
  return !/[\p{L}\p{N}_]/u.test(prevChar);
}

/** customLabel schema bound (content-mark.ts mentionTokenSchema). */
export const MENTION_LABEL_MAX = 512;

/** One-line picker banner text: long labels truncate so the banner stays a line. */
export function truncatePickerHint(text: string): string {
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

/**
 * The `/query` slash starter AST — exactly what the query builder composes
 * from its default state, so the token the builder opens on matches one
 * clean Apply cycle.
 */
export const STARTER_QUERY_AST: Record<string, unknown> = {
  version: 1,
  scope: { type: "entire_workspace" },
  root: { type: "group", logic: "and", children: [] },
};

/** Strict local YYYY-MM-DD for the date chain (mirrors the picker idiom). */
export function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Second-stage state of the `/template` slash flow (the trigger is already consumed). */
export interface TemplateStageState {
  /** Draft-prose offset where the instantiated page's mention lands. */
  start: number;
  /** The remainder typed after "template" — the picker's initial filter. */
  filter: string;
}

export interface CaptureState {
  kind: CaptureKind;
  /** Prose offset of the trigger character. */
  start: number;
  /**
   * Draft text between the trigger and the caret (slash inline mode) — or,
   * for a mention popup opened over a selection, the selected text, which
   * pre-fills the picker's search field and becomes the custom label on a
   * Ctrl/Cmd+Enter pick.
   */
  query: string;
  /** Selected candidate row (slash inline mode only). */
  index: number;
  /**
   * Mention popup opened by typing `@` over a selection: no trigger char
   * exists in the draft; the pick (or cancel) operates on the prose range
   * [start, replaceEnd) instead.
   */
  replaceEnd?: number;
  /**
   * Ctrl/Cmd+Shift+L over a selection: the picker searches with an EMPTY
   * query and this text — the selection itself — becomes the inserted
   * link's custom label (customLabel) on any pick.
   */
  fixedLabel?: string;
  /** Faint one-line mode banner the picker renders above its search field. */
  hint?: string;
  /** Viewport anchor captured when a node-picker popup opened (caret line). */
  anchor?: { top: number; left: number };
}

/** A mention token as stored in the content stream (content-mark.ts) — no
 *  captured link text rides the wire; the visible
 *  label is customLabel ?? the target's current display name. */
export interface MentionToken {
  type: "mention";
  targetNodeId: string;
  customLabel?: string;
  linkId?: string;
  /** Manual per-link embedding flag (default false). */
  isEmbedded?: boolean;
}

/** State of the node-link right-click menu (hit-tested to a mention token). */
export interface LinkMenuState {
  x: number;
  y: number;
  /** Index of the mention token inside contentAst (validated again on action). */
  tokenIndex: number;
  /** Prose range the token covers in the current draft. */
  start: number;
  end: number;
  targetNodeId: string;
}

/** Inline token types the quote token admits as children (SCHEMA.md grammar). */
export const QUOTE_CHILD_TYPES = new Set([
  "text",
  "typed_link",
  "mention",
  "class_link",
  "math",
  "hard_break",
]);
