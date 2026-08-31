/**
 * Library drag-and-drop logic (Task 12 — drag-to-attach & drag-to-collect).
 *
 * Pure, store-free helpers behind the Library panes' drop targets:
 *
 * - Drag a file onto a source row/card → upload + asset node + `attachments`
 *   property entry (`mergeAttachmentValue` computes the new property value).
 * - Drag a source onto a collection in the tree pane → membership.
 *
 * Membership mechanism (Decision 22): collections have no membership table —
 * contents are sources nested under the collection recursively ∪ sources
 * linking to it. A "link" can only ever live in the source's own content AST
 * (`node_link` rows derive from content), which for page-classed sources IS
 * the title: a membership link there would leak into the display name and be
 * wiped by the next rename (title edits replace the whole content). Nesting
 * via the normal `node.move` op is the clean half of Decision 22, so
 * drag-to-collect nests (`resolveCollectionDrop` → `nest`), with no-op guards
 * for self-drops, cycles, and existing membership (nested or linked).
 */
import { parseAST, parseLinkId, unwrapCrdtContentAst } from '@/lib/astBuilder';

/** Shared HTML5 DnD MIME type for dragging Notees nodes (precedent: sidebar cards, NodeInline). */
export const NOTEES_NODE_MIME = 'application/x-notees-node';

export interface NodeDragPayload {
  nodeUuid: string;
  name?: string;
}

/** Serialize a node drag payload (drag start). */
export function serializeNodeDragPayload(payload: NodeDragPayload): string {
  return JSON.stringify(payload);
}

/** Parse a node drag payload (drop). Returns null for missing/malformed data. */
export function parseNodeDragPayload(raw: string | null | undefined): NodeDragPayload | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { nodeUuid?: unknown; name?: unknown };
    if (typeof data?.nodeUuid !== 'string' || data.nodeUuid.length === 0) return null;
    return {
      nodeUuid: data.nodeUuid,
      name: typeof data.name === 'string' ? data.name : undefined,
    };
  } catch {
    return null;
  }
}

/** True when the drag carries OS files (`dataTransfer.types` contains "Files"). */
export function isFileDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).includes('Files');
}

/** True when the drag carries a Notees node payload. */
export function isNodeDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(NOTEES_NODE_MIME);
}

/**
 * Compute the new `attachments` property value (multi node property = a single
 * JSON array of asset node UUIDs) after attaching `assetUuid`. Returns null
 * when the asset is already attached (no-op).
 */
export function mergeAttachmentValue(existing: unknown, assetUuid: string): string[] | null {
  const current = Array.isArray(existing)
    ? existing.filter((v): v is string => typeof v === 'string')
    : typeof existing === 'string'
      ? [existing]
      : [];
  if (current.includes(assetUuid)) return null;
  return [...current, assetUuid];
}

/** True when the node's content AST already references `targetUuid`. */
export function contentLinksTo(content: string | null | undefined, targetUuid: string): boolean {
  if (!content) return false;
  const ast = unwrapCrdtContentAst(parseAST(content));

  const RAW_LINK_RE = /\[\[([^\]]+)\]\]/g;

  function walk(node: unknown): boolean {
    if (node === null || typeof node !== 'object') return false;
    const c = node as { type?: string; text?: string; link_id?: string; children?: unknown[] };
    if (c.type === 'node_link' && typeof c.link_id === 'string') {
      if (parseLinkId(c.link_id).nodeUuid === targetUuid) return true;
    }
    if (c.type === 'text' && typeof c.text === 'string') {
      RAW_LINK_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RAW_LINK_RE.exec(c.text)) !== null) {
        if (match[1] === targetUuid) return true;
      }
    }
    if (Array.isArray(c.children)) {
      for (const child of c.children) {
        if (walk(child)) return true;
      }
    }
    return false;
  }

  return ast.some((block) => walk(block));
}

export type CollectionDropAction =
  | { action: 'nest' }
  | { action: 'noop'; reason: 'self' | 'cycle' | 'already-member' | 'already-linked' };

export interface CollectionDropInput {
  sourceUuid: string;
  collectionUuid: string;
  /** Parent chain of the source (ancestors only, nearest first). */
  sourceAncestors: readonly string[];
  /** Parent chain of the collection (ancestors only, nearest first). */
  collectionAncestors: readonly string[];
  /** The source's content already references the collection. */
  sourceAlreadyLinks: boolean;
}

/**
 * Decide what dropping `sourceUuid` onto `collectionUuid` should do.
 * `nest` = reparent the source under the collection via a normal `node.move`
 * op; the collection's nested-recursive query picks it up.
 */
export function resolveCollectionDrop(input: CollectionDropInput): CollectionDropAction {
  const { sourceUuid, collectionUuid, sourceAncestors, collectionAncestors, sourceAlreadyLinks } =
    input;
  if (sourceUuid === collectionUuid) return { action: 'noop', reason: 'self' };
  if (sourceAncestors.includes(collectionUuid)) return { action: 'noop', reason: 'already-member' };
  if (sourceAlreadyLinks) return { action: 'noop', reason: 'already-linked' };
  if (collectionAncestors.includes(sourceUuid)) return { action: 'noop', reason: 'cycle' };
  return { action: 'nest' };
}
