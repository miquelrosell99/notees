/**
 * Read revisions — the worker-side validity stamps behind the multiRead
 * delta protocol.
 *
 * The main thread's read cache refetches dirtied keys through one multiRead
 * per change burst; at fleet scale that response carried ~240MB per
 * structural gesture (11k fat `getEffectiveProperties` payloads dominate),
 * and structured-cloning it worker→main cost the seconds the app felt. The
 * worker now stamps every cached-read key with a revision string computed
 * from what the read actually depends on, keeps the stamp it last served,
 * and answers `READ_UNCHANGED` instead of the value when the stamp is
 * unchanged — the main thread keeps its cached value for those keys.
 *
 * Stamp soundness rule: the stamp only has to be CONSERVATIVE — over-broad
 * stamps cost a full re-serve (never consulted unless the notification
 * dirtied the key anyway), under-broad stamps serve stale data. When in
 * doubt, mix more counters in. The catch-all for unmapped methods is the
 * global revision (bumped by every apply); a coverage test pins every
 * READ_METHODS entry to an explicit family instead of the catch-all.
 *
 * Revision families:
 *  - node(id): the subtree-row epoch — bumped for the affected ids, their
 *    ancestors (a change under P bubbles up to P), and, for subtree ops
 *    (delete/restore), their descendants. Any read whose value derives from
 *    the row of `id` or rows under it re-serves when this changes.
 *  - shape(id): the subtree-shape epoch — bumped by placement ops
 *    (create/move/delete/restore, isEmbedded flips) for the same three sets.
 *    Membership reads (getChildren/getBlockTree) stamp on this.
 *  - listing / classes / edges / features: coarse counters bumped by the
 *    op-type family (listing-affecting envelopes; class.* and propertySchema.*;
 *    object.* carriers — the content/edge family; feature/prefs ops).
 *  - nodeAll / shapeAll / global: fallbacks for oversized walks, remote
 *    structural batches, and unknown-scope notifications.
 *
 * Old-parent soundness: a move's OLD ancestor chain is invisible to
 * post-apply walks (the node already sits under its new parent), so
 * enqueueLocal collects the pre-apply chain and passes it to bumpLocal.
 */

import type { Envelope } from "@notees/protocol";
import { isListingAffectingEnvelope } from "@notees/sync";

/**
 * multiRead delta sentinel: served in place of a value whose stamp is
 * unchanged since the last serve. An object tag (never a string) — read
 * values are arrays/objects/strings/numbers/null, and no real value carries
 * this key, so the tag is unambiguous after the structured clone. Display
 * names and aliases ARE strings, which is exactly why the sentinel is not.
 */
export const READ_UNCHANGED: { readonly __noteesReadUnchanged: true } = Object.freeze({
  __noteesReadUnchanged: true,
} as const);

export function isReadUnchanged(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __noteesReadUnchanged?: unknown }).__noteesReadUnchanged === true
  );
}

/** Per-envelope walk cap: over it, the coarse "All" counters take over — a wholesale re-serve beats a giant ancestor/descendant walk. */
export const REVISION_WALK_CAP = 512;

export interface RevisionWalk {
  /** The ancestor chain (parent, grandparent, …, excluding `id` itself) at call time. */
  ancestorsOf(id: string): string[];
  /** Every descendant id (recursive children) of the given ids. */
  descendantsOf(ids: string[]): string[];
}

/** Placement ops: their apply can change who appears under whom. */
function isShapeOp(envelope: Envelope): boolean {
  if (envelope.opType === "object.create" || envelope.opType === "object.move") return true;
  if (envelope.opType === "object.delete" || envelope.opType === "object.restore") return true;
  return (
    envelope.opType === "object.update" &&
    typeof envelope.payload === "object" &&
    envelope.payload !== null &&
    "isEmbedded" in envelope.payload
  );
}

/** Subtree-mutating ops: the affected ids' whole subtrees change state. */
function isSubtreeOp(opType: string): boolean {
  return opType === "object.delete" || opType === "object.restore";
}

export class ReadRevisions {
  private global = 0;
  private listing = 0;
  private classes = 0;
  private edges = 0;
  private features = 0;
  private nodeAll = 0;
  private shapeAll = 0;
  private readonly node = new Map<string, number>();
  private readonly shape = new Map<string, number>();

  constructor(private readonly walk: RevisionWalk) {}

  /** The ancestor chain of one id at call time (the pre-apply capture seam). */
  ancestorsOf(id: string): string[] {
    return this.walk.ancestorsOf(id);
  }

  /**
   * Bump after a LOCAL apply (enqueueLocal). `summary` is the store's
   * ChangeSummary (authoritative affected ids); `oldAncestors` is the
   * pre-apply ancestor chain of the affected ids for placement ops — the
   * post-apply walk alone would miss the vacated side of a move.
   */
  bumpLocal(
    envelope: Envelope,
    summary: { affectedNodeIds: string[] },
    oldAncestors: string[],
  ): void {
    this.global += 1;
    const op = envelope.opType;
    const affected = summary.affectedNodeIds;
    if (affected.length === 0) {
      // Evaluate-at-apply ops (trash.empty) touch an unknowable set — coarse.
      this.nodeAll += 1;
      this.shapeAll += 1;
      this.listing += 1;
      this.classes += 1;
      this.edges += 1;
      this.features += 1;
      return;
    }
    const subtree = isSubtreeOp(op);
    const descendants = subtree ? this.walk.descendantsOf(affected) : [];
    const nodeTargets = [...affected, ...oldAncestors, ...descendants];
    for (const id of affected) nodeTargets.push(...this.walk.ancestorsOf(id));
    if (nodeTargets.length > REVISION_WALK_CAP) {
      this.nodeAll += 1;
    } else {
      for (const id of new Set(nodeTargets)) this.bump(this.node, id);
    }
    if (isShapeOp(envelope)) {
      const shapeTargets = [...nodeTargets];
      if (shapeTargets.length > REVISION_WALK_CAP) {
        this.shapeAll += 1;
      } else {
        for (const id of new Set(shapeTargets)) this.bump(this.shape, id);
      }
    }
    if (isListingAffectingEnvelope(envelope)) this.listing += 1;
    if (
      op.startsWith("class.") ||
      op.startsWith("propertySchema.") ||
      op.startsWith("plugin.") ||
      op.startsWith("workspace.plugin.")
    ) {
      this.classes += 1;
    }
    if (op.startsWith("object.")) this.edges += 1;
    if (op === "workspace.feature.set" || op.startsWith("prefs.")) this.features += 1;
  }

  /**
   * Bump for a REMOTE-originated notification (push/pull/realtime callbacks —
   * no envelopes at this seam, only the merged affected set + structural
   * flag). Remote batches are rarer than local keystrokes, so the rule is
   * deliberately coarse: any affected id re-serves the class/edge families,
   * and structural re-serves listings + every shape read.
   */
  bumpRemote(info: { affectedNodeIds: string[]; structural: boolean } | undefined): void {
    this.global += 1;
    if (info === undefined) {
      this.bumpAll();
      return;
    }
    const affected = info.affectedNodeIds;
    if (affected.length > REVISION_WALK_CAP) {
      this.nodeAll += 1;
    } else {
      const targets = [...affected];
      for (const id of affected) targets.push(...this.walk.ancestorsOf(id));
      for (const id of new Set(targets)) this.bump(this.node, id);
    }
    if (affected.length > 0 || info.structural) {
      this.classes += 1;
      this.edges += 1;
    }
    if (info.structural) {
      this.listing += 1;
      this.shapeAll += 1;
    }
  }

  /** Unknown-scope notification (bootstrap, manual wrappers): everything is stale. */
  bumpAll(): void {
    this.nodeAll += 1;
    this.shapeAll += 1;
    this.listing += 1;
    this.classes += 1;
    this.edges += 1;
    this.features += 1;
  }

  private bump(map: Map<string, number>, id: string): void {
    map.set(id, (map.get(id) ?? 0) + 1);
  }

  /**
   * The validity stamp for one cached-read key. Cheap by construction: map
   * lookups and counter reads only — never the read itself.
   */
  stampFor(method: string, args: unknown[]): string {
    const id = typeof args[0] === "string" ? args[0] : null;
    switch (method) {
      case "getNode":
      case "getNodeRaw":
      case "getDisplayName":
      case "getAssetInfo":
      case "getPage":
        return `n:${id === null ? "" : (this.node.get(id) ?? 0)}:${this.nodeAll}`;
      case "getEffectiveProperties":
      case "getPropertyRowShells":
        return `p:${id === null ? "" : (this.node.get(id) ?? 0)}:${this.classes}:${this.nodeAll}`;
      case "getChildren":
      case "getBlockTree":
      case "getChildPages":
      case "getChildPageCount":
        return id === null
          ? `g:${this.global}`
          : `cs:${this.shape.get(id) ?? 0}:${this.node.get(id) ?? 0}:${this.shapeAll}:${this.nodeAll}`;
      case "getBacklinks":
      case "getBacklinkCount":
      case "getLinkedReferences":
      case "getReferences":
      case "getReferenceCount":
      case "getUnlinkedReferences":
      case "getUnlinkedReferenceCount":
      case "getForwardPaths":
      case "aliasNodesOf":
      case "resolveAlias":
      case "resolveNodeByName":
        return `e:${this.edges}`;
      case "roots":
      case "listPages":
      case "listPageSummaries":
      case "listTrashed":
      case "listArchived":
      case "listArchivedClasses":
        return `l:${this.listing}`;
      case "search":
      case "getSearchSnippet":
        // Search rides the content family too: a keystroke must refresh it.
        return `q:${this.listing}:${this.edges}`;
      case "recentLinkTargets":
        return `e:${this.edges}`;
      case "listClasses":
      case "classIcons":
      case "effectiveClassIcons":
      case "getClassParents":
      case "getClassChildren":
      case "getDirectClassChildren":
      case "getClassMembers":
      case "getClassMemberCount":
      case "getClassBindings":
      case "getRegistryBindings":
      case "listPropertySchemas":
      case "effectiveClassColor":
      case "effectiveClassIcon":
      case "effectiveClassParentlessBlock":
      case "getClassDisplayTemplate":
      case "resolveEffectiveDisplayTemplate":
      case "effectiveNodeColor":
      case "effectiveNodeIcon":
        // Edges ride along: archival (object.update {active}) changes class
        // membership listings without touching the class families.
        return `c:${this.classes}:${this.edges}`;
      case "isFeatureEnabled":
      case "listFeatureRows":
      case "getFeatureInstanceCount":
        return `f:${this.features}:${this.global}`;
      default:
        // Unknown/unmapped reads are always fresh (never served stale).
        return `g:${this.global}`;
    }
  }
}
