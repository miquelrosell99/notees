/**
 * Deck builder — the pure slide model behind presentation mode (§34.26 P2).
 *
 * The note is the source: a presentation is a pure read of one page's
 * subtree, split into slides by a tree heuristic (decision D1: no slide-break
 * marker token — top-level children ARE the breaks):
 *
 *   - slide 0 is always the title slide (the page's own text content,
 *     rendered by the view with the node's icon/color per P4);
 *   - every `present_as_main=1` top-level child is one section slide — the
 *     child's own content is the slide title, its children the body;
 *   - runs of `present_as_main=0` (inline body) children chunk into intro
 *     slides by a density rule (greedy: a chunk closes when adding the next
 *     block would pass the character target or the block cap);
 *   - an `embed_ref` found anywhere in a slide's blocks expands (P5): the
 *     embed target's own children splice into the stream right after the
 *     referencing slide, partitioned the same way. The visited set guards
 *     cycles (renderer obligation, same philosophy as EmbedBoundary).
 *
 * Pure module, no React: the view resolves node ids live, the builder only
 * needs a resolver for embed expansion. `ClientNode`/`BlockTreeNode`
 * satisfy the input shapes structurally.
 */

import { proseFromAst } from "@/editor/prose.js";

/** The minimal node shape the builder reads (ClientNode satisfies it). */
export interface DeckNode {
  id: string;
  presentAsMain: boolean;
  contentAst: readonly unknown[];
}

/** Recursive tree input shape (BlockTreeNode satisfies it). */
export interface DeckTreeEntry {
  node: DeckNode;
  children: DeckTreeEntry[];
}

/** Density-driven slide sizing (P4): short slides read large, dense normal. */
export type DeckDensity = "sparse" | "normal" | "dense";

/** Layout heuristic outcome for a content slide (P4). */
export type DeckSlideLayout =
  | { type: "standard" }
  /** Trailing image block: text column left, image column right. */
  | { type: "split"; imageAssetId: string }
  /** The slide's own cover property: text column left, cover column right. */
  | { type: "cover-split"; imageAssetId: string }
  /** The body is a single image block: centered, full size. */
  | { type: "image-full"; imageAssetId: string };

export type DeckSlide =
  | { kind: "title"; nodeId: string }
  | { kind: "section"; nodeId: string; layout: DeckSlideLayout; density: DeckDensity }
  | { kind: "intro"; blockIds: string[]; layout: DeckSlideLayout; density: DeckDensity };

/** Character budget for one intro slide before the chunker closes it. */
export const INTRO_SLIDE_TARGET_CHARS = 500;
/** Hard cap on blocks per intro slide regardless of characters. */
export const INTRO_SLIDE_MAX_BLOCKS = 5;

/** At or below this visible-text length a slide renders sparse (large text). */
export const DENSITY_SPARSE_MAX_CHARS = 280;
/** Above this visible-text length a slide renders dense (guarded overflow). */
export const DENSITY_DENSE_MIN_CHARS = 1000;

/** Visible-text length of one node (its own content, prose projection). */
export function deckTextLength(ast: readonly unknown[]): number {
  return proseFromAst(ast).length;
}

/** Visible-text length of a subtree (block + all nested children). */
export function deckSubtreeLength(entry: DeckTreeEntry): number {
  let total = deckTextLength(entry.node.contentAst);
  for (const child of entry.children) total += deckSubtreeLength(child);
  return total;
}

/** Map a visible-text length to the density tier (P4 sizing). */
export function deckDensityOf(totalChars: number): DeckDensity {
  if (totalChars <= DENSITY_SPARSE_MAX_CHARS) return "sparse";
  if (totalChars >= DENSITY_DENSE_MIN_CHARS) return "dense";
  return "normal";
}

/** The single asset an image block carries, when the block IS one asset_ref. */
export function imageAssetOfBlock(entry: DeckTreeEntry): string | null {
  const ast = entry.node.contentAst;
  if (ast.length !== 1) return null;
  const token = ast[0];
  if (typeof token !== "object" || token === null) return null;
  const t = token as Record<string, unknown>;
  if (t.type !== "asset_ref" || typeof t.assetId !== "string") return null;
  return t.assetId;
}

/** Trailing-image layout: a lone image block centers; else text/image split. */
function layoutOfBody(entries: DeckTreeEntry[]): DeckSlideLayout {
  const last = entries[entries.length - 1];
  if (last === undefined) return { type: "standard" };
  const assetId = imageAssetOfBlock(last);
  if (assetId === null) return { type: "standard" };
  return entries.length === 1
    ? { type: "image-full", imageAssetId: assetId }
    : { type: "split", imageAssetId: assetId };
}

/** Every embed_ref target in the entries' content (quote children included),
 *  depth-first, deduped — the expansion splice order for one slide. */
export function collectEmbedTargets(entries: readonly DeckTreeEntry[]): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  const scanAst = (ast: readonly unknown[]): void => {
    for (const token of ast) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      if (t.type === "embed_ref" && typeof t.nodeId === "string" && t.nodeId !== "") {
        if (!seen.has(t.nodeId)) {
          seen.add(t.nodeId);
          targets.push(t.nodeId);
        }
      }
      if (t.type === "quote" && Array.isArray(t.children)) scanAst(t.children as readonly unknown[]);
    }
  };
  const walk = (entry: DeckTreeEntry): void => {
    scanAst(entry.node.contentAst);
    for (const child of entry.children) walk(child);
  };
  for (const entry of entries) walk(entry);
  return targets;
}

/** Greedy density chunking of one inline-body run into intro slides. */
function chunkIntroRun(run: DeckTreeEntry[]): DeckTreeEntry[][] {
  const chunks: DeckTreeEntry[][] = [];
  let current: DeckTreeEntry[] = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    currentChars = 0;
  };
  for (const entry of run) {
    const length = deckSubtreeLength(entry);
    if (
      current.length > 0 &&
      (currentChars + length > INTRO_SLIDE_TARGET_CHARS || current.length >= INTRO_SLIDE_MAX_BLOCKS)
    ) {
      flush();
    }
    current.push(entry);
    currentChars += length;
  }
  flush();
  return chunks;
}

/**
 * Build the slide list for a page subtree. `resolve` supplies embed targets
 * for P5 expansion (return undefined for a broken embed — skipped, matching
 * the renderer's broken-embed placeholder philosophy); the root is never
 * re-expanded (the visited set starts with its id).
 */
export function buildDeck(
  root: DeckTreeEntry,
  resolve: (nodeId: string) => DeckTreeEntry | undefined,
): DeckSlide[] {
  const visited = new Set<string>([root.node.id]);
  const slides: DeckSlide[] = [{ kind: "title", nodeId: root.node.id }];
  emitChildrenSlides(root.children, visited, resolve, slides);
  return slides;
}

/** Partition one children list (sections + intro runs), expanding embeds. */
function emitChildrenSlides(
  children: DeckTreeEntry[],
  visited: Set<string>,
  resolve: (nodeId: string) => DeckTreeEntry | undefined,
  out: DeckSlide[],
): void {
  let introRun: DeckTreeEntry[] = [];
  const flushIntro = () => {
    if (introRun.length === 0) return;
    for (const chunk of chunkIntroRun(introRun)) {
      const chars = chunk.reduce((sum, entry) => sum + deckSubtreeLength(entry), 0);
      out.push({
        kind: "intro",
        blockIds: chunk.map((entry) => entry.node.id),
        layout: layoutOfBody(chunk),
        density: deckDensityOf(chars),
      });
      expandEmbeds(chunk, visited, resolve, out);
    }
    introRun = [];
  };

  for (const child of children) {
    if (child.node.presentAsMain) {
      flushIntro();
      const chars = child.children.reduce((sum, entry) => sum + deckSubtreeLength(entry), 0);
      out.push({
        kind: "section",
        nodeId: child.node.id,
        layout: layoutOfBody(child.children),
        density: deckDensityOf(chars),
      });
      expandEmbeds([child], visited, resolve, out);
    } else {
      introRun.push(child);
    }
  }
  flushIntro();
}

/** P5: an embed target's children splice into the stream after the slide
 *  that references it; nested embeds expand depth-first with cycle guard. */
function expandEmbeds(
  entries: DeckTreeEntry[],
  visited: Set<string>,
  resolve: (nodeId: string) => DeckTreeEntry | undefined,
  out: DeckSlide[],
): void {
  for (const targetId of collectEmbedTargets(entries)) {
    if (visited.has(targetId)) continue;
    visited.add(targetId);
    const target = resolve(targetId);
    if (target === undefined || target.children.length === 0) continue;
    emitChildrenSlides(target.children, visited, resolve, out);
  }
}
