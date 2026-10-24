/**
 * The read API's node + listing + class-binding domain: node identity reads
 * (getNode/getNodeRaw/getPage), the workspace listings (pages/roots/trash/
 * classes), the class-extends relations, and the class → property-schema
 * binding reads (registry rows + the extends-aware/seed-spec-synthesized
 * projection). All reads hit the LOCAL store only; list-scale reads ride the
 * revision cache (cachedListRead in this domain). Standalone domain — takes
 * the shared ClientContext, no inheritance.
 */

import {
  deriveDisplayName,
  rendersWithDocumentChrome,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";
import type { NodeRow } from "@notees/store";

import {
  mapClassBindingRow,
  type ClassBinding,
  type ClientNode,
  type ParentRenderFacts,
  type ArchivedEntry,
  type TrashedEntry,
} from "./types.js";
import type { ClientContext } from "./client-context.js";

export class WorkspaceClientReads {
  constructor(private readonly ctx: ClientContext) {}

  // --- read API (local store only) -------------------------------------------

  /** The node mapped to the client view, or undefined when missing/inactive. */
  getNode(id: string): ClientNode | undefined {
    const row = this.ctx.store.getNode(id);
    if (!row || row.is_active !== 1) return undefined;
    return this.ctx.mapNodeCached(row);
  }

  /** A single node, regardless of active state (backlink sources may be trashed). */
  getNodeRaw(id: string): ClientNode | undefined {
    const row = this.ctx.store.getNode(id);
    return row ? this.ctx.mapNodeCached(row) : undefined;
  }

  /** Display name for mentions/chips (SCHEMA.md name derivation); null when unknown. */
  getDisplayName(id: string): string | null {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) return null;
    return deriveDisplayName(node) || null;
  }

  /**
   * A document-chrome node (Revision 11): non-class and parentless or
   * present-as-main — the Page View's read; anything else (a class, an
   * inline block) is not a page here. The parent-page condition (owner
   * ruling 2026-10-15) is honored via the parent's render facts.
   */
  getPage(id: string): ClientNode | undefined {
    const node = this.getNode(id);
    return node !== undefined &&
      rendersWithDocumentChrome(node, this.parentFactsOf(node), (classId) =>
        this.effectiveClassParentlessBlock(classId),
      )
      ? node
      : undefined;
  }

  /** Class effectiveParentlessRole — the extends-aware "block" demote (owner
   *  2026-10-24): true when the class's OWN flag is "block" OR any
   *  extends-ancestor's is (the same chain walk as effectiveClassColor,
   *  reduced to a boolean one-way demote — there is no per-level unflag).
   *  THIS is the resolver the domain role predicates take for the parentless
   *  cascade branch. Lives in the reads domain so every read class (refs,
   *  props) reaches it without circular wiring. */
  effectiveClassParentlessBlock(classId: string): boolean {
    const seen = new Set<string>();
    const queue = [classId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const node = this.getNode(current) ?? this.getNodeRaw(current);
      if (node !== undefined && node.parentlessRole === "block") return true;
      const parents = this.ctx.store.database
        .prepare("SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id")
        .all(current) as Array<{ parent_class_id: string }>;
      for (const parent of parents) queue.push(parent.parent_class_id);
    }
    return false;
  }

  /** The parent's render facts for the parent-page condition, when known. */
  parentFactsOf(node: { parentId: string | null }): ParentRenderFacts {
    return node.parentId !== null ? this.getNode(node.parentId) : undefined;
  }

  /** All document-chrome nodes (parentless or main children), deterministic
   *  order. parentlessRole-aware (owner 2026-10-24): a parentless node whose
   *  classes effectively carry "block" renders Block-role and is NOT a page —
   *  the same EXISTS the query compiler's pages scope flattens. */
  listPages(): ClientNode[] {
    return this.cachedListRead("listPages", () => {
      const rows = this.ctx.store.database
        .prepare(
          `SELECT * FROM node
         WHERE workspace_id = ? AND is_class = 0 AND (parent_id IS NULL OR is_embedded = 0) AND is_active = 1
           AND (parent_id IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM class_hierarchy ch
             JOIN node c ON c.id = ch.ancestor_id
             WHERE ch.class_id IN (SELECT value FROM json_each(node.class_ids))
               AND c.parentless_role = 'block'))
         ORDER BY COALESCE(name, id), id`,
        )
        .all(this.ctx.workspaceId) as NodeRow[];
      return rows.map((row) => this.ctx.mapNodeCached(row));
    });
  }

  /**
   * Top-level pages only (parentless non-class, active) — the shell's
   * workspace-level page lists and the export enumerator. Same display order
   * as listPages; unlike listPages, main children (subpages in a parent's
   * Pages zone) are NOT included.
   */
  roots(): ClientNode[] {
    return this.cachedListRead("roots", () =>
      this.ctx.store.roots(this.ctx.workspaceId).map((row) => this.ctx.mapNodeCached(row)),
    );
  }

  /**
   * The Trash hub's read: soft-trashed subtree roots (the `trash` table
   * joined to the inactive node rows), newest deletion first. Every normal
   * read filters `is_active = 1`; this is the one surface that deliberately
   * reads the other side. `is_permanent = 0` keeps hard-delete tombstones
   * out — they have no node row to restore.
   */
  listTrashed(): TrashedEntry[] {
    return this.cachedListRead("listTrashed", () => {
      const rows = this.ctx.store.database
        .prepare(
          `SELECT n.*, t.deleted_at AS deleted_at FROM trash t
           JOIN node n ON n.id = t.node_id
           WHERE n.workspace_id = ? AND n.is_active = 0 AND t.is_permanent = 0
           ORDER BY t.deleted_at DESC, n.id`,
        )
        .all(this.ctx.workspaceId) as Array<NodeRow & { deleted_at: string }>;
      return rows.map((row) => ({ node: this.ctx.mapNodeCached(row), deletedAt: row.deleted_at }));
    });
  }

  /**
   * The Archived surface's read (owner ruling 2026-10-22): nodes with
   * `is_active = 0` and NO trash row — the archival side of the liveness
   * bit, distinct from the Trash hub's deletion side. Trashed subtrees stay
   * out (they have their own hub); newest archival first (the node's
   * `updated_at` rides the archival write).
   */
  listArchived(): ArchivedEntry[] {
    return this.cachedListRead("listArchived", () => {
      const rows = this.ctx.store.database
        .prepare(
          `SELECT n.*, n.updated_at AS archived_at FROM node n
           WHERE n.workspace_id = ? AND n.is_active = 0
             AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.node_id = n.id)
           ORDER BY n.updated_at DESC, n.id`,
        )
        .all(this.ctx.workspaceId) as Array<NodeRow & { archived_at: string }>;
      return rows.map((row) => ({ node: this.ctx.mapNodeCached(row), archivedAt: row.archived_at }));
    });
  }

  /**
   * Archived CLASS nodes (the class picker's dimmed enable matches and the
   * gallery's disabled set): class rows on the archival side of the
   * liveness bit. Family-base classes archived by their feature toggle ride
   * here too — the picker's Enable row re-enables through the toggle (the
   * F4 inverse), not a raw unarchive.
   */
  listArchivedClasses(): ClientNode[] {
    return this.cachedListRead("listArchivedClasses", () => {
      const rows = this.ctx.store.database
        .prepare(
          `SELECT n.* FROM node n
           WHERE n.workspace_id = ? AND n.is_class = 1 AND n.is_active = 0
             AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.node_id = n.id)
           ORDER BY COALESCE(n.name, n.id), n.id`,
        )
        .all(this.ctx.workspaceId) as NodeRow[];
      return rows.map((row) => this.ctx.mapNodeCached(row));
    });
  }

  /** All active classes in the workspace, deterministic order (# capture). */
  listClasses(): ClientNode[] {
    return this.cachedListRead("listClasses", () => {
      const rows = this.ctx.store.database
        .prepare(
          `SELECT * FROM node
         WHERE workspace_id = ? AND is_class = 1 AND is_active = 1
         ORDER BY COALESCE(name, id), id`,
        )
        .all(this.ctx.workspaceId) as NodeRow[];
      return rows.map((row) => this.ctx.mapNodeCached(row));
    });
  }

  /**
   * The class id → icon lookup behind the UI icon maps: a narrow
   * `SELECT id, icon` — no content blob, no sort — revision-cached like the
   * list reads. Both web clients satisfy this; icon-map call sites should
   * prefer it over `classIconMap(client.listClasses())`.
   */
  classIcons(): ReadonlyMap<string, string | null> {
    return this.cachedListRead("classIcons", () => {
      const rows = this.ctx.store.database
        .prepare(
          `SELECT id, icon FROM node
         WHERE workspace_id = ? AND is_class = 1 AND is_active = 1`,
        )
        .all(this.ctx.workspaceId) as Array<{ id: string; icon: string | null }>;
      return new Map(rows.map((row) => [row.id, row.icon]));
    });
  }

  /**
   * The class id → EFFECTIVE icon lookup (#1 follow-up): each class's own
   * icon, else the first icon found walking its `class_extends` chain (the
   * `classIconInChain` semantics — a daily page whose icon arrives through
   * a class parent now renders it in ROWS too, not just group-by headers).
   * Computed once per revision over the narrow id+icon read + the extends
   * table. Display-time only: the stored icons stay as authored.
   */
  effectiveClassIcons(): ReadonlyMap<string, string | null> {
    return this.cachedListRead("effectiveClassIcons", () => {
      const own = this.classIcons();
      const rows = this.ctx.store.database
        .prepare(
          "SELECT class_id, parent_class_id FROM class_extends ORDER BY class_id, parent_class_id",
        )
        .all() as Array<{ class_id: string; parent_class_id: string }>;
      const parentsOf = new Map<string, string[]>();
      for (const row of rows) {
        const list = parentsOf.get(row.class_id);
        if (list === undefined) parentsOf.set(row.class_id, [row.parent_class_id]);
        else list.push(row.parent_class_id);
      }
      const resolved = new Map<string, string | null>();
      const resolve = (id: string, seen: ReadonlySet<string>): string | null => {
        if (resolved.has(id)) return resolved.get(id)!;
        if (seen.has(id)) return null;
        const icon = own.get(id);
        if (icon !== null && icon !== undefined && icon !== "") {
          resolved.set(id, icon);
          return icon;
        }
        const next = new Set(seen).add(id);
        for (const parent of parentsOf.get(id) ?? []) {
          const parentIcon = resolve(parent, next);
          if (parentIcon !== null) {
            resolved.set(id, parentIcon);
            return parentIcon;
          }
        }
        resolved.set(id, null);
        return null;
      };
      for (const id of own.keys()) resolve(id, new Set());
      return resolved;
    });
  }

  /** Compute-once-per-revision list read (see `listReadCache`). */
  cachedListRead<T>(key: string, compute: () => T): T {
    if (this.ctx.listReadCache.has(key)) return this.ctx.listReadCache.get(key) as T;
    const value = compute();
    this.ctx.listReadCache.set(key, value);
    return value;
  }

  /** Direct extends parents of a class (m2m), deterministic order. */
  getClassParents(classId: string): string[] {
    return this.ctx.store.classParentIds(classId);
  }

  /** Classes directly extending this one (one extends edge), as nodes — the
   * "Extended by" rows: transitive extenders appear only under their own
   * direct parent. */
  getDirectClassChildren(classId: string): ClientNode[] {
    return this.ctx.store
      .directClassChildIds(classId)
      .map((id) => this.getNode(id) ?? this.getNodeRaw(id))
      .filter((node): node is ClientNode => node !== undefined);
  }

  /** Classes extending this one (transitive), as nodes — the "Extended by" read. */
  getClassChildren(classId: string): ClientNode[] {
    return this.ctx.store
      .classChildIds(classId)
      .map((id) => this.getNode(id) ?? this.getNodeRaw(id))
      .filter((node): node is ClientNode => node !== undefined);
  }

  /** Nodes with present OR-set membership in the class, display order. */
  getClassMembers(classId: string): ClientNode[] {
    return this.ctx.store.classMembers(classId).map((row) => this.ctx.mapNodeCached(row));
  }

  /** The classed-nodes section badge — the same membership projection as a COUNT. */
  getClassMemberCount(classId: string): number {
    return this.ctx.store.classMembersCount(classId);
  }

  /**
   * The class's property bindings in ALPHABETICAL order (by property name —
   * owner ruling 2026-10-21: binding `sequence` retired, class panels are a
   * pure alphabetical list). Registry rows (`class_property` joined to
   * `property_schema`, authored by class.property.set) win; the designed
   * system seeds (@notees/domain, keyed by the class's stored name) fill the
   * schemas the registry does not bind yet — so a seeded class keeps its
   * designed bindings, and user classes (no seed spec) show exactly their
   * registry rows.
   */
  getClassBindings(classId: string): ClassBinding[] {
    const node = this.getNode(classId);
    if (node === undefined || !node.isClass) {
      return [];
    }
    // Extends-aware (owner fix): a class's bindings include its ancestors'
    // — book extends source, so source's bound properties are book's class
    // properties too. Own rows first; the first binding for a schema wins.
    // class_hierarchy rows are (class_id, ancestor_id): the ancestor set of
    // `classId` is `SELECT ancestor_id … WHERE class_id = classId` (the
    // transpose — `class_id … WHERE ancestor_id` — selected the DESCENDANTS,
    // leaking children's rows into the parent read).
    const rows = this.ctx.store.database
      .prepare(
        `SELECT cp.property_schema_id,
                cp.active AS binding_active, ps.name, ps.type, ps.multi, ps.target_class_filter, ps.active,
                ps.date_precision, ps.date_qualified, ps.number_pad, ps.number_decimals, ps.number_rounding
         FROM class_property cp
         LEFT JOIN property_schema ps ON ps.id = cp.property_schema_id
         WHERE cp.class_id IN (SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?)
         ORDER BY (cp.class_id = ?) DESC, ps.name, cp.property_schema_id`,
      )
      .all(classId, classId) as Array<Record<string, unknown>>;
    const seenSchemas = new Set<string>();
    const dedupedRows = rows.filter((row) => {
      const id = String(row.property_schema_id);
      if (seenSchemas.has(id)) return false;
      seenSchemas.add(id);
      return true;
    });
    const bindings: ClassBinding[] = dedupedRows.map((row) => mapClassBindingRow(row));
    const bound = new Set(bindings.map((b) => b.propertySchemaId));
    const byName = (a: ClassBinding, b: ClassBinding) => a.name.localeCompare(b.name);
    // Seed-spec fallback: a system class whose binding rows were never
    // authored still exposes its spec's schemas (read-synthesized — the
    // PG14 seed-spec lookup). Keyed on the RESERVED SYSTEM ID, not the
    // title, so the lookup survives display-wording renames (the system-
    // names pass) and ad-hoc test fixtures alike. The synthesized label
    // comes from the property_schema ROW when one exists (the row is the
    // naming authority — renames and user edits ride it); only a missing
    // row falls back to the manifest's display name.
    const systemClassName = (
      Object.entries(SYSTEM_CLASS_UUIDS) as Array<[string, string]>
    ).find(([, id]) => id === classId)?.[0];
    const schemaNameStmt = this.ctx.store.database.prepare(
      "SELECT name FROM property_schema WHERE id = ?",
    );
    for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
      // bindTo-less specs (the global alias schema) are never class-bound —
      // skip them explicitly (undefined === systemClassName would otherwise
      // "match" for non-system classes). `bind: false` specs (owner ruling
      // 2026-10-24: the source pool's type-specific fields) seed NO binding
      // row on their bindTo — the source base never read-synthesizes them.
      if (
        spec === undefined ||
        spec.bind === false ||
        spec.bindTo === undefined ||
        spec.bindTo !== systemClassName
      ) {
        continue;
      }
      const id = SYSTEM_PROPERTY_UUIDS[name as keyof typeof SYSTEM_PROPERTY_UUIDS];
      if (bound.has(id)) continue;
      const stored = schemaNameStmt.get(id) as { name: string } | undefined;
      bindings.push({
        propertySchemaId: id,
        name:
          stored?.name ??
          SYSTEM_PROPERTY_DISPLAY_NAMES[name as keyof typeof SYSTEM_PROPERTY_DISPLAY_NAMES],
        type: spec.type,
        multi: spec.multi ?? false,
        targetClassFilter: spec.targetClassFilter ?? null,
        datePrecision: null,
        dateQualified: null,
        active: true,
      });
    }
    return bindings.sort(byName);
  }

  /**
   * The class's OWN registry rows (class_property ⋈ property_schema),
   * ALPHABETICAL by property name (owner ruling 2026-10-21 — binding
   * `sequence` retired) — no extends inheritance, no seed-spec fallback
   * synthesis. This is the honest existence read for write-path self-heals
   * (deploySystemClass's binding step): getClassBindings read-synthesizes
   * the designed system seeds for system classes, so a workspace whose
   * registry rows were never authored still LOOKS bound through that read
   * while the registry-only effective-properties read (store effective.ts)
   * sees nothing. Reads that deliberately rely on the fallback (the
   * meetingFamily present gates, the calendar chip eligibility walk, the
   * ClassView) keep using getClassBindings.
   */
  getRegistryBindings(classId: string): ClassBinding[] {
    const node = this.getNode(classId);
    if (node === undefined || !node.isClass) {
      return [];
    }
    const rows = this.ctx.store.database
      .prepare(
        `SELECT cp.property_schema_id,
                cp.active AS binding_active, ps.name, ps.type, ps.multi, ps.target_class_filter, ps.active,
                ps.date_precision, ps.date_qualified, ps.number_pad, ps.number_decimals, ps.number_rounding
         FROM class_property cp
         LEFT JOIN property_schema ps ON ps.id = cp.property_schema_id
         WHERE cp.class_id = ?
         ORDER BY ps.name, cp.property_schema_id`,
      )
      .all(classId) as Array<Record<string, unknown>>;
    return rows.map((row) => mapClassBindingRow(row));
  }
}
