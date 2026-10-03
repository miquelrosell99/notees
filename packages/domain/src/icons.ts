/**
 * Display-time default icons — the glyphs a node/class renders when no icon
 * is authored anywhere in its fallback chain. These are READ-side constants
 * only: nothing here is ever persisted to the operation log or the derived
 * stores. The stored `icon` field stays null/"" until the user picks one;
 * every effective-icon resolver ends its chain with `defaultIconFor`.
 *
 * Values are MDI names in the kebab form the web `Icon` resolver accepts
 * (same glyph choices the command palette already used as its fallbacks).
 */

import { isClassNode, rendersWithDocumentChrome, type NodeLike } from "./node.js";

/** Classes with no authored icon (own or inherited) render as a shape. */
export const DEFAULT_CLASS_ICON = "mdi-shape-outline";

/** Pages (document chrome) with no authored icon render as a document. */
export const DEFAULT_PAGE_ICON = "mdi-file-document-outline";

/**
 * Render-state-aware display fallback: class nodes get the class glyph,
 * document-chrome nodes the page glyph, inline blocks none (their chrome is
 * the bullet dot — a default glyph there would erase the page/block
 * distinction the render cascade exists to make).
 */
export function defaultIconFor(
  node: Pick<NodeLike, "isClass" | "parentId" | "presentAsMain">,
): string | null {
  if (isClassNode(node)) return DEFAULT_CLASS_ICON;
  return rendersWithDocumentChrome(node) ? DEFAULT_PAGE_ICON : null;
}
