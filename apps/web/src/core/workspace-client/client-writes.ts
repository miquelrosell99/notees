/**
 * The write API domain: the optimistic local-apply + outbox-push object,
 * class, tag, and property-schema operations. Every write builds a protocol
 * envelope (the context's buildEnvelope), applies through the single local
 * enqueue seam, and kicks a best-effort push; composed gestures
 * (mergeNodes, promotePropertyCarrier) journal as one undo batch. Standalone
 * domain — takes the shared ClientContext plus the reads and reads-props
 * domains, no inheritance.
 */

import { uuidv7 } from "uuidv7";
import { planMerge, type MergePlanSummary } from "@notees/store";

import { UUID_LIKE } from "./types.js";
import type {
  CreateObjectInput,
  CreatePropertySchemaInput,
  DeleteObjectOptions,
  SetClassPropertyInput,
  UpdateObjectInput,
  UpdatePropertySchemaInput,
} from "./types.js";
import type { ClientContext } from "./client-context.js";
import { WorkspaceClientReads } from "./client-reads.js";
import { WorkspaceClientReadsProps } from "./client-reads-props.js";

export class WorkspaceClientWrites {
  constructor(
    private readonly ctx: ClientContext,
    private readonly reads: WorkspaceClientReads,
    private readonly props: WorkspaceClientReadsProps,
  ) {}

  // --- write API (optimistic local apply + outbox push) -----------------------

  /** Create an object; returns its id. Applied locally, push kicked off. */
  async createObject(partial: CreateObjectInput): Promise<string> {
    const id = partial.id ?? uuidv7();
    const payload: Record<string, unknown> = { objectId: id };
    if (partial.isEmbedded !== undefined) payload.isEmbedded = partial.isEmbedded;
    if (partial.classIds !== undefined) payload.classIds = partial.classIds;
    if (partial.tagIds !== undefined) payload.tagIds = partial.tagIds;
    // Title-is-content: the protocol has no object `name`. The `name`
    // convenience becomes the node's initial text content (a single text
    // token), so callers can keep naming pages at creation.
    const initialText = partial.name !== undefined && partial.contentAst === undefined
      ? [{ type: "text", text: partial.name }]
      : undefined;
    if (initialText !== undefined) payload.contentAst = initialText;
    if (partial.contentAst !== undefined) payload.contentAst = partial.contentAst;
    if (partial.parentId !== undefined) payload.parentId = partial.parentId;
    if (partial.afterId !== undefined) payload.afterId = partial.afterId;
    if (partial.beforeId !== undefined) payload.beforeId = partial.beforeId;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("object.create", payload, [id]));
    return id;
  }

  /** Update object fields (object.update; at least one field required). */
  async updateObject(id: string, fields: UpdateObjectInput): Promise<void> {
    const payload: Record<string, unknown> = { objectId: id };
    if (fields.isEmbedded !== undefined) payload.isEmbedded = fields.isEmbedded;
    if (fields.contentAst !== undefined) payload.contentAst = fields.contentAst;
    if (fields.icon !== undefined) payload.icon = fields.icon;
    if (fields.color !== undefined) payload.color = fields.color;
    if (fields.coverAssetId !== undefined) payload.coverAssetId = fields.coverAssetId;
    if (fields.bannerAssetId !== undefined) payload.bannerAssetId = fields.bannerAssetId;
    if (fields.aliasedNodeId !== undefined) payload.aliasedNodeId = fields.aliasedNodeId;
    if (fields.description !== undefined) payload.description = fields.description;
    if (fields.listStyle !== undefined) payload.listStyle = fields.listStyle;
    if (fields.active !== undefined) payload.active = fields.active;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("object.update", payload, [id]));
  }

  /**
   * Archive / unarchive a node (object.update {active} — the classes-gallery
   * batch): false archives (reversible; the node leaves every default read
   * with no trash row), true unarchives. The store refuses the archival
   * direction for locked system classes and family bases (fail loud).
   */
  async setArchived(id: string, active: boolean): Promise<void> {
    await this.updateObject(id, { active });
  }

  /** Trash (default) or permanently delete an object and its subtree. */
  async deleteObject(id: string, opts: DeleteObjectOptions = {}): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope(
        "object.delete",
        { objectId: id, permanent: opts.permanent ?? false },
        [id],
      ),
    );
  }

  /**
   * Restore a trashed object and its subtree (object.restore — the same
   * first-class convergent op the undo journal and the merge flow compose;
   * LWW vs delete by log order). No-op when the node is active or unknown —
   * the op itself is idempotent, and the guard avoids noise writes. This is
   * the web surface the CLI's `object restore` already had.
   */
  async restoreObject(id: string): Promise<void> {
    const node = this.reads.getNodeRaw(id);
    if (node === undefined || node.isActive) return;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("object.restore", { objectId: id }, [id]));
  }

  /**
   * Empty the trash (trash.empty): permanently delete every soft-trashed
   * subtree root. The op evaluates the set at apply time — an object.restore
   * that lands before it survives, one after is log-order LWW. Irreversible,
   * so the Trash hub confirms first; permanent deletes never enter the undo
   * journal. No-op when the trash is already empty (the applier no-ops).
   */
  async emptyTrash(): Promise<void> {
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("trash.empty", {}, []));
  }

  /**
   * Reparent a node (outliner indent/outdent gesture) — issues `object.move`.
   * `parentId` null means workspace root — legal for any non-class node (a
   * parentless node simply renders with document chrome; only a class under
   * a parent violates the store's placement CHECK). Pass `afterId` to land
   * the node immediately after that sibling in the parent's child order
   * (Enter placement); omit it to append at the end (Tab indent). Applied
   * locally, push kicked off.
   */
  async moveObject(
    id: string,
    parentId: string | null,
    afterId?: string,
    beforeId?: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = { objectId: id, parentId };
    if (afterId !== undefined) payload.afterId = afterId;
    if (beforeId !== undefined) payload.beforeId = beforeId;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("object.move", payload, [id]));
  }

  /**
   * Merge one page into another (SCHEMA.md "Node merge"): `planMerge` computes
   * the deterministic plan of EXISTING ops from the local store's read state —
   * children move, class/tag/property/collection remap, mention +
   * property-reference rewrites, field copy, the source trash LAST — and the
   * client applies the whole plan as ONE undo-journal batch (a single undo
   * restores the merge). `MergeGuardError` fails loud before any op is
   * emitted; the wire is untouched (every op is an ordinary convergent op).
   */
  async mergeNodes(sourceId: string, targetId: string): Promise<MergePlanSummary> {
    const plan = planMerge(this.ctx.store.database, sourceId, targetId);
    this.ctx.undoJournal.batch(() => {
      for (const op of plan.ops) {
        this.ctx.enqueueLocal(
          this.ctx.buildEnvelope(op.opType, op.payload, [plan.sourceId, plan.targetId]),
        );
      }
    });
    return plan.summary;
  }

  /**
   * OR-set class membership add (the `#` / `+` set gesture). No-op when the
   * class is already assigned. Membership is NOT an object.update field:
   * class_ids is a CRDT OR-Set whose add carrier is a re-issued
   * object.create on the same id — the applier's exists-branch seeds
   * class_member_set add-wins per pair without touching the tree
   * (store/appliers.ts applyObjectCreate, conflicts.ts class_conflict).
   * Immediate (not debounced) — a discrete gesture with the same optimistic
   * envelope path as any write.
   */
  async assignClass(id: string, classId: string): Promise<void> {
    const node = this.reads.getNode(id) ?? this.reads.getNodeRaw(id);
    if (!node) throw new Error(`assignClass: node ${id} not found`);
    if (node.classIds.includes(classId)) return;
    await this.createObject({
      id,
      parentId: node.parentId,
      contentAst: node.contentAst,
      classIds: [classId],
      // exactOptionalPropertyTypes: only present the key when set.
      ...(node.name !== null ? { name: node.name } : {}),
    });
  }

  /**
   * User-defined class ORDER (class.reorder, display-only LWW): writes the
   * full ordered member list; the applier keeps ordered members first and
   * appends any unlisted members sorted by id.
   */
  async reorderClasses(id: string, classIds: string[]): Promise<void> {
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("class.reorder", { objectId: id, classIds }, [id]));
  }

  /**
   * OR-set class membership remove — the class chip's × gesture
   * (class.unassign). No-op when the class is not assigned. The applier
   * tombstones the class_member_set pair add-wins and recomputes class_ids;
   * the effective read drops the class's derived defaults automatically and
   * authored property values survive (SCHEMA.md "Class properties").
   * Immediate (not debounced) — a discrete gesture, same optimistic envelope
   * path as any write.
   *
   * Owner rule: authored values that merely MIRROR the departing
   * class's binding defaults carry no user data — the user never put
   * anything in that property. Sweep them (unset envelopes, explicit ops —
   * every client converges) before the membership remove. The provenance
   * flag (owner directive — value metadata, wire-neutral) makes
   * the call EXACT where present:
   *   metadata.provenance === "system" → the system materialized it —
   *     sweep even when it differs from the default;
   *   metadata.provenance === "user"   → the user explicitly wrote it —
   *     NEVER sweep, even when it equals the default;
   *   absent (legacy data)             → the original mirror heuristic.
   */
  async unassignClass(id: string, classId: string): Promise<void> {
    const node = this.reads.getNode(id) ?? this.reads.getNodeRaw(id);
    if (!node) throw new Error(`unassignClass: node ${id} not found`);
    if (!node.classIds.includes(classId)) return;
    const bindings = this.reads.getClassBindings(classId);
    if (bindings.length > 0) {
      const authored = this.props.getEffectiveProperties(id).filter((row) => row.source === "authored");
      // The default is SCHEMA-level (owner ruling 2026-10-20) — one global
      // default per property, whatever class binds it.
      const schemas = this.props.listPropertySchemas();
      for (const binding of bindings) {
        const defaultValue =
          schemas.find((schema) => schema.id === binding.propertySchemaId)?.defaultValue ?? null;
        const defaultJson = JSON.stringify(defaultValue ?? null);
        for (const row of authored) {
          if (row.propertySchemaId !== binding.propertySchemaId) continue;
          const provenance =
            typeof row.metadata?.provenance === "string" ? row.metadata.provenance : null;
          const mirrorsDefault =
            JSON.stringify(row.value) === defaultJson &&
            defaultValue !== null &&
            defaultValue !== undefined;
          const sweep =
            provenance === "system" ? true : provenance === "user" ? false : mirrorsDefault;
          if (!sweep) continue;
          const payload: Record<string, unknown> = {
            objectId: id,
            propertySchemaId: binding.propertySchemaId,
          };
          // PG5: unset by element id when the row carries a writer-minted
          // UUID element; the deterministic composite (node:schema:idx) is
          // not uuid-shaped — those rows unset by idx.
          if (
            typeof row.elementId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.elementId)
          ) {
            payload.elementId = row.elementId;
          } else {
            payload.idx = row.idx;
          }
          this.ctx.enqueueLocal(this.ctx.buildEnvelope("property.unset", payload, [id]));
        }
      }
    }
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("class.unassign", { objectId: id, classId }, [id]));
  }

  /**
   * Assign a tag (any page) to a node — pages AND blocks (owner rule:
   * tags are node-scoped, the block metadata section renders them). The
   * add carrier is a re-issued object.create with the single tag, the same
   * OR-Set convergence pattern as classes.
   */
  async assignTag(id: string, tagId: string): Promise<void> {
    const node = this.reads.getNode(id) ?? this.reads.getNodeRaw(id);
    if (!node) throw new Error(`assignTag: node ${id} not found`);
    if (node.tagIds.includes(tagId)) return;
    await this.createObject({
      id,
      parentId: node.parentId,
      contentAst: node.contentAst,
      tagIds: [tagId],
      ...(node.name !== null ? { name: node.name } : {}),
    });
  }

  /** Remove a tag (OR-Set tombstone; loses to a concurrent newer add). */
  async unassignTag(id: string, tagId: string): Promise<void> {
    const node = this.reads.getNode(id) ?? this.reads.getNodeRaw(id);
    if (!node) throw new Error(`unassignTag: node ${id} not found`);
    if (!node.tagIds.includes(tagId)) return;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("tag.unassign", { objectId: id, tagId }, [id]));
  }

  /**
   * Create a class (class.create: node row + class registry row — the
   * registry row is what keeps the extends closure rebuild authoritative).
   * The store seeds the hierarchy self-row at create time, so no setExtends
   * is needed for a class that never extends anything.
   * Returns the new class id. Applied locally, push kicked off.
   */
  async createClass(
    name: string,
    opts?: { icon?: string; color?: string; id?: string },
  ): Promise<string> {
    // Caller-chosen id (the object.create pattern): system authoring
    // (ensureTaskFamily) creates the task class at its reserved seed id.
    const id = opts?.id ?? uuidv7();
    // Title-is-content: the class's name becomes its (text-only) content.
    const payload: Record<string, unknown> = {
      classId: id,
      contentAst: [{ type: "text", text: name }],
    };
    if (opts?.icon !== undefined) payload.icon = opts.icon;
    if (opts?.color !== undefined) payload.color = opts.color;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("class.create", payload, [id]));
    return id;
  }

  /**
   * Replace a class's full extends parent set (class.setExtends — m2m,
   * replace semantics; an empty array detaches all parents). The store keeps
   * the transitive closure in sync and fails loud on cycles (CycleError),
   * which callers surface as a transient message.
   */
  async setClassExtends(classId: string, parentClassIds: string[]): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope(
        "class.setExtends",
        { classId, parentClassIds },
        [classId, ...parentClassIds],
      ),
    );
  }

  /**
   * Upsert a class → property-schema binding (class.property.set). The
   * payload PATCHES the row: omitted fields keep their existing values. The
   * binding carries the genuinely per-class mechanic ONLY — the active
   * soft-unbind flag (owner rulings 2026-10-20/21 retired `required` and
   * `sequence` and moved `defaultValue` to the schema; see
   * updatePropertySchema).
   */
  async setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): Promise<void> {
    const payload: Record<string, unknown> = { classId, propertySchemaId };
    if (fields.active !== undefined) payload.active = fields.active;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("class.property.set", payload, [classId]));
  }

  /** Remove a class → property-schema binding (class.property.unset). */
  async unsetClassProperty(classId: string, propertySchemaId: string): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope(
        "class.property.unset",
        { classId, propertySchemaId },
        [classId],
      ),
    );
  }

  /**
   * Create a property schema (propertySchema.create); returns the new id.
   * The bindings picker's "+ new schema" path.
   */
  async createPropertySchema(input: CreatePropertySchemaInput): Promise<string> {
    const id = input.id ?? uuidv7();
    const payload: Record<string, unknown> = {
      propertySchemaId: id,
      name: input.name,
      type: input.type,
    };
    if (input.multi !== undefined) payload.multi = input.multi;
    if (input.scopeClassIds !== undefined) payload.scopeClassIds = input.scopeClassIds;
    if (input.icon !== undefined) payload.icon = input.icon;
    if (input.options !== undefined) payload.options = input.options;
    if (input.targetClassFilter !== undefined) payload.targetClassFilter = input.targetClassFilter;
    if (input.datePrecision !== undefined) payload.datePrecision = input.datePrecision;
    if (input.dateQualified !== undefined) payload.dateQualified = input.dateQualified;
    if (input.defaultValue !== undefined) payload.defaultValue = input.defaultValue;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("propertySchema.create", payload, []));
    return id;
  }

  /**
   * Patch a property schema's metadata (propertySchema.update): name/options
   * plus the SCHEMA.md "Dates" fields (the Class View bindings editor's
   * precision/qualified controls). Omitted fields keep their values.
   */
  async updatePropertySchema(propertySchemaId: string, fields: UpdatePropertySchemaInput): Promise<void> {
    const payload: Record<string, unknown> = { propertySchemaId };
    if (fields.name !== undefined) payload.name = fields.name;
    // The owner-2026-10-20 fields ride the wire verbatim — the strict
    // payload enforces applicability (empty scopeClassIds rejected,
    // min/max on number schemas, pattern on text/url/email).
    if (fields.icon !== undefined) payload.icon = fields.icon;
    if (fields.scopeClassIds !== undefined) payload.scopeClassIds = fields.scopeClassIds;
    if (fields.targetClassFilter !== undefined) payload.targetClassFilter = fields.targetClassFilter;
    if (fields.multi !== undefined) payload.multi = fields.multi;
    if (fields.validationRules !== undefined) payload.validationRules = fields.validationRules;
    if (fields.options !== undefined) payload.options = fields.options;
    if (fields.datePrecision !== undefined) payload.datePrecision = fields.datePrecision;
    if (fields.dateQualified !== undefined) payload.dateQualified = fields.dateQualified;
    if (fields.numberPad !== undefined) payload.numberPad = fields.numberPad;
    if (fields.numberDecimals !== undefined) payload.numberDecimals = fields.numberDecimals;
    if (fields.numberRounding !== undefined) payload.numberRounding = fields.numberRounding;
    // The global default (owner ruling 2026-10-20): keep/clear — absent
    // keeps, present-null clears; PC2 type-check runs at apply.
    if (fields.defaultValue !== undefined) payload.defaultValue = fields.defaultValue;
    if (fields.display !== undefined) payload.display = fields.display;
    if (fields.hideWhenEmpty !== undefined) payload.hideWhenEmpty = fields.hideWhenEmpty;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("propertySchema.update", payload, []));
  }

  /**
   * Soft-delete a property schema (propertySchema.delete — the conversion
   * flow's final step). Authored values under the schema survive
   * in the log; recreate-under-the-same-id reactivates (the applier upsert).
   */
  async deletePropertySchema(propertySchemaId: string): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope("propertySchema.delete", { propertySchemaId }, []),
    );
  }

  /**
   * Author a property value (property.set) — the panel's edit path. Writing
   * an authored value shadows any derived class-binding default at the slot.
   * `metadata` carries per-value qualifiers (SCHEMA.md "Dates": dateQualified
   * schemas persist startDate/endDate here).
   */
  async setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx = 0,
    metadata?: Record<string, unknown>,
    /** PG5 multi-value element ADD: a writer-minted UUIDv7 (uuidv7) — the
     *  applier keys the new property_value row on it (the OR-Set add;
     *  absent = the legacy positional carrier). */
    elementId?: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = { objectId, propertySchemaId, value, idx };
    if (metadata !== undefined) payload.metadata = metadata;
    if (elementId !== undefined) payload.elementId = elementId;
    this.ctx.enqueueLocal(this.ctx.buildEnvelope("property.set", payload, [objectId]));
  }

  /** Clear an authored property value (property.unset) — the default resurfaces. */
  async unsetProperty(objectId: string, propertySchemaId: string, idx = 0): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope(
        "property.unset",
        { objectId, propertySchemaId, idx },
        [objectId],
      ),
    );
  }

  /**
   * Assign a property to a node WITHOUT a value (property.assign — owner
   * ruling 2026-10-23, the v1 `node_property` lineage): the panel row renders
   * empty and the row's editor authors the first value later via setProperty.
   * Assignment carries zero availability semantics — scope stays the sole
   * locality authority (the applier rejects ineligible nodes, fail loud).
   */
  async assignProperty(objectId: string, propertySchemaId: string): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope("property.assign", { objectId, propertySchemaId }, [objectId]),
    );
  }

  /** Remove a node→property assignment (property.unassign) — authored values survive. */
  async unassignProperty(objectId: string, propertySchemaId: string): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope("property.unassign", { objectId, propertySchemaId }, [objectId]),
    );
  }

  /**
   * "Promote to block" (SCHEMA.md "Node-backed text properties"): detach a
   * node-backed text property value and surface the carrier in the owner's
   * body as an ordinary child. Composed from existing ops — property.unset
   * (whose applier trashes the now-unreferenced carrier, trash + retention
   * per the spec) followed by object.restore (revives the carrier subtree as
   * a body child; a safe no-op when the unset left it alive, e.g. another
   * slot still references it). Display state only: no move op — the carrier
   * keeps its tree position and renders in the body once no value references
   * it. Fails loud when the slot holds no authored value or the value is not
   * a node-backed reference.
   */
  async promotePropertyCarrier(objectId: string, propertySchemaId: string, idx = 0): Promise<void> {
    const row = this.ctx.store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
      )
      .get(objectId, propertySchemaId, idx) as { value: string } | undefined;
    if (row === undefined) {
      throw new Error(
        `promotePropertyCarrier: no authored value at ${propertySchemaId}:${idx} on ${objectId}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = undefined;
    }
    const carrier =
      typeof parsed === "object" && parsed !== null && "nodeId" in parsed
        ? String((parsed as { nodeId: unknown }).nodeId)
        : typeof parsed === "string" && UUID_LIKE.test(parsed)
          ? parsed
          : null;
    if (carrier === null) {
      throw new Error(
        `promotePropertyCarrier: value at ${propertySchemaId}:${idx} is not a node-backed carrier reference`,
      );
    }
    // One gesture, two envelopes: journal them as a single entry (the unset
    // and the restore undo together, in reverse).
    this.ctx.undoJournal.batch(() => {
      this.ctx.enqueueLocal(
        this.ctx.buildEnvelope("property.unset", { objectId, propertySchemaId, idx }, [objectId]),
      );
      this.ctx.enqueueLocal(
        this.ctx.buildEnvelope("object.restore", { objectId: carrier }, [objectId, carrier]),
      );
    });
  }
}
