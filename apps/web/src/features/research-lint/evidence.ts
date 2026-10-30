/**
 * research-lint — the synthesis-evidence lint's read layer (research-tier2
 * slice 4). A SUGGESTION-ONLY lint: it counts a synthesis page's embedded
 * evidence set and the UI shows a dashed hint when the set is empty or
 * single-source. Nothing here writes; the lint never gates an edit.
 *
 * Evidence semantics (Review Focus #4):
 *
 *  - Evidence = DISTINCT source-family targets of `embed_ref` tokens in the
 *    page's SUBTREE (the node itself plus every contained node — a plain
 *    getChildren walk, containment-aware: no render-cache exclusions).
 *  - Source-family is EXTENDS-AWARE (the sourcesQuery walk idiom): a node
 *    counts when its class set carries the `source` base OR a class whose
 *    extends-closure reaches it (book → source; a user class extending
 *    journal_article too).
 *  - An embed whose target is NOT source-family resolves to the target's
 *    NEAREST source-family ancestor — an embed of a note block living
 *    inside a source counts as evidence OF that source.
 *  - The edge table's `is_embedded` sees no embeds (embeds ride content
 *    ASTs, never edges), so `mention` tokens carrying the per-link
 *    `isEmbedded` transclusion flag are a SECONDARY signal: they resolve
 *    through the same source-family walk and count toward the same distinct
 *    set. An ordinary mention (the flag absent/false) is a link, not
 *    evidence, and never counts.
 *
 * `synthesisEvidenceOf` is the pure contract (reads injected — tests mock
 * them); `synthesisEvidenceCount` is the render-time read over a live
 * client (synchronous — PageView already re-renders on the client's
 * notifications, so the count recomputes with the same freshness as every
 * other chrome row).
 */

import { SYSTEM_CLASS_UUIDS, workflowEntityId } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import type { ClientNode, WorkspaceClient } from "../../core/workspace-client/index.js";
import type { WorkerClient } from "../../core/worker-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Task 2's deterministic id — the workflow-materialized synthesis class. */
export const SYNTHESIS_CLASS_ID = workflowEntityId("research", "class", "synthesis");

const SOURCE_BASE_ID = SYSTEM_CLASS_UUIDS.source;

/**
 * The read surface the counter composes from — injected so tests exercise
 * the counting semantics without a store.
 */
export interface SynthesisEvidenceReads {
  /** Every node id in the subtree (root included) mapped to its content AST. */
  subtreeContentAst(nodeId: string): Promise<Map<string, ContentAst>>;
  /**
   * The node itself when it is source-family, else the nearest source-family
   * ANCESTOR's id (walked up the parent chain); null when neither exists —
   * such a ref is not evidence.
   */
  nearestSourceAncestorId(nodeId: string): Promise<string | null>;
}

/**
 * Every evidence-bearing ref in the ASTs: `embed_ref` targets first-class,
 * `mention` targets only when the per-link transclusion flag is set
 * (`isEmbedded === true` — the secondary signal).
 */
function evidenceRefsOf(asts: Iterable<ContentAst>): string[] {
  const refs: string[] = [];
  for (const ast of asts) {
    for (const token of ast) {
      if (token.type === "embed_ref") refs.push(token.nodeId);
      else if (token.type === "mention" && token.isEmbedded === true) {
        refs.push(token.targetNodeId);
      }
    }
  }
  return refs;
}

/**
 * The pinned interface: the DISTINCT source-family evidence count for the
 * subtree rooted at `nodeId` — the 0/1 arms the lint's two messages ride.
 */
export async function synthesisEvidenceOf(
  reads: SynthesisEvidenceReads,
  nodeId: string,
): Promise<number> {
  const asts = await reads.subtreeContentAst(nodeId);
  const evidence = new Set<string>();
  for (const ref of evidenceRefsOf(asts.values())) {
    const sourceId = await reads.nearestSourceAncestorId(ref);
    if (sourceId !== null) evidence.add(sourceId);
  }
  return evidence.size;
}

// --- the live-client read -------------------------------------------------------

/**
 * True when the node's class set answers to the source family: the base
 * directly or any class whose extends-closure reaches it. The extends walk
 * is memoized per reads instance (the sourcesQuery ancestor-cache idiom).
 */
function sourceFamilyProbeOf(client: AnyClient): (node: ClientNode) => boolean {
  const extendsCache = new Map<string, boolean>();
  const classReachesSource = (classId: string): boolean => {
    const cached = extendsCache.get(classId);
    if (cached !== undefined) return cached;
    const seen = new Set<string>([classId]);
    let reaches = classId === SOURCE_BASE_ID;
    const stack = [...client.getClassParents(classId)];
    while (!reaches && stack.length > 0) {
      const parent = stack.pop()!;
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (parent === SOURCE_BASE_ID) {
        reaches = true;
        break;
      }
      stack.push(...client.getClassParents(parent));
    }
    extendsCache.set(classId, reaches);
    return reaches;
  };
  return (node) => node.classIds.some(classReachesSource);
}

/** The subtree content read: the root's own AST plus every contained node's. */
function subtreeContentAstSync(client: AnyClient, nodeId: string): Map<string, ContentAst> {
  const map = new Map<string, ContentAst>();
  const visit = (id: string): void => {
    if (map.has(id)) return;
    const node = client.getNode(id);
    if (node === undefined || !node.isActive) return;
    map.set(id, node.contentAst);
    for (const child of client.getChildren(id)) visit(child.id);
  };
  visit(nodeId);
  return map;
}

/** The source-ancestor read: self when source-family, else walk the parents. */
function nearestSourceAncestorIdSync(client: AnyClient, nodeId: string): string | null {
  const isSourceFamily = sourceFamilyProbeOf(client);
  const seen = new Set<string>();
  let current = client.getNode(nodeId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (isSourceFamily(current)) return current.id;
    if (current.parentId === null) return null;
    current = client.getNode(current.parentId);
  }
  return null;
}

/** The read pair composed over a live client (the pure interface's instance). */
export function evidenceReadsOf(client: AnyClient): SynthesisEvidenceReads {
  return {
    subtreeContentAst: (nodeId) => Promise.resolve(subtreeContentAstSync(client, nodeId)),
    nearestSourceAncestorId: (nodeId) =>
      Promise.resolve(nearestSourceAncestorIdSync(client, nodeId)),
  };
}

/**
 * The render-time count: synchronous over the client's (cache-backed)
 * reads, so chrome renders compute it inline like every other row. Same
 * semantics as {@link synthesisEvidenceOf} — this is that function applied
 * to {@link evidenceReadsOf}, minus the Promise ceremony.
 */
export function synthesisEvidenceCount(client: AnyClient, nodeId: string): number {
  const evidence = new Set<string>();
  for (const ref of evidenceRefsOf(subtreeContentAstSync(client, nodeId).values())) {
    const sourceId = nearestSourceAncestorIdSync(client, ref);
    if (sourceId !== null) evidence.add(sourceId);
  }
  return evidence.size;
}
