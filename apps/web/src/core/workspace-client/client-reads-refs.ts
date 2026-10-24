/**
 * The references + render-derivation read domain: effective class/node
 * icon/color walks over the extends chain, backlinks and the linked/
 * unlinked references rolls (alias-aware), alias resolution, child-page
 * listings/counts, the workspace feature toggles (reads plus the one
 * feature write), and the external-id mapping surface for importer/sync
 * plugins (reads plus the two writes). All graph reads hit the LOCAL store
 * only. Standalone domain — takes the shared ClientContext plus the reads
 * and reads-props domains, no inheritance.
 */

import {
  DEFAULT_CLASS_ICON,
  defaultIconFor,
  deriveDisplayName,
  rendersWithDocumentChrome,
} from "@notees/domain";
import type { WorkspaceFeature } from "@notees/protocol";

import type { ClientEdge, ClientNode, ReferenceEntry } from "./types.js";
import type { ClientContext } from "./client-context.js";
import { WorkspaceClientReads } from "./client-reads.js";
import { WorkspaceClientReadsProps } from "./client-reads-props.js";

export class WorkspaceClientReadsRefs {
  constructor(
    private readonly ctx: ClientContext,
    private readonly reads: WorkspaceClientReads,
    private readonly props: WorkspaceClientReadsProps,
  ) {}

  /**
   * Class effectiveColor: the class's own color, else the nearest ancestor
   * in the extends chain with a color (walked via class_extends edges).
   */
  effectiveClassColor(classId: string): string | null {
    const seen = new Set<string>();
    const queue = [classId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const node = this.reads.getNode(current) ?? this.reads.getNodeRaw(current);
      if (node !== undefined && node.color !== null && node.color !== "") {
        return node.color;
      }
      const parents = this.ctx.store.database
        .prepare("SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id")
        .all(current) as Array<{ parent_class_id: string }>;
      for (const parent of parents) queue.push(parent.parent_class_id);
    }
    return null;
  }

  /** Raw class-icon walk: the class's own icon, else the nearest ancestor
   * in the extends chain with an icon (same walk as effectiveClassColor).
   * No display-time default — the shared building block of the two
   * effective-icon resolvers below. */
  private classIconInChain(classId: string): string | null {
    const seen = new Set<string>();
    const queue = [classId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const node = this.reads.getNode(current) ?? this.reads.getNodeRaw(current);
      if (node !== undefined && node.icon !== null && node.icon !== "") {
        return node.icon;
      }
      const parents = this.ctx.store.database
        .prepare("SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id")
        .all(current) as Array<{ parent_class_id: string }>;
      for (const parent of parents) queue.push(parent.parent_class_id);
    }
    return null;
  }

  /** Class effectiveIcon: the raw chain walk, else the display-time default
   * DEFAULT_CLASS_ICON. The default is read-side only — the stored icon stays
   * empty until the user picks one. Never null. */
  effectiveClassIcon(classId: string): string {
    return this.classIconInChain(classId) ?? DEFAULT_CLASS_ICON;
  }

  /** Node effectiveIcon: the node's own icon, else the first assigned class's
   * chain icon (class order, mirroring effectiveNodeColor). The class default
   * does NOT leak into a node — an iconless classed page renders the page
   * default, not the class glyph. The final fallback is the render-state
   * display default (class → class glyph, document chrome → page glyph,
   * inline block → null, whose chrome is the bullet dot). */
  effectiveNodeIcon(
    node: Pick<ClientNode, "icon" | "classIds" | "isClass" | "isEmbedded" | "parentId">,
  ): string | null {
    if (node.icon !== null && node.icon !== undefined && node.icon !== "") return node.icon;
    for (const classId of node.classIds) {
      const icon = this.classIconInChain(classId);
      if (icon !== null) return icon;
    }
    return defaultIconFor(node);
  }

  /**
   * Node effectiveColor: the node's own color, else the first assigned
   * class's effectiveColor (class order). Drives link underlines and the
   * node-view accent border.
   */
  effectiveNodeColor(node: Pick<ClientNode, "color" | "classIds">): string | null {
    if (node.color !== null && node.color !== undefined && node.color !== "") return node.color;
    for (const classId of node.classIds) {
      const color = this.effectiveClassColor(classId);
      if (color !== null) return color;
    }
    return null;
  }

  /** Edges pointing at the node (mentions, typed links, property refs). */
  getBacklinks(id: string): ClientEdge[] {
    const rows = this.ctx.store.backlinks(id) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sourceId: String(row.source_id),
      targetId: row.target_id === null || row.target_id === undefined ? null : String(row.target_id),
      type: String(row.type),
      verb: row.verb === null || row.verb === undefined ? null : String(row.verb),
      metadata: row.metadata === null || row.metadata === undefined ? null : String(row.metadata),
    }));
  }

  /**
   * Linked references (SCHEMA.md system sections): the three-family read in
   * ONE store pass — direct backlinks of the node, source-side containment
   * roll-up (query-time traversal), and the node-alias roll-up. The alias
   * family rides the applier-materialized `resolved_target_id` column (the
   * store schema v17 optimization — a plain index read replacing the old
   * recursive alias-set walk + per-alias union; the carrier filter is the
   * SCHEMA.md page restriction, mirrored into the store read, so non-page
   * alias carriers still don't act as aliases). The store orders
   * direct+containment first and alias rows last, deduping per (source,
   * kind); the client seen-set keeps one reference per source (direct beats
   * containment beats alias). The alias page's own view is unchanged: its
   * edges match on the raw target column, so it lists only edges targeting
   * the alias itself (SCHEMA.md "Node aliases").
   *
   * Worker-cache freshness (op-lag slice 3): the read is scope-classed —
   * invalidated only when the target id is in the change's affected set
   * (an edge landing on it, or an edit inside its subtree). Rows render
   * through the scope-classed per-row getNode re-read (ReferenceList), so
   * a source edited elsewhere still shows fresh text.
   */
  getLinkedReferences(id: string): ReferenceEntry[] {
    const seen = new Set<string>();
    const entries: ReferenceEntry[] = [];
    for (const row of this.ctx.store.backlinksWithRollup(id) as Array<Record<string, unknown>>) {
      const sourceId = String(row.source_id);
      if (seen.has(sourceId)) continue;
      // Live sources only — a trashed node no longer claims a reference.
      const source = this.reads.getNode(sourceId);
      if (!source) continue;
      const entry = this.referenceEntry(source);
      if (entry === null) continue;
      // Links written inside the node's OWN subtree (a link mentioned in the
      // page's own blocks) are content, not references.
      if (entry.containingPageId === id || entry.source.id === id) continue;
      // Alias-family rows carry the edge's RAW target (the alias page): a
      // link from inside the alias's subtree to the alias is the alias's own
      // content, never a main-page reference — the same both-ends exclusion
      // the client-side union applied before the materialization.
      const rawTargetId =
        row.target_id === null || row.target_id === undefined ? null : String(row.target_id);
      if (
        rawTargetId !== null &&
        rawTargetId !== id &&
        (entry.containingPageId === rawTargetId || entry.source.id === rawTargetId)
      ) {
        continue;
      }
      seen.add(sourceId);
      const kind =
        row.kind === "alias" ? "alias" : row.kind === "containment" ? "containment" : "direct";
      entries.push({
        ...entry,
        kind,
        verb: row.verb === null || row.verb === undefined ? null : String(row.verb),
      });
    }
    return entries;
  }

  /**
   * References (the page's References tab): the distinct document-chrome
   * pages this node's subtree points AT — the outgoing mirror of
   * getLinkedReferences. A mention authored in a block under the node (or a
   * node-typed property value on it) whose target renders with document
   * chrome and is top-level or one of the node's own child pages; the store
   * filter keeps classes, inline blocks, deeper-nested pages and trashed
   * nodes out. One row per target, direct first (the store contract).
   */
  getReferences(id: string): ClientNode[] {
    const targets: ClientNode[] = [];
    for (const row of this.ctx.store.referencesWithRollup(id) as Array<Record<string, unknown>>) {
      const target = this.reads.getNode(String(row.target_id));
      if (!target) continue;
      targets.push(target);
    }
    return targets;
  }

  /**
   * Eager References-tab count for the section-visibility rule (hide the
   * tab at 0). Unlike the linked-references badge — direct-only
   * node_stats, so that LIST can honestly outrun its number — this count
   * reads the same roll-up the list renders, one row per target, so the
   * badge and the rows cannot diverge. Cost: one subtree query per mount,
   * the accepted price (the unlinked-reference count pays a full FTS pass).
   */
  getReferenceCount(id: string): number {
    return (this.ctx.store.referencesWithRollup(id) as Array<Record<string, unknown>>).length;
  }

  /**
   * Unlinked references (document-chrome nodes only — inline blocks never
   * get this section): literal-text FTS matches of the node's display name
   * across the workspace, excluding the node itself and every node that
   * already links to it (the linked-references set).
   *
   * Worker-cache freshness (op-lag slice 3): scope-classed like the linked
   * family. The exclusion side (a source becoming linked) is covered by
   * edge-target inclusion. The DISCOVERY side is not: some other node's
   * literal text newly containing this node's name does not touch this
   * node, so the new row appears only on the next change affecting this
   * node or a listing-affecting op (accepted staleness). Renaming this
   * node IS covered — its own content edit lands in its affected set.
   */
  getUnlinkedReferences(id: string): ReferenceEntry[] {
    const entries: ReferenceEntry[] = [];
    for (const nodeId of this.unlinkedReferenceIds(id)) {
      const source = this.reads.getNode(nodeId);
      if (!source) continue;
      entries.push(this.referenceEntry(source));
    }
    return entries;
  }

  /**
   * Eager unlinked-reference count for the SystemSections visibility rule
   * (hide the section at 0). Same cost as one unlinked query — the section
   * header must know emptiness without an expand, and windowed feeds (the
   * journal) mount too few pages for the per-page query to matter.
   */
  getUnlinkedReferenceCount(id: string): number {
    return this.unlinkedReferenceIds(id).length;
  }

  /** Source ids matching the node's name, minus itself and linked sources. */
  private unlinkedReferenceIds(id: string): string[] {
    const node = this.reads.getNode(id);
    if (!node || !rendersWithDocumentChrome(node, this.reads.parentFactsOf(node))) return [];
    // A source linking the node OR any of its alias pages is already linked
    // (the linked-references set rolls alias-targeted edges in — see
    // getLinkedReferences), so the unlinked list excludes both families.
    const linkedSources = new Set(this.getBacklinks(id).map((edge) => edge.sourceId));
    for (const aliasId of this.props.aliasPageIdsOf(id)) {
      for (const edge of this.getBacklinks(aliasId)) linkedSources.add(edge.sourceId);
    }
    // Name-equivalents: the display name AND every text alias value AND
    // every alias-page title each get a literal-text FTS pass (aliases are
    // names for search).
    const names = [deriveDisplayName(node), ...this.props.nameEquivalentsOf(id)].filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    );
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      // Literal mode (`"name"`): a hit must CONTAIN the name text — the
      // default OR pass would count every row carrying any single name
      // word as a mention (priority ranking, owner 2026-10-13).
      for (const hit of this.ctx.store.search(`"${name}"`)) {
        if (hit.nodeId === id || linkedSources.has(hit.nodeId) || seen.has(hit.nodeId)) continue;
        seen.add(hit.nodeId);
        ids.push(hit.nodeId);
      }
    }
    return ids;
  }

  /**
   * Every node whose alias-terminal is `id` (the aliases listing behind the
   * title-row affordance): live ids from the store's recursive read, mapped
   * to nodes. The main page itself never lists.
   */
  aliasNodesOf(id: string): ClientNode[] {
    const nodes: ClientNode[] = [];
    for (const aliasId of this.ctx.store.aliasNodesOf(id)) {
      const alias = this.reads.getNode(aliasId);
      if (alias === undefined || !rendersWithDocumentChrome(alias, this.reads.parentFactsOf(alias))) continue;
      nodes.push(alias);
    }
    return nodes;
  }

  /**
   * The terminal of a node-alias chain (SCHEMA.md "Node aliases"): the id
   * unchanged when the node is not an alias / the chain is cyclic; otherwise
   * the final main node. The navigation seam — the App open funnels resolve
   * every open through this read, so mentions, links, palette rows,
   * breadcrumbs and graph clicks all land on the terminal.
   */
  resolveAlias(id: string): string {
    return this.ctx.store.resolveAlias(id);
  }

  /**
   * Direct main children (Revision 11: is_class = 0 AND is_embedded = 0
   * — the parent's main-children zone, the Pages section's rows; inline
   * body blocks and classes never appear here).
   */
  getChildPages(id: string): ClientNode[] {
    return this.ctx.store
      .children(id)
      .filter((row) => row.is_class === 0 && row.is_embedded === 0 && row.is_active === 1)
      .map((row) => this.ctx.mapNodeCached(row));
  }

  /**
   * Materialized backlink count (node_stats) — the linked-references badge.
   * DIRECT edges only (targeting the node itself): containment roll-up rows
   * and issue #7 node-alias roll-up rows lengthen the linked-references LIST
   * without moving this number — the same accepted badge-vs-list divergence
   * the containment roll-up documented (see getLinkedReferences).
   */
  getBacklinkCount(id: string): number {
    const row = this.ctx.store.database
      .prepare("SELECT backlink_count AS n FROM node_stats WHERE node_id = ?")
      .get(id) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Feature-toggle read — absent row means enabled (default on). */
  isFeatureEnabled(feature: WorkspaceFeature): boolean {
    return this.ctx.store.isFeatureEnabled(this.ctx.workspaceId, feature);
  }

  /** Toggled feature rows only (untoggled features are absent, not listed). */
  listFeatureRows(): Array<{ feature: string; enabled: boolean }> {
    return this.ctx.store.listFeatureRows(this.ctx.workspaceId);
  }

  /** Active instance count across the feature's managed classes (the F3 disable confirmation). */
  getFeatureInstanceCount(feature: WorkspaceFeature): number {
    return this.ctx.store.featureInstanceCount(this.ctx.workspaceId, feature);
  }

  /** Write a feature toggle (workspace.feature.set, LWW by HLC). */
  async setFeatureEnabled(feature: WorkspaceFeature, enabled: boolean): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope(
        "workspace.feature.set",
        { feature, enabled },
        [],
      ),
    );
  }

  /**
   * Resolve an external-id mapping (importer/sync plugins — a Google event
   * UID, a Readwise highlight id) to the node id; null when unmapped or
   * tombstoned. The mapping names a node, it does not guarantee one — the
   * caller validates the target.
   */
  resolveExternalRef(ref: string): string | null {
    return this.ctx.store.resolveExternalRef(this.ctx.workspaceId, ref);
  }

  /** Every live external ref mapped to the node, sorted (many refs per node). */
  externalRefsOf(nodeId: string): string[] {
    return this.ctx.store.externalRefsOf(this.ctx.workspaceId, nodeId);
  }

  /** Write an external-id mapping (external_ref.set, LWW by HLC per ref). */
  async setExternalRef(ref: string, nodeId: string): Promise<void> {
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("external_ref.set", { ref, nodeId }, [nodeId]));
  }

  /**
   * Remove an external-id mapping (external_ref.delete). The envelope's
   * affected set names the row's CURRENT carrier so the notify cycle
   * refreshes that node's scoped reads even though the payload cannot
   * carry it.
   */
  async removeExternalRef(ref: string): Promise<void> {
    const nodeId = this.resolveExternalRef(ref);
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope("external_ref.delete", { ref }, nodeId !== null ? [nodeId] : []),
    );
  }

  /** Direct main-child count (cheap child-order read) — the child-pages badge. */
  getChildPageCount(id: string): number {
    const row = this.ctx.store.database
      .prepare(
        `SELECT COUNT(*) AS n FROM node_child_order o
         JOIN node n ON n.id = o.child_id
         WHERE o.parent_id = ? AND n.is_class = 0 AND n.is_embedded = 0 AND n.is_active = 1`,
      )
      .get(id) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Breadcrumb row for a reference: the source plus its containing main
   * node — the nearest ancestor matching the document-chrome predicate
   * (non-class, parentless or present-as-main; the source itself when it
   * already matches).
   */
  private referenceEntry(source: ClientNode): ReferenceEntry {
    let current = source;
    for (let guard = 0; guard < 64; guard += 1) {
      if (current.parentId === null) break;
      const parent = this.reads.getNode(current.parentId);
      // The parent-page condition rides along (owner ruling 2026-10-15): a
      // bit under a non-page parent is inert, so the walk continues past
      // it to the real containing page.
      if (parent === undefined || rendersWithDocumentChrome(current, parent)) break;
      current = parent;
    }
    return {
      source,
      containingPageId: current.id,
      containingPageName: deriveDisplayName(current) || current.id,
      // Direct by default; getLinkedReferences overrides for containment rows.
      kind: "direct",
      // Unlinked references match literal text, not an edge — no verb.
      verb: null,
    };
  }
}
