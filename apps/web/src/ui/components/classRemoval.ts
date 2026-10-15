/**
 * classRemoval — the non-removable-class rule: the journal chain classes
 * are identity-bearing (the year/month/day journal chain per the seed
 * manifest), so class-membership removal is refused for them everywhere the
 * UI offers ×-removal (NodePills — the page classes row AND the block-row
 * classes column —, the classed-nodes section, the node context menu, and
 * the selection bar's bulk unassign). (The seeded `class` meta class left
 * the list with its 2026-10-07 retirement — it is no longer seeded.)
 *
 * The refusal is UI-level and honest: the × stays visible, the click
 * surfaces an explanatory toast, and no write is issued. (The server/CLI
 * REST surface stays ungated — a deliberate admin escape hatch, same as
 * the original shell.)
 */

import type { ContentAst } from "@notees/protocol";
import { deriveDisplayName, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { notificationStore } from "./ui/notificationStore.js";

/** Class ids whose membership ×-removal is refused (the journal chain). */
const NON_REMOVABLE_CLASS_IDS: ReadonlySet<string> = new Set([
  SYSTEM_CLASS_UUIDS.year,
  SYSTEM_CLASS_UUIDS.month,
  SYSTEM_CLASS_UUIDS.day,
]);

/** The refusal message for a non-removable class id, or null when removable. */
export function classRemovalRefusal(classId: string): string | null {
  if (!NON_REMOVABLE_CLASS_IDS.has(classId)) return null;
  return "Journal classes are identity-bearing — they can't be removed from a node.";
}

/**
 * Enforce the rule for one attempted removal: refuses (toast + true) when
 * the class is non-removable; no-op false otherwise.
 */
export function refuseClassRemoval(classId: string): boolean {
  const refusal = classRemovalRefusal(classId);
  if (refusal === null) return false;
  notificationStore.warning("Class can't be removed", refusal);
  return true;
}

/** True when the class pill's × is replaced by the non-removable lock. */
export function isClassNonRemovable(classId: string): boolean {
  return NON_REMOVABLE_CLASS_IDS.has(classId);
}

// --- Removal dissolution (owner ruling 2026-10-15) ------------------------------

/**
 * An inline class link is a LIVE REFERENCE to the class membership — when
 * the class is REMOVED from the node, every `class_link` token for it in
 * the node's content dissolves into plain text (the label the link
 * rendered: its one-off `displayText`, else the class's current name, else
 * the raw id), so a removal gesture never leaves a dangling reference. The
 * divergent state (link present, membership gone) stays legal for paths
 * that bypass the gesture (undo interleavings, external writers) — the
 * dashed pending rendering covers those.
 *
 * Gesture-level convenience only: the wire stays pure — `class.unassign`
 * never mutates content (appliers can't rewrite other ops), so this is two
 * plain ops (a content `object.update` + the unassign) issued by the client
 * gesture. The session undo journal reverts both, restoring the link.
 */


/** The minimal client surface the dissolution writes through. */
export interface DissolveClient {
  getNode(id: string): { id: string; contentAst: ContentAst; classIds: string[] } | undefined;
  /** Optional display-name cache read; absent clients fall back to deriving
   *  the label from the class node's own content. */
  getDisplayName?(id: string): string | null;
  updateObject(id: string, fields: { contentAst: ContentAst }): Promise<void>;
  unassignClass(id: string, classId: string): Promise<void>;
}

/**
 * Deep-rewrite one content AST: every `class_link` carrying `classId`
 * becomes a plain text token of its rendered label. Returns the (possibly
 * unchanged) AST and the dissolved token count.
 */
export function dissolveClassLinksInAst(
  ast: readonly unknown[],
  classId: string,
  labelFor: (classId: string) => string,
): { ast: unknown[]; changed: number } {
  let changed = 0;
  const walk = (tokens: readonly unknown[]): unknown[] =>
    tokens.map((token) => {
      if (typeof token !== "object" || token === null) return token;
      const t = token as Record<string, unknown>;
      if (t.type === "class_link" && t.classId === classId) {
        changed += 1;
        const label =
          (typeof t.displayText === "string" ? t.displayText : undefined) ??
          labelFor(classId);
        return { type: "text", text: label };
      }
      if (Array.isArray(t.children)) {
        const children = walk(t.children as readonly unknown[]);
        if (children !== t.children) return { ...t, children };
      }
      return token;
    });
  const rewritten = walk(ast);
  return { ast: rewritten, changed };
}

/**
 * The removal gesture: dissolve the node's inline links to the class, then
 * unassign it. No-op content-wise when the node references the class only
 * via the pill.
 */
export async function removeClassDissolvingLinks(
  client: DissolveClient,
  nodeId: string,
  classId: string,
): Promise<void> {
  const node = client.getNode(nodeId);
  if (node !== undefined) {
    const { ast, changed } = dissolveClassLinksInAst(node.contentAst, classId, (id) => {
      const cached = client.getDisplayName?.(id);
      if (cached !== undefined && cached !== null && cached !== "") return cached;
      const target = client.getNode(id);
      return target === undefined ? id : (deriveDisplayName(target) || id);
    });
    if (changed > 0) {
      await client.updateObject(nodeId, { contentAst: ast as ContentAst });
    }
  }
  await client.unassignClass(nodeId, classId);
}
